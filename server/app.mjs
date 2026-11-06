import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerFrontend } from './services/static.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createStore, now, terminal } from './services/store.mjs';
import { hashPassword, verifyPassword, hashToken, equalSecret } from './lib/crypto.mjs';
import {
  fail,
  isUuid,
  validateProject,
  validateCredential,
  validatePassword,
  sameTarget,
} from './lib/validation.mjs';
import { projectRoot } from './config.mjs';
import { isAllowedHttpGitRepository } from '../shared/repository-policy.mjs';

const execFileAsync = promisify(execFile);
const SESSION_SECONDS = 7 * 24 * 3600;
export const logPath = (config, id) => path.join(config.dataDir, 'logs', `${id}.log`);

export function publicRun(run, config) {
  if (!run) return null;
  const { projectSnapshot, artifactPath, cancelRequested, ...value } = run;
  return {
    ...value,
    projectName: projectSnapshot.name,
    projectType: projectSnapshot.type || 'node',
    branch: projectSnapshot.branch,
    ...(projectSnapshot.buildMode === 'multi'
      ? {
          buildMode: 'multi',
          taskCount: projectSnapshot.tasks.length,
          sourceCount: projectSnapshot.sources.length,
        }
      : {}),
    cancelRequested,
    ...(run.kind === 'command'
      ? {
          commands: projectSnapshot.commands,
          executionDirectory: projectSnapshot.deploy.root,
          executionHost:
            projectSnapshot.deploy.type === 'ssh'
              ? `${projectSnapshot.deploy.user}@${projectSnapshot.deploy.host}`
              : null,
        }
      : {}),
    artifactAvailable:
      run.kind === 'build' &&
      run.status === 'success' &&
      Boolean(artifactPath && fs.existsSync(artifactPath)),
  };
}

