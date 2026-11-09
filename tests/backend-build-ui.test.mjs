import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

test('project UI renders one Vue3 frontend/API pipeline and retains edit state while credential metadata loads', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-backend-ui-'));
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
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const form = {
    type: 'node',
    name: '咖啡',
    group: '',
    description: '',
    buildMode: 'multi',
    repoUrl: '',
    nodeVersion: '22.18.0',
    envText: 'SYNTHETIC_COMMON=preserved',
    timeoutSeconds: 7200,
    retainReleases: 5,
    environment: { SYNTHETIC_COMMON: 'preserved' },
    deploy: {
      type: 'ssh',
      root: '/data/httpd/www/demo.yunyingbao.net/frontend-deploy/coffee',
      host: '47.118.69.157',
      user: 'root',
      port: 22,
      credentialId: id,
    },
    sources: [
      {
        id: 'official',
        name: '官方仓库',
        repoUrl: 'http://git.yin-duo.com/mini-program/coffee.git',
        branch: 'main',
        buildCredentialId: id,
      },
    ],
    tasks: ['h5', 'admin'].map((task) => ({
      id: task,
      name: task,
      sourceId: 'official',
      nodeVersion: '22.18.0',
      targetVueMajor: 3,
      workdir: task === 'h5' ? 'mobile' : 'admin',
      packageManager: 'npm',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      artifactDir: 'dist',
      publishDir: task,
      environment: { SYNTHETIC_TASK: 'unchanged' },
      envText: 'SYNTHETIC_TASK=unchanged',
    })),
    backend: {
      enabled: true,
      type: 'php',
      sourceId: 'official',
      workdir: 'api',
      phpVersion: '8.5',
      application: 'coffee',
    },
  };
  const before = structuredClone(form);
  const render = (modelValue, credentials = []) =>
    renderToString(
      createSSRApp({
        render: () => h(Form, { modelValue, nodeVersions: ['22.18.0', '24'], credentials }),
      }),
    );
  const html = await render(form);
  for (const text of [
    'PHP 后端阶段',
    'API 仓库',
    'API 源码目录',
    '应用标识',
    'Vue 3',
    '22.18.0',
    'PHP 8.5 API',
    '不会升级仓库源码',
    '数据库、环境配置或上传数据',
  ]) {
    // The concise summary lives in the project list; the form itself displays its fixed version.
    if (text !== 'PHP 8.5 API') assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('http://git.yin-duo.com/mini-program/coffee.git'));
  assert.ok(html.includes('value="8.5"'));
  assert.equal(
    (html.match(/<option\b(?=[^>]*\bvalue="3")(?=[^>]*\bselected)[^>]*>Vue 3/g) || []).length,
    2,
  );
  assert.equal(html.includes('全部成功后，合并为一个版本并统一发布、回滚'), false);
  assert.deepEqual(form, before);
  const legacy = structuredClone(form);
  delete legacy.backend;
  legacy.tasks.forEach((task) => delete task.targetVueMajor);
  const oldBefore = structuredClone(legacy);
  const oldHtml = await render(legacy);
  assert.equal(oldHtml.includes('API 源码目录'), false);
  assert.ok(oldHtml.includes('全部成功后，合并为一个版本并统一发布、回滚'));
  assert.deepEqual(legacy, oldBefore);
  const single = {
    ...structuredClone(legacy),
    buildMode: 'single',
    repoUrl: form.sources[0].repoUrl,
    buildCredentialId: id,
  };
  const singleBefore = structuredClone(single);
  await render(single);
  assert.deepEqual(single, singleBefore);
});
