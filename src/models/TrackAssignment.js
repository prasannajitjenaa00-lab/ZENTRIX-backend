'use strict';
const { Schema, model } = require('mongoose');
const S = new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },
  migrationBatch: { type: String, index: true },
  track: { type: Schema.Types.ObjectId, ref: 'AudioTrack', required: true },
  project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  assignee: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  assignedAt: { type: Date, default: Date.now },
  deadline: { type: Date, default: null },
  status: { type: String, enum: ['assigned', 'in_progress', 'submitted', 'reviewed', 'revision_requested'], default: 'assigned' },
  startedAt: { type: Date, default: null },
  submittedAt: { type: Date, default: null },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reviewFeedback: { type: String, default: '', maxlength: 2000 },
}, { timestamps: false });
S.index({ track: 1, assignee: 1 }, { unique: true });   // original rule: no duplicate (track, employee)
module.exports = model('TrackAssignment', S);
