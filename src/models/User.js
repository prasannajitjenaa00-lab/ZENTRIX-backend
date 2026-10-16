'use strict';
const { Schema, model } = require('mongoose');

const TrustedDevice = new Schema({
  tokenHash: { type: String, required: true },
  label: { type: String, maxlength: 80 },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
}, { _id: true });

const RecoveryCode = new Schema({
  hash: { type: String, required: true },
  usedAt: Date,
}, { _id: false });

const UserSchema = new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },
  migrationBatch: { type: String, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254, unique: true },
  passwordHash: { type: String, required: true, select: false },
  passwordChangedAt: Date,
  passwordChangedBy: { type: String, maxlength: 120 },
  mustChangePassword: { type: Boolean, default: false },
  failedLogins: { type: Number, default: 0, select: false },
  lockedUntil: { type: Date, select: false },

  role: { type: String, enum: ['admin', 'floor_manager', 'team_leader', 'employee'], required: true, index: true },
  department: { type: String, maxlength: 60 },
  title: { type: String, maxlength: 80 },
  phone: { type: String, maxlength: 30, default: '' },
  status: { type: String, enum: ['Active', 'Suspended'], default: 'Active', index: true },
  joined: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },

  leader: { type: Schema.Types.ObjectId, ref: 'User', index: true },   // employee -> team leader
  floor: { type: Schema.Types.ObjectId, ref: 'User', index: true },    // team leader / employee -> floor manager
  package: { type: Schema.Types.ObjectId, ref: 'Package' },            // employee wallet package
  lastLoginAt: Date,

  mfa: {
    enabled: { type: Boolean, default: true },
    lastAt: Date,
    recovery: { type: [RecoveryCode], select: false, default: [] },
    trustedDevices: { type: [TrustedDevice], select: false, default: [] },
  },

  // Bank details: one AES-256-GCM blob (holder, name, account, ifsc). Never returned unless explicitly selected.
  bank: {
    enc: { type: String, select: false },
    hasDetails: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
    updatedAt: Date,
  },
}, { timestamps: true });

UserSchema.index({ role: 1, status: 1 });
module.exports = model('User', UserSchema);
