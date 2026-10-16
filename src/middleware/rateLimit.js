'use strict';
const rateLimit = require('express-rate-limit');
const make = (windowMs, limit, code, message) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: { code, message } }),
});
module.exports = {
  global: make(60e3, 600, 'RATE_LIMITED', 'Too many requests. Slow down.'),
  login: make(15 * 60e3, 30, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.'),
  mfa: make(15 * 60e3, 40, 'RATE_LIMITED', 'Too many code attempts. Try again later.'),
  forgot: make(60 * 60e3, 10, 'RATE_LIMITED', 'Too many reset requests. Try again later.'),
  upload: make(60e3, 300, 'RATE_LIMITED', 'Too many uploads. Slow down.'),
};
