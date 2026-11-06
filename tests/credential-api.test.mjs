import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { encrypt } from '../server/lib/crypto.mjs';

const fixtureKey =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only-private-key-body\n-----END OPENSSH PRIVATE KEY-----\n';

test('approved HTTP projects use existing Git account credentials and reject SSH or missing credentials', async (t) => {
  const f = await fixture(t);
  const gitCredential = (
    await f.request('POST', '/api/credentials', {
      name: 'HTTP account fixture',
      type: 'git-https',
      authType: 'password',
      username: 'fixture-user',
      password: 'fixture-http-token',
    })
  ).body.credential;
  const sshCredential = (
    await f.request('POST', '/api/credentials', {
      name: 'SSH fixture',
      type: 'ssh',
      authType: 'password',
      password: 'fixture-ssh',
    })
  ).body.credential;
  for (const slug of ['baking', 'yshop', 'yshopbbc']) {
    const project = {
      name: `HTTP project ${slug}`,
      repoUrl: `http://git.yin-duo.com/mini-program/${slug}.git`,
      deploy: { type: 'local', root: path.join(f.root, slug) },
    };
    assert.equal((await f.request('POST', '/api/projects', project)).code, 400);
    assert.equal(
      (
        await f.request('POST', '/api/projects', {
          ...project,
          buildCredentialId: sshCredential.id,
        })
      ).code,
      400,
    );
    const saved = await f.request('POST', '/api/projects', {
      ...project,
      buildCredentialId: gitCredential.id,
    });
    assert.equal(saved.code, 201);
    assert.equal(saved.body.project.repoUrl, project.repoUrl);
    assert.equal(saved.body.project.buildCredentialId, gitCredential.id);
  }
  metadataOnly(gitCredential);
  const project = {
    name: 'HTTP rejected fixture',
    repoUrl: 'http://git.yin-duo.com/mini-program/baking.git',
    deploy: { type: 'local', root: path.join(f.root, 'site') },
  };
  for (const repoUrl of [
    project.repoUrl + '?token=x',
    project.repoUrl.replace('git.yin-duo.com', 'other.invalid'),
    project.repoUrl.replace('baking.git', 'hanfu.git'),
    'http://git.yin-duo.com/mini-program/yshop-extra.git',
    'http://git.yin-duo.com/other/yshopbbc.git',
  ])
    assert.equal(
      (
        await f.request('POST', '/api/projects', {
          ...project,
          repoUrl,
          buildCredentialId: gitCredential.id,
        })
      ).code,
      400,
    );
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-credential-api-'));
  const config = getConfig({
    dataDir: path.join(root, 'data'),
    setupToken: 'credential-test-setup-token',
  });
  const app = await createApp(config);
  let cookie;
  const request = async (method, url, payload) => {
    const response = await app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
    if (response.headers['set-cookie'])
      cookie = String(response.headers['set-cookie']).split(';')[0];
    return { code: response.statusCode, body: response.json() };
  };
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(
    (
      await request('POST', '/api/auth/setup', {
        username: 'admin',
        password: 'fixture-admin-password',
        setupToken: config.setupToken,
      })
    ).code,
    200,
  );
  return { root, config, app, request };
}

function metadataOnly(credential) {
  assert.equal(Object.hasOwn(credential, 'password'), false);
  assert.equal(Object.hasOwn(credential, 'privateKey'), false);
  assert.deepEqual(
    Object.keys(credential).sort(),
    ['id', 'name', 'type', 'authType', 'createdAt', 'hasKnownHosts'].sort(),
  );
}

test('SSH 密码凭据原样加密保存，API 仅返回认证类型和元数据', async (t) => {
  const f = await fixture(t);
  const password = '  fixture-only "quoted" $dollar \\slash  ';
  const knownHosts = 'example.invalid ssh-ed25519 fixture-only-host-key';
  const result = await f.request('POST', '/api/credentials', {
    name: '密码凭据',
    type: 'ssh',
    authType: 'password',
    password,
    privateKey: fixtureKey,
    knownHosts,
  });
  assert.equal(result.code, 201);
  const credential = result.body.credential;
  metadataOnly(credential);
  assert.equal(credential.authType, 'password');
  assert.equal(credential.hasKnownHosts, true);
  const stored = f.app.store.getCredential(credential.id);
  assert.equal(stored.password, password);
  assert.equal(stored.authType, 'password');
  assert.equal(Object.hasOwn(stored, 'privateKey'), false);
  const raw = f.app.store.db
    .prepare('SELECT secret FROM credentials WHERE id=?')
    .get(credential.id).secret;
  assert.equal(raw.includes(password), false);
  assert.equal(raw.includes('fixture-only'), false);
  const list = await f.request('GET', '/api/credentials');
  assert.equal(list.code, 200);
  assert.equal(list.body.credentials.length, 1);
  metadataOnly(list.body.credentials[0]);
  assert.equal(list.body.credentials[0].authType, 'password');
});

test('SSH 密码校验拒绝空值、超长与换行，保留合法空格密码', async (t) => {
  const f = await fixture(t);
  for (const password of [
    undefined,
    null,
    123,
    '',
    'x'.repeat(1025),
    'fixture\0secret',
    'fixture\rsecret',
    'fixture\nsecret',
  ]) {
    const result = await f.request('POST', '/api/credentials', {
      name: '无效密码',
      type: 'ssh',
      authType: 'password',
      password,
    });
    assert.equal(result.code, 400);
    assert.match(result.body.error, /SSH 密码/);
  }
  assert.equal(
    (
      await f.request('POST', '/api/credentials', {
        name: '无效类型',
        type: 'ssh',
        authType: 'other',
        password: 'fixture-only',
      })
    ).code,
    400,
  );
  assert.equal((await f.request('GET', '/api/credentials')).body.credentials.length, 0);
  for (const password of ['   ', 'x'.repeat(1024)]) {
    const result = await f.request('POST', '/api/credentials', {
      name: '有效密码',
      type: 'ssh',
      authType: 'password',
      password,
    });
    assert.equal(result.code, 201);
    assert.equal(f.app.store.getCredential(result.body.credential.id).password, password);
    metadataOnly(result.body.credential);
  }
});

test('旧私钥凭据缺省 key 认证，历史加密记录无需迁移且不返回私钥', async (t) => {
  const f = await fixture(t);
  const result = await f.request('POST', '/api/credentials', {
    name: '旧私钥',
    type: 'ssh',
    privateKey: fixtureKey,
    password: 'must-not-be-stored',
  });
  assert.equal(result.code, 201);
  const id = result.body.credential.id;
  assert.equal(result.body.credential.authType, 'key');
  metadataOnly(result.body.credential);
  assert.equal(f.app.store.getCredential(id).privateKey, fixtureKey);
  assert.equal(Object.hasOwn(f.app.store.getCredential(id), 'password'), false);

  // Model a pre-authType credential already present on disk.
  f.app.store.db
    .prepare('UPDATE credentials SET secret=? WHERE id=?')
    .run(encrypt({ privateKey: fixtureKey, knownHosts: '' }, f.config.masterKey), id);
  assert.equal(f.app.store.getCredential(id).authType, 'key');
  assert.equal(f.app.store.getCredential(id).privateKey, fixtureKey);
  const listed = (await f.request('GET', '/api/credentials')).body.credentials[0];
  assert.equal(listed.authType, 'key');
  metadataOnly(listed);
});

test('root 用户可引用密码凭据，仓库和远程项目响应不包含认证秘密', async (t) => {
  const f = await fixture(t);
  const password = 'fixture-only-root-password';
  const id = (
    await f.request('POST', '/api/credentials', {
      name: 'root 登录',
      type: 'ssh',
      authType: 'password',
      password,
    })
  ).body.credential.id;
  const command = await f.request('POST', '/api/projects', {
    type: 'command',
    name: '远程命令',
    commands: 'pwd',
    deploy: {
      type: 'ssh',
      host: 'example.invalid',
      port: 22,
      user: 'root',
      root: '/srv/www/fixture',
      credentialId: id,
    },
  });
  assert.equal(command.code, 201);
  assert.equal(command.body.project.deploy.user, 'root');
  assert.equal(command.body.project.deploy.credentialId, id);
  const node = await f.request('POST', '/api/projects', {
    name: '仓库密码',
    repoUrl: 'git@example.invalid:team/web.git',
    buildCredentialId: id,
    deploy: { type: 'local', root: path.join(f.root, 'site') },
  });
  assert.equal(node.code, 201);
  assert.equal(node.body.project.buildCredentialId, id);
  const run = await f.request('POST', `/api/projects/${command.body.project.id}/runs`, {});
  assert.equal(run.code, 202);
  for (const body of [
    command.body,
    node.body,
    run.body,
    (await f.request('GET', '/api/projects')).body,
  ]) {
    assert.equal(JSON.stringify(body).includes(password), false);
    assert.equal(Object.hasOwn(body, 'password'), false);
    assert.equal(Object.hasOwn(body, 'privateKey'), false);
  }
  assert.equal((await f.request('DELETE', `/api/credentials/${id}`)).code, 409);
});

test('Git HTTPS 账号密码完整加密存储，API 和任务响应不回显账号或密码', async (t) => {
  const f = await fixture(t);
  const username = 'fixture-git-account@example.invalid';
  const password = '  fixture-token-"$&:/%中文  ';
  const result = await f.request('POST', '/api/credentials', {
    name: 'HTTPS 仓库',
    type: 'git-https',
    authType: 'password',
    username,
    password,
    privateKey: fixtureKey,
    knownHosts: 'must-not-be-stored',
  });
  assert.equal(result.code, 201);
  const credential = result.body.credential;
  metadataOnly(credential);
  assert.equal(credential.type, 'git-https');
  assert.equal(credential.authType, 'password');
  assert.equal(credential.hasKnownHosts, false);
  assert.equal(Object.hasOwn(credential, 'username'), false);
  const stored = f.app.store.getCredential(credential.id);
  assert.equal(stored.username, username);
  assert.equal(stored.password, password);
  assert.equal(stored.type, 'git-https');
  assert.equal(Object.hasOwn(stored, 'privateKey'), false);
  assert.equal(Object.hasOwn(stored, 'knownHosts'), false);
  const raw = f.app.store.db
    .prepare('SELECT secret FROM credentials WHERE id=?')
    .get(credential.id).secret;
  for (const secret of [username, password, 'fixture-token'])
    assert.equal(raw.includes(secret), false);

  const projectResult = await f.request('POST', '/api/projects', {
    name: 'HTTPS 构建',
    repoUrl: 'https://example.invalid/team/site.git',
    buildCredentialId: credential.id,
    deploy: { type: 'local', root: path.join(f.root, 'https-site') },
  });
  assert.equal(projectResult.code, 201);
  assert.equal(projectResult.body.project.buildCredentialId, credential.id);
  const run = await f.request('POST', `/api/projects/${projectResult.body.project.id}/runs`, {});
  assert.equal(run.code, 202);
  for (const body of [
    result.body,
    projectResult.body,
    run.body,
    (await f.request('GET', '/api/credentials')).body,
    (await f.request('GET', '/api/projects')).body,
  ]) {
    assert.equal(JSON.stringify(body).includes(username), false);
    assert.equal(JSON.stringify(body).includes(password), false);
  }
  assert.equal((await f.request('DELETE', `/api/credentials/${credential.id}`)).code, 409);

  // Reopening the database uses the same encrypted record, without a schema migration.
  const { createStore } = await import('../server/services/store.mjs');
  const reopened = createStore(f.config);
  try {
    assert.equal(reopened.getCredential(credential.id).username, username);
    assert.equal(reopened.getCredential(credential.id).password, password);
    metadataOnly(reopened.listCredentials()[0]);
  } finally {
    reopened.close();
  }
});

test('Git HTTPS 凭据校验账号与密码，拒绝协议不匹配的仓库和 SSH 部署', async (t) => {
  const f = await fixture(t);
  const base = {
    name: 'Git HTTPS',
    type: 'git-https',
    username: 'fixture-user',
    password: 'fixture-token',
  };
  for (const patch of [
    { username: undefined },
    { username: '' },
    { username: '   ' },
    { username: 'bad:name' },
    { username: 'bad\nname' },
    { username: 'bad\tname' },
    { username: 'u'.repeat(256) },
    { password: undefined },
    { password: '' },
    { password: 'p'.repeat(4097) },
    { password: 'bad\0secret' },
    { password: 'bad\rsecret' },
    { password: 'bad\nsecret' },
    { authType: 'key' },
    { type: 'http' },
  ]) {
    assert.equal((await f.request('POST', '/api/credentials', { ...base, ...patch })).code, 400);
  }
  const httpsCredential = (await f.request('POST', '/api/credentials', base)).body.credential;
  const sshCredential = (
    await f.request('POST', '/api/credentials', {
      name: 'SSH',
      type: 'ssh',
      authType: 'password',
      password: 'ssh-fixture-only',
    })
  ).body.credential;
  const project = {
    name: '协议校验',
    repoUrl: 'https://example.invalid/team/site.git',
    deploy: { type: 'local', root: path.join(f.root, 'site') },
  };
  const mismatch = await f.request('POST', '/api/projects', {
    ...project,
    buildCredentialId: sshCredential.id,
  });
  assert.equal(mismatch.code, 400);
  assert.match(mismatch.body.error, /HTTPS.*凭据/);
  assert.equal(
    (
      await f.request('POST', '/api/projects', {
        ...project,
        repoUrl: 'git@example.invalid:team/site.git',
        buildCredentialId: httpsCredential.id,
      })
    ).code,
    400,
  );
  assert.equal(
    (
      await f.request('POST', '/api/projects', {
        ...project,
        deploy: {
          type: 'ssh',
          host: 'example.invalid',
          user: 'root',
          port: 22,
          root: '/srv/www/site',
          credentialId: httpsCredential.id,
        },
      })
    ).code,
    400,
  );
  for (const repoUrl of [
    'http://example.invalid/site.git',
    'https://user:password@example.invalid/site.git',
  ]) {
    assert.equal((await f.request('POST', '/api/projects', { ...project, repoUrl })).code, 400);
  }
  assert.equal((await f.request('POST', '/api/projects', { ...project })).code, 201);
  const valid = await f.request('POST', '/api/projects', {
    ...project,
    buildCredentialId: httpsCredential.id,
  });
  assert.equal(valid.code, 201);
  assert.equal(
    (
      await f.request('PUT', `/api/projects/${valid.body.project.id}`, {
        ...project,
        buildCredentialId: sshCredential.id,
      })
    ).code,
    400,
  );
});
