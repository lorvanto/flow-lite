import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const imagePathComponent = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const imageRegistry = '[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?';
const imageRepository = new RegExp(
  `^(?:${imageRegistry}/)?${imagePathComponent}(?:/${imagePathComponent})*$`,
);

export function validateNodeImagePrefix(value) {
  if (typeof value !== 'string' || value.length > 255 || !imageRepository.test(value)) {
    throw new Error('FLOW_NODE_IMAGE_PREFIX 必须为不含协议、标签或摘要的镜像仓库名');
  }
  const registry = value.split('/')[0];
  if (registry.includes(':')) {
    const port = Number(registry.split(':')[1]);
    if (port < 1 || port > 65535) throw new Error('FLOW_NODE_IMAGE_PREFIX 的镜像仓库端口无效');
  }
  return value;
}

export function getConfig(overrides = {}) {
  const config = {
    dataDir: path.resolve(process.env.FLOW_DATA_DIR || path.join(projectRoot, 'data')),
    host: process.env.FLOW_HOST || '127.0.0.1',
    port: Number(process.env.FLOW_PORT || 3210),
    runnerMode: process.env.FLOW_RUNNER_MODE || 'docker',
    nodeImagePrefix: process.env.FLOW_NODE_IMAGE_PREFIX || 'node',
    dockerMemory: process.env.FLOW_DOCKER_MEMORY || '8g',
    dockerCpus: process.env.FLOW_DOCKER_CPUS || '4',
    allowHostRunner: process.env.FLOW_ALLOW_HOST_RUNNER === 'true',
    allowLocalRepositories: process.env.FLOW_ALLOW_LOCAL_REPOSITORIES === 'true',
    secureCookie: process.env.FLOW_SECURE_COOKIE === 'true',
    setupToken: process.env.FLOW_SETUP_TOKEN || '',
    ...overrides,
  };
  config.nodeImagePrefix = validateNodeImagePrefix(config.nodeImagePrefix);
  if (!['docker', 'host'].includes(config.runnerMode))
    throw new Error('FLOW_RUNNER_MODE 必须为 docker 或 host');
  if (config.runnerMode === 'host' && !config.allowHostRunner)
    throw new Error('宿主机构建需要显式设置 FLOW_ALLOW_HOST_RUNNER=true');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error('无效端口');
  if (!/^\d+(?:[kmgt])?$/i.test(config.dockerMemory) || !(Number(config.dockerCpus) > 0))
    throw new Error('无效的 Docker 资源限制');
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  for (const name of ['logs', 'artifacts', 'workspaces'])
    fs.mkdirSync(path.join(config.dataDir, name), { recursive: true, mode: 0o700 });
  config.masterKey = readOrCreate(path.join(config.dataDir, 'master.key'), 32);
  if (!config.setupToken)
    config.setupToken = readOrCreate(path.join(config.dataDir, 'setup-token'), 24).toString('hex');
  return config;
}

function readOrCreate(filename, length) {
  try {
    fs.writeFileSync(filename, randomBytes(length).toString('hex'), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const hex = fs.readFileSync(filename, 'utf8').trim();
  if (!new RegExp(`^[a-f0-9]{${length * 2}}$`).test(hex))
    throw new Error(`密钥文件格式错误：${filename}`);
  fs.chmodSync(filename, 0o600);
  return Buffer.from(hex, 'hex');
}
