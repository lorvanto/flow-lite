import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export function checkAbort(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('任务已取消', 'AbortError');
  }
}

/** Run a subprocess without a shell; abort its entire process group on POSIX. */
export async function runProcess(command, args = [], options = {}) {
  const { cwd, env, signal, onOutput, input, captureLimit = 4 * 1024 * 1024 } = options;
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let outputQueue = Promise.resolve();
    let outputError;
    let spawnError;
    let inputError;
    let killTimer;
    let closed = false;
    const pending = { stdout: '', stderr: '' };

    const killGroup = (force = false) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM');
        else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') spawnError ??= error;
      }
    };
    const abort = () => {
      killGroup();
      killTimer ??= setTimeout(() => killGroup(true), 1500);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });

    const emit = (value) => {
      if (!onOutput || !value) return;
      outputQueue = outputQueue
        .then(() => onOutput(value))
        .catch((error) => {
          outputError ??= error;
          abort();
        });
    };
    const consume = (kind, value) => {
      if (kind === 'stdout') stdout = (stdout + value).slice(-captureLimit);
      else stderr = (stderr + value).slice(-captureLimit);
      // Keep ordinary lines together so log redaction also works across stream chunks.
      pending[kind] += value;
      let index;
      while ((index = pending[kind].indexOf('\n')) >= 0) {
        emit(pending[kind].slice(0, index + 1));
        pending[kind] = pending[kind].slice(index + 1);
      }
      if (pending[kind].length > 65536) {
        emit(pending[kind].slice(0, 32768));
        pending[kind] = pending[kind].slice(32768);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => consume('stdout', value));
    child.stderr.on('data', (value) => consume('stderr', value));
    child.on('error', (error) => {
      spawnError = error;
    });
    child.stdin.on('error', (error) => {
      // EPIPE is expected when a command rejects input and exits early.
      if (error.code !== 'EPIPE') inputError = error;
    });

    if (input?.pipe) {
      input.on('error', (error) => {
        inputError = error;
        abort();
      });
      input.pipe(child.stdin);
    } else {
      child.stdin.end(input);
    }
    // Account for cancellation between the initial check and listener registration.
    if (signal?.aborted) abort();

    child.on('close', async (code, exitSignal) => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', abort);
      // The parent may exit before a descendant that ignored SIGTERM. Never leave
      // that descendant alive merely because the direct child already closed.
      if (signal?.aborted || outputError || inputError) killGroup(true);
      if (killTimer) clearTimeout(killTimer);
      if (input?.destroy && !input.destroyed) input.destroy();
      emit(pending.stdout);
      emit(pending.stderr);
      await outputQueue;
      try {
        checkAbort(signal);
        if (outputError) throw outputError;
        if (spawnError) throw spawnError;
        if (inputError) throw inputError;
        if (code !== 0) {
          const error = new Error(
            `${basename(command)} 执行失败（${exitSignal || `退出码 ${code}`}）`,
          );
          error.exitCode = code;
          error.stdout = stdout;
          error.stderr = stderr;
          throw error;
        }
        resolve({ stdout, stderr, exitCode: code });
      } catch (error) {
        reject(error);
      }
    });
  });
}
