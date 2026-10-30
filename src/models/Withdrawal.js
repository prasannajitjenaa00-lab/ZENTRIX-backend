'use strict';
const { Schema, model } = require('mongoose');

const WithdrawalSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, default: '₹' },
  status: {
    type: String,
    enum: ['pending', 'approved', 'completed', 'rejected'],
    default: 'pending',
    index: true,
  },
  bankDetails: {
    holder: { type: String, default: '' },
    name: { type: String, default: '' },
    account: { type: String, default: '' },
    ifsc: { type: String, default: '' },
  },
  note: { type: String, default: '' },
  adminNote: { type: String, default: '' },
  utr: { type: String, default: '' },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
  processedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = model('Withdrawal', WithdrawalSchema);

