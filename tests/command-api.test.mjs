import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { runWorker } from '../server/worker.mjs';

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-command-api-'));
  const target = path.join(root, 'existing-project');
  await fs.mkdir(target);
  const config = getConfig({
    dataDir: path.join(root, 'data'),
    runnerMode: 'docker',
    allowHostRunner: false,
    allowLocalRepositories: false,
    setupToken: 'command-fixture-setup',
  });
  const app = await createApp(config);
  let cookie;
  const request = async (method, url, payload) => {
    const response = await app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
    const setCookie = response.headers['set-cookie'];
    if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    return {
      code: response.statusCode,
      body: response.headers['content-type']?.includes('application/json')
        ? response.json()
        : response.body,
    };
  };
  assert.equal(
    (
      await request('POST', '/api/auth/setup', {
        username: 'admin',
        password: 'command-test-password',
        setupToken: config.setupToken,
      })
    ).code,
    200,
  );
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = async (extra = {}) => {
    const model = {
      type: 'command',
      name: '命令测试',
      commands: 'printf "completed\\n"',
      deploy: { type: 'local', root: target },
      environment: {},
      timeoutSeconds: 30,
      ...extra,
    };
    const response = await request('POST', '/api/projects', model);
    assert.equal(response.code, 201, JSON.stringify(response.body));
    return { project: response.body.project, model };
  };
  const enqueue = async (project) => {
    const response = await request('POST', `/api/projects/${project.id}/runs`, {});
    assert.equal(response.code, 202, JSON.stringify(response.body));
    return response.body.run;
  };
  return { root, target, config, app, request, create, enqueue };
}

async function dockerUnavailable(t, f) {
  const directory = path.join(f.root, 'mock-bin');
  const calls = path.join(f.root, 'docker-calls');
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(calls)}\nprintf 'fixture Docker is unavailable\\n' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previousPath || '/usr/bin:/bin'}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  return calls;
}

test('命令API不要求Node字段，公开运行类型且拒绝空命令和无效类型', async (t) => {
  const f = await fixture(t);
  const { project, model } = await f.create();
  assert.equal(project.type, 'command');
  for (const key of ['repoUrl', 'nodeVersion', 'installCommand', 'buildCommand', 'artifactDir'])
    assert.equal(project[key], undefined);
  const run = await f.enqueue(project);
  assert.equal(run.kind, 'command');
  assert.equal(run.projectType, 'command');
  assert.equal(run.artifactAvailable, false);
  assert.equal(
    (await f.request('GET', `/api/projects/${project.id}`)).body.project.latestRun.projectType,
    'command',
  );
  assert.equal(
    (await f.request('POST', '/api/projects', { ...model, commands: ' \n ' })).code,
    400,
  );
  assert.equal((await f.request('POST', '/api/projects', { ...model, type: 'unknown' })).code, 400);
  assert.equal(
    (
      await f.request('POST', '/api/projects', {
        ...model,
        environment: { NODE_OPTIONS: '--require ./hook.js' },
      })
    ).code,
    400,
  );
  assert.equal(
    (await f.request('POST', '/api/projects', { ...model, commands: '注'.repeat(35000) })).code,
    400,
  );
});

