'use strict';
const sessions = require('../services/sessions');
const { getConfig } = require('../config/env');
const { unauthorized, forbidden, AppError } = require('../utils/errors');
const asyncHandler = require('../utils/asyncHandler');

/** Attach req.user / req.session from the httpOnly cookie. */
const requireAuth = asyncHandler(async (req, _res, next) => {
  const raw = req.cookies?.[getConfig().session.cookieName];
  const found = await sessions.resolve(raw);
  if (!found) throw unauthorized();
  req.user = found.user; req.session = found.session; req.sessionToken = raw;
  next();
});

/** Accounts created/reset by an admin must pick their own password before using anything else. */
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/api/auth/me', '/api/auth/password', '/api/auth/logout']);
function enforcePasswordChange(req, _res, next) {
  // Disabled: Users access workspace directly with login credentials without forced password reset
  next();
}
const requireRole = (...roles) => (req, _res, next) => (roles.includes(req.user?.role) ? next() : next(forbidden()));

/**
 * CSRF defence for cookie auth: SameSite=Lax cookie + required custom header (cannot be sent cross-site without CORS preflight,
 * which only FRONTEND_URL passes) + Origin check when the browser sends one.
 */
function csrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-pulse-client') !== '1') return next(new AppError(403, 'CSRF', 'Missing client header.'));
  const origin = req.get('origin');
  const cfg = getConfig();
  if (cfg.allowAnyOrigin) return next();
  const allowed = cfg.frontendOrigins?.length ? cfg.frontendOrigins : [cfg.frontendOrigin];
  if (origin && !allowed.includes(origin)) return next(new AppError(403, 'CSRF', 'Origin not allowed.'));
  next();
}
module.exports = { requireAuth, enforcePasswordChange, requireRole, csrf };
