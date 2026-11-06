import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcess, checkAbort } from '../lib/process.mjs';
import { validateNodeImagePrefix } from '../config.mjs';
import { prepareSshAuth } from './ssh-auth.mjs';
import { prepareGitHttpsAuth } from './git-auth.mjs';
import { isAllowedHttpGitRepository } from '../../shared/repository-policy.mjs';
import { validateProject } from '../lib/validation.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^(?:v)?(\d{1,2})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?$/;
const MANAGER_VERSION = /^\d{1,3}(?:\.\d{1,3}){0,2}(?:-[\da-z.-]+)?$/i;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function assertId(value, label) {
  if (!UUID.test(value || '')) throw new Error(`${label}不是有效的 UUID`);
  return value;
}

function relativePath(value, label, { allowDot = true } = {}) {
  const candidate = value || (allowDot ? '.' : 'dist');
  if (
    typeof candidate !== 'string' ||
    candidate.includes('\0') ||
    candidate.includes('\\') ||
    path.isAbsolute(candidate) ||
    candidate.split('/').includes('..')
  ) {
    throw new Error(`${label}必须是项目内的相对目录`);
  }
  const normalized = path.posix.normalize(candidate);
  if ((!allowDot && normalized === '.') || /[\r\n]/.test(normalized))
    throw new Error(`${label}无效`);
  return normalized;
}

function deployRoot(value) {
  if (
    typeof value !== 'string' ||
    !path.posix.isAbsolute(value) ||
    /[\0\r\n]/.test(value) ||
    value.split('/').includes('..')
  ) {
    throw new Error('发布根目录必须是绝对路径，且不能包含上级目录');
  }
  const root = path.posix.normalize(value).replace(/\/$/, '');
  if (!root || root.split('/').filter(Boolean).length < 2)
    throw new Error('请使用专门的网站发布目录，例如 /srv/www/example');
  return root;
}

function baseEnvironment() {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

function projectEnvironment(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('环境变量必须是键值对象');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof item !== 'string' ||
      /[\0\r\n]/.test(item)
    ) {
      throw new Error('环境变量名称无效，或值包含不支持的换行字符');
    }
    result[key] = item;
  }
  return result;
}

function normalizeNodeVersion(value) {
  const match = VERSION.exec(String(value || '').trim());
  if (!match || Number(match[1]) < 14)
    throw new Error('Node.js 版本需为 14 或以上的数字版本，例如 14 或 14.21.3');
  return match
    .slice(1)
    .filter((item) => item !== undefined)
    .join('.');
}

export function nodeImageName(version, prefix = 'node') {
  const normalized = normalizeNodeVersion(version);
  const variant = Number(normalized.split('.')[0]) < 18 ? 'bullseye' : 'bookworm';
  return `${validateNodeImagePrefix(prefix)}:${normalized}-${variant}`;
}

function assertRepository(repoUrl, config) {
  if (typeof repoUrl !== 'string' || /[\0\r\n]/.test(repoUrl) || repoUrl.startsWith('-'))
    throw new Error('Git 仓库地址无效');
  if (/^https:\/\//i.test(repoUrl)) {
    const url = new URL(repoUrl);
    if (url.username || url.password)
      throw new Error('请通过凭据配置账号、密码或令牌，不要写入 Git 仓库地址');
    return;
  }
  if (/^http:\/\//i.test(repoUrl)) {
    if (!isAllowedHttpGitRepository(repoUrl))
      throw new Error('HTTP 仅支持已批准的 git.yin-duo.com/mini-program 仓库地址');
    return;
  }
  if (/^ssh:\/\//i.test(repoUrl)) {
    const url = new URL(repoUrl);
    if (
      !/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[\da-f:]+\])$/i.test(url.hostname) ||
      url.password ||
      (url.username && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(url.username))
    )
      throw new Error('SSH 仓库地址无效');
    return;
  }
  if (
    /^[A-Za-z_][A-Za-z0-9_.-]*@(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[\da-f:]+\]):[^\s]+$/i.test(repoUrl)
  )
    return;
  if (
    config.allowLocalRepositories &&
    (path.isAbsolute(repoUrl) || repoUrl.startsWith('file://'))
  ) {
    if (repoUrl.startsWith('file://')) fileURLToPath(repoUrl);
    return;
  }
  throw new Error('仓库仅支持 HTTPS 或 SSH 地址；本地仓库仅在显式开启测试选项时可用');
}

function lookupCredential(credentials, id) {
  if (!id) return null;
  const credential = credentials instanceof Map ? credentials.get(id) : credentials?.[id];
  if (!credential) throw new Error('所选凭据不存在');
  return { ...credential, type: credential.type || 'ssh' };
}

function getCredential(credentials, id) {
  const credential = lookupCredential(credentials, id);
  if (credential && credential.type !== 'ssh') throw new Error('发布目标仅支持 SSH 凭据');
  return credential;
}

async function requireGitHttpsIsolation(env, signal) {
  const version = await runProcess('git', ['--version'], { env, signal });
  const match = /^git version (\d+)\.(\d+)/.exec(version.stdout.trim());
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 32))
    throw new Error('Git HTTPS 凭据需要 Git 2.32 或以上，请升级 Git 后重试');
}