test('命令在现有目录真实写删文件，env脱敏且不创建产物或可回滚版本', async (t) => {
  const f = await fixture(t);
  await dockerUnavailable(t, f);
  await fs.writeFile(path.join(f.target, 'delete-me'), 'fixture');
  const secret = 'command-secret-do-not-log';
  const { project } = await f.create({
    environment: { COMMAND_TEST_SECRET: secret },
    commands:
      'printf "%s\\n" "$COMMAND_TEST_SECRET" > result.txt\nrm -- delete-me\nprintf "%s\\n" "$COMMAND_TEST_SECRET"\nprintf "finished\\n"',
  });
  const run = await f.enqueue(project);
  await runWorker(f.config, { once: true });
  const result = (await f.request('GET', `/api/runs/${run.id}`)).body.run;
  assert.equal(result.status, 'success', result.error);
  assert.equal(result.kind, 'command');
  assert.equal(result.projectType, 'command');
  assert.equal(result.stage, 'done');
  assert.equal(result.artifactAvailable, false);
  assert.equal(result.commitSha, null);
  assert.equal(result.nodeVersion, null);
  assert.equal(await fs.readFile(path.join(f.target, 'result.txt'), 'utf8'), `${secret}\n`);
  await assert.rejects(fs.stat(path.join(f.target, 'delete-me')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.target, 'current')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.target, 'releases')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.config.dataDir, 'artifacts', project.id)), {
    code: 'ENOENT',
  });
  assert.equal(f.app.store.getProject(project.id).currentReleaseId, null);
  const logs = (await f.request('GET', `/api/runs/${run.id}/logs`)).body.text;
  assert.equal(logs.includes(secret), false);
  assert.match(logs, /REDACTED/);
  assert.match(logs, /finished/);
  assert.match(logs, /prepare/);
  assert.match(logs, /commands/);
  const events = await f.request('GET', `/api/runs/${run.id}/events`);
  assert.match(events.body, /event: end/);
  assert.equal(events.body.includes(secret), false);
  assert.equal(
    (await f.request('POST', `/api/projects/${project.id}/rollback`, { releaseId: run.id })).code,
    400,
  );
  const storedProject = f.app.store.db
    .prepare('SELECT config FROM projects WHERE id=?')
    .get(project.id).config;
  const snapshot = f.app.store.db
    .prepare('SELECT snapshot FROM runs WHERE id=?')
    .get(run.id).snapshot;
  assert.equal(storedProject.includes(secret), false);
  assert.equal(snapshot.includes(secret), false);
  assert.equal(f.app.store.getRun(run.id).artifactPath, null);
});

test('重新运行沿用原命令配置但读取执行时目标状态，不假定固定commit', async (t) => {
  const f = await fixture(t);
  await dockerUnavailable(t, f);
  await fs.writeFile(path.join(f.target, 'input.txt'), 'version-one\n');
  const { project, model } = await f.create({ commands: 'cat input.txt >> observed.txt' });
  const first = await f.enqueue(project);
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(first.id).status, 'success');
  await fs.writeFile(path.join(f.target, 'input.txt'), 'version-two\n');
  assert.equal(
    (
      await f.request('PUT', `/api/projects/${project.id}`, {
        ...model,
        commands: 'printf "wrong\\n" >> observed.txt',
      })
    ).code,
    200,
  );
  const retry = await f.request('POST', `/api/runs/${first.id}/retry`, {});
  assert.equal(retry.code, 202);
  assert.equal(retry.body.run.kind, 'command');
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(retry.body.run.id).status, 'success');
  assert.equal(
    await fs.readFile(path.join(f.target, 'observed.txt'), 'utf8'),
    'version-one\nversion-two\n',
  );
  assert.equal(f.app.store.getRun(retry.body.run.id).commitSha, null);
});

test('命令失败即停，取消运行不会撤销已完成的文件操作', async (t) => {
  const f = await fixture(t);
  await dockerUnavailable(t, f);
  const { project, model } = await f.create({
    commands: 'printf "before\\n" > before.txt\nfalse\nprintf "after\\n" > after.txt',
  });
  const failed = await f.enqueue(project);
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(failed.id).status, 'failed');
  assert.equal(await fs.readFile(path.join(f.target, 'before.txt'), 'utf8'), 'before\n');
  await assert.rejects(fs.stat(path.join(f.target, 'after.txt')), { code: 'ENOENT' });
  await f.request('PUT', `/api/projects/${project.id}`, {
    ...model,
    commands: 'printf "started\\n" > started.txt\nsleep 30\nprintf "done\\n" > done.txt',
  });
  const slow = await f.enqueue(project);
  const controller = new AbortController();
  const work = runWorker(f.config, { once: true, signal: controller.signal });
  try {
    let started = false;
    for (let n = 0; n < 100; n++) {
      if (
        await fs.stat(path.join(f.target, 'started.txt')).then(
          () => true,
          () => false,
        )
      ) {
        started = true;
        break;
      }
      await delay(25);
    }
    assert.equal(started, true, 'command should begin executing');
    assert.equal((await f.request('POST', `/api/runs/${slow.id}/cancel`, {})).code, 200);
    await work;
    assert.equal(f.app.store.getRun(slow.id).status, 'cancelled');
    assert.equal(await fs.readFile(path.join(f.target, 'started.txt'), 'utf8'), 'started\n');
    await assert.rejects(fs.stat(path.join(f.target, 'done.txt')), { code: 'ENOENT' });
  } finally {
    controller.abort();
    await work;
  }
});

