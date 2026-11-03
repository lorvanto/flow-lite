import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { executeCommands } from '../server/runners/command.mjs';
import { runProcess } from '../server/lib/process.mjs';
import { projectRoot } from '../server/config.mjs';

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-command-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'site');
  const dataDir = path.join(root, 'data');
  const projectRoot = path.join(root, 'platform');
  for (const item of [directory, dataDir, projectRoot]) await fs.mkdir(item);
  const project = {
    id: randomUUID(),
    type: 'command',
    name: 'Commands',
    commands: 'printf "done\\n"',
    deploy: { type: 'local', root: directory },
    environment: {},
    timeoutSeconds: 10,
  };
  const config = { dataDir, projectRoot, runnerMode: 'docker', allowHostRunner: false };
  const options = (extra = {}) => ({
    run: { id: randomUUID(), projectId: project.id },
    project,
    config,
    ...extra,
  });
  return { root, directory, project, config, options };
}

test('runs real git pull and rm in the existing project without Docker or host-runner opt-in', async (t) => {
  const f = await fixture(t);
  const origin = path.join(f.root, 'origin');
  await fs.mkdir(origin);
  const git = (args) => runProcess('git', args, { cwd: origin });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'flow@example.invalid']);
  await git(['config', 'user.name', 'Flow test']);
  await fs.writeFile(path.join(origin, 'index.php'), '<?php echo "first";');
  await git(['add', '.']);
  await git(['commit', '-m', 'first']);
  await fs.rm(f.directory, { recursive: true });
  await runProcess('git', ['clone', origin, f.directory]);
  await fs.writeFile(path.join(origin, 'index.php'), '<?php echo "updated";');
  await git(['commit', '-am', 'second']);
  await fs.writeFile(path.join(f.directory, 'cache.tmp'), 'remove me');
  f.project.commands = 'git pull --ff-only\nrm -f cache.tmp\nprintf "released\\n"';
  const stages = [];
  let logs = '';
  const result = await executeCommands(
    f.options({
      onStage: (value) => stages.push(value),
      onLog: (value) => {
        logs += value;
      },
    }),
  );
  assert.deepEqual(stages, ['prepare', 'commands']);
  assert.equal(result.releasePath, f.directory);
  assert.match(await fs.readFile(path.join(f.directory, 'index.php'), 'utf8'), /updated/);
  await assert.rejects(fs.stat(path.join(f.directory, 'cache.tmp')), { code: 'ENOENT' });
  assert.match(logs, /released/);
  assert.equal(await fs.stat(path.join(f.directory, 'current')).catch(() => null), null);
});

test('sh -e stops at the first failed command and keeps already completed changes', async (t) => {
  const f = await fixture(t);
  f.project.commands = 'printf first > first.txt\nfalse\nprintf never > never.txt';
  await assert.rejects(executeCommands(f.options()), (error) => error.exitCode === 1);
  assert.equal(await fs.readFile(path.join(f.directory, 'first.txt'), 'utf8'), 'first');
  await assert.rejects(fs.stat(path.join(f.directory, 'never.txt')), { code: 'ENOENT' });
});

test('inherits only PATH/HOME/LANG and applies configured environment without shell expansion', async (t) => {
  const f = await fixture(t);
  const previous = {};
  for (const key of [
    'FLOW_SETUP_TOKEN',
    'FLOW_MASTER_KEY',
    'UNRELATED_PRODUCTION_SECRET',
    'SSH_AUTH_SOCK',
  ]) {
    previous[key] = process.env[key];
    process.env[key] = 'must-not-inherit';
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  f.project.environment = { MESSAGE: "with ' quote; $HOME $(false)" };
  f.project.commands = `printf '%s\\n' "$MESSAGE" "\${FLOW_SETUP_TOKEN-unset}" "\${FLOW_MASTER_KEY-unset}" "\${UNRELATED_PRODUCTION_SECRET-unset}" "\${SSH_AUTH_SOCK-unset}" > environment.txt`;
  await executeCommands(f.options());
  assert.equal(
    await fs.readFile(path.join(f.directory, 'environment.txt'), 'utf8'),
    `${f.project.environment.MESSAGE}\nunset\nunset\nunset\nunset\n`,
  );
});

test('rejects missing directories, files, broad roots and aliases to platform data/source', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'missing');
  f.project.deploy.root = missing;
  await assert.rejects(executeCommands(f.options()), /工作目录不存在/);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  const file = path.join(f.root, 'file');
  await fs.writeFile(file, 'x');
  f.project.deploy.root = file;
  await assert.rejects(executeCommands(f.options()), /已存在的目录/);
  for (const value of [
    '/',
    '/var/www',
    '/www/wwwroot',
    f.config.dataDir,
    f.config.projectRoot,
    f.root,
    path.join(projectRoot, 'tests'),
  ]) {
    f.project.deploy.root = value;
    await assert.rejects(executeCommands(f.options()), /根目录|公共父目录|平台源码或数据目录/);
  }
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.config.dataDir, alias);
  f.project.deploy.root = alias;
  await assert.rejects(executeCommands(f.options()), /平台源码或数据目录/);
});

