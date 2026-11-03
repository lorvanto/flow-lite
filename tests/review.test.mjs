import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { validateProject } from '../server/lib/validation.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-review-test-'));
  const config = getConfig({ dataDir: path.join(root, 'data'), setupToken: 'review-setup-token' });
  const app = await createApp(config);
  let cookie;
  const request = async (method, url, payload, options = {}) => {
    const result = await app.inject({
      method,
      url,
      payload,
      ...options,
      headers: { ...(cookie ? { cookie } : {}), ...options.headers },
    });
    const setCookie = result.headers['set-cookie'];
    if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    return { code: result.statusCode, body: result.json() };
  };
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(
    (
      await request('POST', '/api/auth/setup', {
        username: 'admin',
        password: 'review-password-123',
        setupToken: config.setupToken,
      })
    ).code,
    200,
  );
  const model = {
    name: 'Review project',
    repoUrl: 'https://example.invalid/frontend.git',
    deploy: { type: 'local', root: path.join(root, 'site-a') },
  };
  const project = (await request('POST', '/api/projects', model)).body.project;
  return { root, config, app, request, model, project };
}

test('发布目标在排队和执行时保持不变，完成后更改会清空当前版本并禁止旧目标重试', async (t) => {
  const f = await fixture(t);
  const endpoint = `/api/projects/${f.project.id}`;
  const run = (await f.request('POST', `${endpoint}/runs`, {})).body.run;
  const moved = { ...f.model, deploy: { type: 'local', root: path.join(f.root, 'site-b') } };
  assert.equal((await f.request('PUT', endpoint, moved)).code, 409);
  assert.equal(f.app.store.getProject(f.project.id).deploy.root, f.model.deploy.root);
  assert.equal((await f.request('PUT', endpoint, { ...f.model, name: 'Renamed' })).code, 200);
  f.app.store.acquireWorker('review-worker');
  f.app.store.claimNextRun('review-worker');
  assert.equal((await f.request('PUT', endpoint, moved)).code, 409);
  f.app.store.updateRun(run.id, { status: 'success' });
  f.app.store.setCurrentRelease(f.project.id, run.id);
  assert.equal((await f.request('PUT', endpoint, moved)).body.project.currentReleaseId, null);
  assert.equal((await f.request('POST', `/api/runs/${run.id}/retry`, {})).code, 409);
  assert.equal((await f.request('POST', `${endpoint}/runs`, {})).code, 202);
});

test('取消事务读取最新状态，任务被worker接手后只设置取消标志', async (t) => {
  const f = await fixture(t);
  const run = (await f.request('POST', `/api/projects/${f.project.id}/runs`, {})).body.run;
  f.app.store.acquireWorker('review-worker');
  const original = f.app.store.getRun;
  let claimed = false;
  f.app.store.getRun = (id) => {
    const snapshot = original(id);
    if (!claimed && id === run.id) {
      claimed = true;
      f.app.store.claimNextRun('review-worker');
    }
    return snapshot;
  };
  const cancelled = await f.request('POST', `/api/runs/${run.id}/cancel`, {});
  assert.equal(cancelled.code, 200);
  assert.equal(cancelled.body.run.status, 'running');
  assert.equal(cancelled.body.run.cancelRequested, true);
  assert.equal(f.app.store.hasActiveRuns(f.project.id), true);
  assert.equal((await f.request('DELETE', `/api/projects/${f.project.id}`)).code, 409);
  f.app.store.updateRun(run.id, { status: 'cancelled' });
  assert.equal((await f.request('POST', `/api/runs/${run.id}/cancel`, {})).code, 409);
});

test('loopback代理按真实客户端独立限流，外部直连不能伪造代理头绕过限流', async (t) => {
  const f = await fixture(t);
  const wrong = { username: 'admin', password: 'wrong-password' };
  const valid = { username: 'admin', password: 'review-password-123' };
  const forwarded = (ip) => ({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ip } });
  for (let n = 0; n < 10; n++)
    assert.equal(
      (await f.request('POST', '/api/auth/login', wrong, forwarded('198.51.100.1'))).code,
      401,
    );
  assert.equal(
    (await f.request('POST', '/api/auth/login', valid, forwarded('198.51.100.1'))).code,
    429,
  );
  assert.equal(
    (await f.request('POST', '/api/auth/login', valid, forwarded('198.51.100.2'))).code,
    200,
  );
  for (let n = 0; n < 10; n++) {
    assert.equal(
      (
        await f.request('POST', '/api/auth/login', wrong, {
          remoteAddress: '203.0.113.5',
          headers: { 'x-forwarded-for': `198.51.100.${n + 10}` },
        })
      ).code,
      401,
    );
  }
  assert.equal(
    (
      await f.request('POST', '/api/auth/login', valid, {
        remoteAddress: '203.0.113.5',
        headers: { 'x-forwarded-for': '192.0.2.99' },
      })
    ).code,
    429,
  );
});

test('保存配置时拒绝多行环境变量和过早Node版本，Yarn默认命令兼容classic', async (t) => {
  const f = await fixture(t);
  for (const value of ['line1\nline2', 'line1\rline2', 'line1\0line2']) {
    assert.equal(
      (
        await f.request('PUT', `/api/projects/${f.project.id}`, {
          ...f.model,
          environment: { TOKEN: value },
        })
      ).code,
      400,
    );
  }
  for (const nodeVersion of ['0', '13', '13.14.0']) {
    assert.equal(
      (await f.request('PUT', `/api/projects/${f.project.id}`, { ...f.model, nodeVersion })).code,
      400,
    );
  }
  assert.equal(
    validateProject({ ...f.model, nodeVersion: '16', packageManager: 'yarn' }, f.config)
      .installCommand,
    'yarn install --frozen-lockfile',
  );
});

test('系统列出 Node.js 14/18，API 保存旧项目主版本与完整版本且默认仍为 24', async (t) => {
  const f = await fixture(t);
  assert.equal(f.project.nodeVersion, '24');
  const system = await f.request('GET', '/api/system');
  assert.equal(system.code, 200);
  assert.deepEqual(system.body.nodeVersions, ['14', '18', '22', '24', '26']);
  assert.equal(system.body.hostNodeVersion, process.versions.node);

  for (const nodeVersion of ['14', '18']) {
    const created = await f.request('POST', '/api/projects', {
      ...f.model,
      name: `Legacy Node ${nodeVersion}`,
      nodeVersion,
    });
    assert.equal(created.code, 201);
    const project = created.body.project;
    assert.equal(project.nodeVersion, nodeVersion);
    assert.equal(f.app.store.getProject(project.id).nodeVersion, nodeVersion);
    assert.equal(
      (await f.request('GET', `/api/projects/${project.id}`)).body.project.nodeVersion,
      nodeVersion,
    );

    const fullVersion = nodeVersion === '14' ? '14.21.3' : '18.20.8';
    const updated = await f.request('PUT', `/api/projects/${project.id}`, {
      ...f.model,
      nodeVersion: fullVersion,
    });
    assert.equal(updated.code, 200);
    assert.equal(updated.body.project.nodeVersion, fullVersion);
    assert.equal(
      (await f.request('GET', `/api/projects/${project.id}`)).body.project.nodeVersion,
      fullVersion,
    );
  }
  assert.equal(validateProject({ ...f.model, nodeVersion: '15' }, f.config).nodeVersion, '15');
});