export async function createApp(config, options = {}) {
  config.projectRoot ||= projectRoot;
  const store = options.store || createStore(config);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 512 * 1024,
    trustProxy: 'loopback',
  });
  const events = new Set();
  const attempts = new Map();
  let dockerCache = { checkedAt: 0, available: false };
  await app.register(cookie);
  app.decorate('store', store);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin) {
      let origin;
      try {
        origin = new URL(request.headers.origin);
      } catch {
        fail('请求来源无效', 403);
      }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host)
        fail('请从同一站点提交请求', 403);
    }
    const open = ['/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/health'];
    if (open.includes(request.url.split('?')[0])) return;
    const token = request.cookies.flow_session;
    const session =
      token &&
      store.db
        .prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?')
        .get(hashToken(token), now());
    if (!session) fail('请先登录', 401);
  });

  app.setErrorHandler((error, request, reply) => {
    const code =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (code === 500) request.log.error({ err: error }, 'request failed');
    reply
      .code(code)
      .send({ error: code === 500 ? '服务器处理失败，请检查服务日志' : error.message });
  });

  function rateLimit(request) {
    const key = request.ip;
    const current = attempts.get(key);
    if (current && Date.now() - current.since < 15 * 60 * 1000) {
      if (current.count >= 10) fail('尝试次数过多，请 15 分钟后重试', 429);
      current.count++;
    } else attempts.set(key, { since: Date.now(), count: 1 });
    if (attempts.size > 1000)
      for (const [ip, value] of attempts)
        if (Date.now() - value.since > 15 * 60 * 1000) attempts.delete(ip);
  }
  function startSession(reply) {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
    store.db
      .prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)')
      .run(hashToken(token), new Date(Date.now() + SESSION_SECONDS * 1000).toISOString());
    reply.setCookie('flow_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookie,
      maxAge: SESSION_SECONDS,
    });
  }
  function projectOrFail(id) {
    if (!isUuid(id)) fail('项目不存在', 404);
    const project = store.getProject(id);
    if (!project) fail('项目不存在', 404);
    return project;
  }
  function runOrFail(id) {
    if (!isUuid(id)) fail('运行记录不存在', 404);
    const run = store.getRun(id);
    if (!run) fail('运行记录不存在', 404);
    return run;
  }
  function checkCredentials(project) {
    for (const source of project.buildMode === 'multi' ? project.sources : [project]) {
      if (!source.buildCredentialId) continue;
      const credential = store.getCredential(source.buildCredentialId);
      if (!credential) fail('所选仓库凭据不存在');
      const https = /^https:\/\//i.test(source.repoUrl || '');
      const http = isAllowedHttpGitRepository(source.repoUrl);
      if ((https || http) && credential.type !== 'git-https')
        fail(`${http ? 'HTTP' : 'HTTPS'} 仓库请选择 Git HTTPS 账号密码凭据`);
      if (!https && !http && credential.type !== 'ssh')
        fail('Git HTTPS 账号密码凭据只能用于 HTTPS 或已批准的 HTTP 仓库');
    }
    if (project.deploy.type === 'ssh') {
      const credential = store.getCredential(project.deploy.credentialId);
      if (!credential) fail('所选 SSH 凭据不存在');
      if (credential.type !== 'ssh') fail('SSH 部署请选择 SSH 私钥或密码凭据');
    }
  }
  function projectOutput(project) {
    return {
      ...project,
      type: project.type || 'node',
      latestRun: publicRun(store.latestRun(project.id), config),
    };
  }

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth/status', async (request) => {
    const auth = store.setting('auth');
    const token = request.cookies.flow_session;
    const authenticated = Boolean(
      token &&
      store.db
        .prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?')
        .get(hashToken(token), now()),
    );
    return {
      initialized: Boolean(auth),
      authenticated,
      username: authenticated ? auth?.username : null,
      setupTokenRequired: !auth,
    };
  });
  app.post('/api/auth/setup', async (request, reply) => {
    if (store.setting('auth')) fail('管理员已经创建', 409);
    rateLimit(request);
    if (!equalSecret(request.body?.setupToken || '', config.setupToken))
      fail('初始化令牌不正确，请读取数据目录中的 setup-token 文件', 403);
    const username = request.body?.username;
    if (typeof username !== 'string' || !/^[\p{L}\p{N}_.@-]{2,50}$/u.test(username))
      fail('用户名需要为 2～50 位字母、数字或常用符号');
    const passwordHash = hashPassword(validatePassword(request.body?.password));
    store.transaction(() => {
      if (store.setting('auth')) fail('管理员已经创建', 409);
      store.setSetting('auth', { username, passwordHash });
    });
    attempts.delete(request.ip);
    startSession(reply);
    return { username };
  });
  app.post('/api/auth/login', async (request, reply) => {
    rateLimit(request);
    const auth = store.setting('auth');
    if (!auth) fail('请先创建管理员', 409);
    if (
      typeof request.body?.password !== 'string' ||
      request.body.password.length > 256 ||
      request.body?.username !== auth.username ||
      !verifyPassword(request.body.password, auth.passwordHash)
    )
      fail('用户名或密码不正确', 401);
    attempts.delete(request.ip);
    startSession(reply);
    return { username: auth.username };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.cookies.flow_session)
      store.db
        .prepare('DELETE FROM sessions WHERE token_hash=?')
        .run(hashToken(request.cookies.flow_session));
    reply.clearCookie('flow_session', { path: '/' });
    return { ok: true };
  });
  app.post('/api/auth/password', async (request, reply) => {
    rateLimit(request);
    const auth = store.setting('auth');
    if (
      typeof request.body?.currentPassword !== 'string' ||
      request.body.currentPassword.length > 256 ||
      !verifyPassword(request.body.currentPassword, auth.passwordHash)
    )
      fail('当前密码不正确', 400);
    store.setSetting('auth', {
      ...auth,
      passwordHash: hashPassword(validatePassword(request.body.newPassword)),
    });
    store.db.prepare('DELETE FROM sessions').run();
    startSession(reply);
    attempts.delete(request.ip);
    return { ok: true };
  });

  app.get('/api/system', async () => {
    if (Date.now() - dockerCache.checkedAt > 10000) {
      let available = false;
      try {
        await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
          timeout: 2000,
          maxBuffer: 4096,
        });
        available = true;
      } catch {
        /* UI reports unavailable. */
      }
      dockerCache = { checkedAt: Date.now(), available };
    }
    const worker = store.setting('worker');
    return {
      version: '0.1.0',
      nodeVersions: ['14', '18', '22', '24', '26'],
      runnerMode: config.runnerMode,
      dockerAvailable: dockerCache.available,
      hostNodeVersion: process.versions.node,
      allowHostRunner: config.allowHostRunner,
      dataDir: config.dataDir,
      worker: {
        online: Boolean(worker && Date.now() - Date.parse(worker.lastSeen) < 15000),
        lastSeen: worker?.lastSeen || null,
      },
    };
  });
  app.get('/api/projects', async () => ({ projects: store.listProjects().map(projectOutput) }));
  app.get('/api/projects/:id', async (request) => ({
    project: projectOutput(projectOrFail(request.params.id)),
  }));
  app.post('/api/projects', async (request, reply) => {
    const project = validateProject(request.body, config);
    checkCredentials(project);
    reply.code(201);
    return { project: projectOutput(store.saveProject(project)) };
  });
  app.put('/api/projects/:id', async (request) => {
    const project = validateProject(request.body, config);
    checkCredentials(project);
    return store.transaction(() => {
      const existing = projectOrFail(request.params.id);
      const targetChanged = !sameTarget(existing.deploy, project.deploy);
      const typeChanged = (existing.type || 'node') !== project.type;
      if ((targetChanged || typeChanged) && store.hasActiveRuns(existing.id))
        fail('项目仍有排队或运行中的任务，请先完成或取消任务后再修改类型或发布位置', 409);
      store.saveProject(project, existing.id);
      if (targetChanged || typeChanged) store.setCurrentRelease(existing.id, null);
      return { project: projectOutput(store.getProject(existing.id)) };
    });
  });
  app.delete('/api/projects/:id', async (request) => {
    const project = projectOrFail(request.params.id);
    if (store.hasActiveRuns(project.id)) fail('项目仍有排队或运行中的任务，请先取消', 409);
    const runs = store.listRuns(project.id, 100000);
    store.deleteProject(project.id);
    for (const run of runs) fs.rmSync(logPath(config, run.id), { force: true });
    fs.rmSync(path.join(config.dataDir, 'artifacts', project.id), { recursive: true, force: true });
    return { ok: true, message: '配置与本地产物已删除，网站发布目录已保留' };
  });
  app.post('/api/projects/:id/runs', async (request, reply) => {
    const project = projectOrFail(request.params.id);
    checkCredentials(project);
    if (store.listRuns(project.id, 101).filter((run) => !terminal(run.status)).length >= 20)
      fail('此项目排队任务过多，请等待已有任务完成', 409);
    reply.code(202);
    return { run: publicRun(store.enqueue(project), config) };
  });
  app.get('/api/runs', async (request) => {
    const projectId = request.query.projectId;
    if (projectId) projectOrFail(projectId);
    const limit = Math.min(500, Math.max(1, parseInt(request.query.limit, 10) || 100));
    return { runs: store.listRuns(projectId, limit).map((run) => publicRun(run, config)) };
  });
  app.get('/api/runs/:id', async (request) => ({
    run: publicRun(runOrFail(request.params.id), config),
  }));
  app.post('/api/runs/:id/cancel', async (request) => {
    const run = runOrFail(request.params.id);
    const result = store.requestCancelRun(run.id);
    if (!result) fail('运行记录不存在', 404);
    if (!result.accepted) fail('任务已经结束', 409);
    return { run: publicRun(result.run, config) };
  });
  app.post('/api/runs/:id/retry', async (request, reply) => {
    const source = runOrFail(request.params.id);
    if (!terminal(source.status)) fail('任务尚未结束', 409);
    const project = projectOrFail(source.projectId);
    if ((source.projectSnapshot.type || 'node') !== (project.type || 'node'))
      fail('流水线类型已变更，请按当前配置创建新的运行', 409);
    if (!sameTarget(source.projectSnapshot.deploy, project.deploy))
      fail('网站发布位置已变更，请从项目创建新的运行', 409);
    checkCredentials(source.projectSnapshot);
    if (source.kind === 'rollback') fail('请从发布记录重新选择回滚版本', 400);
    let run = store.enqueue(source.projectSnapshot);
    if (source.commitSha || source.buildDetails)
      run = store.updateRun(run.id, {
        ...(source.commitSha ? { commitSha: source.commitSha } : {}),
        ...(source.buildDetails
          ? {
              buildDetails: {
                sources: source.buildDetails.sources.map((item) => ({
                  ...item,
                  status: 'waiting',
                })),
                tasks: source.buildDetails.tasks.map((item) => ({
                  ...item,
                  status: 'waiting',
                  stage: 'waiting',
                })),
              },
            }
          : {}),
      });
    reply.code(202);
    return { run: publicRun(run, config) };
  });
  app.post('/api/projects/:id/rollback', async (request, reply) => {
    const project = projectOrFail(request.params.id);
    if (project.type === 'command') fail('命令直接修改现有项目，不提供产物自动回滚');
    const source = runOrFail(request.body?.releaseId);
    if (
      source.projectId !== project.id ||
      source.kind !== 'build' ||
      source.status !== 'success' ||
      !source.artifactPath ||
      !fs.existsSync(source.artifactPath)
    )
      fail('此版本的构建产物不可用，无法回滚');
    if (!sameTarget(source.projectSnapshot.deploy, project.deploy))
      fail('网站发布位置已变更，此版本不能回滚到当前目标');
    checkCredentials(project);
    reply.code(202);
    const run = store.enqueue(project, 'rollback', source.id);
    store.updateRun(run.id, {
      commitSha: source.commitSha,
      nodeVersion: source.nodeVersion,
      packageManagerVersion: source.packageManagerVersion,
      buildDetails: source.buildDetails,
    });
    return { run: publicRun(store.getRun(run.id), config) };
  });

  const credentialOutput = (credential) => ({
    id: credential.id,
    name: credential.name,
    type: credential.type || 'ssh',
    authType: credential.authType || 'key',
    createdAt: credential.createdAt,
    hasKnownHosts: Boolean(credential.hasKnownHosts),
  });
  app.get('/api/credentials', async () => ({
    credentials: store.listCredentials().map(credentialOutput),
  }));
  app.post('/api/credentials', async (request, reply) => {
    reply.code(201);
    return { credential: credentialOutput(store.saveCredential(validateCredential(request.body))) };
  });
  app.delete('/api/credentials/:id', async (request) => {
    const id = request.params.id;
    if (!isUuid(id) || !store.getCredential(id)) fail('凭据不存在', 404);
    const uses = (project) =>
      project.buildCredentialId === id ||
      (project.sources || []).some((source) => source.buildCredentialId === id) ||
      project.deploy.credentialId === id;
    if (
      store.listProjects().some(uses) ||
      store.listRuns(null, 100000).some((run) => !terminal(run.status) && uses(run.projectSnapshot))
    )
      fail('凭据正在被项目或待执行任务使用，请先解除关联', 409);
    store.deleteCredential(id);
    return { ok: true };
  });

  app.get('/api/runs/:id/logs', async (request) => {
    const run = runOrFail(request.params.id);
    return readLogs(logPath(config, run.id), request.query.offset);
  });
  app.get('/api/runs/:id/logs/download', async (request, reply) => {
    const run = runOrFail(request.params.id);
    reply.header('Content-Disposition', `attachment; filename="flow-${run.number}-${run.id}.log"`);
    reply.type('text/plain; charset=utf-8');
    return fs.existsSync(logPath(config, run.id))
      ? fs.createReadStream(logPath(config, run.id))
      : '';
  });
  app.get('/api/runs/:id/events', async (request, reply) => {
    const run = runOrFail(request.params.id);
    let offset = Math.max(
      0,
      Number(request.headers['last-event-id']) || Number(request.query.offset) || 0,
    );
    let previous = '';
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    reply.raw.write(': connected\n\n');
    let closed = false;
    let timer;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      events.delete(close);
      reply.raw.end();
    };
    events.add(close);
    reply.raw.on('close', close);
    function send(event, value, id) {
      if (!closed)
        reply.raw.write(
          `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
        );
    }
    function tick() {
      if (closed) return;
      try {
        const current = store.getRun(run.id);
        if (!current) {
          close();
          return;
        }
        const chunk = readLogs(logPath(config, run.id), offset, 64 * 1024);
        if (chunk.text) {
          offset = chunk.nextOffset;
          send('log', { text: chunk.text, offset }, offset);
        }
        const state = JSON.stringify(publicRun(current, config));
        if (state !== previous) {
          send('run', { run: JSON.parse(state) });
          previous = state;
        }
        if (terminal(current.status) && chunk.nextOffset >= chunk.totalBytes) {
          send('end', {});
          close();
        } else reply.raw.write(': heartbeat\n\n');
      } catch {
        close();
      }
    }
    timer = setInterval(tick, 800);
    tick();
  });

  const dist = path.join(projectRoot, 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    registerFrontend(app, dist);
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
      if (!request.headers.accept?.includes('text/html')) return reply.code(404).send('Not found');
      return reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(fs.createReadStream(path.join(dist, 'index.html')));
    });
    app.addHook('onSend', async (request, reply, payload) => {
      if (!request.url.startsWith('/api/'))
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
      return payload;
    });
  } else
    app.get('/', async (request, reply) =>
      reply
        .type('text/plain; charset=utf-8')
        .send('Flow Lite API 已启动。开发请访问 Vite 地址；生产请先执行 npm run build。'),
    );

  app.addHook('onClose', async () => {
    for (const close of events) close();
    if (!options.store) store.close();
  });
  return app;
}

function readLogs(filename, requested = 0, maxBytes = 1024 * 1024) {
  let size;
  try {
    size = fs.statSync(filename).size;
  } catch (error) {
    if (error.code === 'ENOENT') return { text: '', nextOffset: 0, totalBytes: 0 };
    throw error;
  }
  let offset = Number(requested);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) offset = 0;
  const fd = fs.openSync(filename, 'r');
  try {
    let length = Math.min(maxBytes, size - offset);
    const buffer = Buffer.alloc(length);
    length = fs.readSync(fd, buffer, 0, length, offset);
    if (offset + length < size) {
      let start = length - 1;
      while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
      if (start >= 0) {
        const byte = buffer[start];
        const count = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        if (length - start < count) length = start;
      }
    }
    return {
      text: buffer.subarray(0, length).toString('utf8'),
      nextOffset: offset + length,
      totalBytes: size,
    };
  } finally {
    fs.closeSync(fd);
  }
}
