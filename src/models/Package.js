'use strict';
const { Schema, model } = require('mongoose');
module.exports = model('Package', new Schema({
  key: { type: String, unique: true, sparse: true },  // original ids: none/starter/standard/premium; null for admin-created
  name: { type: String, required: true, trim: true, maxlength: 80 },
  amount: { type: Number, required: true, min: 0, default: 0 },
  currency: { type: String, default: '₹', maxlength: 4 },
  note: { type: String, default: '', maxlength: 300 },
  migrationBatch: { type: String, index: true },
}, { timestamps: true }));
