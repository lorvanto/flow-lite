import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  includePhpSource,
  phpConstraintAllows,
  readPhpGitSource,
  phpFileManifest,
  createPhpTar,
  validatePhpTar,
  lintPhpSource,
  preparePhpBackend,
  loadPhpBackendHandle,
  activatePhpBackend,
  rollbackPhpBackend,
  statusPhpBackend,
  PHP_LINT_SCRIPT,
  capturePhpBackendSource,
} from '../server/runners/php-backend.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function fixture(t, { symlink = false, php = '^8.0' } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flow-php-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, 'source');
  await fs.mkdir(sourceDir);
  const files = {
    'api/public/index.php': '<?php echo "fixture";\n',
    'api/vendor/autoload.php': '<?php // synthetic autoload\n',
    'api/vendor/acme/library/src/Session/Handler.php': '<?php class Handler {}\n',
    'api/composer.json': JSON.stringify({ require: { php, 'ext-json': '*' } }),
    'api/composer.lock': JSON.stringify({ platform: { php } }),
    'api/.env': 'DO_NOT_READ_OR_SEND_PRIVATE_ENV_CANARY',
    'api/DB.env': 'DO_NOT_READ_DB_CANARY',
    'api/runtime/session.bin': 'PRIVATE_SESSION',
    'api/public/uploads/image.png': 'PRIVATE_UPLOAD',
    'api/public/static/admin/index.html': 'NOT_BACKEND',
    'api/public/qrcode/a.png': 'PRIVATE_QRCODE',
    'api/vendor/acme/library/tests/fixture.php': '<?php not production',
    'api/app/install/data/install.sql': 'PRIVATE_SQL',
    'api/extend/cert/apiclient_key.pem': 'PRIVATE_KEY',
    'mobile/package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(sourceDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  if (symlink) await fs.symlink('/etc/passwd', path.join(sourceDir, 'api/public/linked.php'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: sourceDir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const sourceCommit = git('rev-parse', 'HEAD');
  const tempDir = path.join(directory, 'workspace');
  await fs.mkdir(tempDir);
  const context = {
    project: {
      id: projectId,
      sources: [{ id: 'official', repoUrl: 'http://git.yin-duo.com/mini-program/coffee.git' }],
      tasks: [
        { id: 'h5', sourceId: 'official' },
        { id: 'admin', sourceId: 'official' },
      ],
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
        credentialId,
      },
    },
    run: { id: runId, projectId },
    config: { dataDir: path.join(directory, 'data') },
    tempDir,
    credentials: {
      [credentialId]: {
        type: 'ssh',
        privateKey: 'SYNTHETIC_PRIVATE_KEY',
        knownHosts: 'fixture known hosts',
      },
    },
    onLog: () => {},
  };
  return { directory, sourceDir, sourceCommit, context, git };
}

test('source filter excludes private/runtime/frontend data while preserving vendor Session source', () => {
  for (const name of [
    '.env',
    '.env.production',
    'DB.env',
    'config/production.env',
    'x/.git/config',
    'runtime/a',
    'public/uploads/a',
    'public/qrcode/a',
    'public/admin/a',
    'public/static/admin/a',
    'public/static/install/a',
    'app/install/data/a.sql',
    'cert/a.pem',
    'cert/a.pem.php',
    'foo.sql.gz',
    '../escape',
    '/absolute',
    'x\\y',
    'vendor/acme/pkg/tests/a.php',
  ])
    assert.equal(includePhpSource(name), false, name);
  for (const name of [
    'vendor/acme/pkg/src/Session/Handler.php',
    'vendor/acme/pkg/src/Cache.php',
    'public/static/fonts/font.woff2',
    'app/controller/App.php',
  ])
    assert.equal(includePhpSource(name), true, name);
});

test('PHP constraints require an 8.x baseline and permit the actual 8.5 patch', () => {
  for (const value of [
    '^8.0',
    '^8.5.0',
    '~8.5.0',
    '8.5.*',
    '>=8.0 <9.0',
    '>=8.0 <9',
    '~8.0',
    '>=8.0, <9.0',
    '^8.0 || ^8.5',
  ])
    assert.equal(phpConstraintAllows(value, '8.5.12'), true, value);
  for (const value of [
    '>=7.4',
    '^7.4 || ^8.0',
    '~8.4.0',
    '8.5.0',
    '>=8.6',
    '*',
    'dev-main',
    '>=8.0 <8.5',
    '^8.0; touch /tmp/a',
  ])
    assert.equal(phpConstraintAllows(value, '8.5.12'), false, value);
  assert.equal(phpConstraintAllows('~8.5.13', '8.5.12'), false);
  assert.equal(phpConstraintAllows('>=8.5.1 <=8.5.12', null), true);
  assert.equal(phpConstraintAllows('>=8.5.1 <=8.5.12', '8.5.12'), true);
  assert.equal(phpConstraintAllows('>8.5.1 <8.5.2', null), false);
  assert.equal(phpConstraintAllows('^8.5.*', null), false);
});

