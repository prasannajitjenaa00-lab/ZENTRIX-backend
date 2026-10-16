'use strict';
const { Schema, model } = require('mongoose');
const S = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  usedAt: Date,
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
S.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });
module.exports = model('PasswordResetToken', S);