async function realDirectoryWithin(root, relative, label) {
  let cursor = root;
  for (const part of relative.split('/').filter((part) => part !== '.' && part !== '')) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${label}不能包含符号链接，且必须是目录`);
  }
  const real = await fs.realpath(cursor);
  const realRoot = await fs.realpath(root);
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`))
    throw new Error(`${label}超出了项目目录`);
  return cursor;
}

async function readSmallFile(filename, maxBytes = 1024 * 1024) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error(`文件无效或过大：${path.basename(filename)}`);
  return fs.readFile(filename, 'utf8');
}

async function readOptional(filename) {
  try {
    return await readSmallFile(filename, 4096);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function determineNodeVersion(project, sourceDir, projectDir) {
  if (project.nodeVersion !== 'auto') return normalizeNodeVersion(project.nodeVersion || '24');
  for (const dir of [...new Set([projectDir, sourceDir])]) {
    for (const filename of ['.nvmrc', '.node-version']) {
      const text = await readOptional(path.join(dir, filename));
      const version = text
        ?.split(/\r?\n/)
        .find((line) => line.trim() && !line.trim().startsWith('#'))
        ?.trim();
      if (version) return normalizeNodeVersion(version);
    }
  }
  return '24';
}

export function selectPackageManager(project, pkg, nodeVersion) {
  const manager = project.packageManager || 'npm';
  if (!['npm', 'pnpm', 'yarn'].includes(manager)) throw new Error('包管理器仅支持 npm、pnpm、yarn');
  const nodeMajor = Number(normalizeNodeVersion(nodeVersion).split('.')[0]);
  const defaultPnpmVersion =
    nodeMajor < 16 ? '7' : nodeMajor < 18 ? '8' : nodeMajor < 20 ? '9' : '10';
  const declared =
    typeof pkg.packageManager === 'string'
      ? /^(npm|pnpm|yarn)@([^+]+)(?:\+.*)?$/.exec(pkg.packageManager)
      : null;
  const version =
    project.packageManagerVersion?.trim() ||
    (declared?.[1] === manager ? declared[2] : '') ||
    (manager === 'pnpm' ? defaultPnpmVersion : manager === 'yarn' ? '1.22.22' : '');
  if (version && !MANAGER_VERSION.test(version))
    throw new Error('包管理器版本应为数字版本，例如 10.15.0');
  return { name: manager, version };
}

function managerPackage(manager) {
  return manager.name === 'yarn' && Number(manager.version.split('.')[0]) >= 2
    ? '@yarnpkg/cli-dist'
    : manager.name;
}

export async function installPackageManager(manager, { exec, prefix, nodeVersion, onLog }) {
  // Keep the image's bundled npm (including npm 6 on Node 14) unless pinned.
  if (manager.name === 'npm' && !manager.version) return;
  await onLog(`准备 ${manager.name}@${manager.version}\n`);
  try {
    await exec(
      `npm install --engine-strict --no-audit --no-fund --prefix ${shellQuote(prefix)} ${shellQuote(`${managerPackage(manager)}@${manager.version}`)}`,
    );
  } catch (error) {
    if (
      /\b(?:EBADENGINE|ENOTSUP)\b|Unsupported engine|not compatible with your version of node/i.test(
        `${error.stdout || ''}\n${error.stderr || ''}`,
      )
    ) {
      throw new Error(
        `${manager.name}@${manager.version} 的引擎要求与 Node.js ${nodeVersion} 不兼容，请调整 Node.js 或包管理器版本`,
      );
    }
    throw error;
  }
}

async function plainDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`目录不能是符号链接：${directory}`);
}

async function publicDirectory(directory) {
  // The platform can use umask 0077 for credentials/data while websites remain
  // readable by a separate Nginx user. Never chmod a pre-existing directory.
  const firstCreated = await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  if (!firstCreated) return;
  let cursor = firstCreated;
  await fs.chmod(cursor, 0o755);
  for (const part of path.relative(firstCreated, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    await fs.chmod(cursor, 0o755);
  }
}

/** Copy only real files/directories; symlinks and device nodes never become published files. */
async function copyStaticTree(source, target, signal) {
  checkAbort(signal);
  await plainDirectory(source);
  await fs.mkdir(target, { recursive: false, mode: 0o755 });
  await fs.chmod(target, 0o755);
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    checkAbort(signal);
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`构建产物包含符号链接，已拒绝发布：${entry.name}`);
    if (stat.isDirectory()) await copyStaticTree(from, to, signal);
    else if (stat.isFile()) {
      await fs.copyFile(from, to);
      await fs.chmod(to, 0o644);
    } else throw new Error(`构建产物包含不支持的文件类型：${entry.name}`);
  }
}

async function validateStaticTree(source, signal) {
  checkAbort(signal);
  await plainDirectory(source);
  const index = await fs.lstat(path.join(source, 'index.html')).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('构建产物中没有 index.html，请检查产物目录配置');
    throw error;
  });
  if (!index.isFile() || index.isSymbolicLink())
    throw new Error('构建产物 index.html 必须是普通文件');
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      checkAbort(signal);
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error(`构建产物包含不支持的链接或文件：${entry.name}`);
      if (stat.isDirectory()) await walk(entryPath);
    }
  };
  await walk(source);
}

