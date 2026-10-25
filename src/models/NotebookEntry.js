'use strict';
const { Schema, model } = require('mongoose');
const S = new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },
  migrationBatch: { type: String, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  track: { type: Schema.Types.ObjectId, ref: 'AudioTrack', required: true },
  text: { type: String, default: '', maxlength: 100000 },
  version: { type: Number, default: 0 },
  submittedAt: { type: Date, default: null },
  submittedText: { type: String, default: '', maxlength: 100000 },
  history: {
    type: [{ text: String, version: Number, submittedAt: Date }],
    default: [],
  },
  listenedSeconds: { type: Number, default: 0, min: 0 },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: false });
S.index({ user: 1, track: 1 }, { unique: true });
module.exports = model('NotebookEntry', S);
