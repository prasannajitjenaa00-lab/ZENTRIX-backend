'use strict';
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { validate, rules: r } = require('../validators');
const auth = require('../services/auth');
const sessions = require('../services/sessions');
const usersSvc = require('../services/users');
const dto = require('../services/dto');
const { getConfig } = require('../config/env');
const { ok } = require('../middleware/respond');
const rl = require('../middleware/rateLimit');
const { requireAuth, enforcePasswordChange } = require('../middleware/auth');

const router = express.Router();
const sessionCookie = (s) => ({ httpOnly: true, secure: getConfig().session.secure, sameSite: getConfig().session.sameSite, path: '/', domain: getConfig().session.cookieDomain, expires: s.expiresAt });
const ctxOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), trustedCookie: req.cookies?.[getConfig().session.trustedCookieName] });

function setSession(res, result) {
  const cfg = getConfig().session;
  res.cookie(cfg.cookieName, result.session.token, sessionCookie(result.session));
  if (result.trusted) res.cookie(cfg.trustedCookieName, result.trusted.cookieValue, { ...sessionCookie({ expiresAt: result.trusted.expiresAt }), path: '/api/auth' });
}

router.post('/login', rl.login, asyncHandler(async (req, res) => {
  const body = validate(req.body, { email: r.string({ min: 1, max: 254, lower: true }), password: r.string({ min: 1, max: 200, trim: false }) });
  const result = await auth.login(body, ctxOf(req));
  if (result.mfaRequired) return ok(res, { mfaRequired: true, challengeId: result.challengeId, devPreview: result.devPreview || undefined });
  setSession(res, result);
  return ok(res, { mfaRequired: false, user: await meDto(result.userId) });
}));

router.post('/mfa/verify', rl.mfa, asyncHandler(async (req, res) => {
  const body = validate(req.body, { challengeId: r.string({ min: 1, max: 40 }), code: r.string({ min: 1, max: 40 }), trust: r.bool({ optional: true }) });
  const result = await auth.verifyMfa(body, ctxOf(req));
  setSession(res, result);
  ok(res, { user: await meDto(result.userId), recoveryUsed: result.recoveryUsed, recoveryRemaining: result.recoveryUsed ? await auth.recoveryRemaining(result.userId) : undefined });
}));

router.post('/mfa/resend', rl.mfa, asyncHandler(async (req, res) => {
  const body = validate(req.body, { challengeId: r.string({ min: 1, max: 40 }) });
  const ch = await auth.resendChallenge(body.challengeId);
  ok(res, { challengeId: ch.challengeId, devPreview: ch.devPreview || undefined });
}));

router.post('/forgot', rl.forgot, asyncHandler(async (req, res) => {
  const { email } = validate(req.body, { email: r.email() });
  const out = await auth.forgot(email);
  ok(res, { message: out.message, devPreview: out.devPreview || undefined });
}));
router.post('/reset/verify', rl.forgot, asyncHandler(async (req, res) => {
  const { token } = validate(req.body, { token: r.string({ min: 10, max: 200 }) });
  ok(res, await auth.resetVerify(token));
}));
router.post('/reset', rl.forgot, asyncHandler(async (req, res) => {
  const b = validate(req.body, { token: r.string({ min: 10, max: 200 }), password: r.string({ min: 1, max: 200, trim: false }) });
  ok(res, await auth.resetPassword(b.token, b.password));
}));

async function meDto(userId) {
  const { User } = require('../models');
  const u = await User.findById(userId);
  const leader = u.leader ? await User.findById(u.leader).select('name').lean() : null;
  return { ...dto.userFull(u), leaderName: leader?.name || null, recoveryCodesRemaining: await auth.recoveryRemaining(u._id) };
}
router.get('/me', requireAuth, enforcePasswordChange, asyncHandler(async (req, res) => ok(res, { user: await meDto(req.user._id) })));

router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await sessions.revoke(req.sessionToken);
  res.clearCookie(getConfig().session.cookieName, { path: '/', domain: getConfig().session.cookieDomain });
  ok(res, { loggedOut: true });
}));

router.post('/password', requireAuth, asyncHandler(async (req, res) => {
  const b = validate(req.body, { currentPassword: r.string({ min: 1, max: 200, trim: false }), newPassword: r.string({ min: 1, max: 200, trim: false }) });
  await auth.changeOwnPassword(req.user, b.currentPassword, b.newPassword, req.session._id);
  ok(res, { changed: true });
}));

module.exports = router;
