'use strict';
const { Schema, model } = require('mongoose');
module.exports = model('HelpMessage', new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, maxlength: 120 },   // display name at send time
  role: { type: String, required: true, maxlength: 30 },    // role at send time
  text: { type: String, required: true, maxlength: 500 },
  at: { type: Date, default: Date.now, index: true },
  status: { type: String, enum: ['pending', 'resolved'], default: 'pending', index: true },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  adminReply: { type: String, default: '', maxlength: 500 },
}, { timestamps: false }));
