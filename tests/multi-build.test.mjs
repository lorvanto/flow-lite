import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { validateProject } from '../server/lib/validation.mjs';
import { executeBuild, executeRollback } from '../server/runners/build.mjs';
import { runProcess } from '../server/lib/process.mjs';
import { createStore } from '../server/services/store.mjs';
import { getConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { secretValues, createLogWriter } from '../server/lib/logs.mjs';
import { enableMultiBuild, taskPayloads, environmentText } from '../web/src/lib/multi-build.js';

const git = (repo, args) =>
  runProcess(
    'git',
    ['-c', 'user.name=Flow Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: repo },
  );
async function repository(root, name, modules) {
  const repo = path.join(root, name);
  await fs.mkdir(repo);
  for (const dir of modules) {
    const folder = path.join(repo, dir);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, 'package.json'),
      JSON.stringify({ name: dir, version: '1.0.0', private: true }),
    );
    await fs.writeFile(
      path.join(folder, 'build.mjs'),
      `import fs from 'node:fs';
if(process.env.FAIL==='yes')process.exit(4);
if(process.env.LINK==='yes'){fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','ok');fs.symlinkSync('/etc/passwd','dist/escape');}
else {fs.mkdirSync('dist');fs.writeFileSync('dist/index.html',fs.readFileSync('../version.txt','utf8')+'|'+process.env.TARGET+'|'+process.env.COMMON);fs.writeFileSync('dist/app.js','console.log("fixture")');}
if(process.env.TASK_SECRET){process.stdout.write(process.env.TASK_SECRET.slice(0,5));await new Promise(r=>setTimeout(r,10));console.log(process.env.TASK_SECRET.slice(5));}
`,
    );
  }
  await fs.writeFile(path.join(repo, 'version.txt'), name + '-v1');
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'fixture']);
  return repo;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-multi-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = getConfig({
    dataDir: path.join(root, 'data'),
    runnerMode: 'host',
    allowHostRunner: true,
    allowLocalRepositories: true,
    setupToken: 'multi-build-fixture-setup',
  });
  const a = await repository(root, 'repo-a', ['admin', 'mobile']);
  const b = await repository(root, 'repo-b', ['pc']);
  const task = (id, sourceId, workdir, publishDir) => ({
    id,
    name: id,
    sourceId,
    workdir,
    publishDir,
    nodeVersion: process.versions.node,
    packageManager: 'npm',
    installCommand: 'node -e "process.exit(0)"',
    buildCommand: 'node build.mjs',
    artifactDir: 'dist',
    environment: { TARGET: id },
  });
  const input = {
    id: randomUUID(),
    type: 'node',
    buildMode: 'multi',
    name: '商城',
    environment: { COMMON: 'shared', TARGET: 'global' },
    timeoutSeconds: 60,
    deploy: { type: 'local', root: path.join(root, 'site') },
    sources: [
      { id: 'main', name: '商城', repoUrl: a, branch: 'main' },
      { id: 'pc', name: '独立PC仓库', repoUrl: b, branch: 'main' },
    ],
    tasks: [
      task('admin', 'main', 'admin', 'static/admin'),
      task('h5', 'main', 'mobile', 'h5'),
      task('pc', 'pc', 'pc', 'pc'),
    ],
  };
  const project = { ...validateProject(input, config), id: input.id };
  const runs = async (changes = {}, runExtra = {}, options = {}) => {
    const current = { ...structuredClone(project), ...changes };
    const run = { id: randomUUID(), projectId: project.id, ...runExtra };
    const metadata = [];
    let logs = '';
    const result = await executeBuild({
      project: current,
      run,
      config,
      onLog: (text) => {
        logs += text;
      },
      onMetadata: (value) => {
        metadata.push(structuredClone(value));
      },
      ...options,
    });
    return { run, result, metadata, logs };
  };
  return { root, config, input, project, runs, a, b };
}