test('requires explicit command type and rejects reserved or multiline environment', async (t) => {
  const f = await fixture(t);
  f.project.type = 'node';
  await assert.rejects(executeCommands(f.options()), /显式的自定义命令/);
  f.project.type = 'command';
  f.project.environment = { HOME: '/tmp' };
  await assert.rejects(executeCommands(f.options()), /保留变量/);
  f.project.environment = { MESSAGE: 'one\ntwo' };
  await assert.rejects(executeCommands(f.options()), /值包含换行/);
});

test('cancellation stops the command process group and timeout is enforced', async (t) => {
  const f = await fixture(t);
  f.project.commands = `printf 'started\\n'\n${quote(process.execPath)} -e 'setInterval(()=>{},1000)'\nprintf never > never.txt`;
  const controller = new AbortController();
  await assert.rejects(
    executeCommands(
      f.options({
        signal: controller.signal,
        onLog: (value) => {
          if (value === 'started\n') controller.abort(new DOMException('Cancelled', 'AbortError'));
        },
      }),
    ),
    { name: 'AbortError' },
  );
  await assert.rejects(fs.stat(path.join(f.directory, 'never.txt')), { code: 'ENOENT' });
  f.project.timeoutSeconds = 1;
  await assert.rejects(executeCommands(f.options()), { name: 'TimeoutError' });
});

async function mockSsh(t, f, { withSetsid = false, denyCdTo = [] } = {}) {
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  const trace = path.join(f.root, 'ssh-trace.json');
  const script = `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const args=process.argv.slice(2);const keyPath=args.includes('-i')?args[args.indexOf('-i')+1]:null;const hosts=args.find(x=>x.startsWith('UserKnownHostsFile='))?.slice('UserKnownHostsFile='.length);const passwordFile=process.env.FLOW_SSH_PASSWORD_FILE;const askpass=process.env.SSH_ASKPASS;
const passwordResult=askpass?cp.execFileSync(askpass,['Password:'],{env:process.env,encoding:'utf8'}):null;
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,input,env:process.env,keyPath,keyMode:keyPath?fs.statSync(keyPath).mode&511:null,key:keyPath?fs.readFileSync(keyPath,'utf8'):null,hosts:hosts?fs.readFileSync(hosts,'utf8'):null,passwordFile,passwordMode:passwordFile?fs.statSync(passwordFile).mode&511:null,askpassMode:askpass?fs.statSync(askpass).mode&511:null,passwordHash:passwordResult?require('node:crypto').createHash('sha256').update(passwordResult).digest('hex'):null})+'\\n');
const prefix=${JSON.stringify(denyCdTo.length ? `cd() { case "$2" in ${denyCdTo.map(quote).join('|')}) printf '%s\\n' 'Permission denied' >&2; return 1 ;; esac; command cd "$@"; }\n` : '')};
const child=cp.spawn('/bin/sh',['-c',args.at(-1)],{env:{...process.env,UNRELATED_REMOTE_SECRET:'must-not-inherit'},stdio:['pipe','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.end(prefix+input);child.on('exit',code=>process.exit(code??1));
});
`;
  await fs.writeFile(path.join(bin, 'ssh'), script, { mode: 0o755 });
  if (withSetsid) {
    await fs.writeFile(
      path.join(bin, 'setsid'),
      `#!/usr/bin/env node\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='--help'){console.log('--wait');process.exit(0);}if(args[0]==='--wait')args.shift();const c=cp.spawn(args[0],args.slice(1),{detached:true,stdio:'inherit'});c.on('exit',code=>process.exit(code??1));\n`,
      { mode: 0o755 },
    );
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  return trace;
}