async function existingStat(filename) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function deployLocal(artifactPath, target, releaseId, signal, onLog) {
  const root = deployRoot(target.root);
  await publicDirectory(root);
  await plainDirectory(root);
  const releases = path.join(root, 'releases');
  await publicDirectory(releases);
  await plainDirectory(releases);
  const releasePath = path.join(releases, releaseId);
  const staging = path.join(releases, `.upload-${randomUUID()}`);
  const temporaryLink = path.join(root, `.current-${randomUUID()}`);
  try {
    const previous = await existingStat(releasePath);
    if (previous) await validateStaticTree(releasePath, signal);
    else {
      await copyStaticTree(artifactPath, staging, signal);
      await fs.rename(staging, releasePath);
    }
    checkAbort(signal);
    const current = await existingStat(path.join(root, 'current'));
    if (current && !current.isSymbolicLink())
      throw new Error('发布目录的 current 已存在且不是符号链接，请先迁移网站目录');
    await fs.symlink(`releases/${releaseId}`, temporaryLink, 'dir');
    checkAbort(signal);
    await fs.rename(temporaryLink, path.join(root, 'current'));
    await onLog(`已切换当前网站版本：${releaseId}\n`);
    return releasePath;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(temporaryLink, { force: true });
  }
}

const REMOTE_DEPLOY = `set -eu
umask 022
root=$1
release=$2
upload=$3
mkdir -p -- "$root"
[ ! -L "$root" ] && [ -d "$root" ] || { echo '发布根目录不能是符号链接' >&2; exit 1; }
mkdir -p -- "$root/releases"
[ ! -L "$root/releases" ] && [ -d "$root/releases" ] || { echo 'releases 目录不能是符号链接' >&2; exit 1; }
staging="$root/releases/.upload-$upload"
link="$root/.current-$upload"
[ ! -e "$staging" ] && [ ! -L "$staging" ] || exit 1
mkdir -- "$staging"
trap 'rm -rf -- "$staging"; rm -f -- "$link"' EXIT HUP INT TERM
tar --no-same-owner --no-same-permissions -xf - -C "$staging"
[ -f "$staging/index.html" ] || { echo '产物缺少 index.html' >&2; exit 1; }
target="$root/releases/$release"
[ ! -L "$target" ] || { echo '版本目录不能是符号链接' >&2; exit 1; }
if [ -e "$target" ]; then
  [ -d "$target" ] && [ -f "$target/index.html" ] || exit 1
  [ -z "$(find "$target" -type l -print -quit)" ] || { echo '版本目录包含符号链接' >&2; exit 1; }
else
  mv -- "$staging" "$target"
fi
if [ -e "$root/current" ] && [ ! -L "$root/current" ]; then
  echo 'current 已存在且不是符号链接' >&2; exit 1
fi
ln -s -- "releases/$release" "$link"
mv -Tf -- "$link" "$root/current"
printf '已切换当前网站版本：%s\\n' "$release"
`;

async function deployRemote(artifactPath, target, releaseId, context) {
  const { credentials, tempDir, signal, onLog } = context;
  const root = deployRoot(target.root);
  const host = String(target.host || '');
  const user = String(target.user || '');
  const port = Number(target.port || 22);
  if (
    !/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[\da-f:]+\]|[\da-f:]+)$/i.test(host) ||
    !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(user) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('SSH 主机、用户名或端口配置无效');
  }
  const credential = getCredential(credentials, target.credentialId);
  const auth = await prepareSshAuth({
    credential,
    tempDir,
    prefix: 'deploy',
    env: baseEnvironment(),
  });
  const archive = path.join(tempDir, 'artifact.tar');
  await runProcess('tar', ['-cf', archive, '-C', artifactPath, '.'], {
    env: baseEnvironment(),
    signal,
    onOutput: onLog,
  });
  const remoteCommand = `sh -c ${shellQuote(REMOTE_DEPLOY)} -- ${shellQuote(root)} ${shellQuote(releaseId)} ${shellQuote(randomUUID())}`;
  const destination = `${user}@${host}`;
  await onLog(`通过 SSH 发布到 ${destination}:${root}\n`);
  await runProcess('ssh', [...auth.args, '-p', String(port), '--', destination, remoteCommand], {
    env: auth.env,
    signal,
    onOutput: onLog,
    input: createReadStream(archive),
  });
  return `${root}/releases/${releaseId}`;
}

async function publish(artifactPath, project, releaseId, context) {
  checkAbort(context.signal);
  if (project.deploy?.type === 'local')
    return deployLocal(artifactPath, project.deploy, releaseId, context.signal, context.onLog);
  if (project.deploy?.type === 'ssh')
    return deployRemote(artifactPath, project.deploy, releaseId, context);
  throw new Error('发布目标必须选择本机目录或 SSH 服务器');
}

