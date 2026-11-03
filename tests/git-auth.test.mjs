import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../server/lib/process.mjs';
import { prepareGitHttpsAuth } from '../server/runners/git-auth.mjs';
import { createGitHttpsFixture } from './helpers/git-https.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-git-auth-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const credential = {
  type: 'git-https',
  authType: 'password',
  username: ' developer+ci@example.invalid ',
  password: "  token '$HOME:@/+=; value  ",
};
const base = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' });

test('real git credential fill handles special characters and only releases the bound HTTPS host/port/path', async (t) => {
  const tempDir = await temporary(t);
  const auth = await prepareGitHttpsAuth({
    credential,
    repoUrl: 'https://example.invalid:8443/team/repo.git/',
    tempDir,
    env: base(),
  });
  const input = 'protocol=https\nhost=example.invalid:8443\npath=team/repo.git\n\n';
  const filled = await runProcess('git', ['credential', 'fill'], {
    env: auth.env,
    cwd: tempDir,
    input,
  });
  assert.ok(filled.stdout.includes(`username=${credential.username.trim()}\n`));
  assert.ok(filled.stdout.includes(`password=${credential.password}\n`));
  for (const other of [
    input.replace('8443', '9443'),
    input.replace('example.invalid', 'other.invalid'),
    input.replace('repo.git', 'repo.git-other'),
    input.replace('https', 'http'),
    `${input.trim()}\nusername=another-user\n\n`,
  ]) {
    await assert.rejects(
      runProcess('git', ['credential', 'fill'], { env: auth.env, cwd: tempDir, input: other }),
    );
  }
  assert.equal(
    Object.values(auth.env).some((value) => value.includes(credential.password)),
    false,
  );
  const authDirectory = path.dirname(auth.env.FLOW_GIT_CREDENTIAL_FILE);
  assert.equal((await fs.stat(authDirectory)).mode & 0o777, 0o700);
  for (const file of await fs.readdir(authDirectory))
    assert.equal((await fs.stat(path.join(authDirectory, file))).mode & 0o777, 0o600);
  const before = await fs.readFile(auth.env.FLOW_GIT_CREDENTIAL_FILE, 'utf8');
  for (const operation of ['approve', 'reject'])
    await runProcess('git', ['credential', operation], {
      env: auth.env,
      cwd: tempDir,
      input: `${input.trim()}\nusername=${credential.username.trim()}\npassword=${credential.password}\n\n`,
    });
  assert.equal(await fs.readFile(auth.env.FLOW_GIT_CREDENTIAL_FILE, 'utf8'), before);
  await auth.cleanup();
  await auth.cleanup();
  await assert.rejects(fs.stat(authDirectory), { code: 'ENOENT' });
});

test('HTTPS helper resets inherited helpers and preserves TLS verification', async (t) => {
  const tempDir = await temporary(t);
  const auth = await prepareGitHttpsAuth({
    credential,
    repoUrl: 'https://example.invalid/team/repo.git',
    tempDir,
    env: {
      ...base(),
      GIT_SSL_NO_VERIFY: 'true',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'store',
    },
  });
  assert.equal(auth.env.GIT_SSL_NO_VERIFY, undefined);
  assert.equal(auth.env.GIT_CONFIG_VALUE_0, '');
  const config = await runProcess(
    'git',
    ['config', '--get-regexp', '^(http\\.(sslverify|followredirects)|credential\\.usehttppath)$'],
    { env: auth.env, cwd: tempDir },
  );
  assert.match(config.stdout, /http.sslverify true/);
  assert.match(config.stdout, /http.followredirects false/);
  assert.match(config.stdout, /credential.usehttppath true/);
  await auth.cleanup();
});

test('real TLS smart HTTP clone authenticates, keeps origin/config clean, and rejects invalid passwords and redirects', async (t) => {
  const fixture = await createGitHttpsFixture(t);
  const tempDir = await temporary(t);
  const credentials = {
    type: 'git-https',
    authType: 'password',
    username: fixture.username,
    password: fixture.password,
  };
  const auth = await prepareGitHttpsAuth({
    credential: credentials,
    repoUrl: fixture.url,
    tempDir,
    env: base(),
  });
  const clone = path.join(tempDir, 'clone');
  await runProcess(fixture.realGit, ['clone', '--depth', '1', '--', fixture.url, clone], {
    env: fixture.trust(auth.env),
  });
  assert.equal(await fs.readFile(path.join(clone, 'README.txt'), 'utf8'), 'real TLS Git fixture\n');
  const config = await fs.readFile(path.join(clone, '.git/config'), 'utf8');
  assert.ok(config.includes(fixture.url));
  assert.equal(config.includes(fixture.password), false);
  assert.equal(config.includes('credential'), false);
  assert.equal(config.includes('helper.cjs'), false);
  await runProcess(
    fixture.realGit,
    ['clone', '--depth', '1', '--', `${fixture.url}/`, path.join(tempDir, 'trailing-slash')],
    { env: fixture.trust(auth.env) },
  );
  await auth.cleanup();
  const wrong = await prepareGitHttpsAuth({
    credential: { ...credentials, password: 'wrong-password' },
    repoUrl: fixture.url,
    tempDir,
    env: base(),
  });
  await assert.rejects(
    runProcess(fixture.realGit, ['clone', '--', fixture.url, path.join(tempDir, 'wrong')], {
      env: fixture.trust(wrong.env),
    }),
  );
  await wrong.cleanup();
  const redirectUrl = fixture.url.replace('/team/repo.git', '/redirect.git');
  const redirect = await prepareGitHttpsAuth({
    credential: credentials,
    repoUrl: redirectUrl,
    tempDir,
    env: base(),
  });
  await assert.rejects(
    runProcess(fixture.realGit, ['clone', '--', redirectUrl, path.join(tempDir, 'redirect')], {
      env: fixture.trust(redirect.env),
    }),
  );
  await redirect.cleanup();
  assert.equal(
    fixture.requests.some(
      (request) => request.pathname.startsWith('/redirect.git') && request.authenticated,
    ),
    true,
  );
  assert.equal(
    fixture.requests.some((request) => request.pathname.includes('other.git')),
    false,
  );
  const untrusted = await prepareGitHttpsAuth({
    credential: credentials,
    repoUrl: fixture.url,
    tempDir,
    env: base(),
  });
  await assert.rejects(
    runProcess(fixture.realGit, ['clone', '--', fixture.url, path.join(tempDir, 'untrusted')], {
      env: untrusted.env,
    }),
  );
  await untrusted.cleanup();
  assert.ok(fixture.requests.some((request) => request.authenticated));
});

test('Git HTTPS helper refuses wrong types, unsafe URLs, usernames and multiline secrets', async (t) => {
  const tempDir = await temporary(t);
  for (const repoUrl of [
    'http://example.invalid/repo.git',
    'ssh://example.invalid/repo.git',
    'https://name:secret@example.invalid/repo.git',
    'https://example.invalid/repo.git?token=value',
  ])
    await assert.rejects(prepareGitHttpsAuth({ credential, repoUrl, tempDir }));
  for (const invalid of [
    { ...credential, type: 'ssh' },
    { ...credential, username: 'with:colon' },
    { ...credential, password: 'line\nbreak' },
  ])
    await assert.rejects(
      prepareGitHttpsAuth({
        credential: invalid,
        repoUrl: 'https://example.invalid/repo.git',
        tempDir,
      }),
    );
});
