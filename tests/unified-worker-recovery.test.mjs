import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../server/config.mjs';
import { createStore } from '../server/services/store.mjs';
import { runWorker } from '../server/worker.mjs';

async function fixture(t, kind = 'build') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flow-unified-worker-')));
  const config = getConfig({
    dataDir: path.join(root, 'data'),
    runnerMode: 'host',
    allowHostRunner: true,
    setupToken: 'synthetic-worker-setup',
  });
  const store = createStore(config);
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const prior = randomUUID();
  let project = store.saveProject({
    type: 'node',
    name: 'Synthetic unified',
    timeoutSeconds: 60,
    deploy: { type: 'local', root: path.join(root, 'site') },
    environment: {},
    retainReleases: 3,
  });
  store.setCurrentRelease(project.id, prior);
  project = store.getProject(project.id);
  const run = store.enqueue(project, kind, kind === 'rollback' ? prior : null);
  const artifact = path.join(
    config.dataDir,
    'artifacts',
    project.id,
    kind === 'rollback' ? prior : run.id,
  );
  const makeArchive = async () => {
    await fs.mkdir(artifact, { recursive: true });
    await fs.writeFile(path.join(artifact, 'index.html'), 'synthetic saved release');
  };
  return { root, config, store, project, prior, run, artifact, makeArchive };
}

test('uncertain unified failure keeps the saved frontend archive and current pointer unchanged', async (t) => {
  const f = await fixture(t);
  await runWorker(f.config, {
    once: true,
    runner: {
      executeBuild: async (args) => {
        await f.makeArchive();
        args.onMetadata({
          buildDetails: {
            sources: [],
            tasks: [],
            backend: { stage: 'recovery_required', status: 'failed' },
          },
        });
        const error = new Error('统一发布恢复状态未确认，需核实');
        error.recoveryRequired = true;
        throw error;
      },
    },
  });
  assert.equal(f.store.getRun(f.run.id).status, 'failed');
  assert.match(f.store.getRun(f.run.id).error, /恢复状态未确认/);
  assert.equal(
    await fs.readFile(path.join(f.artifact, 'index.html'), 'utf8'),
    'synthetic saved release',
  );
  assert.equal(f.store.getProject(f.project.id).currentReleaseId, f.prior);
});

test('cancelled uncertain recovery retains its specific diagnostic and archive', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await runWorker(f.config, {
    once: true,
    signal: controller.signal,
    runner: {
      executeBuild: async (args) => {
        await f.makeArchive();
        args.onMetadata({ buildDetails: { backend: { stage: 'recovery_required' } } });
        f.store.requestCancelRun(f.run.id);
        controller.abort();
        const error = new Error('统一发布恢复状态未确认，API 与前端需核实');
        error.recoveryRequired = true;
        throw error;
      },
    },
  });
  assert.equal(f.store.getRun(f.run.id).status, 'cancelled');
  assert.match(f.store.getRun(f.run.id).error, /恢复状态未确认/);
  assert.doesNotMatch(f.store.getRun(f.run.id).error, /执行器正在关闭/);
  assert.equal((await fs.stat(f.artifact)).isDirectory(), true);
  assert.equal(f.store.getProject(f.project.id).currentReleaseId, f.prior);
});

test('ordinary build failure still deletes its new archive without changing current', async (t) => {
  const f = await fixture(t);
  await runWorker(f.config, {
    once: true,
    runner: {
      executeBuild: async (args) => {
        await f.makeArchive();
        args.onMetadata({ buildDetails: { backend: { stage: 'failed' } } });
        throw new Error('synthetic ordinary failure');
      },
    },
  });
  assert.equal(f.store.getRun(f.run.id).status, 'failed');
  await assert.rejects(fs.stat(f.artifact), { code: 'ENOENT' });
  assert.equal(f.store.getProject(f.project.id).currentReleaseId, f.prior);
});

test('failed historical rollback never deletes its saved selected frontend archive', async (t) => {
  const f = await fixture(t, 'rollback');
  await f.makeArchive();
  await runWorker(f.config, {
    once: true,
    runner: {
      executeRollback: async () => {
        throw new Error('synthetic historical failure');
      },
    },
  });
  assert.equal(f.store.getRun(f.run.id).status, 'failed');
  assert.equal((await fs.stat(f.artifact)).isDirectory(), true);
  assert.equal(f.store.getProject(f.project.id).currentReleaseId, f.prior);
});

for (const interruptedStage of ['activate', 'done']) {
  test(`restart during ${interruptedStage} conservatively preserves the archive without attempting a switch`, async (t) => {
    const f = await fixture(t);
    await f.makeArchive();
    f.store.updateRun(f.run.id, {
      status: 'running',
      buildDetails: {
        sources: [],
        tasks: [],
        backend: { status: 'running', stage: interruptedStage },
      },
    });
    let calls = 0;
    await runWorker(f.config, {
      once: true,
      runner: {
        executeBuild: async () => {
          calls++;
        },
      },
    });
    assert.equal(calls, 0);
    assert.equal(f.store.getRun(f.run.id).status, 'failed');
    assert.equal(f.store.getRun(f.run.id).buildDetails.backend.stage, 'recovery_required');
    assert.match(f.store.getRun(f.run.id).error, /恢复状态未确认/);
    assert.equal((await fs.stat(f.artifact)).isDirectory(), true);
    assert.equal(f.store.getProject(f.project.id).currentReleaseId, f.prior);
  });
}