async function dockerBuild(context) {
  const {
    project,
    config,
    sourceDir,
    workdir,
    nodeVersion,
    manager,
    environment,
    tempDir,
    signal,
    onLog,
    onStage,
    onMetadata,
  } = context;
  const name = `flow-${randomUUID()}`;
  let created = false;
  const image = nodeImageName(nodeVersion, config.nodeImagePrefix);
  const memory = config.dockerMemory || '8g';
  const cpus = String(config.dockerCpus || '4');
  if (
    !/^\d+(?:\.\d+)?[bkmg]?$/i.test(memory) ||
    Number.parseFloat(memory) <= 0 ||
    !/^\d+(?:\.\d+)?$/.test(cpus) ||
    Number(cpus) <= 0
  )
    throw new Error('Docker CPU 或内存限制配置无效');
  const uid = process.getuid?.() || 1000;
  const gid = process.getgid?.() || 1000;
  const cacheDir = path.join(config.dataDir, 'cache', project.id, `node-${nodeVersion}`);
  await fs.mkdir(cacheDir, { recursive: true });
  if (process.getuid?.() === 0) {
    const chownTree = async (directory) => {
      await fs.chown(directory, uid, gid);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await chownTree(filename);
        else await fs.chown(filename, uid, gid);
      }
    };
    await chownTree(sourceDir);
    await fs.chown(cacheDir, uid, gid);
  }
  const envFile = path.join(tempDir, 'build.env');
  const buildEnv = {
    ...environment,
    HOME: '/tmp/flow-home',
    CI: 'true',
    npm_config_cache: '/npm-cache',
  };
  await fs.writeFile(
    envFile,
    Object.entries(buildEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  const command = async (args, output = true) => {
    try {
      return await runProcess('docker', args, {
        env: baseEnvironment(),
        signal,
        onOutput: output ? onLog : undefined,
      });
    } catch (error) {
      if (!output && error.stderr) await onLog(error.stderr);
      throw error;
    }
  };
  try {
    await onLog(`构建环境：${image}（CPU ${cpus} / 内存 ${memory}）\n`);
    created = true;
    await command(
      [
        'create',
        '--name',
        name,
        '--label',
        `com.flow-lite.instance=${instanceLabel(config)}`,
        '--label',
        `com.flow-lite.run=${context.run.id}`,
        '--init',
        '--user',
        `${uid}:${gid}`,
        '--cpus',
        cpus,
        '--memory',
        memory,
        '--memory-swap',
        memory,
        '--pids-limit',
        '256',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--mount',
        `type=bind,src=${sourceDir},dst=/workspace`,
        '--mount',
        `type=bind,src=${cacheDir},dst=/npm-cache`,
        '--workdir',
        path.posix.join('/workspace', workdir),
        '--env-file',
        envFile,
        image,
        'sh',
        '-c',
        'mkdir -p "$HOME"; trap "exit 0" TERM INT; while :; do sleep 1; done',
      ],
      false,
    );
    await command(['start', name], false);
    const actualNode = (
      await command(['exec', name, 'node', '-p', 'process.versions.node'], false)
    ).stdout.trim();
    normalizeNodeVersion(actualNode);
    await onMetadata({ nodeVersion: actualNode });
    await onLog(`Node.js ${actualNode}\n`);
    const exec = async (script, output = true) =>
      command(
        [
          'exec',
          name,
          'sh',
          '-c',
          `export PATH=/tmp/flow-tools/node_modules/.bin:$PATH; ${script}`,
        ],
        output,
      );
    await onStage('install');
    await installPackageManager(manager, {
      exec,
      prefix: '/tmp/flow-tools',
      nodeVersion: actualNode,
      onLog,
    });
    const actualManager = (await exec(`${manager.name} --version`, false)).stdout.trim();
    await onMetadata({ packageManagerVersion: actualManager });
    await onLog(`${manager.name} ${actualManager}\n$ ${project.installCommand}\n`);
    await exec(project.installCommand);
    await onStage('build');
    await onLog(`$ ${project.buildCommand}\n`);
    await exec(project.buildCommand);
    return { nodeVersion: actualNode, packageManagerVersion: actualManager };
  } finally {
    // Removing the container also terminates background processes left by build scripts.
    if (created)
      await runProcess('docker', ['rm', '-f', name], {
        env: baseEnvironment(),
        signal: AbortSignal.timeout(15000),
      }).catch(() => {});
  }
}

async function hostBuild(context) {
  const {
    project,
    config,
    projectDir,
    nodeVersion,
    manager,
    environment,
    tempDir,
    signal,
    onLog,
    onStage,
    onMetadata,
  } = context;
  if (!config.allowHostRunner)
    throw new Error('宿主机构建需要显式开启 FLOW_ALLOW_HOST_RUNNER，仅应用于自己的可信仓库');
  const actualNode = process.versions.node;
  if (actualNode !== nodeVersion && !actualNode.startsWith(`${nodeVersion}.`)) {
    throw new Error(
      `宿主机实际为 Node.js ${actualNode}，无法执行所选 ${nodeVersion}；请启用 Docker 构建环境`,
    );
  }
  const home = path.join(tempDir, 'build-home');
  const tools = path.join(tempDir, 'tools');
  await fs.mkdir(home);
  const env = {
    ...baseEnvironment(),
    ...environment,
    HOME: home,
    CI: 'true',
    PATH: `${tools}/node_modules/.bin${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`,
    npm_config_cache: path.join(config.dataDir, 'cache', project.id, `node-${nodeVersion}`),
  };
  const exec = (script, output = true) =>
    runProcess('/bin/sh', ['-c', script], {
      cwd: projectDir,
      env,
      signal,
      onOutput: output ? onLog : undefined,
    });
  await onMetadata({ nodeVersion: actualNode });
  await onLog(`宿主机构建：Node.js ${actualNode}（仅适用于可信仓库）\n`);
  await onStage('install');
  await installPackageManager(manager, { exec, prefix: tools, nodeVersion: actualNode, onLog });
  const actualManager = (await exec(`${manager.name} --version`, false)).stdout.trim();
  await onMetadata({ packageManagerVersion: actualManager });
  await onLog(`${manager.name} ${actualManager}\n$ ${project.installCommand}\n`);
  await exec(project.installCommand);
  await onStage('build');
  await onLog(`$ ${project.buildCommand}\n`);
  await exec(project.buildCommand);
  return { nodeVersion: actualNode, packageManagerVersion: actualManager };
}

async function createContext(options) {
  const { project, run, config } = options;
  assertId(project.id, '项目 ID');
  assertId(run.id, '运行 ID');
  if (run.projectId && run.projectId !== project.id) throw new Error('任务与项目不匹配');
  if (!path.isAbsolute(config.dataDir)) throw new Error('数据目录必须是绝对路径');
  const timeout = Number(project.timeoutSeconds || 900);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400)
    throw new Error('任务超时应在 1 到 86400 秒之间');
  const timeoutSignal = AbortSignal.timeout(timeout * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  checkAbort(signal);
  const workspaceRoot = path.join(config.dataDir, 'workspaces');
  await fs.mkdir(workspaceRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(workspaceRoot, `${run.id}-`));
  return {
    ...options,
    credentials: options.credentials || {},
    onLog: options.onLog || (() => {}),
    onStage: options.onStage || (() => {}),
    onMetadata: options.onMetadata || (() => {}),
    signal,
    tempDir,
  };
}

async function checkoutRepository(context, sourceDir) {
  const { project, run, config, tempDir, signal, onLog, credentials } = context;
  assertRepository(project.repoUrl, config);
  const branch = project.branch || 'main';
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    /[/.]$/.test(branch)
  )
    throw new Error('Git 分支名称无效');
  let httpsAuth;
  try {
    const credential = lookupCredential(credentials, project.buildCredentialId);
    const approvedHttp = isAllowedHttpGitRepository(project.repoUrl);
    const gitBase = {
      ...baseEnvironment(),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: approvedHttp
        ? 'http'
        : config.allowLocalRepositories
          ? 'https:ssh:file'
          : 'https:ssh',
    };
    let gitEnv;
    if (/^https:\/\//i.test(project.repoUrl) || approvedHttp) {
      if (approvedHttp && !credential) throw new Error('该 HTTP 仓库需要选择 Git 账号密码凭据');
      if (credential && credential.type !== 'git-https')
        throw new Error(`${approvedHttp ? 'HTTP' : 'HTTPS'} 仓库需要 Git HTTPS 账号密码或令牌凭据`);
      if (credential) {
        await requireGitHttpsIsolation(gitBase, signal);
        httpsAuth = await prepareGitHttpsAuth({
          credential,
          repoUrl: project.repoUrl,
          tempDir,
          env: gitBase,
        });
        gitEnv = httpsAuth.env;
      } else gitEnv = gitBase;
    } else {
      if (credential && credential.type !== 'ssh')
        throw new Error('SSH 或本地仓库不能使用 Git HTTPS 凭据');
      const auth = await prepareSshAuth({
        credential,
        tempDir,
        prefix: 'repository',
        env: gitBase,
      });
      gitEnv = { ...auth.env, GIT_SSH_COMMAND: ['ssh', ...auth.args].map(shellQuote).join(' ') };
    }
    await runProcess(
      'git',
      [
        'clone',
        '--no-local',
        '--no-checkout',
        '--depth',
        '1',
        '--single-branch',
        '--branch',
        branch,
        '--',
        project.repoUrl,
        sourceDir,
      ],
      { env: gitEnv, signal, onOutput: onLog },
    );
    if (run.commitSha) {
      if (!/^[0-9a-f]{40,64}$/i.test(run.commitSha)) throw new Error('重试任务的提交版本无效');
      try {
        await runProcess('git', ['cat-file', '-e', `${run.commitSha}^{commit}`], {
          cwd: sourceDir,
          env: httpsAuth ? gitBase : gitEnv,
          signal,
        });
      } catch (error) {
        checkAbort(signal);
        await runProcess('git', ['fetch', '--depth', '1', 'origin', run.commitSha], {
          cwd: sourceDir,
          env: gitEnv,
          signal,
          onOutput: onLog,
        });
      }
    }
    // Network credentials must be gone before Git checkout can invoke filters or
    // any repository package/build code starts executing.
    if (httpsAuth) await httpsAuth.cleanup();
    const checkoutEnv = httpsAuth ? gitBase : gitEnv;
    const commitSha = (
      await runProcess('git', ['rev-parse', run.commitSha || 'HEAD'], {
        cwd: sourceDir,
        env: checkoutEnv,
        signal,
      })
    ).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commitSha)) throw new Error('无法识别 Git 提交版本');
    await runProcess('git', ['checkout', '--detach', commitSha], {
      cwd: sourceDir,
      env: checkoutEnv,
      signal,
      onOutput: onLog,
    });
    return commitSha;
  } finally {
    if (httpsAuth) await httpsAuth.cleanup().catch(() => {});
  }
}

