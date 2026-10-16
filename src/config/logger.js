'use strict';
/* Structured JSON logger with redaction. Never logs credentials, tokens, OTPs, bank details or cookies. */
const SENSITIVE = /pass(word)?|token|secret|otp|recovery|authorization|cookie|account|ifsc|bank|hash|pepper|key/i;
function redact(value, depth = 0) {
  if (depth > 5 || value == null) return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function makeLogger(sink = (line) => process.stdout.write(line + '\n'), min = process.env.LOG_LEVEL || 'info') {
  const log = (level, msg, fields) => {
    if (LEVELS[level] < (LEVELS[min] || 20)) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(fields || {}) }));
  };
  return { debug: (m, f) => log('debug', m, f), info: (m, f) => log('info', m, f), warn: (m, f) => log('warn', m, f), error: (m, f) => log('error', m, f) };
}
module.exports = { makeLogger, redact, logger: makeLogger() };
