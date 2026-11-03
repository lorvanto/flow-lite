import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import {
  executeBuild,
  executeRollback,
  pruneReleases,
  cleanupAbandonedBuilds,
  nodeImageName,
  selectPackageManager,
  installPackageManager,
} from '../server/runners/build.mjs';
import { runProcess } from '../server/lib/process.mjs';
import { createGitHttpsFixture } from './helpers/git-https.mjs';

test('Node image selection keeps version tags while allowing alternate registries', () => {
  assert.equal(nodeImageName('14'), 'node:14-bullseye');
  assert.equal(nodeImageName('v14.21.3'), 'node:14.21.3-bullseye');
  assert.equal(nodeImageName('16.20.2'), 'node:16.20.2-bullseye');
  assert.equal(nodeImageName('18'), 'node:18-bookworm');
  assert.equal(
    nodeImageName('18.20.8', 'public.ecr.aws/docker/library/node'),
    'public.ecr.aws/docker/library/node:18.20.8-bookworm',
  );
  assert.equal(nodeImageName('24'), 'node:24-bookworm');
  assert.equal(
    nodeImageName('24.13.0', 'public.ecr.aws/docker/library/node'),
    'public.ecr.aws/docker/library/node:24.13.0-bookworm',
  );
  assert.equal(
    nodeImageName('22', 'registry.example.com:5000/team/node'),
    'registry.example.com:5000/team/node:22-bookworm',
  );
});

test('Node image prefixes reject tags, digests, protocols and unsafe command characters', () => {
  for (const prefix of [
    'node:24',
    'node@sha256:abc',
    'https://public.ecr.aws/docker/library/node',
    'node;id',
    'node$(id)',
    'node\n',
    '/node',
    'node/',
    'registry.example.com//node',
    'registry.example.com:0/team/node',
    'registry.example.com:65536/team/node',
  ]) {
    assert.throws(() => nodeImageName('24', prefix), /FLOW_NODE_IMAGE_PREFIX/, prefix);
  }
  assert.throws(() => nodeImageName('24;id'), /Node.js 版本/);
  assert.throws(() => nodeImageName('12'), /14 或以上/);
});

test('package manager defaults remain compatible with the chosen legacy Node runtime', () => {
  for (const [nodeVersion, version] of [
    ['14', '7'],
    ['14.21.3', '7'],
    ['16', '8'],
    ['18', '9'],
    ['18.20.8', '9'],
    ['20', '10'],
    ['22', '10'],
    ['24', '10'],
  ]) {
    assert.deepEqual(selectPackageManager({ packageManager: 'pnpm' }, {}, nodeVersion), {
      name: 'pnpm',
      version,
    });
  }
  assert.deepEqual(selectPackageManager({ packageManager: 'npm' }, {}, '14'), {
    name: 'npm',
    version: '',
  });
  assert.deepEqual(selectPackageManager({ packageManager: 'yarn' }, {}, '14'), {
    name: 'yarn',
    version: '1.22.22',
  });
  assert.equal(
    selectPackageManager(
      { packageManager: 'pnpm', packageManagerVersion: '10.11.0' },
      { packageManager: 'pnpm@7.33.7' },
      '14',
    ).version,
    '10.11.0',
  );
  assert.equal(
    selectPackageManager(
      { packageManager: 'pnpm' },
      { packageManager: 'pnpm@9.15.9+sha512.fixture' },
      '14',
    ).version,
    '9.15.9',
  );
});