export async function executeBuild(options) {
  if (options.project.buildMode === 'multi') return executeMultiBuild(options);
  const context = await createContext(options);
  const { project, run, config, tempDir, signal, onLog, onStage, onMetadata, credentials } =
    context;
  const sourceDir = path.join(tempDir, 'source');
  let artifactPath;
  let archived = false;
  try {
    assertRepository(project.repoUrl, config);
    const branch = project.branch || 'main';
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      branch.includes('..') ||
      branch.includes('//') ||
      /[/.]$/.test(branch)
    )
      throw new Error('Git 分支名称无效');
    if (
      typeof project.installCommand !== 'string' ||
      !project.installCommand.trim() ||
      typeof project.buildCommand !== 'string' ||
      !project.buildCommand.trim()
    )
      throw new Error('安装命令和构建命令不能为空');
    const workdir = relativePath(project.workdir || '.', '工作目录');
    const artifactDir = relativePath(project.artifactDir || 'dist', '产物目录', {
      allowDot: false,
    });
    const environment = projectEnvironment(project.environment);
    await onStage('checkout');
    await onLog(`检出仓库分支：${branch}\n`);
    const commitSha = await checkoutRepository(context, sourceDir);
    await onMetadata({ commitSha });
    await onLog(`提交：${commitSha}\n`);
    const projectDir = await realDirectoryWithin(sourceDir, workdir, '工作目录');
    const pkg = JSON.parse(await readSmallFile(path.join(projectDir, 'package.json')));
    const nodeVersion = await determineNodeVersion(project, sourceDir, projectDir);
    const manager = selectPackageManager(project, pkg, nodeVersion);
    if (pkg.engines?.node) await onLog(`项目声明 Node.js 兼容范围：${String(pkg.engines.node)}\n`);
    const runtimeContext = {
      ...context,
      sourceDir,
      workdir,
      projectDir,
      nodeVersion,
      manager,
      environment,
    };
    const result =
      config.runnerMode === 'host'
        ? await hostBuild(runtimeContext)
        : await dockerBuild(runtimeContext);
    await onStage('archive');
    const verifiedProjectDir = await realDirectoryWithin(sourceDir, workdir, '工作目录');
    const outputDir = await realDirectoryWithin(verifiedProjectDir, artifactDir, '产物目录');
    await validateStaticTree(outputDir, signal);
    const projectArtifacts = path.join(config.dataDir, 'artifacts', project.id);
    await fs.mkdir(projectArtifacts, { recursive: true });
    await plainDirectory(projectArtifacts);
    artifactPath = path.join(projectArtifacts, run.id);
    await copyStaticTree(outputDir, artifactPath, signal);
    archived = true;
    await onLog('构建产物已保存\n');
    await onStage('deploy');
    const releasePath = await publish(artifactPath, project, run.id, context);
    return { artifactPath, releasePath, commitSha, ...result };
  } catch (error) {
    // A deploy failure keeps a completed archive available for diagnosis/retry.
    if (artifactPath && !archived)
      await fs.rm(artifactPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeMultiBuild(options) {
  // Revalidate immutable snapshots as well as API input: credential and output
  // boundaries must also hold for imported/old database records.
  const project = { ...validateProject(options.project, options.config), id: options.project.id };
  const context = await createContext({ ...options, project });
  const { run, config, tempDir, signal, onLog, onStage, onMetadata } = context;
  const pinned = run.buildDetails?.sources || [];
  const details = {
    sources: project.sources.map(({ id, name, branch }) => ({
      id,
      name,
      branch,
      status: 'waiting',
    })),
    tasks: project.tasks.map(({ id, name, sourceId, publishDir }) => ({
      id,
      name,
      sourceId,
      publishDir,
      status: 'waiting',
      stage: 'waiting',
    })),
  };
  const emit = async () => {
    await onMetadata({ buildDetails: structuredClone(details) });
  };
  const directories = new Map();
  const combined = path.join(tempDir, 'combined');
  let activeSource;
  let activeTask;
  let artifactPath;
  let archived = false;
  try {
    await emit();
    await onStage('checkout');
    for (const source of project.sources) {
      checkAbort(signal);
      activeSource = details.sources.find((item) => item.id === source.id);
      activeSource.status = 'running';
      await emit();
      await onLog(`\n[Flow Lite] 代码源：${source.name} / ${source.branch}\n`);
      const directory = path.join(tempDir, `source-${source.id}`);
      const authDirectory = path.join(tempDir, `auth-${source.id}`);
      await fs.mkdir(authDirectory, { mode: 0o700 });
      let commitSha;
      try {
        commitSha = await checkoutRepository(
          {
            ...context,
            project: { ...project, ...source },
            tempDir: authDirectory,
            run: { ...run, commitSha: pinned.find((item) => item.id === source.id)?.commitSha },
          },
          directory,
        );
      } finally {
        // No repository credential material survives into any build task.
        await fs.rm(authDirectory, { recursive: true, force: true });
      }
      Object.assign(activeSource, { commitSha, status: 'success' });
      directories.set(source.id, directory);
      await onLog(`提交：${commitSha}\n`);
      await emit();
      activeSource = null;
    }
    await onMetadata({ commitSha: details.sources[0].commitSha });
    await onStage('build');
    for (const task of project.tasks) {
      checkAbort(signal);
      activeTask = details.tasks.find((item) => item.id === task.id);
      Object.assign(activeTask, { status: 'running', stage: 'install' });
      await emit();
      await onLog(`\n[Flow Lite] 构建任务：${task.name} → ${task.publishDir}\n`);
      const sourceDir = directories.get(task.sourceId);
      const projectDir = await realDirectoryWithin(sourceDir, task.workdir, '任务工作目录');
      const pkg = JSON.parse(await readSmallFile(path.join(projectDir, 'package.json')));
      const nodeVersion = await determineNodeVersion(task, sourceDir, projectDir);
      const manager = selectPackageManager(task, pkg, nodeVersion);
      const taskDirectory = path.join(tempDir, `task-${task.id}`);
      await fs.mkdir(taskDirectory, { mode: 0o700 });
      const runtimeContext = {
        ...context,
        project: { ...project, ...task, id: project.id },
        sourceDir,
        projectDir,
        workdir: relativePath(task.workdir, '任务工作目录'),
        nodeVersion,
        manager,
        tempDir: taskDirectory,
        environment: projectEnvironment({ ...project.environment, ...task.environment }),
        onStage: async (stage) => {
          activeTask.stage = stage;
          await emit();
        },
        onMetadata: async (metadata) => {
          for (const key of ['nodeVersion', 'packageManagerVersion'])
            if (metadata[key]) activeTask[key] = metadata[key];
          await emit();
        },
      };
      await (config.runnerMode === 'host'
        ? hostBuild(runtimeContext)
        : dockerBuild(runtimeContext));
      const verifiedProjectDir = await realDirectoryWithin(sourceDir, task.workdir, '任务工作目录');
      const output = await realDirectoryWithin(
        verifiedProjectDir,
        task.artifactDir,
        '任务产物目录',
      );
      await validateStaticTree(output, signal);
      const target = path.join(combined, task.publishDir);
      if (task.publishDir !== '.') await fs.mkdir(path.dirname(target), { recursive: true });
      await copyStaticTree(output, target, signal);
      Object.assign(activeTask, { status: 'success', stage: 'done' });
      await emit();
      activeTask = null;
    }
    if (!(await existingStat(path.join(combined, 'index.html')))) {
      const escape = (value) =>
        String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
      const links = project.tasks
        .map(
          (task) =>
            `<li><a href="./${task.publishDir.split('/').map(encodeURIComponent).join('/')}/">${escape(task.name)}</a></li>`,
        )
        .join('');
      await fs.writeFile(
        path.join(combined, 'index.html'),
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(project.name)}</title><h1>${escape(project.name)}</h1><ul>${links}</ul></html>`,
      );
    }
    await onStage('archive');
    await validateStaticTree(combined, signal);
    const projectArtifacts = path.join(config.dataDir, 'artifacts', project.id);
    await fs.mkdir(projectArtifacts, { recursive: true });
    await plainDirectory(projectArtifacts);
    artifactPath = path.join(projectArtifacts, run.id);
    await copyStaticTree(combined, artifactPath, signal);
    archived = true;
    await onStage('deploy');
    const releasePath = await publish(artifactPath, project, run.id, context);
    return {
      artifactPath,
      releasePath,
      commitSha: details.sources[0].commitSha,
      nodeVersion: [...new Set(details.tasks.map((task) => task.nodeVersion))].join(' / '),
      buildDetails: details,
    };
  } catch (error) {
    if (activeSource) activeSource.status = signal.aborted ? 'cancelled' : 'failed';
    if (activeTask) {
      activeTask.status = signal.aborted ? 'cancelled' : 'failed';
      activeTask.stage = activeTask.status;
    }
    for (const item of [...details.sources, ...details.tasks])
      if (item.status === 'waiting') item.status = 'skipped';
    await emit().catch(() => {});
    if (artifactPath && !archived)
      await fs.rm(artifactPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function executeRollback(options) {
  const context = await createContext(options);
  const { project, run, config, signal, onLog, onStage, tempDir } = context;
  try {
    const releaseId = assertId(run.rollbackReleaseId, '回滚版本 ID');
    const artifactPath = path.join(config.dataDir, 'artifacts', project.id, releaseId);
    await validateStaticTree(artifactPath, signal);
    await onStage('deploy');
    await onLog(`回滚到已保存的构建版本：${releaseId}\n`);
    const releasePath = await publish(artifactPath, project, releaseId, context);
    return { artifactPath, releasePath };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

const REMOTE_PRUNE = `set -eu
root=$1
shift
[ -d "$root/releases" ] || exit 0
[ ! -L "$root" ] && [ ! -L "$root/releases" ] || exit 1
current=''
if [ -L "$root/current" ]; then
  current=$(readlink "$root/current")
  case "$current" in
    releases/*|"$root"/releases/*) ;;
    *) echo 'current 指向非版本目录，已跳过清理'; exit 0 ;;
  esac
elif [ -e "$root/current" ]; then
  echo 'current 不是符号链接，已跳过清理'; exit 0
fi
keep=" $* "
for directory in "$root/releases"/*; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || continue
  id=\${directory##*/}
  printf '%s' "$id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' || continue
  [ "$current" != "releases/$id" ] && [ "$current" != "$root/releases/$id" ] || continue
  case "$keep" in *" $id "*) continue ;; esac
  rm -rf -- "$directory"
  printf '已清理旧版本：%s\\n' "$id"
done
`;

/** Delete only explicitly managed UUID release directories, never the current target. */
export async function pruneReleases({
  project,
  keepIds,
  credentials = {},
  config,
  onLog = () => {},
}) {
  assertId(project.id, '项目 ID');
  if (!Array.isArray(keepIds)) throw new Error('保留版本必须是 UUID 数组');
  const keep = new Set(keepIds.map((id) => assertId(id, '保留版本 ID')));
  const root = deployRoot(project.deploy?.root);
  if (project.deploy.type === 'local') {
    const releases = path.join(root, 'releases');
    if (!(await existingStat(releases))) return;
    await plainDirectory(root);
    await plainDirectory(releases);
    let currentTarget;
    const current = await existingStat(path.join(root, 'current'));
    if (current) {
      if (!current.isSymbolicLink()) {
        await onLog('current 不是符号链接，已跳过版本清理\n');
        return;
      }
      currentTarget = path.resolve(root, await fs.readlink(path.join(root, 'current')));
      if (!currentTarget.startsWith(`${releases}${path.sep}`)) {
        await onLog('current 指向非版本目录，已跳过版本清理\n');
        return;
      }
    }
    for (const entry of await fs.readdir(releases, { withFileTypes: true })) {
      if (
        !UUID.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        keep.has(entry.name)
      )
        continue;
      const directory = path.join(releases, entry.name);
      if (directory === currentTarget) continue;
      await fs.rm(directory, { recursive: true, force: true });
      await onLog(`已清理旧版本：${entry.name}\n`);
    }
    return;
  }
  if (project.deploy.type !== 'ssh') throw new Error('发布目标无效');
  const target = project.deploy;
  const host = String(target.host || '');
  const user = String(target.user || '');
  const port = Number(target.port || 22);
  if (
    !/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[\da-f:]+\]|[\da-f:]+)$/i.test(host) ||
    !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(user) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('SSH 配置无效');
  const workspaceRoot = path.join(config.dataDir, 'workspaces');
  await fs.mkdir(workspaceRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(workspaceRoot, 'prune-'));
  try {
    const auth = await prepareSshAuth({
      credential: getCredential(credentials, target.credentialId),
      tempDir,
      prefix: 'prune',
      env: baseEnvironment(),
    });
    const remoteCommand = `sh -c ${shellQuote(REMOTE_PRUNE)} -- ${[root, ...keep].map(shellQuote).join(' ')}`;
    await runProcess(
      'ssh',
      [...auth.args, '-p', String(port), '--', `${user}@${host}`, remoteCommand],
      {
        env: auth.env,
        signal: AbortSignal.timeout(30000),
        onOutput: onLog,
      },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function instanceLabel(config) {
  return createHash('sha256').update(path.resolve(config.dataDir)).digest('hex').slice(0, 24);
}

/** Call only after acquiring the instance's exclusive worker lock. */
export async function cleanupAbandonedBuilds({ config, onLog = () => {} }) {
  if (!path.isAbsolute(config.dataDir)) throw new Error('数据目录必须是绝对路径');
  if (config.runnerMode === 'docker') {
    const { stdout } = await runProcess(
      'docker',
      ['ps', '-aq', '--filter', `label=com.flow-lite.instance=${instanceLabel(config)}`],
      {
        env: baseEnvironment(),
        signal: AbortSignal.timeout(15000),
      },
    );
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.some((id) => !/^[0-9a-f]{12,64}$/i.test(id)))
      throw new Error('Docker 返回了无效的容器 ID，已停止遗留任务清理');
    if (ids.length) {
      await runProcess('docker', ['rm', '-f', ...ids], {
        env: baseEnvironment(),
        signal: AbortSignal.timeout(30000),
      });
      await onLog(`已停止 ${ids.length} 个中断任务遗留的构建容器\n`);
    }
  }
  const workspaceRoot = path.join(config.dataDir, 'workspaces');
  if (!(await existingStat(workspaceRoot))) return;
  await plainDirectory(workspaceRoot);
  let removed = 0;
  for (const entry of await fs.readdir(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = /^(.+)-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (!match || (match[1] !== 'prune' && !UUID.test(match[1]))) continue;
    await fs.rm(path.join(workspaceRoot, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  if (removed) await onLog(`已清理 ${removed} 个中断任务的临时目录\n`);
}
