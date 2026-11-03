import fs from 'node:fs/promises';
import path from 'node:path';

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function repositoryScope(repoUrl) {
  let url;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error('Git HTTPS 仓库地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Git HTTPS 凭据仅用于不含账号、密码、查询参数或片段的 HTTPS 仓库地址');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch {
    throw new Error('Git HTTPS 仓库路径编码无效');
  }
  if (!pathname || /[\x00-\x1f\x7f-\x9f]/.test(pathname)) throw new Error('Git HTTPS 仓库路径无效');
  return { protocol: 'https', host: url.host.toLowerCase(), path: pathname };
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
      const data = JSON.parse(fs.readFileSync(process.env.FLOW_GIT_CREDENTIAL_FILE, 'utf8'));
      const context = {};
      for (const line of input.split('\n')) {
        const equal = line.indexOf('=');
        if (equal > 0) context[line.slice(0, equal)] = line.slice(equal + 1);
      }
      const hostUrl = new URL(`https://${context.host || ''}`);
      const host = hostUrl.host.toLowerCase();
      const pathname = (context.path || '').replace(/^\/+|\/+$/g, '');
      if (
        context.protocol !== 'https' ||
        /[\\/?#@\x00-\x20\x7f]/.test(context.host || '') ||
        hostUrl.username ||
        hostUrl.password ||
        hostUrl.pathname !== '/' ||
        hostUrl.search ||
        hostUrl.hash ||
        host !== data.scope.host ||
        pathname !== data.scope.path ||
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

/** Prepare process-only Git HTTPS authentication. No config is written to the repository. */
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
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(credentialFile, JSON.stringify({ scope, username, password }), {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.writeFile(helperFile, `(${credentialHelperMain.toString()})();\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.chmod(credentialFile, 0o600);
    await fs.chmod(helperFile, 0o600);
    const gitEnv = { ...env };
    for (const key of Object.keys(gitEnv)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete gitEnv[key];
    }
    for (const key of ['GIT_CONFIG_PARAMETERS', 'GIT_SSL_NO_VERIFY', 'GIT_ASKPASS', 'SSH_ASKPASS'])
      delete gitEnv[key];
    const configuration = [
      ['credential.helper', ''],
      ['credential.helper', `!${shellQuote(process.execPath)} ${shellQuote(helperFile)}`],
      ['credential.useHttpPath', 'true'],
      ['http.sslVerify', 'true'],
      ['http.followRedirects', 'false'],
      ['http.extraHeader', ''],
    ];
    Object.assign(gitEnv, {
      FLOW_GIT_CREDENTIAL_FILE: credentialFile,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'https',
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