test('package manager bootstrap enforces engines and reports an incompatible explicit version', async () => {
  let command;
  const manager = selectPackageManager(
    { packageManager: 'pnpm', packageManagerVersion: '10.11.0' },
    {},
    '14',
  );
  await assert.rejects(
    installPackageManager(manager, {
      prefix: '/tmp/flow-tools',
      nodeVersion: '14.21.3',
      onLog: () => {},
      exec: async (value) => {
        command = value;
        const error = new Error('npm failed');
        error.stderr = 'npm ERR! code ENOTSUP\nnpm ERR! Unsupported engine for pnpm@10.11.0';
        throw error;
      },
    }),
    /pnpm@10\.11\.0.*Node.js 14\.21\.3.*不兼容/,
  );
  assert.match(command, /npm install --engine-strict/);
  assert.match(command, /pnpm@10\.11\.0/);
  await installPackageManager(
    { name: 'npm', version: '' },
    {
      exec: () => {
        throw new Error('Bundled npm must not be replaced');
      },
    },
  );
  const networkError = Object.assign(new Error('network failed'), { stderr: 'ECONNREFUSED' });
  await assert.rejects(
    installPackageManager(manager, {
      prefix: '/tmp/flow-tools',
      nodeVersion: '14.21.3',
      onLog: () => {},
      exec: async () => {
        throw networkError;
      },
    }),
    (error) => error === networkError,
  );
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-runner-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (args) => runProcess('git', args, { cwd: repo });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'flow-test@example.invalid']);
  await git(['config', 'user.name', 'Flow test']);
  await fs.writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 'flow-fixture',
      version: '1.0.0',
      private: true,
      scripts: { build: 'node build.cjs' },
      engines: { node: '>=22' },
    }),
  );
  await fs.writeFile(
    path.join(repo, 'package-lock.json'),
    JSON.stringify({
      name: 'flow-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'flow-fixture', version: '1.0.0' } },
    }),
  );
  await fs.writeFile(
    path.join(repo, 'build.cjs'),
    "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html',fs.readFileSync('page.txt'));\n",
  );
  await fs.writeFile(path.join(repo, 'page.txt'), '<h1>version one</h1>');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial fixture']);
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const project = {
    id: randomUUID(),
    name: 'Fixture',
    repoUrl: repo,
    branch: 'main',
    nodeVersion: String(process.versions.node.split('.')[0]),
    packageManager: 'npm',
    installCommand: 'npm ci --ignore-scripts --no-audit --no-fund',
    buildCommand: 'npm run build',
    workdir: '.',
    artifactDir: 'dist',
    timeoutSeconds: 30,
    environment: {},
    deploy: { type: 'local', root: path.join(root, 'website') },
  };
  const config = {
    dataDir: path.join(root, 'data'),
    runnerMode: 'host',
    allowHostRunner: true,
    allowLocalRepositories: true,
  };
  const run = (extra = {}) => ({
    id: randomUUID(),
    projectId: project.id,
    number: 1,
    kind: 'build',
    ...extra,
  });
  const options = (task = run(), overrides = {}) => ({ run: task, project, config, ...overrides });
  return { root, repo, git, commit, project, config, run, options };
}

test('builds immutable Git commits, publishes atomically, and rolls back saved artifacts', async (t) => {
  const f = await fixture(t);
  const stages = [];
  const metadata = {};
  const first = f.run();
  const result = await executeBuild(
    f.options(first, {
      onStage: (value) => stages.push(value),
      onMetadata: (value) => Object.assign(metadata, value),
    }),
  );
  assert.deepEqual(stages, ['checkout', 'install', 'build', 'archive', 'deploy']);
  assert.equal(result.commitSha, f.commit);
  assert.equal(metadata.nodeVersion, process.versions.node);
  assert.match(metadata.packageManagerVersion, /^\d+\./);
  assert.equal(
    await fs.readFile(path.join(result.artifactPath, 'index.html'), 'utf8'),
    '<h1>version one</h1>',
  );
  assert.equal(
    await fs.readlink(path.join(f.project.deploy.root, 'current')),
    `releases/${first.id}`,
  );

  await fs.writeFile(path.join(f.repo, 'page.txt'), '<h1>version two</h1>');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Second version']);
  const second = f.run({ number: 2 });
  await executeBuild(f.options(second));
  assert.equal(
    await fs.readFile(path.join(f.project.deploy.root, 'current/index.html'), 'utf8'),
    '<h1>version two</h1>',
  );
  assert.equal(
    await fs.readFile(path.join(result.artifactPath, 'index.html'), 'utf8'),
    '<h1>version one</h1>',
  );

  // A retry must remain on the old commit even though main has advanced.
  const retry = f.run({ number: 3, commitSha: f.commit });
  const retried = await executeBuild(f.options(retry));
  assert.equal(retried.commitSha, f.commit);
  assert.equal(
    await fs.readFile(path.join(retried.artifactPath, 'index.html'), 'utf8'),
    '<h1>version one</h1>',
  );

  const rollback = f.run({ kind: 'rollback', rollbackReleaseId: second.id });
  await executeRollback(f.options(rollback));
  assert.equal(
    await fs.readlink(path.join(f.project.deploy.root, 'current')),
    `releases/${second.id}`,
  );
  assert.equal(
    await fs.readFile(path.join(f.project.deploy.root, 'current/index.html'), 'utf8'),
    '<h1>version two</h1>',
  );
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
});

