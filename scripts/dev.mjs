import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const useProcessGroups = process.platform !== 'win32';
const children = [];
let stopping = false;
let exitCode = 0;
let forceKillTimer;

function signalChild(child, signal) {
  if (!child.pid) return;
  try {
    if (useProcessGroups) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(`[dev] ${error.message}`);
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const { child } of children) signalChild(child, 'SIGTERM');
  forceKillTimer = setTimeout(() => {
    for (const { child } of children) signalChild(child, 'SIGKILL');
  }, 5000);
}

process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));

for (const [name, args] of [
  ['API', ['--env-file-if-exists=.env', 'server/index.mjs']],
  ['Worker', ['--env-file-if-exists=.env', 'server/worker.mjs']],
  ['Web', ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.js']],
]) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    detached: useProcessGroups,
    env: process.env,
  });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`[dev] ${name} 无法启动：${error.message}`);
      stop(1);
    });
    child.once('close', (code, signal) => {
      if (!stopping) {
        console.error(`[dev] ${name} 已退出（${signal || code}），停止其他进程。`);
        stop(code || 1);
      }
      resolve();
    });
  });
  children.push({ child, closed });
}

await Promise.allSettled(children.map((item) => item.closed));
clearTimeout(forceKillTimer);
process.exitCode = exitCode;