test('重启恢复中断命令记录但不自动重新执行，后续队列可继续执行', async (t) => {
  const f = await fixture(t);
  await dockerUnavailable(t, f);
  const { project } = await f.create({ commands: 'printf "executed\\n" >> counter.txt' });
  const interrupted = await f.enqueue(project);
  assert.equal(f.app.store.acquireWorker('previous-worker'), true);
  assert.equal(f.app.store.claimNextRun('previous-worker').id, interrupted.id);
  f.app.store.releaseWorker('previous-worker');
  const next = await f.enqueue(project);
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(interrupted.id).status, 'failed');
  assert.match(f.app.store.getRun(interrupted.id).error, /中断/);
  assert.equal(f.app.store.getRun(next.id).status, 'success');
  assert.equal(await fs.readFile(path.join(f.target, 'counter.txt'), 'utf8'), 'executed\n');
});

test('旧Node项目缺省type兼容，Docker不可用时保留较早Node任务并执行命令', async (t) => {
  const f = await fixture(t);
  await dockerUnavailable(t, f);
  const response = await f.request('POST', '/api/projects', {
    name: 'Legacy Node',
    repoUrl: 'https://example.invalid/frontend.git',
    deploy: { type: 'local', root: path.join(f.root, 'static-site') },
  });
  assert.equal(response.code, 201);
  assert.equal(response.body.project.type, 'node');
  const { type, id, ...legacy } = response.body.project;
  delete legacy.latestRun;
  f.app.store.saveProject(legacy, id);
  assert.equal((await f.request('GET', `/api/projects/${id}`)).body.project.type, 'node');
  const nodeRun = await f.enqueue({ id });
  assert.equal(nodeRun.kind, 'build');
  assert.equal(nodeRun.projectType, 'node');
  const { project } = await f.create({
    commands: 'printf "works without Docker\\n" > without-docker.txt',
  });
  const commandRun = await f.enqueue(project);
  await runWorker(f.config, { once: true });
  assert.equal(f.app.store.getRun(commandRun.id).status, 'success');
  assert.equal(f.app.store.getRun(nodeRun.id).status, 'queued');
  assert.equal(
    await fs.readFile(path.join(f.target, 'without-docker.txt'), 'utf8'),
    'works without Docker\n',
  );
});

test('项目类型切换保护活动任务、清空旧版本，并拒绝跨类型历史重试和命令回滚', async (t) => {
  const f = await fixture(t);
  const nodeModel = {
    type: 'node',
    name: '切换类型',
    repoUrl: 'https://example.invalid/frontend.git',
    deploy: { type: 'local', root: f.target },
  };
  const response = await f.request('POST', '/api/projects', nodeModel);
  assert.equal(response.code, 201);
  const project = response.body.project;
  const endpoint = `/api/projects/${project.id}`;
  const nodeRun = await f.enqueue(project);
  const commandModel = {
    type: 'command',
    name: '切换类型',
    commands: 'printf "command\\n"',
    deploy: nodeModel.deploy,
  };
  assert.equal((await f.request('PUT', endpoint, commandModel)).code, 409);
  f.app.store.updateRun(nodeRun.id, { status: 'success' });
  f.app.store.setCurrentRelease(project.id, nodeRun.id);
  const switched = await f.request('PUT', endpoint, commandModel);
  assert.equal(switched.code, 200);
  assert.equal(switched.body.project.currentReleaseId, null);
  assert.equal((await f.request('POST', `/api/runs/${nodeRun.id}/retry`, {})).code, 409);
  assert.equal(
    (await f.request('POST', `${endpoint}/rollback`, { releaseId: nodeRun.id })).code,
    400,
  );
  const commandRun = await f.enqueue(project);
  assert.equal(commandRun.kind, 'command');
  assert.equal((await f.request('PUT', endpoint, nodeModel)).code, 409);
  assert.equal((await f.request('POST', `/api/runs/${commandRun.id}/cancel`, {})).code, 200);
  assert.equal((await f.request('PUT', endpoint, nodeModel)).code, 200);
  assert.equal((await f.request('POST', `/api/runs/${commandRun.id}/retry`, {})).code, 409);
});