test('rejects symlink artifacts and preserves the live version on failed builds', async (t) => {
  const f = await fixture(t);
  const first = f.run();
  await executeBuild(f.options(first));
  await fs.writeFile(
    path.join(f.repo, 'build.cjs'),
    "const fs=require('node:fs');fs.mkdirSync('dist');fs.symlinkSync('../../page.txt','dist/index.html');\n",
  );
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Unsafe artifact']);
  const unsafe = f.run();
  await assert.rejects(executeBuild(f.options(unsafe)), /index.html 必须是普通文件/);
  assert.equal(
    await fs.readlink(path.join(f.project.deploy.root, 'current')),
    `releases/${first.id}`,
  );
  await assert.rejects(fs.stat(path.join(f.config.dataDir, 'artifacts', f.project.id, unsafe.id)), {
    code: 'ENOENT',
  });
});

test('host runner refuses to pretend it is a different Node version', async (t) => {
  const f = await fixture(t);
  f.project.nodeVersion = String(Number(process.versions.node.split('.')[0]) + 2);
  await assert.rejects(executeBuild(f.options()), /无法执行所选/);
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
});

test('host runner requires explicit opt-in and local repositories are disabled by default', async (t) => {
  const f = await fixture(t);
  f.config.allowLocalRepositories = false;
  await assert.rejects(executeBuild(f.options()), /本地仓库仅在显式开启/);
  f.config.allowLocalRepositories = true;
  f.config.allowHostRunner = false;
  await assert.rejects(executeBuild(f.options()), /FLOW_ALLOW_HOST_RUNNER/);
});

test('rejects workdir traversal and unknown rollback identifiers', async (t) => {
  const f = await fixture(t);
  f.project.workdir = '../outside';
  await assert.rejects(executeBuild(f.options()), /工作目录必须是项目内/);
  await assert.rejects(
    executeRollback(f.options(f.run({ rollbackReleaseId: '../../outside' }))),
    /回滚版本 ID不是有效/,
  );
});

test('auto Node version reads a numeric .nvmrc from the repository', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, '.nvmrc'), `v${process.versions.node}\n`);
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Pin Node']);
  f.project.nodeVersion = 'auto';
  const result = await executeBuild(f.options());
  assert.equal(result.nodeVersion, process.versions.node);
});

test('auto Node selection accepts Node 14 .nvmrc and Node 18 .node-version before enforcing host-runtime matching', async (t) => {
  const f = await fixture(t);
  f.project.nodeVersion = 'auto';
  for (const [filename, version] of [
    ['.nvmrc', 'v14.21.3'],
    ['.node-version', '18.20.8'],
  ]) {
    await fs.rm(path.join(f.repo, '.nvmrc'), { force: true });
    await fs.rm(path.join(f.repo, '.node-version'), { force: true });
    await fs.writeFile(path.join(f.repo, filename), `${version}\n`);
    await f.git(['add', '-A']);
    await f.git(['commit', '-m', `Pin ${version}`]);
    await assert.rejects(executeBuild(f.options()), (error) =>
      error.message.includes(`无法执行所选 ${version.replace(/^v/, '')}`),
    );
  }
});

