'use strict';
const mongoose = require('mongoose');
const { Session, User } = require('../models');
const { randomToken, hmacHex } = require('../utils/crypto');
const { getConfig } = require('../config/env');

const hashToken = (raw) => hmacHex(raw, getConfig().pepper);

async function create(user, { ip, userAgent } = {}) {
  const cfg = getConfig().session;
  const token = randomToken(32);
  const now = Date.now();
  const doc = await Session.create({
    user: user._id, tokenHash: hashToken(token), ip, userAgent: String(userAgent || '').slice(0, 200),
    idleExpiresAt: new Date(now + cfg.idleMs), expiresAt: new Date(now + cfg.absoluteMs),
  });
  return { token, expiresAt: doc.expiresAt };
}

/** Resolve a cookie value to {session, user}. Enforces idle + absolute expiry, suspension, and slides the idle window. */
async function resolve(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length > 200) return null;
  const s = await Session.findOne({ tokenHash: hashToken(rawToken) });
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt.getTime() <= now || s.idleExpiresAt.getTime() <= now) { await s.deleteOne(); return null; }
  const user = await User.findById(s.user);
  if (!user || user.status !== 'Active') { await Session.deleteMany({ user: s.user }); return null; }
  if (now - s.lastSeenAt.getTime() > 5 * 60 * 1000) {      // slide at most every 5 min to limit writes
    const cfg = getConfig().session;
    s.lastSeenAt = new Date(now);
    s.idleExpiresAt = new Date(Math.min(now + cfg.idleMs, s.expiresAt.getTime()));
    await s.save();
  }
  return { session: s, user };
}
const revoke = (rawToken) => Session.deleteOne({ tokenHash: hashToken(rawToken) });
const revokeAllForUser = (userId, exceptSessionId) =>
  Session.deleteMany({ user: userId, ...(exceptSessionId ? { _id: { $ne: new mongoose.Types.ObjectId(String(exceptSessionId)) } } : {}) });

module.exports = { create, resolve, revoke, revokeAllForUser, hashToken };
