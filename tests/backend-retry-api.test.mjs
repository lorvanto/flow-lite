import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-backend-retry-api-'));
  const config = getConfig({
    dataDir: path.join(root, 'data'),
    setupToken: 'synthetic-backend-retry-setup',
  });
  const app = await createApp(config);
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  let cookie;
  const request = async (method, url, payload) => {
    const result = await app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
    if (result.headers['set-cookie']) cookie = String(result.headers['set-cookie']).split(';')[0];
    return { status: result.statusCode, body: result.json() };
  };
  assert.equal(
    (
      await request('POST', '/api/auth/setup', {
        username: 'admin',
        password: 'synthetic-retry-password',
        setupToken: config.setupToken,
      })
    ).status,
    200,
  );
  const git = (
    await request('POST', '/api/credentials', {
      name: 'synthetic-git',
      type: 'git-https',
      authType: 'password',
      username: 'fixture',
      password: 'synthetic-git-password',
    })
  ).body.credential;
  const ssh = (
    await request('POST', '/api/credentials', {
      name: 'synthetic-ssh',
      type: 'ssh',
      authType: 'password',
      password: 'synthetic-ssh-password',
    })
  ).body.credential;
  const model = (enabled = false, target = false) => ({
    type: 'node',
    buildMode: 'multi',
    name: 'coffee',
    environment: { SYNTHETIC_PRIVATE_ENV: 'unchanged' },
    sources: [
      {
        id: 'official',
        name: 'official',
        repoUrl: 'http://git.yin-duo.com/mini-program/coffee.git',
        branch: 'main',
        buildCredentialId: git.id,
      },
    ],
    tasks: ['h5', 'admin'].map((id) => ({
      id,
      name: id,
      sourceId: 'official',
      workdir: id === 'h5' ? 'mobile' : 'admin',
      publishDir: id,
      nodeVersion: '22.18.0',
      packageManager: 'npm',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      artifactDir: 'dist',
      environment: {},
      ...(target ? { targetVueMajor: 3 } : {}),
    })),
    ...(enabled
      ? {
          backend: {
            enabled: true,
            type: 'php',
            sourceId: 'official',
            workdir: 'api',
            phpVersion: '8.5',
            application: 'coffee',
          },
        }
      : {}),
    deploy: {
      type: 'ssh',
      host: '47.118.69.157',
      port: 22,
      user: 'root',
      root: '/data/httpd/www/demo.yunyingbao.net/frontend-deploy/coffee',
      credentialId: ssh.id,
    },
  });
  const create = async (input) => {
    const result = await request('POST', '/api/projects', input);
    assert.equal(result.status, 201);
    return result.body.project;
  };
  const historical = (project) => {
    const run = app.store.enqueue(project);
    return app.store.updateRun(run.id, {
      status: 'success',
      stage: 'done',
      commitSha: 'a'.repeat(40),
      buildDetails: {
        sources: [
          {
            id: 'official',
            name: 'official',
            branch: 'main',
            commitSha: 'a'.repeat(40),
            status: 'success',
          },
        ],
        tasks: project.tasks.map(({ id, name, sourceId, publishDir }) => ({
          id,
          name,
          sourceId,
          publishDir,
          status: 'success',
          stage: 'done',
        })),
      },
    });
  };
  const encryptedSnapshot = (run) =>
    app.store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(run.id).snapshot;
  return { app, request, model, create, historical, encryptedSnapshot };
}

test('enabling or disabling backend blocks old-history retry without changing its snapshot or adding a run', async (t) => {
  for (const enabled of [false, true]) {
    const f = await fixture(t);
    const project = await f.create(f.model(enabled));
    const run = f.historical(project);
    const encrypted = f.encryptedSnapshot(run);
    const next = f.model(!enabled);
    if (!next.backend) next.backend = { enabled: false };
    assert.equal((await f.request('PUT', `/api/projects/${project.id}`, next)).status, 200);
    const count = f.app.store.listRuns(project.id).length;
    const response = await f.request('POST', `/api/runs/${run.id}/retry`);
    assert.equal(response.status, 409);
    assert.match(response.body.error, /API 发布配置已变更/);
    assert.equal(f.app.store.listRuns(project.id).length, count);
    assert.equal(f.encryptedSnapshot(run), encrypted);
  }
});

test('new Vue3 requirement blocks prior non-Vue3 task snapshots before enqueue', async (t) => {
  const f = await fixture(t);
  const project = await f.create(f.model(true, false));
  const run = f.historical(project);
  const encrypted = f.encryptedSnapshot(run);
  assert.equal(
    (await f.request('PUT', `/api/projects/${project.id}`, f.model(true, true))).status,
    200,
  );
  const response = await f.request('POST', `/api/runs/${run.id}/retry`);
  assert.equal(response.status, 409);
  assert.match(response.body.error, /Vue 3 构建目标已变更/);
  assert.equal(f.encryptedSnapshot(run), encrypted);
  assert.equal(f.app.store.listRuns(project.id).length, 1);
});

test('backend schema difference or unknown backend fields in historical snapshots cannot be retried', async (t) => {
  const f = await fixture(t);
  const project = await f.create(f.model(true, true));
  for (const mutation of [
    (backend) => {
      backend.phpVersion = '8.2';
    },
    (backend) => {
      backend.root = '/unexpected';
    },
    (backend) => {
      backend.sourceId = 'other';
    },
  ]) {
    const snapshot = structuredClone(project);
    mutation(snapshot.backend);
    const run = f.historical(snapshot);
    const before = f.encryptedSnapshot(run);
    const count = f.app.store.listRuns(project.id).length;
    assert.equal((await f.request('POST', `/api/runs/${run.id}/retry`)).status, 409);
    assert.equal(f.app.store.listRuns(project.id).length, count);
    assert.equal(f.encryptedSnapshot(run), before);
  }
});

test('same unified configuration retries with its original commit and immutable source snapshot', async (t) => {
  const f = await fixture(t);
  const project = await f.create(f.model(true, true));
  const source = f.historical(project);
  const before = f.encryptedSnapshot(source);
  const response = await f.request('POST', `/api/runs/${source.id}/retry`);
  assert.equal(response.status, 202);
  const retry = f.app.store.getRun(response.body.run.id);
  assert.equal(retry.status, 'queued');
  assert.equal(retry.commitSha, source.commitSha);
  assert.deepEqual(retry.projectSnapshot, source.projectSnapshot);
  assert.equal(retry.buildDetails.sources[0].commitSha, source.commitSha);
  assert.ok(retry.buildDetails.tasks.every((task) => task.status === 'waiting'));
  assert.equal(f.encryptedSnapshot(source), before);
});

test('legacy projects without backend or Vue3 target retain their historical retry behavior', async (t) => {
  const f = await fixture(t);
  const project = await f.create(f.model());
  const source = f.historical(project);
  assert.equal(
    (
      await f.request('PUT', `/api/projects/${project.id}`, {
        ...f.model(),
        name: 'renamed legacy project',
      })
    ).status,
    200,
  );
  const response = await f.request('POST', `/api/runs/${source.id}/retry`);
  assert.equal(response.status, 202);
  assert.equal(response.body.run.commitSha, source.commitSha);
  assert.equal(f.app.store.getRun(response.body.run.id).projectSnapshot.backend, undefined);
});
