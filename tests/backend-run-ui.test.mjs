import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

test('run detail projects the separate PHP backend progress without treating it as a frontend task', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-backend-run-ui-'));
  const server = await createServer({
    cacheDir,
    optimizeDeps: { noDiscovery: true, include: [] },
    configFile: fileURLToPath(new URL('../web/vite.config.js', import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
  });
  t.after(async () => {
    await server.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });
  const { default: Drawer } = await server.ssrLoadModule('/src/components/RunDetailDrawer.vue');
  const backend = {
    type: 'php',
    phpVersion: '8.5.12',
    application: 'coffee',
    sourceCommit: 'a'.repeat(40),
    status: 'running',
    stage: 'lint',
    extra: 'SYNTHETIC_PRIVATE_BACKEND_FIELD',
  };
  const run = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    number: 1,
    projectName: '咖啡',
    kind: 'build',
    status: 'running',
    stage: 'build',
    createdAt: '2026-11-06T00:00:00.000Z',
    buildMode: 'multi',
    sourceCount: 1,
    taskCount: 2,
    nodeVersion: '22.18.0',
    buildDetails: {
      sources: [{ id: 'official', name: '官方仓库', branch: 'main', commitSha: 'a'.repeat(40) }],
      tasks: ['h5', 'admin'].map((id) => ({
        id,
        name: id,
        status: 'success',
        nodeVersion: '22.18.0',
        publishDir: id,
      })),
      backend,
    },
  };
  const render = (value) =>
    renderToString(createSSRApp({ render: () => h(Drawer, { run: value }) }));
  const active = await render(run);
  for (const text of [
    'API 后端阶段',
    'PHP 8.5.12',
    'PHP 语法检查',
    '类型 PHP',
    '应用 coffee',
    'aaaaaaaaaaaa',
    '2 个前端任务',
  ])
    assert.ok(active.includes(text), text);
  assert.equal(active.includes(backend.extra), false);
  assert.equal(run.buildDetails.tasks.length, 2);
  const failed = await render({
    ...run,
    buildDetails: { ...run.buildDetails, backend: { ...backend, status: 'failed' } },
  });
  assert.ok(failed.includes('失败'));
  const uncertain = await render({
    ...run,
    buildDetails: {
      ...run.buildDetails,
      backend: { ...backend, status: 'failed', stage: 'recovery_required' },
    },
  });
  assert.ok(uncertain.includes('需核实恢复状态'));
  const publishing = await render({
    ...run,
    buildDetails: { ...run.buildDetails, backend: { ...backend, stage: 'frontend-publish' } },
  });
  assert.ok(publishing.includes('发布前端版本'));
  const rollback = await render({
    ...run,
    kind: 'rollback',
    buildDetails: { ...run.buildDetails, backend: { ...backend, stage: 'rollback' } },
  });
  assert.ok(rollback.includes('使用历史前端与 API 代码产物回滚'));
  assert.ok(rollback.includes('数据库、环境配置和上传数据保持不变'));
  const legacy = structuredClone(run);
  delete legacy.buildDetails.backend;
  const old = await render(legacy);
  assert.equal(old.includes('API 后端阶段'), false);
  assert.ok(old.includes('2 个构建任务'));
});
