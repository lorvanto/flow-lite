import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { secretValues, createLogWriter, redactText } from '../server/lib/logs.mjs';

test('SSH passwords are redacted from streamed logs and errors, preserving leading and trailing spaces', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-password-redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const password = '  pass-$()"-secret  ';
  const credentials = {
    one: { type: 'ssh', authType: 'password', password },
    two: {
      type: 'ssh',
      privateKey: '-----BEGIN PRIVATE KEY-----\nlegacy-key-body\n-----END PRIVATE KEY-----',
    },
  };
  const secrets = secretValues({ environment: { TOKEN: 'environment-token' } }, credentials);
  assert.ok(secrets.includes(password));
  assert.ok(secrets.includes('legacy-key-body'));
  const file = path.join(root, 'task.log');
  const writer = createLogWriter(file, secrets);
  const output = `prefix:${password}:suffix\nenvironment-token\nlegacy-key-body\n`;
  for (const char of output) writer.write(char);
  writer.close();
  assert.equal(
    await fs.readFile(file, 'utf8'),
    'prefix:[REDACTED]:suffix\n[REDACTED]\n[REDACTED]\n',
  );
  assert.equal(
    redactText(`authentication failed: ${password}`, secrets),
    'authentication failed: [REDACTED]',
  );
});

test('short SSH passwords are collected once for both object and Map credentials', () => {
  const credential = { type: 'ssh', authType: 'password', password: 'z' };
  for (const credentials of [
    { one: credential, two: credential },
    new Map([
      ['one', credential],
      ['two', credential],
    ]),
  ]) {
    const secrets = secretValues({ environment: {} }, credentials);
    assert.deepEqual(secrets, ['z']);
    assert.equal(redactText('value=z', secrets), 'value=[REDACTED]');
  }
});

test('Git HTTPS passwords, URL-encoded values and Basic auth are redacted across log chunks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-git-redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const username = 'fixture-account';
  const password = '  fixture-token:/%中文  ';
  const encoded = encodeURIComponent(password);
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  const secrets = secretValues(
    { environment: {} },
    new Map([['git', { type: 'git-https', authType: 'password', username, password }]]),
  );
  for (const value of [password, encoded, basic]) assert.ok(secrets.includes(value));
  const file = path.join(root, 'task.log');
  const writer = createLogWriter(file, secrets);
  for (const char of `${password}\n${encoded}\nAuthorization: Basic ${basic}\n`) writer.write(char);
  writer.close();
  assert.equal(
    await fs.readFile(file, 'utf8'),
    '[REDACTED]\n[REDACTED]\nAuthorization: Basic [REDACTED]\n',
  );
  assert.equal(
    redactText(`authentication failed: ${basic}`, secrets),
    'authentication failed: [REDACTED]',
  );
});
