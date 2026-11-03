import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { runWorker } from '../server/worker.mjs';
import { createLogWriter } from '../server/lib/logs.mjs';

const exec = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-api-test-'));
  const config = getConfig({
    dataDir: path.join(root, 'data'),
    runnerMode: 'host',
    allowHostRunner: true,
    allowLocalRepositories: true,
    setupToken: 'test-bootstrap-token',
  });
  const app = await createApp(config);
  let cookie = '';
  const request = async (method, url, body, extraHeaders = {}) => {
    const result = await app.inject({
      method,
      url,
      payload: body,
      headers: { ...(cookie ? { cookie } : {}), ...extraHeaders },
    });
    const setCookie = result.headers['set-cookie'];
    if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    return {
      code: result.statusCode,
      body: result.headers['content-type']?.includes('application/json')
        ? result.json()
        : result.body,
      headers: result.headers,
    };
  };
  const setup = () =>
    request('POST', '/api/auth/setup', {
      username: 'admin',
      password: 'long-test-password-123',
      setupToken: config.setupToken,
    });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, config, app, request, setup };
}

async function repository(root) {
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const pkg = {
    name: 'flow-integration-fixture',
    version: '1.0.0',
    private: true,
    scripts: { build: 'node build.mjs' },
  };
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(
    path.join(repo, 'package-lock.json'),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: pkg.name, version: pkg.version } },
    }),
  );
  await fs.writeFile(path.join(repo, 'version.txt'), 'version-one');
  await fs.writeFile(
    path.join(repo, 'build.mjs'),
    `
import fs from 'node:fs';
if (process.env.FAIL_BUILD === 'yes') { console.error('fixture failure'); process.exit(3); }
if (process.env.SECRET_VALUE) { process.stdout.write(process.env.SECRET_VALUE.slice(0,5)); await new Promise(r=>setTimeout(r,20)); console.log(process.env.SECRET_VALUE.slice(5)); }
if (process.env.SLOW_BUILD === 'yes') await new Promise(r=>setTimeout(r,30000));
fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('dist/index.html', '<!doctype html><title>Fixture</title>'+fs.readFileSync('version.txt','utf8'));
`,
  );
  await exec('git', ['init', '-b', 'main'], { cwd: repo });
  await exec(
    'git',
    ['-c', 'user.name=Flow Test', '-c', 'user.email=test@example.invalid', 'add', '.'],
    { cwd: repo },
  );
  await exec(
    'git',
    ['-c', 'user.name=Flow Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'first'],
    { cwd: repo },
  );
  return repo;
}
const model = (repo, site, extra = {}) => ({
  name: '测试前端',
  group: '测试',
  repoUrl: repo,
  branch: 'main',
  nodeVersion: process.versions.node,
  packageManager: 'npm',
  installCommand: 'npm ci --no-audit --no-fund',
  buildCommand: 'npm run build',
  workdir: '.',
  artifactDir: 'dist',
  timeoutSeconds: 30,
  retainReleases: 2,
  deploy: { type: 'local', root: site },
  environment: {},
  ...extra,
});

test('管理员初始化、认证、同源校验及密码更换', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/api/projects')).code, 401);
  assert.equal(
    (
      await f.request('POST', '/api/auth/setup', {
        username: 'admin',
        password: 'long-test-password-123',
        setupToken: 'wrong',
      })
    ).code,
    403,
  );
  assert.equal((await f.setup()).code, 200);
  assert.equal((await f.request('POST', '/api/auth/setup', {})).code, 409);
  assert.equal((await f.request('GET', '/api/auth/status')).body.authenticated, true);
  assert.equal(
    (await f.request('POST', '/api/projects', {}, { origin: 'https://attacker.invalid' })).code,
    403,
  );
  assert.equal(
    (
      await f.request('POST', '/api/auth/password', {
        currentPassword: 'wrong',
        newPassword: 'another-long-password',
      })
    ).code,
    400,
  );
  assert.equal(
    (
      await f.request('POST', '/api/auth/password', {
        currentPassword: 'long-test-password-123',
        newPassword: 'another-long-password',
      })
    ).code,
    200,
  );
  assert.equal((await f.request('POST', '/api/auth/logout', {})).code, 200);
  assert.equal((await f.request('GET', '/api/projects')).code, 401);
  assert.equal(
    (
      await f.request('POST', '/api/auth/login', {
        username: 'admin',
        password: 'long-test-password-123',
      })
    ).code,
    401,
  );
  assert.equal(
    (
      await f.request('POST', '/api/auth/login', {
        username: 'admin',
        password: 'another-long-password',
      })
    ).code,
    200,
  );
});

