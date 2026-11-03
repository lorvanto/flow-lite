import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess, checkAbort } from '../lib/process.mjs';
import { prepareSshAuth } from './ssh-auth.mjs';
import { projectRoot as sourceRoot } from '../config.mjs';

const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const broadRoots = new Set([
  '/',
  '/bin',
  '/sbin',
  '/usr',
  '/usr/local',
  '/etc',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/var/www',
  '/var/lib',
  '/var/log',
  '/srv',
  '/srv/www',
  '/opt',
  '/home',
  '/root',
  '/tmp',
  '/run',
  '/www',
  '/www/wwwroot',
  '/data',
  '/data/www',
]);
const reservedEnv = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'BASH_ENV',
  'ENV',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
]);

function baseEnvironment() {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
  };
}

function environmentMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('环境变量必须为键值对象');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(key) || typeof item !== 'string' || /[\0\r\n]/.test(item))
      throw new Error('环境变量名称无效或值包含换行');
    if (reservedEnv.has(key) || key.startsWith('__FLOW_LITE_'))
      throw new Error(`环境变量 ${key} 为执行器保留变量`);
    result[key] = item;
  }
  return result;
}

function validateRoot(value) {
  if (
    typeof value !== 'string' ||
    !path.posix.isAbsolute(value) ||
    /[\0\r\n\\]/.test(value) ||
    value.split('/').includes('..')
  )
    throw new Error('命令工作目录必须为独立的绝对路径');
  const root = path.posix.normalize(value).replace(/\/$/, '') || '/';
  if (root.split('/').filter(Boolean).length < 2 || broadRoots.has(root))
    throw new Error('不能在根目录或公共父目录执行命令，请填写具体项目目录');
  return root;
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

async function canonicalCandidate(candidate) {
  let cursor = path.resolve(candidate);
  const missing = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(cursor), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function localDirectory(root, config) {
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('命令工作目录不存在，请先在服务器上创建项目目录');
    throw error;
  }
  if (!stat.isDirectory()) throw new Error('命令工作目录必须是已存在的目录');
  const real = await fs.realpath(root);
  validateRoot(real);
  if (process.env.HOME && real === (await canonicalCandidate(process.env.HOME)))
    throw new Error('不能直接在用户主目录执行命令，请填写具体项目目录');
  for (const candidate of [config.dataDir, config.projectRoot, sourceRoot].filter(Boolean)) {
    const protectedPath = await canonicalCandidate(candidate);
    if (overlaps(real, protectedPath)) throw new Error('命令工作目录不能与平台源码或数据目录重叠');
  }
  return real;
}

function remoteDirectoryChecks(root, config) {
  const lines = [
    `__FLOW_LITE_ROOT=${shellQuote(root)}`,
    '[ -d "$__FLOW_LITE_ROOT" ] || { printf "%s\\n" "命令工作目录不存在或不是目录" >&2; exit 1; }',
    'cd -- "$__FLOW_LITE_ROOT"',
    '__FLOW_LITE_REAL=$(pwd -P)',
    'case "$__FLOW_LITE_REAL" in /*/*) ;; *) printf "%s\\n" "不能在根目录或公共父目录执行命令" >&2; exit 1 ;; esac',
    `case "$__FLOW_LITE_REAL" in ${[...broadRoots].map(shellQuote).join('|')}) printf "%s\\n" "不能在根目录或公共父目录执行命令" >&2; exit 1 ;; esac`,
    '[ "$__FLOW_LITE_REAL" != "$HOME" ] || { printf "%s\\n" "不能直接在用户主目录执行命令" >&2; exit 1; }',
  ];
  for (const candidate of [
    ...new Set([config.dataDir, config.projectRoot, sourceRoot].filter(Boolean)),
  ]) {
    const protectedPath = path.posix.normalize(candidate);
    lines.push(
      `__FLOW_LITE_PROTECTED=${shellQuote(protectedPath)}`,
      'case "$__FLOW_LITE_ROOT/" in "$__FLOW_LITE_PROTECTED/"*) printf "%s\\n" "命令工作目录不能与平台源码或数据目录重叠" >&2; exit 1 ;; esac',
      'case "$__FLOW_LITE_PROTECTED/" in "$__FLOW_LITE_ROOT/"*) printf "%s\\n" "命令工作目录不能与平台源码或数据目录重叠" >&2; exit 1 ;; esac',
      'if [ -d "$__FLOW_LITE_PROTECTED" ]; then if __FLOW_LITE_CANON=$(cd -- "$__FLOW_LITE_PROTECTED" 2>/dev/null && pwd -P); then __FLOW_LITE_PROTECTED=$__FLOW_LITE_CANON; fi; fi',
      'case "$__FLOW_LITE_REAL/" in "$__FLOW_LITE_PROTECTED/"*) printf "%s\\n" "命令工作目录不能与平台源码或数据目录重叠" >&2; exit 1 ;; esac',
      'case "$__FLOW_LITE_PROTECTED/" in "$__FLOW_LITE_REAL/"*) printf "%s\\n" "命令工作目录不能与平台源码或数据目录重叠" >&2; exit 1 ;; esac',
    );
  }
  return lines;
}

// Keep the remote command fixed: user commands and values travel over stdin.
const REMOTE_LAUNCH = `exec /usr/bin/env -i PATH="\${PATH:-/usr/local/bin:/usr/bin:/bin}" HOME="$HOME" LANG="\${LANG:-C.UTF-8}" /bin/sh -c 'if command -v setsid >/dev/null 2>&1 && setsid --help 2>&1 | grep -q -- --wait; then export __FLOW_LITE_SESSION=1; exec setsid --wait /bin/sh -e; else exec /bin/sh -e; fi'`;

function remoteScript({ root, config, environment, commands, token }) {
  return [
    ...remoteDirectoryChecks(root, config),
    `printf '${token}:%s:%s\\n' "$$" "\${__FLOW_LITE_SESSION:-0}"`,
    '__flow_lite_exit() {',
    '  __FLOW_LITE_STATUS=$?',
    '  trap - EXIT HUP INT TERM',
    '  trap "" HUP INT TERM',
    '  if [ "\${__FLOW_LITE_SESSION:-0}" = 1 ]; then',
    '    (sleep 1; /bin/kill -KILL -- "-$$" 2>/dev/null || true) </dev/null >/dev/null 2>&1 &',
    '    /bin/kill -TERM -- "-$$" 2>/dev/null || true',
    '  fi',
    '  exit "$__FLOW_LITE_STATUS"',
    '}',
    'trap __flow_lite_exit EXIT',
    'trap "exit 129" HUP',
    'trap "exit 130" INT',
    'trap "exit 143" TERM',
    ...Object.entries(environment).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    commands,
    '',
  ].join('\n');
}

async function remoteCommands({
  run,
  project,
  config,
  credentials,
  signal,
  onLog,
  onStage,
  environment,
  root,
}) {
  const target = project.deploy;
  const host = String(target.host || '');
  const user = String(target.user || '');
  const port = Number(target.port || 22);
  if (
    !/^(?:[A-Za-z\d][A-Za-z\d.-]*|\[[\da-f:]+\]|[\da-f:]+)$/i.test(host) ||
    !/^[A-Za-z_][A-Za-z\d_.-]*\$?$/.test(user) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('SSH 主机、用户名或端口无效');
  const credential =
    credentials instanceof Map
      ? credentials.get(target.credentialId)
      : credentials?.[target.credentialId];
  if (!credential || credential.type !== 'ssh') throw new Error('请选择有效的 SSH 凭据');
  const workspaceRoot = path.join(config.dataDir, 'workspaces');
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const tempDir = await fs.mkdtemp(path.join(workspaceRoot, `${run.id}-`));
  await fs.chmod(tempDir, 0o700);
  let control;
  const token = `__FLOW_LITE_CONTROL_${randomUUID().replaceAll('-', '')}`;
  const controlPattern = new RegExp(`^${token}:(\\d+):([01])\\s*$`);
  try {
    const auth = await prepareSshAuth({
      credential,
      tempDir,
      prefix: 'command',
      env: baseEnvironment(),
    });
    const sshArgs = [
      '-T',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      ...auth.args,
    ];
    sshArgs.push('-p', String(port), '--', `${user}@${host}`, REMOTE_LAUNCH);
    await onLog(`SSH 工作目录：${user}@${host}:${root}\n`);
    await onStage('commands');
    try {
      await runProcess('ssh', sshArgs, {
        env: auth.env,
        signal,
        input: remoteScript({ root, config, environment, commands: project.commands, token }),
        onOutput: async (value) => {
          const match = controlPattern.exec(value);
          if (match) {
            const pid = Number(match[1]);
            if (Number.isSafeInteger(pid) && pid > 1 && pid <= 2147483647)
              control = { pid, group: match[2] === '1' };
            if (!control?.group)
              await onLog(
                '远端不支持带等待功能的 setsid，取消时只能尽力终止命令，请检查残留进程。\n',
              );
          } else await onLog(value);
        },
      });
    } catch (error) {
      if (signal.aborted) {
        await onLog('正在尝试终止远程命令；已经完成的文件修改不会自动撤销。\n');
        if (control) {
          const destination = control.group ? `-${control.pid}` : String(control.pid);
          const cleanup = `set +e\n/bin/kill -TERM -- ${shellQuote(destination)} 2>/dev/null\nsleep 1\n/bin/kill -KILL -- ${shellQuote(destination)} 2>/dev/null\nexit 0\n`;
          try {
            await runProcess('ssh', sshArgs, {
              env: auth.env,
              signal: AbortSignal.timeout(5000),
              input: cleanup,
            });
            await onLog('已发送远程终止请求。SSH 断线时仍需检查目标服务器上的执行结果。\n');
          } catch {
            await onLog('远程终止请求未能确认，请检查目标服务器是否仍有命令运行。\n');
          }
        } else await onLog('未取得远程进程信息，请检查目标服务器是否仍有命令运行。\n');
      }
      throw error;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function executeCommands({
  run,
  project,
  config,
  credentials = {},
  signal,
  onLog = () => {},
  onStage = () => {},
}) {
  if (project?.type !== 'command') throw new Error('命令执行器仅接受显式的自定义命令项目');
  if (!UUID.test(run?.id || '')) throw new Error('运行 ID 无效');
  if (!path.isAbsolute(config?.dataDir || '')) throw new Error('平台数据目录必须为绝对路径');
  if (
    typeof project.commands !== 'string' ||
    !project.commands.trim() ||
    project.commands.includes('\0') ||
    Buffer.byteLength(project.commands) > 100 * 1024
  )
    throw new Error('请填写自定义命令，长度不能超过 100 KB');
  const timeout = Number(project.timeoutSeconds || 900);
  if (
    !Number.isFinite(timeout) ||
    timeout < 1 ||
    timeout > 86400 ||
    !Number.isInteger(timeout * 1000)
  )
    throw new Error('任务超时必须在 1 到 86400 秒之间');
  const timeoutSignal = AbortSignal.timeout(timeout * 1000);
  const activeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  checkAbort(activeSignal);
  await onStage('prepare');
  const environment = environmentMap(project.environment);
  const root = validateRoot(project.deploy?.root);
  if (project.deploy.type === 'local') {
    const directory = await localDirectory(root, config);
    checkAbort(activeSignal);
    await onLog(`本机工作目录：${root}\n自定义命令将直接修改该目录中的文件。\n`);
    await onStage('commands');
    await runProcess('/bin/sh', ['-e'], {
      cwd: directory,
      env: { ...baseEnvironment(), ...environment },
      signal: activeSignal,
      input: `${project.commands.replaceAll('\r\n', '\n')}\n`,
      onOutput: onLog,
    });
  } else if (project.deploy.type === 'ssh') {
    await remoteCommands({
      run,
      project,
      config,
      credentials,
      signal: activeSignal,
      onLog,
      onStage,
      environment,
      root,
    });
  } else throw new Error('命令执行目标必须为本机或 SSH 服务器');
  checkAbort(activeSignal);
  await onLog('自定义命令执行完成。\n');
  return { releasePath: project.deploy.root };
}
