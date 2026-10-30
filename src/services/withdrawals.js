'use strict';
const { Withdrawal, User, Package, TrackAssignment, AudioTrack } = require('../models');
const usersSvc = require('./users');
const activity = require('./activity');
const { emit } = require('./realtime');
const { bad, notFound, forbidden } = require('../utils/errors');

async function getMyWithdrawals(user) {
  const u = await User.findById(user._id).populate('package').lean();
  const bank = await usersSvc.getBank(user, user._id);
  const pkg = u?.package;
  const currency = pkg?.currency || '₹';

  const baseEarnings = pkg?.amount || 0;
  const ratePerHour = pkg?.ratePerHour || (baseEarnings ? Math.round(baseEarnings / 20) : 200);

  // Completed translations and total audio duration
  const completedAssignments = await TrackAssignment.find({
    assignee: user._id,
    status: { $in: ['submitted', 'reviewed', 'approved'] },
  }).lean();

  const trackIds = completedAssignments.map((a) => a.track);
  const tracks = await AudioTrack.find({ _id: { $in: trackIds } }).lean();
  const trackMap = new Map(tracks.map((t) => [String(t._id), t]));

  let totalDurationSec = 0;
  for (const a of completedAssignments) {
    const t = trackMap.get(String(a.track));
    const dur = t?.duration || (t?.size ? Math.round(t.size / 24000) : 180);
    totalDurationSec += dur;
  }

  // Audio earnings calculated by per hour price
  const taskEarnings = Math.round((totalDurationSec / 3600) * ratePerHour);
  const totalEarned = baseEarnings + taskEarnings;

  const records = await Withdrawal.find({ user: user._id }).sort({ requestedAt: -1 }).lean();

  let totalWithdrawn = 0;
  let pendingAmount = 0;

  const withdrawals = records.map((w) => {
    if (w.status === 'completed') totalWithdrawn += w.amount;
    if (w.status === 'pending' || w.status === 'approved') pendingAmount += w.amount;

    return {
      id: String(w._id),
      amount: w.amount,
      currency: w.currency || currency,
      status: w.status,
      requestedAt: w.requestedAt || w.createdAt,
      bankDetails: w.bankDetails || {},
      adminNote: w.adminNote || '',
      note: w.note || '',
      utr: w.utr || '',
    };
  });

  const availableBalance = Math.max(0, totalEarned - totalWithdrawn - pendingAmount);

  return {
    currency,
    availableBalance,
    totalEarned,
    totalWithdrawn,
    pendingAmount,
    bank,
    withdrawals,
  };
}

async function requestWithdrawal(user, { amount, note }) {
  const myData = await getMyWithdrawals(user);
  const num = Math.round(Number(amount));
  if (!num || num <= 0) throw bad('Invalid withdrawal amount.');
  if (num < 100) throw bad('Minimum withdrawal amount is ₹100.');
  if (num > myData.availableBalance) {
    throw bad(`Amount exceeds your available balance of ${myData.currency}${myData.availableBalance}.`);
  }

  const bank = myData.bank?.details;
  if (!myData.bank?.hasDetails || !bank?.account) {
    throw bad('Please link and verify your bank account details before requesting a withdrawal.');
  }

  const w = await Withdrawal.create({
    user: user._id,
    amount: num,
    currency: myData.currency,
    bankDetails: {
      holder: bank.holder || user.name,
      name: bank.name || 'Bank',
      account: bank.account,
      ifsc: bank.ifsc || '',
    },
    note: String(note || '').trim(),
    status: 'pending',
    requestedAt: new Date(),
  });

  await activity.log(`${user.name} submitted a withdrawal request of ${myData.currency}${num.toLocaleString()}.`, {
    actor: user._id,
    type: 'wallet',
    rooms: ['admin'],
  });

  emit(['admin'], 'withdrawal:created', { id: String(w._id) });

  return {
    id: String(w._id),
    amount: w.amount,
    currency: w.currency,
    status: w.status,
    requestedAt: w.requestedAt,
  };
}

async function listAllWithdrawals(actor, query = {}) {
  const filter = {};
  if (query.status && query.status !== 'all') {
    filter.status = String(query.status);
  }

  const list = await Withdrawal.find(filter)
    .populate('user', 'name email legacyId')
    .sort({ requestedAt: -1 })
    .lean();

  return list.map((w) => ({
    id: String(w._id),
    employeeId: w.user ? String(w.user._id) : '',
    employeeName: w.user?.name || 'Employee',
    employeeEmail: w.user?.email || '',
    legacyId: w.user?.legacyId || '',
    amount: w.amount,
    currency: w.currency || '₹',
    status: w.status,
    requestedAt: w.requestedAt || w.createdAt,
    bankDetails: w.bankDetails || {},
    note: w.note || '',
    adminNote: w.adminNote || '',
    utr: w.utr || '',
    processedAt: w.processedAt || null,
  }));
}

async function updateWithdrawalStatus(actor, id, { status, adminNote, utr }) {
  const w = await Withdrawal.findById(id).populate('user', 'name');
  if (!w) throw notFound('Withdrawal request not found.');

  if (!['approved', 'completed', 'rejected'].includes(status)) {
    throw bad('Invalid withdrawal status.');
  }

  w.status = status;
  if (adminNote !== undefined) w.adminNote = String(adminNote).trim();
  if (utr !== undefined) w.utr = String(utr).trim();
  w.processedAt = new Date();
  w.processedBy = actor._id;

  await w.save();

  await activity.log(`${actor.name} marked withdrawal #${String(w._id).slice(-6)} as ${status}.`, {
    actor: actor._id,
    involved: [String(w.user?._id || w.user)],
    type: 'wallet',
    rooms: ['admin', `user:${String(w.user?._id || w.user)}`],
  });

  emit([`user:${String(w.user?._id || w.user)}`, 'admin'], 'withdrawal:updated', { id: String(w._id), status });

  return {
    id: String(w._id),
    status: w.status,
    adminNote: w.adminNote,
    utr: w.utr,
  };
}

module.exports = {
  getMyWithdrawals,
  requestWithdrawal,
  listAllWithdrawals,
  updateWithdrawalStatus,
};

