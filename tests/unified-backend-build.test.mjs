import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  preflightVue3Tasks,
  verifyInstalledVue3,
  unifiedReleaseProof,
  frontendBaseline,
  publishUnifiedRelease,
  rollbackUnifiedRelease,
  executeRollback,
} from '../server/runners/build.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flow-unified-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectId = randomUUID(),
    release = randomUUID(),
    prior = randomUUID(),
    old = randomUUID();
  const project = {
    id: projectId,
    type: 'node',
    buildMode: 'multi',
    timeoutSeconds: 60,
    sources: [{ id: 'official', repoUrl: 'http://git.yin-duo.com/mini-program/coffee.git' }],
    tasks: ['h5', 'admin'].map((id) => ({
      id,
      sourceId: 'official',
      workdir: id === 'h5' ? 'mobile' : 'admin',
      publishDir: id,
      targetVueMajor: 3,
    })),
    backend: {
      enabled: true,
      type: 'php',
      sourceId: 'official',
      workdir: 'api',
      phpVersion: '8.5',
      application: 'coffee',
    },
    deploy: {
      type: 'ssh',
      host: '47.118.69.157',
      user: 'root',
      port: 22,
      root: '/data/httpd/www/demo.yunyingbao.net/frontend-deploy/coffee',
      credentialId: randomUUID(),
    },
    currentReleaseId: prior,
  };
  const context = {
    project,
    run: { id: release, projectId },
    config: { dataDir: path.join(root, 'data') },
    signal: new AbortController().signal,
    onLog: () => {},
    onStage: () => {},
    onMetadata: () => {},
  };
  const handle = {
    schemaVersion: 1,
    kind: 'flow-php-backend-handle',
    projectId,
    application: 'coffee',
    release,
    sourceCommit: 'a'.repeat(40),
    apiTreeSha256: 'b'.repeat(64),
    archiveSha256: 'c'.repeat(64),
    archiveBytes: 1024,
    phpVersion: '8.5.12',
  };
  const artifact = (id) => path.join(context.config.dataDir, 'artifacts', projectId, id);
  for (const id of [release, prior, old]) {
    await fs.mkdir(artifact(id), { recursive: true });
    await fs.writeFile(path.join(artifact(id), 'index.html'), 'synthetic frontend');
  }
  await fs.writeFile(
    path.join(artifact(release), '.flow-unified-proof.json'),
    JSON.stringify(unifiedReleaseProof(handle)),
  );
  const previousFrontend = await frontendBaseline(context, prior);
  const events = [];
  const operations = {
    status: async (ctx) => {
      events.push(['status', ctx.signal.aborted]);
      return { currentManagedRelease: prior };
    },
    publish: async (file, p, id, ctx) => {
      events.push(['publish', id, ctx.signal.aborted]);
      return `/releases/${id}`;
    },
    activate: async () => {
      events.push(['activate']);
      return { state: 'activated' };
    },
    rollback: async (ctx, h, options) => {
      events.push(['rollback', options, ctx.signal.aborted]);
      return { state: 'rolled_back', rollbackConfirmed: true };
    },
  };
  const onBackend = async (value) => {
    events.push(['backend', value.stage, value.status]);
  };
  return {
    root,
    project,
    context,
    handle,
    artifact,
    prior,
    old,
    previousFrontend,
    events,
    operations,
    onBackend,
  };
}

test('all Vue3 declarations are inspected before any script; VueCLI5 compat is accepted', async (t) => {
  const f = await fixture(t),
    repo = path.join(f.root, 'repo');
  for (const part of ['mobile', 'admin']) {
    await fs.mkdir(path.join(repo, part), { recursive: true });
    await fs.writeFile(
      path.join(repo, part, 'package.json'),
      JSON.stringify({
        dependencies: { vue: '^3.5.0' },
        scripts: { preinstall: 'MUST_NOT_EXECUTE' },
      }),
    );
  }
  const dirs = new Map([['official', repo]]);
  await preflightVue3Tasks(f.project, dirs);
  await fs.writeFile(
    path.join(repo, 'admin/package.json'),
    JSON.stringify({
      dependencies: {
        vue: 'npm:@vue/compat@^3.5.0',
        '@vue/compat': '^3.5.0',
        '@vue/cli-service': '~5.0.8',
      },
    }),
  );
  await preflightVue3Tasks(f.project, dirs);
  await fs.writeFile(
    path.join(repo, 'admin/package.json'),
    JSON.stringify({ dependencies: { vue: '^2.7.0' } }),
  );
  await assert.rejects(preflightVue3Tasks(f.project, dirs), /尚未执行任何依赖安装/);
  f.project.tasks[1].publishDir = 'h5';
  await assert.rejects(preflightVue3Tasks(f.project, dirs), /全部独立前端目录/);
});

