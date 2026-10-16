'use strict';
const { Schema, model } = require('mongoose');
module.exports = model('AudioTrack', new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },
  migrationBatch: { type: String, index: true },
  project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  originalName: { type: String, required: true, maxlength: 200 },
  storageKey: { type: String, required: true, unique: true },   // random file name inside STORAGE_DIR; never user-controlled
  size: { type: Number, required: true, min: 1 },
  mime: { type: String, default: 'audio/mpeg' },
  duration: { type: Number, default: null },   // seconds, best-effort; null when it could not be determined
  sha256: String,
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));
