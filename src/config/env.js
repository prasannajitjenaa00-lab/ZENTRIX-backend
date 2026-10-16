'use strict';
const path = require('node:path');
const { parseKey } = require('../utils/crypto');

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d; };

/** Pure: builds and validates configuration from an env-like object. Throws with all problems listed. */
function loadConfig(env = process.env) {
  const problems = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const need = (k) => { if (!env[k]) problems.push(`${k} is required.`); return env[k]; };

  let encKey; let pepper;
  try { encKey = parseKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY'); } catch (e) { problems.push(e.message); }
  const pepperRaw = env.TOKEN_PEPPER || '';
  if (pepperRaw.length < 32) problems.push('TOKEN_PEPPER must be at least 32 characters.'); else pepper = pepperRaw;

  const frontendUrl = need('FRONTEND_URL');
  let frontendOrigin = frontendUrl;
  try { frontendOrigin = new URL(frontendUrl).origin; } catch { if (frontendUrl) problems.push('FRONTEND_URL must be a valid URL.'); }
  need('MONGODB_URI');

  const devMailPreview = bool(env.DEV_MAIL_PREVIEW, false);
  const allowDevMailInProd = bool(env.ALLOW_DEV_MAIL_IN_PROD, false);
  const smtpHost = env.SMTP_HOST || '';
  if (isProd && devMailPreview && !allowDevMailInProd) problems.push('DEV_MAIL_PREVIEW must be false in production (it would leak OTPs and reset links).');
  if (isProd && !smtpHost && !allowDevMailInProd) problems.push('SMTP_HOST is required in production (MFA codes and reset links are sent by email).');
  if (isProd && frontendOrigin && !frontendOrigin.startsWith('https://')) problems.push('FRONTEND_URL must be https:// in production (secure cookies).');

  const passwordMin = num(env.PASSWORD_MIN_LENGTH, 6);
  if (passwordMin < 6) problems.push('PASSWORD_MIN_LENGTH cannot be below 6.');

  if (problems.length) {
    const err = new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    err.problems = problems;
    throw err;
  }

  return Object.freeze({
    nodeEnv, isProd,
    port: num(env.PORT, 8787), host: env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: num(env.TRUST_PROXY, 0),
    timezone: env.APP_TIMEZONE || 'Asia/Kolkata',
    mongoUri: env.MONGODB_URI,
    frontendOrigin,
    encKey, pepper,
    session: {
      cookieName: env.COOKIE_NAME || 'pulse_sid',
      trustedCookieName: `${env.COOKIE_NAME || 'pulse_sid'}_td`,
      idleMs: num(env.SESSION_IDLE_HOURS, 8) * 3600e3,
      absoluteMs: num(env.SESSION_ABSOLUTE_DAYS, 7) * 86400e3,
      trustedDeviceMs: num(env.TRUSTED_DEVICE_DAYS, 30) * 86400e3,
      cookieDomain: env.COOKIE_DOMAIN || undefined,
      sameSite: env.COOKIE_SAME_SITE || (isProd ? 'none' : 'lax'),
      secure: isProd,
    },
    auth: {
      passwordMin,
      mfaTtlMs: num(env.MFA_TTL_MINUTES, 5) * 60e3,
      mfaMaxAttempts: num(env.MFA_MAX_ATTEMPTS, 5),
      resetTtlMs: num(env.RESET_TTL_MINUTES, 30) * 60e3,
      loginMaxFailures: num(env.LOGIN_MAX_FAILURES, 10),
      loginLockMs: num(env.LOGIN_LOCK_MINUTES, 15) * 60e3,
      mfaSendsPer15Min: 5,
    },
    storage: {
      dir: path.resolve(env.STORAGE_DIR || './storage'),
      maxBatch: num(env.MAX_AUDIO_BATCH, 100),
      maxFileBytes: num(env.MAX_AUDIO_FILE_MB, 400) * 1024 * 1024,
    },
    mail: {
      host: smtpHost, port: num(env.SMTP_PORT, 587), secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || '', pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || 'Zentrix Pulse <no-reply@localhost>',
      devPreview: (devMailPreview && !isProd) || (allowDevMailInProd && !smtpHost),
    },
  });
}

let cached;
function getConfig() {
  if (!cached) {
    try {
      require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
      require('dotenv').config();
    } catch { /* dotenv optional at runtime */ }
    cached = loadConfig(process.env);
  }
  return cached;
}
function setConfigForTests(cfg) { cached = cfg; }

module.exports = { loadConfig, getConfig, setConfigForTests };
