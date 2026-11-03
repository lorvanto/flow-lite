import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../server/config.mjs';

test('Docker默认限制4CPU/8GB，环境变量可显式覆盖', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-test-'));
  const keys = ['FLOW_DOCKER_MEMORY', 'FLOW_DOCKER_CPUS'];
  const previousValues = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const key of keys) {
      if (previousValues[key] === undefined) delete process.env[key];
      else process.env[key] = previousValues[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const key of keys) delete process.env[key];
  const defaults = getConfig({
    dataDir: directory,
    runnerMode: 'docker',
    setupToken: 'config-test-token',
  });
  assert.equal(defaults.dockerCpus, '4');
  assert.equal(defaults.dockerMemory, '8g');

  process.env.FLOW_DOCKER_CPUS = '2.5';
  process.env.FLOW_DOCKER_MEMORY = '4g';
  const overridden = getConfig({
    dataDir: directory,
    runnerMode: 'docker',
    setupToken: 'config-test-token',
  });
  assert.equal(overridden.dockerCpus, '2.5');
  assert.equal(overridden.dockerMemory, '4g');
});
