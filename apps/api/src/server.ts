import { resolve } from 'node:path';
import { createApp } from './app.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535.');
const app = await createApp({
  dataFile: resolve(process.env.API_DATA_FILE ?? 'data/projects.json'),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5173',
  ...(process.env.SOCIAL_DATA_FILE ? { socialDataFile: resolve(process.env.SOCIAL_DATA_FILE) } : {}),
  onError: (error) => console.error(error),
});
const server = app.listen(port, host, () =>
  console.log(`Yap API listening at http://${host}:${port}`),
);
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  });
}