test('mock SSH verifies strict host checks, stdin-only commands/env, quoting, and temporary key cleanup', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "client's website");
  await fs.mkdir(directory);
  const credentialId = randomUUID();
  const privateKey =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only-key\n-----END OPENSSH PRIVATE KEY-----';
  const credentials = {
    [credentialId]: {
      type: 'ssh',
      privateKey,
      knownHosts: 'example.invalid ssh-ed25519 fixture-key',
    },
  };
  const trace = await mockSsh(t, f);
  f.project.deploy = {
    type: 'ssh',
    root: directory,
    host: 'example.invalid',
    user: 'deploy',
    port: 2222,
    credentialId,
  };
  f.project.environment = { TOKEN: "secret with ' quote $HOME" };
  f.project.commands = `printf '%s\\n' "$TOKEN" "\${UNRELATED_REMOTE_SECRET-unset}" > result.txt\nprintf 'remote done\\n'`;
  let logs = '';
  await executeCommands(
    f.options({
      credentials,
      onLog: (value) => {
        logs += value;
      },
    }),
  );
  const captured = JSON.parse((await fs.readFile(trace, 'utf8')).trim());
  assert.ok(captured.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(captured.args.includes('ForwardAgent=no'));
  assert.ok(captured.args.includes('IdentitiesOnly=yes'));
  assert.ok(captured.args.includes('2222'));
  assert.equal(captured.keyMode, 0o600);
  assert.equal(captured.key.trim(), privateKey);
  assert.match(captured.hosts, /example.invalid/);
  assert.equal(captured.args.join(' ').includes(f.project.environment.TOKEN), false);
  assert.equal(captured.args.join(' ').includes('result.txt'), false);
  assert.equal(captured.input.includes(privateKey), false);
  assert.equal(captured.env.SSH_AUTH_SOCK, undefined);
  assert.equal(
    await fs.readFile(path.join(directory, 'result.txt'), 'utf8'),
    `${f.project.environment.TOKEN}\nunset\n`,
  );
  assert.match(logs, /remote done/);
  assert.equal(logs.includes('__FLOW_LITE_CONTROL_'), false);
  await assert.rejects(fs.stat(captured.keyPath), { code: 'ENOENT' });
});

test('mock SSH cancellation sends a second connection to terminate the remote session group', async (t) => {
  const f = await fixture(t);
  const trace = await mockSsh(t, f, { withSetsid: true });
  const sentinel = path.join(f.directory, 'remote-orphan-survived');
  const credentialId = randomUUID();
  const credentials = {
    [credentialId]: {
      type: 'ssh',
      privateKey: 'fixture-only-key',
      knownHosts: 'example.invalid ssh-ed25519 key',
    },
  };
  f.project.deploy = {
    type: 'ssh',
    root: f.directory,
    host: 'example.invalid',
    user: 'deploy',
    credentialId,
  };
  const childScript = `process.on('SIGTERM',()=>{});process.stdout.write('remote started\\n');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad'),2000);setInterval(()=>{},1000)`;
  f.project.commands = `${quote(process.execPath)} -e ${quote(childScript)}`;
  const controller = new AbortController();
  let logs = '';
  await assert.rejects(
    executeCommands(
      f.options({
        credentials,
        signal: controller.signal,
        onLog: (value) => {
          logs += value;
          if (value === 'remote started\n')
            controller.abort(new DOMException('Cancelled', 'AbortError'));
        },
      }),
    ),
    { name: 'AbortError' },
  );
  const connections = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(connections.length, 2);
  assert.match(connections[0].args.at(-1), /setsid --wait \/bin\/sh -e/);
  assert.match(connections[1].input, /\/bin\/kill -TERM -- '-\d+'/);
  assert.match(connections[1].input, /\/bin\/kill -KILL -- '-\d+'/);
  assert.match(logs, /已经完成的文件修改不会自动撤销/);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
});

test('mock SSH session waits for the script and propagates a failing command status', async (t) => {
  const f = await fixture(t);
  const trace = await mockSsh(t, f, { withSetsid: true });
  const credentialId = randomUUID();
  const credentials = {
    [credentialId]: {
      type: 'ssh',
      privateKey: 'fixture-only-key',
      knownHosts: 'example.invalid ssh-ed25519 key',
    },
  };
  f.project.deploy = {
    type: 'ssh',
    root: f.directory,
    host: 'example.invalid',
    user: 'deploy',
    credentialId,
  };
  f.project.commands = 'printf first > first.txt\nfalse\nprintf never > never.txt';
  await assert.rejects(
    executeCommands(f.options({ credentials })),
    (error) => error.exitCode === 1,
  );
  assert.equal(await fs.readFile(path.join(f.directory, 'first.txt'), 'utf8'), 'first');
  await assert.rejects(fs.stat(path.join(f.directory, 'never.txt')), { code: 'ENOENT' });
  const captured = JSON.parse((await fs.readFile(trace, 'utf8')).trim());
  assert.match(captured.args.at(-1), /setsid --wait \/bin\/sh -e/);
});

