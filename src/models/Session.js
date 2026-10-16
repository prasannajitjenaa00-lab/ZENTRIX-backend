'use strict';
const { Schema, model } = require('mongoose');
const S = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  idleExpiresAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },       // absolute
  ip: String,
  userAgent: { type: String, maxlength: 200 },
});
S.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = model('Session', S);
