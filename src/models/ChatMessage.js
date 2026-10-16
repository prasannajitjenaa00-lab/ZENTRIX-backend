'use strict';
const { Schema, model } = require('mongoose');
module.exports = model('ChatMessage', new Schema({
  legacyId: { type: String, index: { unique: true, sparse: true } },
  migrationBatch: { type: String, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, maxlength: 120 },   // display name at send time (as original)
  text: { type: String, required: true, maxlength: 500 },
  at: { type: Date, default: Date.now, index: true },
}, { timestamps: false }));
