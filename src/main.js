import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createApp } from './app.js';
import { Bot } from './bot.js';
import { Store } from './store.js';

const config = z.object({
  NODE_ENV: z.enum(['development', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  PUBLIC_URL: z.url(), DATA_DIR: z.string().min(1),
  ADMIN_TOKEN: z.string().min(32).max(200).regex(/^[A-Za-z0-9_+/=-]+$/),
  SESSION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
}).parse(process.env);
const production = config.NODE_ENV === 'production';
if (production) process.umask(0o077);
const url = new URL(config.PUBLIC_URL);
if (url.origin !== config.PUBLIC_URL || (production && url.protocol !== 'https:')
  || (!production && !['localhost', '127.0.0.1'].includes(url.hostname)))
  throw new Error('PUBLIC_URL must be an HTTPS origin in production, or a localhost origin in development (no trailing slash).');
const dataDir = resolve(config.DATA_DIR);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (production) chmodSync(dataDir, 0o700);
const store = new Store(resolve(dataDir, 'notifier.sqlite'), Buffer.from(config.SESSION_KEY, 'base64'));
const bot = new Bot(store);
const app = createApp({ store, bot, adminToken: config.ADMIN_TOKEN, publicUrl: config.PUBLIC_URL, production });
const server = app.listen(config.PORT, production ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Notifier listening on port ${config.PORT}; admin: ${config.PUBLIC_URL}/admin`);
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.on('error', () => { console.error('HTTP server failed.'); process.exit(1); });
function shutdown() {
  bot.stop();
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 20000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
// Decryption/schema errors intentionally stop startup; expired Zalo login is visible in admin.
try { await bot.restore(); }
catch { console.error('Stored Zalo session is unreadable or belongs to another bot; verify SESSION_KEY and persistent disk.'); process.exit(1); }
