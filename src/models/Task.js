'use strict';
const { Schema, model } = require('mongoose');
const S = new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },
  migrationBatch: { type: String, index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: '', maxlength: 4000 },
  assignee: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  start: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },          // YYYY-MM-DD strings (no timezone drift)
  due: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
  status: { type: String, enum: ['Pending', 'In Progress', 'On Hold', 'Completed', 'Approved'], default: 'Pending', index: true },
  priority: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium' },
  category: { type: String, default: 'General', maxlength: 60 },
  progress: { type: Number, min: 0, max: 100, default: 0 },
  notes: { type: String, default: '', maxlength: 4000 },
  // Managed explicitly (not mongoose timestamps) so migration preserves original values and the
  // "last work update" inactivity rule keeps its meaning.
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: false });
S.index({ assignee: 1, due: 1 });
S.index({ status: 1, due: 1 });
module.exports = model('Task', S);
