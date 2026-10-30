'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { getConfig } = require('./config/env');
const { dbReady } = require('./config/db');
const rl = require('./middleware/rateLimit');
const { requireAuth, enforcePasswordChange, csrf } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/error');
const { clean } = require('./utils/sanitize');
const misc = require('./routes/misc');
const audio = require('./routes/audio');

function createApp() {
  const cfg = getConfig();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  const isAllowedOrigin = (origin) => {
    if (!origin || cfg.allowAnyOrigin) return true;
    if (cfg.frontendOrigins && cfg.frontendOrigins.includes(origin)) return true;
    if (cfg.frontendOrigin && cfg.frontendOrigin === origin) return true;
    return false;
  };
  app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin) ? origin : false), credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Pulse-Client'], maxAge: 600 }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => { const up = dbReady(); res.status(up ? 200 : 503).json({ ok: up, db: up ? 'up' : 'down', uptime: Math.round(process.uptime()) }); });

  app.use(rl.global);
  app.use(express.json({ limit: '100kb' }));
  app.use((req, _res, next) => { req.body = clean(req.body); req.query = clean(req.query); next(); });
  app.use(csrf);

  const secured = [requireAuth, enforcePasswordChange];
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/users', secured, require('./routes/users'));
  app.use('/api/tasks', secured, require('./routes/tasks'));
  app.use('/api/packages', secured, misc.pkg);
  app.use('/api/wallet', secured, misc.wallet);
  app.use('/api/withdrawals', secured, require('./routes/withdrawals'));
  app.use('/api/projects', secured, audio.projects);
  app.use('/api/audio', secured, audio.audio);
  app.use('/api/notebooks', secured, audio.notebooks);
  app.use('/api/chat', secured, misc.chat);
  app.use('/api/help', secured, misc.help);
  app.use('/api/activity', secured, misc.activity);
  app.use('/api/dashboard', secured, misc.dashboard);
  app.use('/api/mfa', secured, misc.mfa);
  app.use('/api/devices', secured, misc.devices);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
