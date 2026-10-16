'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config/env');
const { makeLogger, redact } = require('../../src/config/logger');

const good = { NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y', FRONTEND_URL: 'http://localhost:5173/', DATA_ENCRYPTION_KEY: 'a'.repeat(64), TOKEN_PEPPER: 'p'.repeat(40) };
const prod = { ...good, NODE_ENV: 'production', FRONTEND_URL: 'https://pulse.example.com', SMTP_HOST: 'smtp.example.com' };

test('valid dev config; FRONTEND_URL normalised to an origin; defaults match the original rules', () => {
  const c = loadConfig(good);
  assert.equal(c.frontendOrigin, 'http://localhost:5173');
  assert.equal(c.auth.mfaTtlMs, 5 * 60e3);        // original: 5 minutes
  assert.equal(c.auth.mfaMaxAttempts, 5);          // original: 5 tries
  assert.equal(c.auth.resetTtlMs, 30 * 60e3);      // original: 30 minutes
  assert.equal(c.session.trustedDeviceMs, 30 * 86400e3); // original: 30 days
  assert.equal(c.auth.passwordMin, 6);             // original: 6 characters
  assert.equal(c.storage.maxBatch, 100);           // original: 100 MP3s
  assert.equal(c.storage.maxFileBytes, 400 * 1024 * 1024);
  assert.equal(c.session.secure, false);
});
test('refuses to boot without secrets, listing every problem', () => {
  assert.throws(() => loadConfig({}), (e) => e.problems.length >= 4 && /DATA_ENCRYPTION_KEY/.test(e.message) && /TOKEN_PEPPER/.test(e.message) && /MONGODB_URI/.test(e.message));
  assert.throws(() => loadConfig({ ...good, DATA_ENCRYPTION_KEY: 'short' }));
  assert.throws(() => loadConfig({ ...good, TOKEN_PEPPER: 'short' }));
});
test('production guards: https, dev mail preview forbidden', () => {
  assert.doesNotThrow(() => loadConfig(prod));
  assert.equal(loadConfig(prod).session.secure, true);
  assert.throws(() => loadConfig({ ...prod, DEV_MAIL_PREVIEW: 'true' }), /DEV_MAIL_PREVIEW/);
  assert.doesNotThrow(() => loadConfig({ ...prod, SMTP_HOST: '' }));
  assert.throws(() => loadConfig({ ...prod, FRONTEND_URL: 'http://pulse.example.com' }), /https/);
  assert.equal(loadConfig({ ...good, DEV_MAIL_PREVIEW: 'true' }).mail.devPreview, true);
  assert.equal(loadConfig({ ...good }).mail.devPreview, false);
});
test('password minimum cannot be configured below the original 6', () => {
  assert.throws(() => loadConfig({ ...good, PASSWORD_MIN_LENGTH: '3' }));
  assert.equal(loadConfig({ ...good, PASSWORD_MIN_LENGTH: '10' }).auth.passwordMin, 10);
});
test('logger redacts credentials, tokens, OTPs, bank data, cookies — and still logs error codes', () => {
  const lines = []; const log = makeLogger((l) => lines.push(JSON.parse(l)), 'debug');
  log.info('x', { password: 'hunter2', newPassword: 'a', token: 't', otpCode: '123456', recoveryCodes: ['P'], cookie: 'sid=1', authorization: 'Bearer z', bankAccount: '123456789', ifsc: 'SBIN0001234', passwordHash: 'h', code: 'NOT_FOUND', nested: { account: '9', user: 'ok' } });
  const l = lines[0];
  for (const k of ['password', 'newPassword', 'token', 'otpCode', 'recoveryCodes', 'cookie', 'authorization', 'bankAccount', 'ifsc', 'passwordHash']) assert.equal(l[k], '[redacted]', k);
  assert.equal(l.nested.account, '[redacted]'); assert.equal(l.nested.user, 'ok'); assert.equal(l.code, 'NOT_FOUND');
  assert.ok(!JSON.stringify(l).includes('hunter2'));
  assert.deepEqual(Object.keys(redact({ e: new Error('boom') }).e), ['name', 'message']);   // no stack in logs
});
test('log level filter', () => { const lines = []; const log = makeLogger((l) => lines.push(l), 'warn'); log.info('a'); log.warn('b'); assert.equal(lines.length, 1); });
