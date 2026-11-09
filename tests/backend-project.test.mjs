import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject } from '../server/lib/validation.mjs';
import {
  backendApplicationForSource,
  environmentText,
  multiBuildSummary,
  parseEnvironment,
  setBackendEnabled,
  taskPayloads,
} from '../web/src/lib/multi-build.js';

const credentialId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fixture = () => ({
  type: 'node',
  name: '咖啡演示',
  buildMode: 'multi',
  sources: [
    {
      id: 'official',
      name: '官方仓库',
      repoUrl: 'http://git.yin-duo.com/mini-program/coffee.git',
      branch: 'main',
      buildCredentialId: credentialId,
    },
  ],
  tasks: ['h5', 'admin'].map((id) => ({
    id,
    name: id,
    sourceId: 'official',
    targetVueMajor: 3,
    nodeVersion: '22.18.0',
    workdir: id === 'h5' ? 'mobile' : 'admin',
    packageManager: 'npm',
    installCommand: 'npm ci',
    buildCommand: 'npm run build',
    artifactDir: 'dist',
    publishDir: id,
    environment: { PRIVATE_TASK_FIXTURE: 'synthetic=task#value' },
  })),
  backend: {
    enabled: true,
    type: 'php',
    sourceId: 'official',
    workdir: 'api',
    phpVersion: '8.5',
    application: 'coffee',
  },
  environment: { PRIVATE_COMMON_FIXTURE: 'synthetic=common#value' },
  deploy: {
    type: 'ssh',
    host: '47.118.69.157',
    user: 'root',
    port: 22,
    root: '/data/httpd/www/demo.yunyingbao.net/frontend-deploy/coffee',
    credentialId,
  },
});
const validate = (input) => validateProject(input, {});

test('one business model preserves Vue3 frontend targets, source and fixed PHP85 API stage', () => {
  const input = fixture();
  const output = validate(input);
  assert.deepEqual(output.backend, input.backend);
  assert.deepEqual(output.sources, input.sources);
  assert.deepEqual(
    output.tasks.map((task) => [task.targetVueMajor, task.nodeVersion]),
    [
      [3, '22.18.0'],
      [3, '22.18.0'],
    ],
  );
  assert.deepEqual(output.environment, input.environment);
  assert.deepEqual(
    output.tasks.map((task) => task.environment),
    input.tasks.map((task) => task.environment),
  );
  assert.match(multiBuildSummary(output), /PHP 8.5 API/);
});

test('absent or disabled backend and absent Vue target preserve legacy model behavior', () => {
  const input = fixture();
  delete input.backend;
  input.tasks.forEach((task) => delete task.targetVueMajor);
  const output = validate(input);
  assert.equal('backend' in output, false);
  assert.equal('targetVueMajor' in output.tasks[0], false);
  input.backend = { enabled: false };
  assert.deepEqual(validate(input).backend, { enabled: false });
  input.backend = false;
  assert.deepEqual(validate(input).backend, { enabled: false });
});

test('API scope rejects alternate scripts, paths, applications, runtimes and mixed sources', () => {
  const changes = [
    (p) => {
      p.backend.root = '/etc';
    },
    (p) => {
      p.backend.commands = 'arbitrary';
    },
    (p) => {
      p.backend.keepPrivate = false;
    },
    (p) => {
      p.backend.phpVersion = '8.2';
    },
    (p) => {
      p.backend.type = 'command';
    },
    (p) => {
      p.backend.workdir = '../api';
    },
    (p) => {
      p.backend.workdir = 'api/';
    },
    (p) => {
      p.backend.application = 'travel';
    },
    (p) => {
      p.backend.application = 'campsite';
    },
    (p) => {
      p.backend.sourceId = 'missing';
    },
    (p) => {
      p.sources[0].repoUrl = 'https://example.invalid/coffee.git';
    },
    (p) => {
      p.sources[0].repoUrl = 'https://git.yin-duo.com/mini-program/coffee.git?x=1';
    },
    (p) => {
      p.deploy = { type: 'local', root: '/srv/www/coffee' };
    },
    (p) => {
      p.buildMode = 'single';
    },
    (p) => {
      p.type = 'command';
      p.commands = 'true';
    },
    (p) => {
      p.sources.push({
        ...p.sources[0],
        id: 'other',
        repoUrl: 'https://example.invalid/other.git',
      });
      p.tasks[1].sourceId = 'other';
    },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => validate(input));
  }
  const disabled = fixture();
  disabled.backend = { enabled: false, root: '/etc' };
  assert.throws(() => validate(disabled));
  for (const target of [2, '3', true, null, {}, 4]) {
    const input = fixture();
    input.tasks[0].targetVueMajor = target;
    assert.throws(() => validate(input), /Vue 3/);
  }
});

test('exact HTTPS official source is supported without broadening application scope', () => {
  const input = fixture();
  input.sources[0].repoUrl = 'https://git.yin-duo.com/mini-program/coffee.git';
  assert.equal(validate(input).backend.application, 'coffee');
  assert.equal(backendApplicationForSource(input.sources[0]), 'coffee');
  assert.equal(backendApplicationForSource({ repoUrl: input.sources[0].repoUrl + '/else' }), '');
});

test('API toggle and JSON edit/save roundtrip retain existing private environments and identity', () => {
  const original = validate(fixture());
  const form = JSON.parse(JSON.stringify(original));
  form.envText = environmentText(form.environment);
  form.tasks.forEach((task) => {
    task.envText = environmentText(task.environment);
  });
  setBackendEnabled(form, false);
  setBackendEnabled(form, true);
  const { envText, ...values } = form;
  const payload = {
    ...values,
    tasks: taskPayloads(form.tasks),
    environment: parseEnvironment(envText),
  };
  assert.deepEqual(validate(payload), original);
  assert.equal(payload.deploy.credentialId, credentialId);
  assert.equal(payload.sources[0].buildCredentialId, credentialId);
  assert.deepEqual(taskPayloads([{ ...original.tasks[0], keepPrivate: true }])[0], {
    ...original.tasks[0],
    keepPrivate: true,
  });
  assert.deepEqual(
    taskPayloads([{ ...original.tasks[0] }])[0].environment,
    original.tasks[0].environment,
  );
  assert.equal(JSON.stringify(payload).includes('envText'), false);
});