test('post-build gate checks actual Vue3/compiler metadata and refuses outside-source symlinks', async (t) => {
  const f = await fixture(t),
    repo = path.join(f.root, 'repo'),
    work = path.join(repo, 'admin');
  await fs.mkdir(work, { recursive: true });
  const write = async (name, version) => {
    const dir = path.join(work, 'node_modules', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  };
  await write('vue', '3.5.0');
  await write('@vue/compiler-sfc', '3.5.0');
  await verifyInstalledVue3(repo, work);
  await write('vue', '2.7.0');
  await assert.rejects(verifyInstalledVue3(repo, work), /不是 Vue3/);
  await fs.rm(path.join(work, 'node_modules/vue'), { recursive: true });
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, 'package.json'),
    JSON.stringify({ name: 'vue', version: '3.5.0' }),
  );
  await fs.symlink(outside, path.join(work, 'node_modules/vue'));
  await assert.rejects(verifyInstalledVue3(repo, work), /越出当前代码源/);
});

test('unified publication orders frontend first, API last and keeps backend metadata separate', async (t) => {
  const f = await fixture(t);
  const result = await publishUnifiedRelease(
    f.context,
    {
      handle: f.handle,
      artifactPath: f.artifact(f.handle.release),
      previousFrontend: f.previousFrontend,
      onBackend: f.onBackend,
    },
    f.operations,
  );
  assert.equal(result, `/releases/${f.handle.release}`);
  assert.deepEqual(
    f.events.filter(([name]) => name !== 'backend').map(([name, id]) => [name, id]),
    [
      ['status', false],
      ['publish', f.handle.release],
      ['activate', undefined],
    ],
  );
  assert.equal(f.events.at(-1)[1], 'done');
  assert.equal(f.events.at(-1)[2], 'success');
});

test('activation network uncertainty restores API before previous frontend with a fresh bounded signal', async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  f.context.signal = abort.signal;
  f.operations.activate = async () => {
    f.events.push(['activate']);
    abort.abort(new Error('synthetic cancel'));
    throw new Error('PRIVATE_RAW_UNKNOWN');
  };
  await assert.rejects(
    publishUnifiedRelease(
      f.context,
      {
        handle: f.handle,
        artifactPath: f.artifact(f.handle.release),
        previousFrontend: f.previousFrontend,
        onBackend: f.onBackend,
      },
      f.operations,
    ),
    (error) =>
      error.code === 'unified_release_restored' &&
      error.rollbackConfirmed === true &&
      !error.message.includes('PRIVATE'),
  );
  const main = f.events.filter(([name]) => name !== 'backend');
  assert.deepEqual(
    main.map(([name]) => name),
    ['status', 'publish', 'activate', 'status', 'rollback', 'publish'],
  );
  assert.equal(main.at(-1)[1], f.prior);
  assert.equal(main.at(-1)[2], false);
  assert.equal(main.at(-2)[2], false);
});

test('real SSH publisher can publish then recover in one context without reusing wx credential files', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'bin'),
    trace = path.join(f.root, 'ssh-trace.jsonl');
  await fs.mkdir(bin);
  f.context.tempDir = path.join(f.root, 'workspace');
  await fs.mkdir(f.context.tempDir);
  f.context.credentials = {
    [f.project.deploy.credentialId]: {
      type: 'ssh',
      privateKey: 'SYNTHETIC_KEY_NOT_REAL',
      knownHosts: 'fixture known hosts',
    },
  };
  await fs.writeFile(
    path.join(bin, 'ssh'),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const key=args[args.indexOf('-i')+1];const stat=fs.lstatSync(key);if(!stat.isFile()||(stat.mode&511)!==384)process.exit(9);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({authDir:path.dirname(key)})+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));\n`,
    { mode: 0o755 },
  );
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${priorPath}`;
  try {
    await assert.rejects(
      publishUnifiedRelease(
        f.context,
        {
          handle: f.handle,
          artifactPath: f.artifact(f.handle.release),
          previousFrontend: f.previousFrontend,
        },
        {
          status: f.operations.status,
          rollback: f.operations.rollback,
          activate: async () => {
            throw new Error('synthetic activation failure');
          },
        },
      ),
      (error) => error.rollbackConfirmed === true,
    );
  } finally {
    process.env.PATH = priorPath;
  }
  const entries = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].authDir, entries[1].authDir);
  for (const entry of entries) await assert.rejects(fs.lstat(entry.authDir), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.context.tempDir), []);
});

