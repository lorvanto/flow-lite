import fs from 'node:fs/promises';
import path from 'node:path';
import { isAllowedHttpGitRepository } from '../../shared/repository-policy.mjs';

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function repositoryScope(repoUrl) {
  let url;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error('Git HTTPS 仓库地址无效');
  }
  if (
    (url.protocol !== 'https:' && !isAllowedHttpGitRepository(repoUrl)) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Git 账号凭据仅用于 HTTPS 或已批准的 HTTP 仓库，地址不能包含账号、密码、查询参数或片段',
    );
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch {
    throw new Error('Git HTTPS 仓库路径编码无效');
  }
  if (!pathname || /[\x00-\x1f\x7f-\x9f]/.test(pathname)) throw new Error('Git HTTPS 仓库路径无效');
  return { protocol: url.protocol.slice(0, -1), host: url.host.toLowerCase(), path: pathname };
}

// This function is serialized without credentials into the task-local helper.
// Git passes the operation as argv[2] and the credential context over stdin.
function credentialHelperMain() {
  const fs = require('node:fs');
  const operation = process.argv[2];
  if (operation !== 'get') {
    process.stdin.resume();
    return;
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > 65536) process.exit(1);
  });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(
        process.env.FLOW_GIT_CREDENTIAL_DATA ||
          fs.readFileSync(process.env.FLOW_GIT_CREDENTIAL_FILE, 'utf8'),
      );
      const context = {};
      for (const line of input.split('\n')) {
        const equal = line.indexOf('=');
        if (equal > 0) context[line.slice(0, equal)] = line.slice(equal + 1);
      }
      const hostUrl = new URL(`${data.scope.protocol}://${context.host || ''}`);
      const host = hostUrl.host.toLowerCase();
      const pathname = (context.path || '').replace(/^\/+|\/+$/g, '');
      if (
        context.protocol !== data.scope.protocol ||
        /[\\/?#@\x00-\x20\x7f]/.test(context.host || '') ||
        hostUrl.username ||
        hostUrl.password ||
        hostUrl.pathname !== '/' ||
        hostUrl.search ||
        hostUrl.hash ||
        host !== data.scope.host ||
        pathname !== data.scope.path ||
        (data.scope.protocol === 'http' && context.path !== data.scope.path) ||
        (context.username !== undefined && context.username !== data.username)
      ) {
        process.stdout.write('quit=true\n');
        return;
      }
      process.stdout.write(`username=${data.username}\npassword=${data.password}\n`);
    } catch {
      process.stdout.write('quit=true\n');
    }
  });
}

/** Scope Git account auth to one repository. HTTP secrets never go into a file. */
export async function prepareGitHttpsAuth({ credential, repoUrl, tempDir, env = {} }) {
  if (credential?.type !== 'git-https' || credential.authType !== 'password')
    throw new Error('请选择 Git HTTPS 账号密码或令牌凭据');
  const username = typeof credential.username === 'string' ? credential.username.trim() : '';
  if (!username || username.length > 255 || /[:\x00-\x1f\x7f-\x9f]/.test(username))
    throw new Error('Git HTTPS 用户名无效');
  const password = credential.password;
  if (
    typeof password !== 'string' ||
    !password ||
    password.length > 4096 ||
    /[\0\r\n]/.test(password)
  )
    throw new Error('Git HTTPS 密码或令牌无效');
  const scope = repositoryScope(repoUrl);
  const parent = await fs.lstat(tempDir);
  if (!path.isAbsolute(tempDir) || !parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('Git HTTPS 临时目录无效');
  await fs.chmod(tempDir, 0o700);
  const directory = await fs.mkdtemp(path.join(tempDir, 'git-https-'));
  const credentialFile = path.join(directory, 'credential.json');
  const helperFile = path.join(directory, 'helper.cjs');
  let gitEnv;
  const cleanup = () => {
    if (gitEnv) delete gitEnv.FLOW_GIT_CREDENTIAL_DATA;
    return fs.rm(directory, { recursive: true, force: true });
  };
  try {
    await fs.chmod(directory, 0o700);
    const data = JSON.stringify({ scope, username, password });
    if (scope.protocol === 'https')
      await fs.writeFile(credentialFile, data, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(helperFile, `(${credentialHelperMain.toString()})();\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    if (scope.protocol === 'https') await fs.chmod(credentialFile, 0o600);
    await fs.chmod(helperFile, 0o600);
    gitEnv = { ...env };
    for (const key of Object.keys(gitEnv)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete gitEnv[key];
    }
    for (const key of [
      'GIT_CONFIG_PARAMETERS',
      'GIT_SSL_NO_VERIFY',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'FLOW_GIT_CREDENTIAL_DATA',
      'FLOW_GIT_CREDENTIAL_FILE',
    ])
      delete gitEnv[key];
    const configuration = [
      ['credential.helper', ''],
      ['credential.helper', `!${shellQuote(process.execPath)} ${shellQuote(helperFile)}`],
      ['credential.useHttpPath', 'true'],
      ['http.sslVerify', 'true'],
      ['http.followRedirects', 'false'],
      ['http.extraHeader', ''],
      ['http.saveCookies', 'false'],
    ];
    Object.assign(gitEnv, {
      ...(scope.protocol === 'http'
        ? { FLOW_GIT_CREDENTIAL_DATA: data }
        : { FLOW_GIT_CREDENTIAL_FILE: credentialFile }),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: scope.protocol,
      GIT_CONFIG_COUNT: String(configuration.length),
    });
    configuration.forEach(([key, value], index) => {
      gitEnv[`GIT_CONFIG_KEY_${index}`] = key;
      gitEnv[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    return { env: gitEnv, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
