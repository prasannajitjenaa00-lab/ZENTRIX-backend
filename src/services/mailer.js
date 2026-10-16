'use strict';
const { getConfig } = require('../config/env');
const { logger } = require('../config/logger');
let transport;

function getTransport() {
  const cfg = getConfig().mail;
  if (!cfg.host) return null;
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined });
  }
  return transport;
}

/**
 * Sends a letter. Production: SMTP only (config refuses to boot otherwise).
 * Development without SMTP: prints to stdout. `preview` is returned ONLY when DEV_MAIL_PREVIEW=true (never in production).
 */
async function sendMail({ to, subject, text, preview }) {
  const cfg = getConfig().mail;
  const t = getTransport();
  if (t) {
    await t.sendMail({ from: cfg.from, to, subject, text });
    logger.info('mail.sent', { subject });
  } else {
    process.stdout.write(`\n--- DEV MAIL (no SMTP configured) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n-------------------------------------\n`);
  }
  return cfg.devPreview ? preview || null : null;
}
function _resetForTests() { transport = undefined; }
module.exports = { sendMail, _resetForTests };