test('timeout stops a build and leaves no workspace or published files', async (t) => {
  const f = await fixture(t);
  f.project.timeoutSeconds = 1;
  f.project.installCommand = `${process.execPath} -e 'setInterval(()=>{},1000)'`;
  await assert.rejects(executeBuild(f.options()), (error) => error.name === 'TimeoutError');
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
  await assert.rejects(fs.stat(path.join(f.project.deploy.root, 'current')), { code: 'ENOENT' });
});

test('process cancellation kills descendants even when the direct child exits first', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process-group behavior');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-abort-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sentinel = path.join(root, 'orphan-survived');
  const controller = new AbortController();
  let childPid;
  const childScript = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad'),1500);setInterval(()=>{},1000)`;
  const parentScript = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setTimeout(()=>process.stdout.write('child:'+c.pid+'\\n'),150);setInterval(()=>{},1000)`;
  t.after(() => {
    if (childPid) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
    }
  });
  await assert.rejects(
    runProcess(process.execPath, ['-e', parentScript], {
      signal: controller.signal,
      onOutput: (value) => {
        childPid = Number(/child:(\d+)/.exec(value)?.[1]);
        controller.abort(new DOMException('Cancelled', 'AbortError'));
      },
    }),
    { name: 'AbortError' },
  );
  await new Promise((resolve) => setTimeout(resolve, 1800));
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
});

test('release retention keeps current, requested versions, and all unmanaged files', async (t) => {
  const f = await fixture(t);
  const releases = path.join(f.project.deploy.root, 'releases');
  await fs.mkdir(releases, { recursive: true });
  const current = randomUUID();
  const keep = randomUUID();
  const remove = randomUUID();
  const link = randomUUID();
  for (const id of [current, keep, remove, 'user-content']) {
    await fs.mkdir(path.join(releases, id));
    await fs.writeFile(path.join(releases, id, 'index.html'), id);
  }
  await fs.symlink(`releases/${current}`, path.join(f.project.deploy.root, 'current'));
  await fs.symlink('../outside', path.join(releases, link));
  await pruneReleases({ project: f.project, keepIds: [keep], config: f.config });
  assert.equal(await fs.readFile(path.join(releases, current, 'index.html'), 'utf8'), current);
  assert.equal(await fs.readFile(path.join(releases, keep, 'index.html'), 'utf8'), keep);
  await assert.rejects(fs.stat(path.join(releases, remove)), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(releases, 'user-content'))).isDirectory());
  assert.ok((await fs.lstat(path.join(releases, link))).isSymbolicLink());
});

test('restart cleanup removes generated workspace directories and preserves unmanaged paths', async (t) => {
  const f = await fixture(t);
  const workspaces = path.join(f.config.dataDir, 'workspaces');
  await fs.mkdir(workspaces, { recursive: true });
  const generated = await fs.mkdtemp(path.join(workspaces, `${randomUUID()}-`));
  await fs.writeFile(path.join(generated, 'repository.key'), 'private');
  const pruned = await fs.mkdtemp(path.join(workspaces, 'prune-'));
  await fs.mkdir(path.join(workspaces, 'user-files'));
  await fs.symlink(f.repo, path.join(workspaces, `${randomUUID()}-abcdef`));
  await cleanupAbandonedBuilds({ config: f.config });
  await assert.rejects(fs.stat(generated), { code: 'ENOENT' });
  await assert.rejects(fs.stat(pruned), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(workspaces, 'user-files'))).isDirectory());
  assert.ok((await fs.stat(f.repo)).isDirectory());
  assert.equal((await fs.readdir(workspaces)).length, 2);
});

test('password auth reaches real Git checkout plus mocked SSH publish, rollback, and retention without leaking to builds', async (t) => {
  const f = await fixture(t);
  const trace = path.join(f.root, 'ssh-trace.jsonl');
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  const script = `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');const crypto=require('node:crypto');const args=process.argv.slice(2);const askpass=process.env.SSH_ASKPASS;const passwordFile=process.env.FLOW_SSH_PASSWORD_FILE;
const password=cp.execFileSync(askpass,['Password:'],{env:process.env,encoding:'utf8'});
const repository=args.includes('-G')||args.some(x=>x.startsWith('git-upload-pack '));
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,env:process.env,repository,passwordFile,passwordMode:fs.statSync(passwordFile).mode&511,askpassMode:fs.statSync(askpass).mode&511,passwordHash:crypto.createHash('sha256').update(password).digest('hex')})+'\\n');
if(args.includes('-G'))process.exit(0);
if(repository){const child=cp.spawn('git',['upload-pack',${JSON.stringify(f.repo)}],{env:process.env,stdio:'inherit'});child.on('exit',code=>process.exit(code??1));}else{process.stdin.resume();process.stdin.on('end',()=>process.exit(0));}
`;
  await fs.writeFile(path.join(bin, 'ssh'), script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const repositoryId = randomUUID();
  const deployId = randomUUID();
  const repoPassword = `Repository-password-${randomUUID()}!`;
  const deployPassword = `Deploy-password-${randomUUID()}!`;
  const credentials = {
    [repositoryId]: {
      type: 'ssh',
      authType: 'password',
      password: repoPassword,
      knownHosts: 'fixture.invalid ssh-ed25519 fixture',
    },
    [deployId]: {
      type: 'ssh',
      authType: 'password',
      password: deployPassword,
      knownHosts: 'fixture.invalid ssh-ed25519 fixture',
    },
  };
  f.project.repoUrl = `ssh://root@fixture.invalid${f.repo}`;
  f.project.buildCredentialId = repositoryId;
  f.project.deploy = {
    type: 'ssh',
    root: '/srv/www/fixture',
    host: 'fixture.invalid',
    user: 'root',
    credentialId: deployId,
  };
  f.project.buildCommand +=
    ' && node -e "if(process.env.FLOW_SSH_PASSWORD_FILE||process.env.SSH_ASKPASS)process.exit(42)"';
  const first = f.run();
  const built = await executeBuild(f.options(first, { credentials }));
  assert.equal(built.commitSha, f.commit);
  await executeRollback(
    f.options(f.run({ kind: 'rollback', rollbackReleaseId: first.id }), { credentials }),
  );
  await pruneReleases({ project: f.project, keepIds: [first.id], credentials, config: f.config });
  const connections = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(connections.some((item) => item.repository));
  assert.equal(connections.filter((item) => !item.repository).length, 3);
  for (const captured of connections) {
    const password = captured.repository ? repoPassword : deployPassword;
    assert.ok(captured.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(captured.args.includes('BatchMode=no'));
    assert.equal(captured.args.join(' ').includes(password), false);
    assert.equal(
      Object.values(captured.env).some((value) => value.includes(password)),
      false,
    );
    assert.equal(captured.passwordHash, createHash('sha256').update(`${password}\n`).digest('hex'));
    assert.equal(captured.passwordMode, 0o600);
    assert.equal(captured.askpassMode, 0o700);
    await assert.rejects(fs.stat(captured.passwordFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(captured.env.SSH_ASKPASS), { code: 'ENOENT' });
  }
});