test('项目校验、凭据加密及被引用凭据保护', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const repo = await repository(f.root);
  const base = model(repo, path.join(f.root, 'site'));
  for (const invalid of [
    { nodeVersion: '24;echo hacked' },
    { workdir: '../../' },
    { artifactDir: '/etc' },
    { deploy: { type: 'local', root: '/' } },
    { environment: { PATH: '/tmp' } },
    { repoUrl: 'https://token:password@example.com/repo.git' },
  ]) {
    assert.equal((await f.request('POST', '/api/projects', { ...base, ...invalid })).code, 400);
  }
  const key =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nconfidential-test-key-body\n-----END OPENSSH PRIVATE KEY-----\n';
  const result = await f.request('POST', '/api/credentials', {
    name: '部署凭据',
    type: 'ssh',
    privateKey: key,
  });
  assert.equal(result.code, 201);
  assert.equal(JSON.stringify(result.body).includes('confidential'), false);
  const project = (
    await f.request('POST', '/api/projects', {
      ...base,
      buildCredentialId: result.body.credential.id,
      environment: { API_SECRET: 'another-secret-value' },
    })
  ).body.project;
  assert.equal(
    (await f.request('DELETE', `/api/credentials/${result.body.credential.id}`)).code,
    409,
  );
  const raw = f.app.store.db
    .prepare('SELECT config FROM projects WHERE id=?')
    .get(project.id).config;
  assert.equal(raw.includes('another-secret-value'), false);
  const secret = f.app.store.db
    .prepare('SELECT secret FROM credentials WHERE id=?')
    .get(result.body.credential.id).secret;
  assert.equal(secret.includes('confidential'), false);
  assert.equal((await f.request('DELETE', `/api/projects/${project.id}`)).code, 200);
  assert.equal(
    (await f.request('DELETE', `/api/credentials/${result.body.credential.id}`)).code,
    200,
  );
});

