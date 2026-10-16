'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getConfig } = require('./config/env');
const { logger } = require('./config/logger');
const { connectDb, disconnectDb } = require('./config/db');
const storage = require('./services/storage');

async function sweepTmp() {          // abandoned multipart temp files (client aborted) older than 1h
  const dir = storage.tmpDir();
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    const p = path.join(dir, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 3600e3) await fsp.unlink(p).catch(() => {});
  }
}

async function main() {
  let cfg;
  try { cfg = getConfig(); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
  await connectDb(cfg.mongoUri);
  require('./models');                                  // register schemas
  const { User } = require('./models');
  await User.init();                                    // ensure unique indexes exist before serving
  await storage.init(); await sweepTmp();

  const { createApp } = require('./app');
  const server = http.createServer(createApp());
  server.requestTimeout = 0;                            // large audio uploads/streams; per-route limits apply
  server.headersTimeout = 65_000;
  const io = require('./socket').attach(server);

  const port = Number(process.env.PORT) || cfg.port;
  const host = (cfg.host && cfg.host !== '127.0.0.1') ? cfg.host : '0.0.0.0';
  server.listen(port, host, () => logger.info('server.listening', { port, host, env: cfg.nodeEnv }));
  const tmpTimer = setInterval(() => sweepTmp().catch(() => {}), 3600e3); tmpTimer.unref();

  let closing = false;
  async function shutdown(signal) {
    if (closing) return; closing = true;
    logger.info('server.shutdown', { signal });
    const force = setTimeout(() => { logger.error('server.shutdown_forced'); process.exit(1); }, 15_000); force.unref();
    io.close();                                         // also closes the HTTP server's websocket upgrades
    server.close(async () => { await disconnectDb().catch(() => {}); logger.info('server.closed'); process.exit(0); });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { err }));
  process.on('uncaughtException', (err) => { logger.error('uncaughtException', { err }); shutdown('uncaughtException'); });
}
main().catch((e) => { logger.error('startup.failed', { err: e }); process.exit(1); });