test('real HTTPS Git retry fetches its fixed commit and removes credentials before checkout/build', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, 'page.txt'), '<h1>version two</h1>');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'advance main']);
  const remote = await createGitHttpsFixture(t, { repoDir: f.repo });
  const calls = await remote.installGitCaShim();
  const credentialId = randomUUID();
  const credentials = {
    [credentialId]: {
      type: 'git-https',
      authType: 'password',
      username: remote.username,
      password: remote.password,
    },
  };
  f.project.repoUrl = remote.url;
  f.project.buildCredentialId = credentialId;
  f.project.buildCommand +=
    " && node -e \"if(process.env.FLOW_GIT_CREDENTIAL_FILE||process.env.GIT_CONFIG_COUNT||require('node:fs').readdirSync('..').some(n=>n.startsWith('git-https-')))process.exit(52)\"";
  let inspected = false;
  const result = await executeBuild(
    f.options(f.run({ commitSha: f.commit }), {
      credentials,
      onMetadata: async (value) => {
        if (!value.commitSha) return;
        const workspaces = path.join(f.config.dataDir, 'workspaces');
        const directories = await fs.readdir(workspaces);
        const directory = path.join(workspaces, directories[0]);
        assert.equal(
          (await fs.readdir(directory)).some((name) => name.startsWith('git-https-')),
          false,
        );
        const config = await fs.readFile(path.join(directory, 'source/.git/config'), 'utf8');
        assert.ok(config.includes(remote.url));
        assert.equal(config.includes(remote.password), false);
        assert.equal(config.includes('helper.cjs'), false);
        assert.equal(config.includes('credential'), false);
        inspected = true;
      },
    }),
  );
  assert.equal(inspected, true);
  assert.equal(result.commitSha, f.commit);
  assert.equal(
    await fs.readFile(path.join(result.artifactPath, 'index.html'), 'utf8'),
    '<h1>version one</h1>',
  );
  assert.ok((await fs.readFile(calls, 'utf8')).split('\n').includes('fetch'));
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
});