test('真实构建、实时日志、第二次发布、精确提交重试、回滚及留存', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const repo = await repository(f.root);
  const site = path.join(f.root, 'site');
  const configuration = model(repo, site, {
    environment: { SECRET_VALUE: 'never-show-this-secret' },
  });
  const created = await f.request('POST', '/api/projects', configuration);
  assert.equal(created.code, 201);
  const id = created.body.project.id;
  async function run() {
    const result = await f.request('POST', `/api/projects/${id}/runs`, {});
    assert.equal(result.code, 202);
    await runWorker(f.config, { once: true });
    return (await f.request('GET', `/api/runs/${result.body.run.id}`)).body.run;
  }
  const first = await run();
  assert.equal(first.status, 'success', first.error);
  assert.equal(first.nodeVersion, process.versions.node);
  assert.equal(first.artifactAvailable, true);
  assert.match(await fs.readFile(path.join(site, 'current/index.html'), 'utf8'), /version-one/);
  const logs = (await f.request('GET', `/api/runs/${first.id}/logs`)).body;
  assert.equal(logs.text.includes('never-show-this-secret'), false);
  assert.match(logs.text, /REDACTED/);
  const events = await f.request('GET', `/api/runs/${first.id}/events`);
  assert.match(events.body, /event: log/);
  assert.match(events.body, /event: end/);
  await fs.writeFile(path.join(repo, 'version.txt'), 'version-two');
  await exec(
    'git',
    [
      '-c',
      'user.name=Flow Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-am',
      'second',
    ],
    { cwd: repo },
  );
  const second = await run();
  assert.equal(second.status, 'success', second.error);
  assert.notEqual(second.commitSha, first.commitSha);
  assert.match(await fs.readFile(path.join(site, 'current/index.html'), 'utf8'), /version-two/);
  const retried = (await f.request('POST', `/api/runs/${first.id}/retry`, {})).body.run;
  await runWorker(f.config, { once: true });
  const repeated = (await f.request('GET', `/api/runs/${retried.id}`)).body.run;
  assert.equal(repeated.status, 'success', repeated.error);
  assert.equal(repeated.commitSha, first.commitSha);
  assert.match(await fs.readFile(path.join(site, 'current/index.html'), 'utf8'), /version-one/);
  const rollback = await f.request('POST', `/api/projects/${id}/rollback`, {
    releaseId: second.id,
  });
  assert.equal(rollback.code, 202);
  await runWorker(f.config, { once: true });
  assert.equal(
    (await f.request('GET', `/api/runs/${rollback.body.run.id}`)).body.run.status,
    'success',
  );
  assert.match(await fs.readFile(path.join(site, 'current/index.html'), 'utf8'), /version-two/);
  assert.equal(
    (await f.request('GET', `/api/projects/${id}`)).body.project.currentReleaseId,
    second.id,
  );
  // The first artifact fell outside the two retained builds; its run record remains.
  assert.equal((await f.request('GET', `/api/runs/${first.id}`)).body.run.artifactAvailable, false);
  assert.equal(
    (await f.request('POST', `/api/projects/${id}/rollback`, { releaseId: first.id })).code,
    400,
  );
  await f.request('PUT', `/api/projects/${id}`, {
    ...configuration,
    deploy: { type: 'local', root: path.join(f.root, 'other-site') },
  });
  assert.equal(
    (await f.request('POST', `/api/projects/${id}/rollback`, { releaseId: second.id })).code,
    400,
  );
});

test('失败构建保留当前版本、取消排队及取消运行中的任务', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const repo = await repository(f.root);
  const site = path.join(f.root, 'site');
  const base = model(repo, site);
  const id = (await f.request('POST', '/api/projects', base)).body.project.id;
  const enqueue = async () => (await f.request('POST', `/api/projects/${id}/runs`, {})).body.run;
  const first = await enqueue();
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(first.id).status, 'success');
  await f.request('PUT', `/api/projects/${id}`, { ...base, environment: { FAIL_BUILD: 'yes' } });
  const failed = await enqueue();
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(failed.id).status, 'failed');
  assert.equal(
    (await f.request('GET', `/api/projects/${id}`)).body.project.currentReleaseId,
    first.id,
  );
  assert.match(await fs.readFile(path.join(site, 'current/index.html'), 'utf8'), /version-one/);
  const queued = await enqueue();
  assert.equal((await f.request('DELETE', `/api/projects/${id}`)).code, 409);
  assert.equal(
    (await f.request('POST', `/api/runs/${queued.id}/cancel`, {})).body.run.status,
    'cancelled',
  );
  await f.request('PUT', `/api/projects/${id}`, { ...base, environment: { SLOW_BUILD: 'yes' } });
  const slow = await enqueue();
  const work = runWorker(f.config, { once: true });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (f.app.store.getRun(slow.id).stage === 'build') {
      ready = true;
      break;
    }
    await delay(50);
  }
  assert.equal(ready, true, 'build should start');
  assert.equal((await f.request('POST', `/api/runs/${slow.id}/cancel`, {})).code, 200);
  await work;
  assert.equal(f.app.store.getRun(slow.id).status, 'cancelled');
  assert.equal(f.app.store.getProject(id).currentReleaseId, first.id);
});