test('one pipeline reuses a monorepo and a second Git, maps three outputs, and pins every source on retry', async (t) => {
  const f = await fixture(t);
  const first = await f.runs();
  assert.equal((first.logs.match(/Cloning into/g) || []).length, 2);
  for (const [dir, content] of [
    ['static/admin', 'repo-a-v1|admin|shared'],
    ['h5', 'repo-a-v1|h5|shared'],
    ['pc', 'repo-b-v1|pc|shared'],
  ])
    assert.equal(
      await fs.readFile(path.join(f.project.deploy.root, 'current', dir, 'index.html'), 'utf8'),
      content,
    );
  assert.equal(first.result.buildDetails.sources.length, 2);
  assert.equal(
    first.result.buildDetails.tasks.filter((task) => task.status === 'success').length,
    3,
  );
  assert.match(
    await fs.readFile(path.join(first.result.artifactPath, 'index.html'), 'utf8'),
    /static\/admin/,
  );
  for (const repo of [f.a, f.b]) {
    await fs.writeFile(path.join(repo, 'version.txt'), 'NEW');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'new-head']);
  }
  const retry = await f.runs({}, { buildDetails: first.result.buildDetails });
  assert.deepEqual(
    retry.result.buildDetails.sources.map((s) => s.commitSha),
    first.result.buildDetails.sources.map((s) => s.commitSha),
  );
  assert.equal(
    await fs.readFile(path.join(retry.result.artifactPath, 'pc/index.html'), 'utf8'),
    'repo-b-v1|pc|shared',
  );
  const rollback = await executeRollback({
    project: f.project,
    run: { id: randomUUID(), projectId: f.project.id, rollbackReleaseId: first.run.id },
    config: f.config,
  });
  assert.equal(
    await fs.readlink(path.join(f.project.deploy.root, 'current')),
    'releases/' + first.run.id,
  );
  assert.equal(rollback.artifactPath, first.result.artifactPath);
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
});

test('a middle task failure skips remaining work and leaves the entire published version unchanged', async (t) => {
  const f = await fixture(t);
  const first = await f.runs();
  const tasks = structuredClone(f.project.tasks);
  tasks[1].environment.FAIL = 'yes';
  let details;
  await assert.rejects(
    f.runs(
      { tasks },
      {},
      {
        onMetadata: (data) => {
          if (data.buildDetails) details = data.buildDetails;
        },
      },
    ),
    /4|失败|退出/,
  );
  assert.deepEqual(
    details.tasks.map((task) => task.status),
    ['success', 'failed', 'skipped'],
  );
  assert.equal(
    await fs.readlink(path.join(f.project.deploy.root, 'current')),
    'releases/' + first.run.id,
  );
  assert.equal(
    (await fs.readdir(path.join(f.config.dataDir, 'artifacts', f.project.id))).length,
    1,
  );
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'workspaces')), []);
});

test('unsafe task artifacts cannot be merged or published', async (t) => {
  const f = await fixture(t);
  const tasks = structuredClone(f.project.tasks);
  tasks[0].environment.LINK = 'yes';
  await assert.rejects(f.runs({ tasks }), /链接/);
  await assert.rejects(fs.lstat(path.join(f.project.deploy.root, 'current')), /ENOENT/);
});

test('cancelling a later task keeps the current release and records skipped work', async (t) => {
  const f = await fixture(t);
  const first = await f.runs();
  const controller = new AbortController();
  let details;
  await assert.rejects(
    f.runs(
      {},
      {},
      {
        signal: controller.signal,
        onMetadata: (data) => {
          if (data.buildDetails) {
            details = data.buildDetails;
            if (details.tasks[1].stage === 'build' && details.tasks[1].status === 'running')
              controller.abort(new Error('fixture cancellation'));
          }
        },
      },
    ),
    /fixture cancellation/,
  );
  assert.deepEqual(
    details.tasks.map((task) => task.status),
    ['success', 'cancelled', 'skipped'],
  );
  assert.equal(
    await fs.readlink(path.join(f.project.deploy.root, 'current')),
    'releases/' + first.run.id,
  );
});

test('multi task validation rejects output overlap, traversal, dangling sources, duplicate identities and bad runtime settings', async (t) => {
  const f = await fixture(t);
  for (const [label, edit] of [
    ['overlap', (p) => (p.tasks[1].publishDir = 'static')],
    ['equivalent', (p) => (p.tasks[1].publishDir = './static/admin')],
    ['traversal', (p) => (p.tasks[0].publishDir = '../site')],
    ['absolute', (p) => (p.tasks[0].publishDir = '/srv/www')],
    ['root overlap', (p) => (p.tasks[0].publishDir = '.')],
    ['workdir escape', (p) => (p.tasks[0].workdir = '../')],
    ['whole source', (p) => (p.tasks[0].artifactDir = '.')],
    ['dangling', (p) => (p.tasks[0].sourceId = 'missing')],
    ['duplicate task', (p) => (p.tasks[1].id = p.tasks[0].id)],
    ['duplicate source', (p) => (p.sources[1].id = p.sources[0].id)],
    ['source escape', (p) => (p.sources[0].id = '../../x')],
    ['runtime', (p) => (p.tasks[0].nodeVersion = '22;id')],
    ['reserved env', (p) => (p.tasks[0].environment.PATH = '/tmp')],
    ['empty', (p) => (p.tasks = [])],
    ['many', (p) => (p.tasks = Array(13).fill(p.tasks[0]))],
  ]) {
    const p = structuredClone(f.input);
    edit(p);
    assert.throws(() => validateProject(p, f.config), undefined, label);
  }
});