test('wrong HTTPS password fails a real clone and cleans all task-local authentication files', async (t) => {
  const f = await fixture(t);
  const remote = await createGitHttpsFixture(t, { repoDir: f.repo });
  await remote.installGitCaShim();
  const credentialId = randomUUID();
  const credentials = {
    [credentialId]: {
      type: 'git-https',
      authType: 'password',
      username: remote.username,
      password: 'definitely-wrong-password',
    },
  };
  f.project.repoUrl = remote.url;
  f.project.buildCredentialId = credentialId;
  await assert.rejects(executeBuild(f.options(f.run(), { credentials })));
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
  assert.equal(
    remote.requests.some((request) => request.authenticated),
    false,
  );
});

test('runner independently rejects HTTPS/SSH credential mismatches and HTTPS credentials for deployment', async (t) => {
  const f = await fixture(t);
  const credentialId = randomUUID();
  f.project.buildCredentialId = credentialId;
  f.project.repoUrl = 'https://example.invalid/team/repo.git';
  await assert.rejects(
    executeBuild(
      f.options(f.run(), {
        credentials: { [credentialId]: { type: 'ssh', privateKey: 'fixture' } },
      }),
    ),
    /HTTPS 仓库需要/,
  );
  const credentials = {
    [credentialId]: {
      type: 'git-https',
      authType: 'password',
      username: 'fixture-user',
      password: 'fixture-token',
    },
  };
  f.project.repoUrl = 'ssh://root@example.invalid/team/repo.git';
  await assert.rejects(executeBuild(f.options(f.run(), { credentials })), /不能使用 Git HTTPS/);
  f.project.repoUrl = f.repo;
  f.project.buildCredentialId = null;
  f.project.deploy = {
    type: 'ssh',
    host: 'example.invalid',
    user: 'root',
    root: '/srv/www/fixture',
    credentialId,
  };
  await assert.rejects(executeBuild(f.options(f.run(), { credentials })), /发布目标仅支持 SSH/);
});

test('HTTPS credentials fail closed on Git older than 2.32 before a helper is created', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'old-git-bin');
  await fs.mkdir(bin);
  const marker = path.join(f.root, 'version-check.json');
  await fs.writeFile(
    path.join(bin, 'git'),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const root=${JSON.stringify(path.join(f.config.dataDir, 'workspaces'))};const run=fs.readdirSync(root)[0];fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),helperPresent:fs.readdirSync(path.join(root,run)).some(x=>x.startsWith('git-https-'))}));console.log('git version 2.31.9');\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  const credentialId = randomUUID();
  f.project.repoUrl = 'https://example.invalid/team/repo.git';
  f.project.buildCredentialId = credentialId;
  const credentials = {
    [credentialId]: {
      type: 'git-https',
      authType: 'password',
      username: 'fixture-user',
      password: 'fixture-token',
    },
  };
  await assert.rejects(executeBuild(f.options(f.run(), { credentials })), /需要 Git 2\.32 或以上/);
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), {
    args: ['--version'],
    helperPresent: false,
  });
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
});