test('队列独占、重启恢复及配置快照', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const repo = await repository(f.root);
  const base = model(repo, path.join(f.root, 'site'));
  const id = (await f.request('POST', '/api/projects', base)).body.project.id;
  const run = (await f.request('POST', `/api/projects/${id}/runs`, {})).body.run;
  await f.request('PUT', `/api/projects/${id}`, { ...base, name: '改名', buildCommand: 'exit 1' });
  assert.equal(f.app.store.getRun(run.id).projectSnapshot.name, '测试前端');
  assert.equal(f.app.store.acquireWorker('first-worker'), true);
  assert.equal(f.app.store.acquireWorker('second-worker'), false);
  assert.equal(f.app.store.claimNextRun('second-worker'), null);
  assert.equal(f.app.store.claimNextRun('first-worker').id, run.id);
  const abandonedArtifact = path.join(f.config.dataDir, 'artifacts', id, run.id);
  await fs.mkdir(abandonedArtifact, { recursive: true });
  await fs.writeFile(path.join(abandonedArtifact, 'index.html'), 'interrupted archive');
  f.app.store.releaseWorker('first-worker');
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(run.id).status, 'failed');
  assert.match(f.app.store.getRun(run.id).error, /中断/);
  await assert.rejects(fs.stat(abandonedArtifact), { code: 'ENOENT' });
});

test('分块日志脱敏与日志大小限制', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-log-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'log');
  const logger = createLogWriter(filename, ['private-token-value'], 500);
  logger.write('hello private-to');
  logger.write('ken-value world\n');
  logger.close();
  const text = await fs.readFile(filename, 'utf8');
  assert.equal(text, 'hello [REDACTED] world\n');
  const ansi = createLogWriter(path.join(root, 'ansi'), ['ABC']);
  ansi.write('A\x1b[3');
  ansi.write('1mBC\n');
  ansi.close();
  assert.equal(await fs.readFile(path.join(root, 'ansi'), 'utf8'), '[REDACTED]\n');
  const live = createLogWriter(path.join(root, 'live'), ['x'.repeat(2000)]);
  live.write('开始构建\n');
  assert.equal(await fs.readFile(path.join(root, 'live'), 'utf8'), '开始构建\n');
  live.close();
  const limited = createLogWriter(path.join(root, 'limited'), [], 100);
  limited.write('x'.repeat(200));
  limited.close();
  assert.match(await fs.readFile(path.join(root, 'limited'), 'utf8'), /上限/);
});

test('Docker 未就绪时执行器保持在线、任务保持排队且可以正常关闭', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const repo = await repository(f.root);
  const id = (await f.request('POST', '/api/projects', model(repo, path.join(f.root, 'site')))).body
    .project.id;
  const run = (await f.request('POST', `/api/projects/${id}/runs`, {})).body.run;
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + originalPath;
  const controller = new AbortController();
  const work = runWorker({ ...f.config, runnerMode: 'docker' }, { signal: controller.signal });
  try {
    await delay(300);
    assert.equal(f.app.store.getRun(run.id).status, 'queued');
    assert.ok(f.app.store.setting('worker')?.lastSeen);
  } finally {
    controller.abort();
    await work;
    process.env.PATH = originalPath;
  }
  assert.equal(f.app.store.setting('worker'), null);
});

test('归档后部署失败会清理本地产物，并保留目标已有的 current 文件', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const repo = await repository(f.root);
  const site = path.join(f.root, 'blocked-site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'current'), 'user-owned-file');
  const id = (await f.request('POST', '/api/projects', model(repo, site))).body.project.id;
  const run = (await f.request('POST', `/api/projects/${id}/runs`, {})).body.run;
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(run.id).status, 'failed');
  await assert.rejects(fs.stat(path.join(f.config.dataDir, 'artifacts', id, run.id)), {
    code: 'ENOENT',
  });
  assert.equal(await fs.readFile(path.join(site, 'current'), 'utf8'), 'user-owned-file');
});
