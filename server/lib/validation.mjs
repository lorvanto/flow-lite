import path from 'node:path';

export function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}
export const isUuid = (value) =>
  typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
const string = (value, label, max = 255, fallback) => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    fail(`${label}格式不正确`);
  return value.trim();
};
const integer = (value, label, min, max, fallback) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    fail(`${label}需要在 ${min}～${max} 之间`);
  return number;
};
function relative(value, label, fallback) {
  const result = string(value, label, 300, fallback);
  if (
    !result ||
    result.startsWith('/') ||
    result.includes('\\') ||
    result.split('/').includes('..')
  )
    fail(`${label}必须为仓库内的相对路径`);
  return result;
}
function credentialId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (!isUuid(value)) fail(`${label}无效`);
  return value;
}
export function validateProject(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('请提交项目配置');
  const name = string(input.name, '项目名称', 100);
  if (!name) fail('请填写项目名称');
  const type = input.type ?? 'node';
  if (!['node', 'command'].includes(type)) fail('流水线类型必须为 Node.js 构建或命令发布');
  const common = {
    type,
    name,
    group: string(input.group, '分组', 80, ''),
    description: string(input.description, '说明', 500, ''),
    deploy: validateDeploy(input.deploy, config),
    environment: validateEnvironment(input.environment, type),
    timeoutSeconds: integer(input.timeoutSeconds, '超时秒数', 30, 7200, 900),
  };
  if (type === 'command') {
    if (
      typeof input.commands !== 'string' ||
      !input.commands.trim() ||
      Buffer.byteLength(input.commands) > 100 * 1024 ||
      input.commands.includes('\0')
    )
      fail('请填写执行命令，最多 100 KB 且不能包含空字符');
    return { ...common, commands: input.commands.replace(/\r\n?/g, '\n'), buildCredentialId: null };
  }
  const repoUrl = string(input.repoUrl, 'Git 仓库地址', 2000);
  if (!repoUrl || /[\r\n\s]/.test(repoUrl) || repoUrl.startsWith('-'))
    fail('Git 仓库地址格式不正确');
  if (/^https:\/\//i.test(repoUrl)) {
    let url;
    try {
      url = new URL(repoUrl);
    } catch {
      fail('Git 仓库地址格式不正确');
    }
    if (url.username || url.password)
      fail('请在凭据管理中保存仓库账号密码，不要在 URL 中填写账号、密码或令牌');
    if (!url.hostname) fail('Git 仓库地址缺少主机');
  } else if (/^ssh:\/\//.test(repoUrl)) {
    let url;
    try {
      url = new URL(repoUrl);
    } catch {
      fail('SSH 仓库地址格式不正确');
    }
    if (!url.hostname || url.password || url.hostname.startsWith('-'))
      fail('SSH 仓库地址格式不正确');
  } else if (!/^[\w.-]+@[a-zA-Z\d.-]+:[^\s]+$/.test(repoUrl)) {
    if (!(
      config.allowLocalRepositories &&
      (path.isAbsolute(repoUrl) || repoUrl.startsWith('file:///'))
    ))
      fail('仓库地址支持 HTTPS 或 SSH；本地仓库默认关闭');
  }
  const branch = string(input.branch, 'Git 分支', 200, 'main');
  if (
    !branch ||
    branch.startsWith('-') ||
    /[\s~^:?*\[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{')
  )
    fail('Git 分支格式不正确');
  const nodeVersion = string(input.nodeVersion, 'Node.js 版本', 50, '24');
  if (
    nodeVersion !== 'auto' &&
    (!/^\d{1,2}(?:\.\d{1,3}\.\d{1,3})?$/.test(nodeVersion) ||
      Number(nodeVersion.split('.')[0]) < 14)
  )
    fail('Node.js 版本需至少为 14，请填写主版本或完整版本，例如 24 或 24.13.0');
  const packageManager = input.packageManager || 'npm';
  if (!['npm', 'pnpm', 'yarn'].includes(packageManager)) fail('不支持的包管理器');
  const packageManagerVersion = string(input.packageManagerVersion, '包管理器版本', 60, '');
  if (packageManagerVersion && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(packageManagerVersion))
    fail('包管理器版本必须为完整版本号');
  const installCommand = string(
    input.installCommand,
    '安装命令',
    4000,
    packageManager === 'npm'
      ? 'npm ci'
      : packageManager === 'pnpm'
        ? 'pnpm install --frozen-lockfile'
        : 'yarn install --frozen-lockfile',
  );
  const buildCommand = string(input.buildCommand, '构建命令', 4000, `${packageManager} run build`);
  if (!installCommand || !buildCommand) fail('请填写安装命令和构建命令');
  return {
    ...common,
    repoUrl,
    branch,
    nodeVersion,
    packageManager,
    packageManagerVersion,
    installCommand,
    buildCommand,
    workdir: relative(input.workdir, '工作目录', '.'),
    artifactDir: relative(input.artifactDir, '产物目录', 'dist'),
    retainReleases: integer(input.retainReleases, '保留版本数', 1, 30, 5),
    buildCredentialId: credentialId(input.buildCredentialId, '仓库凭据'),
  };
}

function validateDeploy(deploy, config) {
  if (!deploy || !['local', 'ssh'].includes(deploy.type)) fail('请选择本机发布或 SSH 发布');
  const root = string(deploy.root, '网站目录', 1000);
  if (
    !root ||
    !path.posix.isAbsolute(root) ||
    root.includes('\\') ||
    /[\r\n]/.test(root) ||
    root.split('/').includes('..') ||
    path.posix.normalize(root) === '/'
  )
    fail('网站目录必须为独立的绝对路径');
  const normalizedRoot = path.posix.normalize(root).replace(/\/$/, '');
  if (deploy.type === 'local') {
    const sensitive = [config.dataDir, config.projectRoot]
      .filter(Boolean)
      .map((p) => path.resolve(p));
    if (
      sensitive.some(
        (p) =>
          normalizedRoot === p ||
          p.startsWith(normalizedRoot + '/') ||
          normalizedRoot.startsWith(p + '/'),
      )
    )
      fail('网站目录不能与平台源码或数据目录重叠');
  }
  const target = { type: deploy.type, root: normalizedRoot };
  if (deploy.type === 'ssh') {
    target.host = string(deploy.host, 'SSH 主机', 253);
    target.user = string(deploy.user, 'SSH 用户', 100);
    if (
      !/^[a-zA-Z\d][a-zA-Z\d.:-]*$/.test(target.host) ||
      !/^[a-zA-Z_][a-zA-Z\d_-]*$/.test(target.user)
    )
      fail('SSH 主机或用户名格式不正确');
    target.port = integer(deploy.port, 'SSH 端口', 1, 65535, 22);
    target.credentialId = credentialId(deploy.credentialId, 'SSH 凭据');
    if (!target.credentialId) fail('请选择 SSH 部署凭据');
  }
  return target;
}

function validateEnvironment(input, type) {
  const environment = input ?? {};
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    Object.keys(environment).length > 100
  )
    fail('环境变量需要为键值对象，最多 100 项');
  const env = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      !/^[a-zA-Z_][a-zA-Z\d_]*$/.test(key) ||
      typeof value !== 'string' ||
      value.length > 20000 ||
      /[\0\r\n]/.test(value)
    )
      fail(`环境变量 ${key} 格式不正确`);
    if (
      [
        'PATH',
        'HOME',
        'NODE_PATH',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'GIT_SSH_COMMAND',
        'BASH_ENV',
        'ENV',
      ].includes(key)
    )
      fail(`环境变量 ${key} 为执行器保留变量`);
    if (
      type === 'command' &&
      (['NODE_OPTIONS', 'GIT_SSH', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID'].includes(key) ||
        key.startsWith('__FLOW_LITE_'))
    )
      fail(`环境变量 ${key} 为命令执行器保留变量`);
    env[key] = value;
  }
  return env;
}

export function validateCredential(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('请提交凭据');
  const name = string(input.name, '凭据名称', 100);
  if (!name) fail('请填写凭据名称');
  const type = input.type ?? 'ssh';
  if (!['ssh', 'git-https'].includes(type)) fail('凭据类型必须为 SSH 或 Git HTTPS');
  if (type === 'git-https') {
    if (input.authType !== undefined && input.authType !== 'password')
      fail('Git HTTPS 认证方式必须为账号密码');
    const username = string(input.username, '仓库账号', 255);
    if (!username || /[\x00-\x1f\x7f-\x9f:]/.test(username))
      fail('仓库账号不能为空，且不能包含冒号或控制字符');
    const password = input.password;
    if (
      typeof password !== 'string' ||
      !password.length ||
      password.length > 4096 ||
      /[\0\r\n]/.test(password)
    )
      fail('仓库密码或访问令牌不能为空，最多 4096 位且不能包含空字符或换行');
    return { name, type, authType: 'password', username, password };
  }
  const authType = input.authType ?? 'key';
  if (!['key', 'password'].includes(authType)) fail('SSH 认证方式必须为私钥或密码');
  const knownHosts = string(input.knownHosts, '主机公钥', 50000, '');
  if (authType === 'password') {
    const password = input.password;
    if (
      typeof password !== 'string' ||
      !password.length ||
      password.length > 1024 ||
      /[\0\r\n]/.test(password)
    )
      fail('SSH 密码不能为空，最多 1024 位且不能包含空字符或换行');
    return { name, type: 'ssh', authType, password, knownHosts };
  }
  const privateKey = string(input.privateKey, 'SSH 私钥', 20000);
  if (!/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(privateKey))
    fail('请粘贴 PEM 或 OpenSSH 格式的私钥');
  return { name, type: 'ssh', authType, privateKey: privateKey + '\n', knownHosts };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256)
    fail('密码长度需要为 12～256 位');
  return password;
}
export function sameTarget(a, b) {
  return (
    a?.type === b?.type &&
    a.root === b.root &&
    (a.type === 'local' ||
      (a.host === b.host && a.user === b.user && Number(a.port) === Number(b.port)))
  );
}
