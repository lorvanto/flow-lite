import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfig } from './config.mjs';
import { createStore, now } from './services/store.mjs';
import * as runner from './runners/build.mjs';
import { executeCommands } from './runners/command.mjs';
import { createLogWriter, secretValues, redactText } from './lib/logs.mjs';
import { sameTarget } from './lib/validation.mjs';

export async function runWorker(config, { signal, once = false } = {}) {
  const store = createStore(config);
  const owner = randomUUID();
  let activeController;
  let heartbeat;
  let acquired = false;
  let ownsLease = true;
  try {
    if (!store.acquireWorker(owner))
      throw new Error('已有执行器持有任务队列，请勿同时启动多个 worker');
    acquired = true;
    heartbeat = setInterval(() => {
      try {
        if (!store.heartbeat(owner)) {
          ownsLease = false;
          activeController?.abort(new Error('执行器失去队列所有权'));
        }
      } catch {
        ownsLease = false;
        activeController?.abort(new Error('任务队列不可用'));
      }
    }, 3000);
    for (const interrupted of store.recoverRuns()) {
      const run = store.getRun(interrupted.id);
      if (run?.kind === 'build')
        fs.rmSync(path.join(config.dataDir, 'artifacts', run.projectId, run.id), {
          recursive: true,
          force: true,
        });
      fs.appendFileSync(
        path.join(config.dataDir, 'logs', `${interrupted.id}.log`),
        '\n[Flow Lite] 执行器重启，原任务已中断。请检查发布目录后重试。\n',
        { mode: 0o600 },
      );
    }
    let cleaned = !runner.cleanupAbandonedBuilds;
    let cleanupWarningAt = 0;
    let cleanupRetryAt = 0;
    const stop = () => activeController?.abort(new Error('执行器正在关闭'));
    signal?.addEventListener('abort', stop);
    try {
      while (!signal?.aborted && ownsLease) {
        if (!cleaned && Date.now() >= cleanupRetryAt) {
          try {
            await runner.cleanupAbandonedBuilds({
              config,
              onLog: (text) => console.info(String(text).trim()),
            });
            cleaned = true;
          } catch (error) {
            cleanupRetryAt = Date.now() + 5000;
            if (Date.now() - cleanupWarningAt > 60000) {
              console.error(
                '[Flow Lite worker] Node.js 构建环境尚未就绪，构建任务保持排队；命令任务仍可执行。请启动 Docker 并检查连接。',
              );
              cleanupWarningAt = Date.now();
            }
          }
        }
        const run = store.claimNextRun(owner, { allowBuilds: cleaned });
        if (!run) {
          if (once) break;
          await delay(500, null, { signal }).catch(() => {});
          continue;
        }
        activeController = new AbortController();
        const project = run.projectSnapshot;
        const credentials = {};
        for (const id of new Set(
          [
            project.buildCredentialId,
            ...(project.sources || []).map((source) => source.buildCredentialId),
            project.deploy.credentialId,
          ].filter(Boolean),
        )) {
          const credential = store.getCredential(id);
          if (credential) credentials[id] = credential;
        }
        const secrets = secretValues(project, credentials);
        const logger = createLogWriter(path.join(config.dataDir, 'logs', `${run.id}.log`), secrets);
        let timeout;
        let cancellation;
        let result;
        let caught;
        try {
          logger.write(
            `[Flow Lite] #${run.number} ${run.kind === 'command' ? '命令发布' : run.kind === 'rollback' ? '回滚' : '构建发布'} ${project.name}\n`,
          );
          logger.write(
            `[Flow Lite] 排队配置已锁定，执行环境：${run.kind === 'command' ? (project.deploy.type === 'ssh' ? 'SSH 命令' : '本机命令') : config.runnerMode}\n`,
          );
          const abort = (message) => {
            if (!activeController.signal.aborted) activeController.abort(new Error(message));
          };
          timeout = setTimeout(
            () => abort(`任务超过 ${project.timeoutSeconds} 秒，已终止`),
            project.timeoutSeconds * 1000,
          );
          cancellation = setInterval(() => {
            if (store.getRun(run.id)?.cancelRequested) abort('用户取消了任务');
          }, 300);
          const args = {
            run,
            project,
            config,
            credentials,
            signal: activeController.signal,
            onLog: (text) => logger.write(text),
            onStage: (stage) => {
              store.updateRun(run.id, { stage });
              logger.write(`\n[Flow Lite] 阶段：${stage}\n`);
            },
            onMetadata: (metadata) => store.updateRun(run.id, metadata),
          };
          result = await (run.kind === 'command'
            ? executeCommands(args)
            : run.kind === 'rollback'
              ? runner.executeRollback(args)
              : runner.executeBuild(args));
          if (run.kind !== 'command')
            store.transaction(() => {
              const current = store.getProject(project.id);
              if (
                (current?.type || 'node') === 'node' &&
                sameTarget(current?.deploy, project.deploy)
              )
                store.setCurrentRelease(
                  project.id,
                  run.kind === 'rollback' ? run.rollbackReleaseId : run.id,
                );
            });
          logger.write(
            run.kind === 'command'
              ? '\n[Flow Lite] 命令执行完成，文件操作已直接应用到执行目录。\n'
              : '\n[Flow Lite] 发布完成，当前网站版本已切换。\n',
          );
        } catch (error) {
          const reason = activeController.signal.aborted ? activeController.signal.reason : error;
          caught = redactText(reason?.message || String(reason), secrets).slice(0, 4000);
          logger.write(`\n[Flow Lite] 执行结束：${caught}\n`);
        } finally {
          clearTimeout(timeout);
          clearInterval(cancellation);
          logger.close();
        }
        if (result) {
          store.updateRun(run.id, {
            ...result,
            status: 'success',
            stage: 'done',
            finishedAt: now(),
            error: null,
          });
          // Cleanup is independent of publication: a cleanup failure must not mark a live release failed.
          try {
            if (run.kind !== 'command') await prune(config, store, project, credentials);
            else pruneOldLogs(config, store);
          } catch (error) {
            fs.appendFileSync(
              path.join(config.dataDir, 'logs', `${run.id}.log`),
              `\n[Flow Lite] 旧版本清理未完成：${redactText(error.message, secrets)}\n`,
              { mode: 0o600 },
            );
          }
        } else {
          const cancelled = store.getRun(run.id)?.cancelRequested;
          store.updateRun(run.id, {
            status: cancelled ? 'cancelled' : 'failed',
            error: caught || '任务执行失败',
            finishedAt: now(),
          });
          if (run.kind === 'build')
            fs.rmSync(path.join(config.dataDir, 'artifacts', project.id, run.id), {
              recursive: true,
              force: true,
            });
        }
        activeController = null;
        if (once) break;
      }
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  } finally {
    clearInterval(heartbeat);
    if (acquired) store.releaseWorker(owner);
    store.close();
  }
}

async function prune(config, store, project, credentials) {
  const runs = store.listRuns(project.id, 100000);
  const successful = runs.filter(
    (run) =>
      run.kind === 'build' &&
      run.status === 'success' &&
      sameTarget(run.projectSnapshot.deploy, project.deploy),
  );
  const keepIds = new Set(successful.slice(0, project.retainReleases).map((run) => run.id));
  const current = store.getProject(project.id)?.currentReleaseId;
  if (current) keepIds.add(current);
  for (const run of runs)
    if (run.rollbackReleaseId && ['queued', 'running'].includes(run.status))
      keepIds.add(run.rollbackReleaseId);
  for (const run of successful) {
    if (keepIds.has(run.id)) continue;
    fs.rmSync(path.join(config.dataDir, 'artifacts', project.id, run.id), {
      recursive: true,
      force: true,
    });
    store.updateRun(run.id, { artifactPath: null });
  }
  if (runner.pruneReleases)
    await runner.pruneReleases({
      config,
      project,
      credentials,
      keepIds: [...keepIds],
      onLog: () => {},
    });
  pruneOldLogs(config, store);
}

function pruneOldLogs(config, store) {
  // Keep every run record while pruning old finished logs after 30 days.
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const run of store.listRuns(null, 100000)) {
    if (run.finishedAt && Date.parse(run.finishedAt) < cutoff)
      fs.rmSync(path.join(config.dataDir, 'logs', `${run.id}.log`), { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => controller.abort(new Error('执行器正在关闭')));
  try {
    await runWorker(getConfig(), { signal: controller.signal });
  } catch (error) {
    console.error(`[Flow Lite worker] ${error.message}`);
    process.exitCode = 1;
  }
}