test('trusted lint program checks real synthetic PHP syntax without executing the file', async (t) => {
  let phpVersion;
  try {
    phpVersion = execFileSync('php', ['-n', '-r', 'echo PHP_VERSION;']).toString();
  } catch {
    t.skip('PHP 8.5 CLI unavailable');
    return;
  }
  if (!phpVersion.startsWith('8.5.')) {
    t.skip('PHP 8.5 CLI unavailable');
    return;
  }
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flow-php-linter-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.php'),
    list = path.join(dir, 'lint-files'),
    canary = path.join(dir, 'must-not-exist');
  await fs.writeFile(file, `<?php file_put_contents(${JSON.stringify(canary)}, 'EXECUTED');`);
  await fs.writeFile(list, `${file}\0`);
  const program = PHP_LINT_SCRIPT.replaceAll('/lint-files', list)
    .replaceAll('/src/', `${dir}/`)
    .replaceAll('/tmp/lint.out', path.join(dir, 'out'))
    .replaceAll('/tmp/lint.err', path.join(dir, 'err'));
  assert.deepEqual(JSON.parse(execFileSync('php', ['-n', '-r', program]).toString()), {
    phpVersion,
    phpFiles: 1,
  });
  await assert.rejects(fs.stat(canary), { code: 'ENOENT' });
  await fs.writeFile(file, '<?php function BROKEN( {');
  assert.throws(
    () => execFileSync('php', ['-n', '-r', program], { stdio: ['ignore', 'pipe', 'pipe'] }),
    (error) => error.status === 13 && error.stdout.length === 0 && error.stderr.length === 0,
  );
});

test('real Git object source ignores mutated worktree and produces canonical regular-only tar', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.sourceDir, 'api/public/index.php'),
    'MUTATED_UNCOMMITTED_FRONTEND_SCRIPT_BYTES',
  );
  const source = await readPhpGitSource(f.sourceDir, f.sourceCommit);
  assert.equal(
    source.entries.find((item) => item.path === 'public/index.php').data.toString(),
    '<?php echo "fixture";\n',
  );
  assert.equal(source.entries.length, 5);
  const manifest = phpFileManifest(source.entries),
    archive = createPhpTar(source.entries);
  assert.equal(validatePhpTar(archive, manifest), true);
  for (const canary of [
    'PRIVATE_ENV',
    'PRIVATE_DB',
    'PRIVATE_SESSION',
    'PRIVATE_UPLOAD',
    'PRIVATE_QRCODE',
    'PRIVATE_SQL',
    'PRIVATE_KEY',
    'MUTATED_UNCOMMITTED',
  ])
    assert.equal(archive.includes(canary), false);
  const file = path.join(f.directory, 'test.tar');
  await fs.writeFile(file, archive);
  const names = execFileSync('tar', ['-tf', file]).toString().trim().split('\n');
  assert.deepEqual(
    names,
    manifest.map((entry) => entry.path),
  );
  assert.equal(
    digest(JSON.stringify(manifest)),
    digest(JSON.stringify(phpFileManifest([...source.entries].reverse()))),
  );
});

test('unknown commit, included symlink, and legacy PHP baseline fail closed', async (t) => {
  const normal = await fixture(t);
  await assert.rejects(readPhpGitSource(normal.sourceDir, 'f'.repeat(40)), /source_commit_changed/);
  const linked = await fixture(t, { symlink: true });
  await assert.rejects(
    readPhpGitSource(linked.sourceDir, linked.sourceCommit),
    /non_regular_php_source/,
  );
  const legacy = await fixture(t, { php: '>=7.4' });
  await assert.rejects(
    readPhpGitSource(legacy.sourceDir, legacy.sourceCommit),
    /php_85_constraint_required/,
  );
});

