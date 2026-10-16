'use strict';
const { Schema, model } = require('mongoose');
module.exports = model('Project', new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },
  migrationBatch: { type: String, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', maxlength: 1000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));
