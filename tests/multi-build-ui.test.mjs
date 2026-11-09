import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

test('Vue form renders editable multi-source admin/H5/PC tasks and keeps legacy mode separate', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-multi-ssr-'));
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
  const { default: Form } = await server.ssrLoadModule('/src/components/ProjectForm.vue');
  const base = {
    type: 'node',
    name: '商城',
    group: '',
    description: '',
    repoUrl: 'https://example.invalid/shop.git',
    branch: 'main',
    nodeVersion: '22.18.0',
    packageManager: 'npm',
    workdir: '.',
    artifactDir: 'dist',
    timeoutSeconds: 900,
    envText: '',
    deploy: { type: 'local', root: '/srv/www/shop' },
    retainReleases: 5,
  };
  const sources = [
    { id: 'one', name: '商城仓库', repoUrl: base.repoUrl, branch: 'main', buildCredentialId: null },
    {
      id: 'two',
      name: '独立PC仓库',
      repoUrl: 'https://example.invalid/pc.git',
      branch: 'release',
      buildCredentialId: null,
    },
  ];
  const tasks = [
    ['admin', 'one', 'admin', 'static/admin'],
    ['H5', 'one', 'mobile', 'h5'],
    ['PC', 'two', 'pc', 'pc'],
  ].map(([name, sourceId, workdir, publishDir], i) => ({
    id: 'task' + i,
    name,
    sourceId,
    workdir,
    publishDir,
    nodeVersion: '22.18.0',
    packageManager: 'npm',
    packageManagerVersion: '',
    installCommand: 'npm ci',
    buildCommand: name === 'admin' ? 'npm run build' : 'npm run build:h5',
    artifactDir: 'dist',
    envText: '',
  }));
  const render = (modelValue) =>
    renderToString(
      createSSRApp({
        render: () => h(Form, { modelValue, nodeVersions: ['22', '24'], credentials: [] }),
      }),
    );
  const multi = await render({ ...base, buildMode: 'multi', sources, tasks });
  for (const label of [
    '添加代码源',
    '添加构建任务',
    '任务环境变量',
    '公共构建环境变量',
    '商城仓库',
    '独立PC仓库',
    'static/admin',
    'mobile',
    '22.18.0',
  ])
    assert.ok(multi.includes(label), label);
  assert.equal((multi.match(/class="multi-card"/g) || []).length, 5);
  assert.ok(multi.includes('按下面的顺序构建'));
  const single = await render({ ...base, buildMode: 'single' });
  assert.equal(single.includes('添加代码源'), false);
  assert.ok(single.includes('构建产物目录'));
});