test('tar validator rejects link entries, traversal, corruption, duplicates, and extra data', () => {
  const entries = [{ path: 'public/index.php', data: Buffer.from('<?php // fixture') }];
  const manifest = phpFileManifest(entries);
  const original = createPhpTar(entries);
  for (const mutation of [
    (tar) => {
      tar[156] = 50;
    },
    (tar) => {
      tar[0] = 46;
      tar[1] = 46;
      tar[2] = 47;
    },
    (tar) => {
      tar[512] ^= 1;
    },
    (tar) => {
      tar[tar.length - 1] = 1;
    },
  ]) {
    const tar = Buffer.from(original);
    mutation(tar);
    assert.throws(() => validatePhpTar(tar, manifest));
  }
  assert.throws(() => createPhpTar([entries[0], entries[0]]), /invalid_archive_entry/);
  assert.throws(
    () => createPhpTar([{ path: '.env', data: Buffer.from('PRIVATE') }]),
    /invalid_archive_entry/,
  );
});

test('Docker lint mounts only filtered bytes, no SSH/env/Flow data, and always cleans on failure', async (t) => {
  const f = await fixture(t),
    source = await readPhpGitSource(f.sourceDir, f.sourceCommit);
  source.entries.push({
    path: 'vendor/topthink/framework/src/think/console/command/make/stubs/command.stub',
    data: Buffer.from('<?php class {%className%} {}'),
  });
  source.entries.push({
    path: 'vendor/phpunit/phpunit/src/Framework/TestRunner/templates/method.tpl',
    data: Buffer.from('<?php function {methodName}() {}'),
  });
  source.entries.push({
    path: 'think',
    data: Buffer.from('#!/usr/bin/env php\n<?php echo "fixture";'),
  });
  source.entries.push({
    path: 'vendor/phpunit/phpunit/src/Util/PHP/Template/PhptTestCase.tpl',
    data: Buffer.from('<?php class {className} {}'),
  });
  source.entries.push({
    path: 'public/template/exception.tpl',
    data: Buffer.from('<?php echo "fixture template";'),
  });
  const calls = [];
  await lintPhpSource(f.context, source, async (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'docker');
    assert.equal('input' in options, false);
    assert.equal('onOutput' in options, false);
    assert.equal(JSON.stringify(options.env).includes('SYNTHETIC_PRIVATE_KEY'), false);
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    assert.ok(args.includes('public.ecr.aws/docker/library/php:8.5-cli-bookworm'));
    assert.ok(args.includes('none'));
    assert.ok(args.includes('--read-only'));
    const mount = args.find((item) => item.includes('dst=/src,'));
    const root = mount.split('src=')[1].split(',dst=')[0];
    const listMount = args.find((item) => item.includes('dst=/lint-files,'));
    const lintFiles = (
      await fs.readFile(listMount.split('src=')[1].split(',dst=')[0], 'utf8')
    ).split('\0');
    assert.equal(
      lintFiles.some((file) => file.endsWith('.stub')),
      false,
    );
    assert.ok(lintFiles.includes('/src/think'));
    assert.equal(
      lintFiles.some((file) => file.includes('/phpunit/') && file.endsWith('.tpl')),
      false,
    );
    assert.ok(lintFiles.includes('/src/public/template/exception.tpl'));
    assert.equal(
      (
        await fs.readFile(
          path.join(
            root,
            'vendor/topthink/framework/src/think/console/command/make/stubs/command.stub',
          ),
          'utf8',
        )
      ).includes('{%className%}'),
      true,
    );
    await assert.rejects(fs.stat(path.join(root, '.env')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, 'runtime')), { code: 'ENOENT' });
    assert.equal(
      await fs.readFile(path.join(root, 'public/index.php'), 'utf8'),
      '<?php echo "fixture";\n',
    );
    throw new Error('DO_NOT_OUTPUT_PRIVATE_DOCKER_ERROR');
  }).then(
    () => assert.fail('must fail'),
    (error) => assert.equal(error.message, 'PHP backend: php85_lint_failed'),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(await fs.readdir(f.context.tempDir), []);
});

