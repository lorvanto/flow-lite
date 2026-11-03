import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { registerFrontend } from '../server/services/static.mjs';

test('静态服务只暴露构建文件，不从请求路径读取磁盘文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-static-test-'));
  const dist = path.join(root, 'dist');
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Flow Lite</title>');
  await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("Flow Lite")');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_SECRET');
  await fs.symlink(path.join(root, '.env'), path.join(dist, 'linked-secret'));
  const app = Fastify();
  registerFrontend(app, dist);
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal((await app.inject('/')).statusCode, 200);
  const script = await app.inject('/assets/app.js');
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['content-type'], /javascript/);
  for (const url of [
    '/../.env',
    '/%2e%2e/.env',
    '/assets/%2e%2e/%2e%2e/.env',
    '/linked-secret',
    '/.env',
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('PRIVATE_SECRET'), false);
  }
});