test('task environment secrets are redacted across process chunks and never stored in build metadata', async (t) => {
  const f = await fixture(t);
  const project = structuredClone(f.project);
  project.tasks[0].environment.TASK_SECRET = 'private-task-token-123';
  const filename = path.join(f.root, 'run.log');
  const logger = createLogWriter(filename, secretValues(project, {}));
  let result;
  try {
    result = await f.runs({ tasks: project.tasks }, {}, { onLog: (text) => logger.write(text) });
  } finally {
    logger.close();
  }
  const text = await fs.readFile(filename, 'utf8');
  assert.equal(text.includes('private-task-token-123'), false);
  assert.match(text, /REDACTED/);
  assert.equal(
    JSON.stringify(result.result.buildDetails).includes('private-task-token-123'),
    false,
  );
});

test('API checks every repository credential, protects nested queued references, and preserves retry metadata', async (t) => {
  const f = await fixture(t);
  const app = await createApp(f.config);
  t.after(() => app.close());
  const call = (method, url, payload) =>
    app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
  let cookie = '';
  const auth = await call('POST', '/api/auth/setup', {
    username: 'admin',
    password: 'multi-build-fixture-password',
    setupToken: f.config.setupToken,
  });
  cookie = auth.headers['set-cookie'].split(';')[0];
  const credential = (
    await call('POST', '/api/credentials', {
      name: 'Git credential',
      type: 'git-https',
      username: 'fixture',
      password: 'fixture-token',
    })
  ).json().credential;
  const ssh = (
    await call('POST', '/api/credentials', {
      name: 'SSH credential',
      type: 'ssh',
      authType: 'password',
      password: 'fixture-password',
    })
  ).json().credential;
  const input = structuredClone(f.input);
  input.sources = [
    {
      id: 'one',
      name: 'One',
      repoUrl: 'https://example.invalid/one.git',
      buildCredentialId: credential.id,
    },
    {
      id: 'two',
      name: 'Two',
      repoUrl: 'http://git.yin-duo.com/mini-program/yshopbbc.git',
      buildCredentialId: ssh.id,
    },
  ];
  input.tasks[0].sourceId = 'one';
  input.tasks[1].sourceId = 'one';
  input.tasks[2].sourceId = 'two';
  assert.equal((await call('POST', '/api/projects', input)).statusCode, 400);
  input.sources[1].buildCredentialId = credential.id;
  const saved = await call('POST', '/api/projects', input);
  assert.equal(saved.statusCode, 201);
  const project = saved.json().project;
  const queued = (await call('POST', `/api/projects/${project.id}/runs`)).json().run;
  assert.equal(queued.taskCount, 3);
  assert.equal(queued.sourceCount, 2);
  assert.equal((await call('DELETE', `/api/credentials/${credential.id}`)).statusCode, 409);
  // Removing a current reference cannot orphan credentials retained by a queued snapshot.
  app.store.saveProject(f.project, project.id);
  assert.equal((await call('DELETE', `/api/credentials/${credential.id}`)).statusCode, 409);
  const buildDetails = {
    sources: [
      { id: 'one', name: 'One', branch: 'main', commitSha: 'a'.repeat(40), status: 'success' },
      { id: 'two', name: 'Two', branch: 'main', commitSha: 'b'.repeat(40), status: 'success' },
    ],
    tasks: project.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      status: 'success',
      stage: 'done',
    })),
  };
  app.store.updateRun(queued.id, { status: 'failed', buildDetails });
  const retry = (await call('POST', `/api/runs/${queued.id}/retry`)).json().run;
  assert.deepEqual(
    retry.buildDetails.sources.map((source) => source.commitSha),
    ['a'.repeat(40), 'b'.repeat(40)],
  );
  assert.ok(retry.buildDetails.tasks.every((task) => task.status === 'waiting'));
  const raw = app.store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(queued.id).snapshot;
  assert.equal(raw.includes('https://example.invalid'), false);
});

test('legacy databases gain nullable run details without changing saved snapshots', async (t) => {
  const f = await fixture(t);
  let store = createStore(f.config);
  const p = store.saveProject(f.project);
  const run = store.enqueue(p);
  store.db.exec('ALTER TABLE runs DROP COLUMN build_details');
  store.close();
  store = createStore(f.config);
  t.after(() => store.close());
  assert.equal(store.getRun(run.id).buildDetails, null);
  assert.deepEqual(store.getRun(run.id).projectSnapshot.sources, p.sources);
});