async function protocolFixture(t, { failPrepare = false, gitWorktree = false } = {}) {
  const f = await fixture(t),
    actions = [],
    captured = [],
    bundles = [];
  const execute = async (command, args, options) => {
    if (command === 'docker')
      return {
        stdout: args[0] === 'run' ? JSON.stringify({ phpVersion: '8.5.12', phpFiles: 3 }) : '',
        stderr: '',
      };
    assert.equal(command, 'ssh');
    const action = ['prepare', 'activate', 'rollback', 'status'].find((value) =>
      args.at(-1).includes(`'${value}'`),
    );
    actions.push(action);
    assert.equal('onOutput' in options, false);
    assert.equal(args.join(' ').includes('SYNTHETIC_PRIVATE_KEY'), false);
    let input = Buffer.alloc(0);
    if (options.input?.[Symbol.asyncIterator]) {
      const chunks = [];
      for await (const chunk of options.input) chunks.push(Buffer.from(chunk));
      input = Buffer.concat(chunks);
    } else input = options.input;
    let metadata;
    if (action === 'prepare') {
      assert.equal(input.subarray(0, 8).toString(), gitWorktree ? 'FPHP8502' : 'FPHP8501');
      const size = input.readUInt32BE(8);
      metadata = JSON.parse(input.subarray(12, 12 + size));
      const tarEnd = 12 + size + metadata.archiveBytes;
      const tar = input.subarray(12 + size, gitWorktree ? tarEnd : undefined);
      assert.equal(tar.length, metadata.archiveBytes);
      assert.equal(digest(tar), metadata.archiveSha256);
      validatePhpTar(tar, metadata.files);
      if (gitWorktree) {
        const bundle = input.subarray(tarEnd);
        assert.equal(metadata.schemaVersion, 2);
        assert.equal(metadata.repositoryUrl, f.context.project.sources[0].repoUrl);
        assert.equal(bundle.length, metadata.gitBundleBytes);
        assert.equal(digest(bundle), metadata.gitBundleSha256);
        bundles.push(bundle);
      }
      captured.push(metadata);
      if (failPrepare) throw new Error('DO_NOT_LEAK_REMOTE_SECRET');
    } else if (action !== 'status') {
      metadata = JSON.parse(input);
      captured.push(metadata);
    } else metadata = captured[0];
    return {
      stdout: JSON.stringify({
        schemaVersion: 1,
        application: 'coffee',
        release: runId,
        state: {
          prepare: 'prepared',
          activate: 'activated',
          rollback: 'rolled_back',
          status: 'status',
        }[action],
        sourceCommit: f.sourceCommit,
        archiveSha256: metadata.archiveSha256,
        currentManagedRelease: runId,
      }),
      stderr: '',
    };
  };
  return { ...f, execute, actions, captured, bundles };
}