test('unconfirmed/foreign API state never causes a blind frontend rollback', async (t) => {
  const f = await fixture(t);
  let statusCount = 0;
  f.operations.status = async () => ({
    currentManagedRelease: ++statusCount === 1 ? f.prior : randomUUID(),
  });
  f.operations.activate = async () => {
    throw new Error('network unknown');
  };
  await assert.rejects(
    publishUnifiedRelease(
      f.context,
      {
        handle: f.handle,
        artifactPath: f.artifact(f.handle.release),
        previousFrontend: f.previousFrontend,
      },
      f.operations,
    ),
    (error) => error.code === 'unified_recovery_uncertain' && !error.rollbackConfirmed,
  );
  assert.deepEqual(
    f.events.filter(([name]) => name === 'publish').map((entry) => entry[1]),
    [f.handle.release],
  );
  assert.equal(
    f.events.some(([name]) => name === 'rollback'),
    false,
  );
});

test('a rollback reply without explicit confirmation keeps the previous frontend untouched', async (t) => {
  const f = await fixture(t);
  f.operations.activate = async () => {
    throw new Error('network unknown');
  };
  f.operations.rollback = async () => ({ state: 'rolled_back' });
  await assert.rejects(
    publishUnifiedRelease(
      f.context,
      {
        handle: f.handle,
        artifactPath: f.artifact(f.handle.release),
        previousFrontend: f.previousFrontend,
      },
      f.operations,
    ),
    (error) => error.code === 'unified_recovery_uncertain',
  );
  assert.deepEqual(
    f.events.filter(([name]) => name === 'publish').map((entry) => entry[1]),
    [f.handle.release],
  );
});

test('stale baseline, source proof mismatch, absent baseline fail before publication', async (t) => {
  const f = await fixture(t);
  f.operations.status = async () => ({ currentManagedRelease: randomUUID() });
  await assert.rejects(
    publishUnifiedRelease(
      f.context,
      {
        handle: f.handle,
        artifactPath: f.artifact(f.handle.release),
        previousFrontend: f.previousFrontend,
      },
      f.operations,
    ),
    /前端基线不同/,
  );
  await assert.rejects(
    publishUnifiedRelease(
      f.context,
      {
        handle: { ...f.handle, sourceCommit: 'f'.repeat(40) },
        artifactPath: f.artifact(f.handle.release),
        previousFrontend: f.previousFrontend,
      },
      f.operations,
    ),
    /同一业务/,
  );
  await assert.rejects(frontendBaseline(f.context, undefined), /UUID/);
  assert.equal(
    f.events.some(([name]) => name === 'publish'),
    false,
  );
});

test('historical rollback binds frontend/API same selected release with fresh current CAS', async (t) => {
  const f = await fixture(t);
  await rollbackUnifiedRelease(
    f.context,
    {
      handle: f.handle,
      artifactPath: f.artifact(f.handle.release),
      previousFrontend: f.previousFrontend,
      onBackend: f.onBackend,
    },
    f.operations,
  );
  const main = f.events.filter(([name]) => name !== 'backend');
  assert.deepEqual(
    main.map(([name]) => name),
    ['status', 'publish', 'rollback'],
  );
  assert.deepEqual(main.at(-1)[1], { expectedCurrentRelease: f.prior });
});

test('historical unknown API result leaves frontend untouched; explicit target restoration allows recovery', async (t) => {
  for (const confirmed of [false, true]) {
    const f = await fixture(t);
    f.operations.rollback = async () => {
      const error = new Error('private response withheld');
      if (confirmed) error.rollbackConfirmed = true;
      throw error;
    };
    await assert.rejects(
      rollbackUnifiedRelease(
        f.context,
        {
          handle: f.handle,
          artifactPath: f.artifact(f.handle.release),
          previousFrontend: f.previousFrontend,
        },
        f.operations,
      ),
      (error) => error.recoveryRequired === !confirmed,
    );
    assert.deepEqual(
      f.events.filter(([name]) => name === 'publish').map((entry) => entry[1]),
      confirmed ? [f.handle.release, f.prior] : [f.handle.release],
    );
  }
});

test('a historical frontend transfer failure restores the current frontend without invoking API change', async (t) => {
  const f = await fixture(t);
  const publish = f.operations.publish;
  f.operations.publish = async (...args) => {
    await publish(...args);
    if (args[2] === f.handle.release) throw new Error('synthetic failed transfer');
    return '/restored';
  };
  await assert.rejects(
    rollbackUnifiedRelease(
      f.context,
      {
        handle: f.handle,
        artifactPath: f.artifact(f.handle.release),
        previousFrontend: f.previousFrontend,
      },
      f.operations,
    ),
    (error) => error.rollbackConfirmed === true,
  );
  assert.equal(
    f.events.some(([name]) => name === 'rollback'),
    false,
  );
  assert.deepEqual(
    f.events.filter(([name]) => name === 'publish').map((entry) => entry[1]),
    [f.handle.release, f.prior],
  );
});

test('legacy frontend-only saved releases cannot be used for unified API historical rollback', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    executeRollback({
      ...f.context,
      run: { ...f.context.run, id: randomUUID(), rollbackReleaseId: f.old },
    }),
    /backend_release_metadata_missing_or_invalid/,
  );
});