async function assertPasswordConnection(captured, password) {
  assert.ok(captured.args.includes('BatchMode=no'));
  assert.ok(captured.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(captured.args.includes('NumberOfPasswordPrompts=1'));
  assert.equal(captured.args.join(' ').includes(password), false);
  assert.equal(
    Object.values(captured.env).some((value) => value.includes(password)),
    false,
  );
  assert.equal(captured.input.includes(password), false);
  assert.equal(captured.passwordMode, 0o600);
  assert.equal(captured.askpassMode, 0o700);
  assert.equal(captured.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(captured.passwordHash, createHash('sha256').update(`${password}\n`).digest('hex'));
  await assert.rejects(fs.stat(captured.passwordFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(captured.env.SSH_ASKPASS), { code: 'ENOENT' });
}

for (const succeeds of [true, false])
  test(`mock SSH root/password ${succeeds ? 'success' : 'failure'} keeps secrets out of argv/env and removes temporary auth files`, async (t) => {
    const f = await fixture(t);
    const trace = await mockSsh(t, f);
    const credentialId = randomUUID();
    const password = `Fixture-password-${randomUUID()}!$'`;
    const credentials = {
      [credentialId]: {
        type: 'ssh',
        authType: 'password',
        password,
        knownHosts: 'example.invalid ssh-ed25519 fixture',
      },
    };
    f.project.deploy = {
      type: 'ssh',
      root: f.directory,
      host: 'example.invalid',
      user: 'root',
      credentialId,
    };
    f.project.commands = succeeds
      ? 'printf "%s" "${FLOW_SSH_PASSWORD_FILE-unset}" > result.txt'
      : 'false\nprintf never > never.txt';
    if (succeeds) {
      await executeCommands(f.options({ credentials }));
      assert.equal(await fs.readFile(path.join(f.directory, 'result.txt'), 'utf8'), 'unset');
    } else
      await assert.rejects(
        executeCommands(f.options({ credentials })),
        (error) => error.exitCode === 1,
      );
    const captured = JSON.parse((await fs.readFile(trace, 'utf8')).trim());
    assert.ok(captured.args.includes('root@example.invalid'));
    await assertPasswordConnection(captured, password);
  });

test('mock SSH password cancellation authenticates the second connection and cleans both password paths', async (t) => {
  const f = await fixture(t);
  const trace = await mockSsh(t, f, { withSetsid: true });
  const credentialId = randomUUID();
  const password = `Cancel-password-${randomUUID()}!`;
  const credentials = {
    [credentialId]: {
      type: 'ssh',
      authType: 'password',
      password,
      knownHosts: 'example.invalid ssh-ed25519 fixture',
    },
  };
  f.project.deploy = {
    type: 'ssh',
    root: f.directory,
    host: 'example.invalid',
    user: 'root',
    credentialId,
  };
  f.project.commands = `${quote(process.execPath)} -e "process.stdout.write('password started\\n');setInterval(()=>{},1000)"`;
  const controller = new AbortController();
  await assert.rejects(
    executeCommands(
      f.options({
        credentials,
        signal: controller.signal,
        onLog: (value) => {
          if (value === 'password started\n')
            controller.abort(new DOMException('Cancelled', 'AbortError'));
        },
      }),
    ),
    { name: 'AbortError' },
  );
  const connections = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(connections.length, 2);
  for (const captured of connections) await assertPasswordConnection(captured, password);
  assert.match(connections[1].input, /\/bin\/kill -TERM/);
});

test('remote commands tolerate inaccessible protected directories while retaining normalized overlap checks', async (t) => {
  const f = await fixture(t);
  await mockSsh(t, f, { denyCdTo: [f.config.dataDir, f.config.projectRoot] });
  const credentialId = randomUUID();
  const credentials = {
    [credentialId]: {
      type: 'ssh',
      privateKey: 'fixture-only-key',
      knownHosts: 'example.invalid ssh-ed25519 fixture',
    },
  };
  f.project.deploy = {
    type: 'ssh',
    root: f.directory,
    host: 'example.invalid',
    user: 'deploy',
    credentialId,
  };
  f.project.commands = 'printf accessible > result.txt';
  await executeCommands(f.options({ credentials }));
  assert.equal(await fs.readFile(path.join(f.directory, 'result.txt'), 'utf8'), 'accessible');
  // This parent contains the known private data path. Even when cd into that
  // private path fails, its normalized path must still block an overlapping cwd.
  f.project.deploy.root = f.root;
  f.project.commands = 'printf forbidden > must-not-run.txt';
  await assert.rejects(
    executeCommands(f.options({ credentials })),
    (error) => error.exitCode === 1,
  );
  await assert.rejects(fs.stat(path.join(f.root, 'must-not-run.txt')), { code: 'ENOENT' });
});