test('prepare wire/private persistence, exact handle, activation, historical CAS, and status binding', async (t) => {
  const f = await protocolFixture(t);
  const handle = await preparePhpBackend(f.context, f, { execute: f.execute });
  assert.deepEqual(await loadPhpBackendHandle(f.context, runId), handle);
  assert.equal(handle.phpVersion, '8.5.12');
  assert.equal(handle.archiveSha256, f.captured[0].archiveSha256);
  await activatePhpBackend(f.context, handle, { execute: f.execute });
  await rollbackPhpBackend(
    f.context,
    handle,
    { expectedCurrentRelease: runId },
    { execute: f.execute },
  );
  assert.equal(f.captured.at(-1).expectedCurrentRelease, runId);
  assert.equal(
    (await statusPhpBackend(f.context, handle, { execute: f.execute })).currentManagedRelease,
    runId,
  );
  assert.deepEqual(f.actions, ['prepare', 'activate', 'rollback', 'status']);
  const dir = path.join(f.context.config.dataDir, 'backend-artifacts', projectId, runId);
  for (const name of ['source.tar', 'metadata.json'])
    assert.equal((await fs.stat(path.join(dir, name))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(f.context.tempDir), []);
  await assert.rejects(
    activatePhpBackend(
      f.context,
      { ...handle, sourceCommit: 'f'.repeat(40) },
      { execute: f.execute },
    ),
    /backend_handle_changed/,
  );
  await assert.rejects(
    loadPhpBackendHandle(f.context, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    /metadata_missing_or_invalid/,
  );
});

test('SSH prepare rejection never activates and withholds raw error/private values', async (t) => {
  const f = await protocolFixture(t, { failPrepare: true });
  await assert.rejects(
    preparePhpBackend(f.context, f, { execute: f.execute }),
    (error) =>
      error.message === 'PHP backend: remote_prepare_failed' &&
      !JSON.stringify(error).includes('SECRET'),
  );
  assert.deepEqual(f.actions, ['prepare']);
  assert.deepEqual(await fs.readdir(f.context.tempDir), []);
});

test('pre-npm host snapshot survives later source and Git mutation and cannot be forged/reused across runs', async (t) => {
  const f = await protocolFixture(t);
  const snapshot = await capturePhpBackendSource(f.context, f);
  assert.deepEqual(Object.keys(snapshot), ['sourceCommit']);
  await fs.writeFile(path.join(f.sourceDir, 'api/public/index.php'), '<?php // MODIFIED_BY_NPM');
  f.git('add', 'api/public/index.php');
  f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'npm-mutated-git',
  );
  assert.notEqual(f.git('rev-parse', 'HEAD'), f.sourceCommit);
  const handle = await preparePhpBackend(f.context, { ...f, snapshot }, { execute: f.execute });
  assert.equal(handle.sourceCommit, f.sourceCommit);
  const tar = await fs.readFile(
    path.join(f.context.config.dataDir, 'backend-artifacts', projectId, runId, 'source.tar'),
  );
  assert.equal(tar.includes('MODIFIED_BY_NPM'), false);
  assert.equal(tar.includes('<?php echo "fixture";'), true);
  await assert.rejects(
    preparePhpBackend(
      f.context,
      { ...f, snapshot: { sourceCommit: f.sourceCommit } },
      { execute: f.execute },
    ),
    /source_snapshot_mismatch/,
  );
  await assert.rejects(
    preparePhpBackend(
      { ...f.context, run: { ...f.context.run, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } },
      { ...f, snapshot },
      { execute: f.execute },
    ),
    /source_snapshot_mismatch/,
  );
});

test('opt-in transport carries a standalone pre-build Git commit without the checkout configuration', async (t) => {
  const f = await protocolFixture(t, { gitWorktree: true });
  f.git('remote', 'add', 'origin', 'https://user:GIT_CONFIG_CANARY@example.invalid/coffee.git');
  await fs.writeFile(path.join(f.sourceDir, '.env'), 'UNTRACKED_ROOT_ENV_CANARY');
  const snapshot = await capturePhpBackendSource(f.context, { ...f, gitWorktree: true });
  await fs.writeFile(path.join(f.sourceDir, 'api/public/index.php'), '<?php // changed by npm');
  f.git('add', 'api/public/index.php');
  f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'later',
  );
  const handle = await preparePhpBackend(f.context, { ...f, snapshot }, { execute: f.execute });
  assert.deepEqual(await loadPhpBackendHandle(f.context, runId), handle);
  const bundle = path.join(f.directory, 'source.bundle');
  const checkout = path.join(f.directory, 'online');
  await fs.writeFile(bundle, f.bundles[0]);
  assert.equal(f.bundles[0].includes('GIT_CONFIG_CANARY'), false);
  execFileSync('git', ['clone', '-q', '--branch', 'flow-release', bundle, checkout]);
  assert.equal(
    execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD']).toString().trim(),
    f.sourceCommit,
  );
  assert.equal(
    await fs.readFile(path.join(checkout, 'api/public/index.php'), 'utf8'),
    '<?php echo "fixture";\n',
  );
  await assert.rejects(fs.access(path.join(checkout, '.env')), { code: 'ENOENT' });
  await activatePhpBackend(f.context, handle, { execute: f.execute });
  assert.deepEqual(f.actions, ['prepare', 'activate']);
});

test('network failure cannot confirm rollback; only exact helper-bound restoration can', async (t) => {
  const f = await protocolFixture(t);
  const handle = await preparePhpBackend(f.context, f, { execute: f.execute });
  const failWith = (body) => async () => {
    const error = new Error('PRIVATE_TRANSPORT_ERROR');
    if (body) error.stdout = JSON.stringify(body);
    throw error;
  };
  const response = {
    schemaVersion: 1,
    state: 'refused',
    application: handle.application,
    release: handle.release,
    sourceCommit: handle.sourceCommit,
    archiveSha256: handle.archiveSha256,
    rollbackConfirmed: true,
  };
  await assert.rejects(
    activatePhpBackend(f.context, handle, { execute: failWith() }),
    (error) =>
      error.code === 'php_backend_remote_activate_failed' && !('rollbackConfirmed' in error),
  );
  await assert.rejects(
    activatePhpBackend(f.context, handle, {
      execute: failWith({ ...response, release: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
    }),
    (error) => !('rollbackConfirmed' in error),
  );
  await assert.rejects(
    activatePhpBackend(f.context, handle, { execute: failWith(response) }),
    (error) => error.rollbackConfirmed === true,
  );
});