test('UI converts a legacy project without losing paths or common env and keeps task env scoped on save', () => {
  const form = {
    repoUrl: 'https://example.invalid/shop.git',
    branch: 'main',
    workdir: 'mobile',
    artifactDir: 'dist/build/h5',
    nodeVersion: '22.18.0',
    environment: { SHARED: 'x' },
  };
  enableMultiBuild(form);
  assert.equal(form.sources.length, 1);
  assert.equal(form.tasks[0].workdir, 'mobile');
  assert.equal(form.tasks[0].publishDir, '.');
  assert.deepEqual(form.environment, { SHARED: 'x' });
  const payload = taskPayloads([{ ...form.tasks[0], envText: 'VITE_BASE=/h5/\nTOKEN=a=b' }])[0];
  assert.deepEqual(payload.environment, { VITE_BASE: '/h5/', TOKEN: 'a=b' });
  assert.equal('envText' in payload, false);
  assert.equal(environmentText(payload.environment), 'VITE_BASE=/h5/\nTOKEN=a=b');
  assert.throws(() => taskPayloads([{ envText: 'invalid' }]), /KEY=value/);
});

test('Docker tasks select independent Node images and environments while sharing one checkout', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  const records = path.join(f.root, 'docker-calls.jsonl');
  const stub = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), root=${JSON.stringify(f.root)}, records=${JSON.stringify(records)};
const record=(value)=>fs.appendFileSync(records,JSON.stringify(value)+'\\n');
if(args[0]==='create'){
 const name=args[args.indexOf('--name')+1], file=args[args.indexOf('--env-file')+1], workdir=args[args.indexOf('--workdir')+1];
 const mount=args.find(x=>x.startsWith('type=bind,src=')&&x.endsWith(',dst=/workspace'));
 const source=mount.slice('type=bind,src='.length,-',dst=/workspace'.length), image=args[args.indexOf('--env-file')+2];
 const env=Object.fromEntries(fs.readFileSync(file,'utf8').trimEnd().split('\\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
 const state={name,source,image,env,envFile:file,cwd:path.join(source,workdir.slice('/workspace/'.length))};fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(state));record({command:'create',...state});console.log(name);
}else if(args[0]==='exec'){
 const state=JSON.parse(fs.readFileSync(path.join(root,args[1]+'.json'),'utf8'));
 if(args[2]==='node'){console.log(state.image.includes(':14')?'14.21.3':'22.18.0');}
 else if(args.at(-1).includes('npm --version'))console.log('10.9.0');
 else if(args.at(-1).includes('node build.mjs')){const result=spawnSync(process.execPath,['build.mjs'],{cwd:state.cwd,env:{...process.env,...state.env},encoding:'utf8'});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status;}
}else if(args[0]==='rm'){record({command:'remove',name:args.at(-1)});}
`;
  await fs.writeFile(path.join(bin, 'docker'), stub);
  await fs.chmod(path.join(bin, 'docker'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  t.after(() => {
    process.env.PATH = previous;
  });
  f.config.runnerMode = 'docker';
  const tasks = structuredClone(f.project.tasks);
  tasks[0].nodeVersion = '22.18.0';
  tasks[1].nodeVersion = '14.21.3';
  tasks[2].nodeVersion = '22.18.0';
  tasks[0].environment.ONLY_ADMIN = 'admin-only';
  const result = await f.runs({ tasks });
  const calls = (await fs.readFile(records, 'utf8')).trim().split('\n').map(JSON.parse);
  const creates = calls.filter((call) => call.command === 'create');
  assert.deepEqual(
    creates.map((call) => call.image),
    ['node:22.18.0-bookworm', 'node:14.21.3-bullseye', 'node:22.18.0-bookworm'],
  );
  assert.equal(creates[0].source, creates[1].source);
  assert.notEqual(creates[1].source, creates[2].source);
  assert.equal(new Set(creates.map((call) => call.envFile)).size, 3);
  assert.equal(creates[0].env.ONLY_ADMIN, 'admin-only');
  assert.equal(creates[1].env.ONLY_ADMIN, undefined);
  assert.deepEqual(
    creates.map((call) => call.env.TARGET),
    ['admin', 'h5', 'pc'],
  );
  assert.ok(
    creates.every(
      (call) =>
        call.env.FLOW_GIT_CREDENTIAL_DATA === undefined && call.env.GIT_SSH_COMMAND === undefined,
    ),
  );
  assert.equal(calls.filter((call) => call.command === 'remove').length, 3);
  assert.deepEqual(
    result.result.buildDetails.tasks.map((task) => task.nodeVersion),
    ['22.18.0', '14.21.3', '22.18.0'],
  );
});
