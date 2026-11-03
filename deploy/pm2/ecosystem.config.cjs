const path = require('node:path');

const common = {
  cwd: path.resolve(__dirname, '../..'),
  interpreter: process.execPath,
  node_args: ['--env-file-if-exists=.env'],
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  restart_delay: 2000,
  min_uptime: 5000,
  max_restarts: 10,
  kill_timeout: 10000,
  time: true,
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    { ...common, name: 'flow-lite-api', script: 'server/index.mjs' },
    { ...common, name: 'flow-lite-worker', script: 'server/worker.mjs' },
  ],
};
