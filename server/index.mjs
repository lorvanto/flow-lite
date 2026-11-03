import { getConfig } from './config.mjs';
import { createApp } from './app.mjs';

const config = getConfig();
const app = await createApp(config, {
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
  },
});
await app.listen({ host: config.host, port: config.port });
if (!app.store.setting('auth'))
  console.info(`首次使用：请读取 ${config.dataDir}/setup-token，在网页中创建管理员。`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000).unref();
    await app.close();
    clearTimeout(deadline);
    process.exit(0);
  });
