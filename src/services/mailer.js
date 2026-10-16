'use strict';
const { getConfig } = require('../config/env');
const { logger } = require('../config/logger');

/**
 * Mail service (nodemailer removed).
 * Dispatches mail details directly to logger/stdout.
 * Dev preview is returned when devPreview is enabled.
 */
async function sendMail({ to, subject, text, preview }) {
  const cfg = getConfig().mail;
  logger.info('mail.dispatch', { to, subject });
  process.stdout.write(`\n--- MAIL (no SMTP / nodemailer removed) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n-------------------------------------------\n`);
  return cfg.devPreview ? preview || null : null;
}

function _resetForTests() {}

module.exports = { sendMail, _resetForTests };
