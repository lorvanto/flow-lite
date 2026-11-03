import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSshAuth } from '../server/runners/ssh-auth.mjs';

const exec = promisify(execFile);
async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-ssh-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('password auth keeps secrets in a 0600 file and askpass reads only its path', async (t) => {
  const tempDir = await temp(t);
  const password = " space ' quote $HOME $(false) password " + Date.now();
  const result = await prepareSshAuth({
    credential: {
      type: 'ssh',
      authType: 'password',
      password,
      knownHosts: 'example.invalid ssh-ed25519 fixture',
    },
    tempDir,
    prefix: 'test',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.ok(result.args.includes('BatchMode=no'));
  assert.ok(result.args.includes('PreferredAuthentications=password,keyboard-interactive'));
  assert.ok(result.args.includes('NumberOfPasswordPrompts=1'));
  assert.ok(result.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(result.args.includes('PubkeyAuthentication=no'));
  assert.equal(result.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(result.args.join(' ').includes(password), false);
  assert.equal(
    Object.values(result.env).some((value) => value.includes(password)),
    false,
  );
  assert.equal((await fs.stat(result.env.FLOW_SSH_PASSWORD_FILE)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(result.env.SSH_ASKPASS)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(tempDir)).mode & 0o777, 0o700);
  const script = await fs.readFile(result.env.SSH_ASKPASS, 'utf8');
  assert.equal(script.includes(password), false);
  assert.match(script, /FLOW_SSH_PASSWORD_FILE/);
  assert.equal(await fs.readFile(result.env.FLOW_SSH_PASSWORD_FILE, 'utf8'), `${password}\n`);
  assert.equal(
    (await exec(result.env.SSH_ASKPASS, ['Password:'], { env: result.env })).stdout,
    `${password}\n`,
  );
  assert.equal((await fs.stat(path.join(tempDir, 'test.known_hosts'))).mode & 0o777, 0o600);
});

test('old credentials without authType remain key-only and retain strict host checking', async (t) => {
  const tempDir = await temp(t);
  const credential = {
    type: 'ssh',
    privateKey: 'fixture-key\n',
    knownHosts: 'example.invalid ssh-ed25519 fixture',
  };
  const result = await prepareSshAuth({ credential, tempDir, env: { HOME: '/home/flow' } });
  assert.ok(result.args.includes('BatchMode=yes'));
  assert.ok(result.args.includes('IdentitiesOnly=yes'));
  assert.ok(result.args.includes('StrictHostKeyChecking=yes'));
  assert.equal(result.env.SSH_ASKPASS, undefined);
  assert.equal(result.env.FLOW_SSH_PASSWORD_FILE, undefined);
  assert.equal((await fs.stat(path.join(tempDir, 'ssh.key'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(tempDir, 'ssh.key'), 'utf8'), credential.privateKey);
});

test('system-key fallback stays noninteractive and password mode rejects incomplete credentials', async (t) => {
  const tempDir = await temp(t);
  const result = await prepareSshAuth({ credential: null, tempDir });
  assert.ok(result.args.includes('BatchMode=yes'));
  assert.ok(result.args.includes('StrictHostKeyChecking=yes'));
  for (const credential of [
    { type: 'ssh', authType: 'password', password: '' },
    { type: 'ssh', authType: 'password', password: 'line\nbreak' },
    { type: 'ssh', authType: 'unknown' },
    { type: 'ssh' },
  ]) {
    await assert.rejects(prepareSshAuth({ credential, tempDir }));
  }
});
