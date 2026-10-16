'use strict';
const { Schema, model } = require('mongoose');
const S = new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },   // sha1(at|text) for rows imported from pulse-db.json
  text: { type: String, required: true, maxlength: 500 },
  type: { type: String, default: 'general', maxlength: 40 },
  actor: { type: Schema.Types.ObjectId, ref: 'User' },
  involved: [{ type: Schema.Types.ObjectId, ref: 'User' }],   // who may see this row (besides admin)
  task: { type: Schema.Types.ObjectId, ref: 'Task', index: true },  // gives per-task history
  at: { type: Date, default: Date.now, index: true },
  migrationBatch: { type: String, index: true },
}, { timestamps: false });
S.index({ involved: 1, at: -1 });
module.exports = model('ActivityLog', S);
