'use strict';
const { Schema, model } = require('mongoose');

const withdrawalSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, default: '₹', maxlength: 4 },
  status: {
    type: String,
    enum: ['pending', 'approved', 'completed', 'rejected'],
    default: 'pending',
    index: true
  },
  bankDetails: {
    holder: { type: String, default: '', trim: true },
    name: { type: String, default: '', trim: true },
    account: { type: String, default: '', trim: true },
    ifsc: { type: String, default: '', trim: true }
  },
  note: { type: String, default: '', maxlength: 500, trim: true },
  adminNote: { type: String, default: '', maxlength: 500, trim: true },
  utr: { type: String, default: '', maxlength: 100, trim: true },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date },
  processedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = model('Withdrawal', withdrawalSchema);
