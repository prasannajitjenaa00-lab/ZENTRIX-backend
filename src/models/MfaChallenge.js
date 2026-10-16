'use strict';
const { Schema, model } = require('mongoose');
const S = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  usedAt: Date,
  trust: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true },
});
S.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });   // physically removed an hour after expiry
module.exports = model('MfaChallenge', S);
