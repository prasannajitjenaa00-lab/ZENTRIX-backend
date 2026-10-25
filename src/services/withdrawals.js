'use strict';
const mongoose = require('mongoose');
const { Withdrawal, User, NotebookEntry, AudioTrack, TrackAssignment } = require('../models');
const usersSvc = require('./users');
const dto = require('./dto');
const activity = require('./activity');
const { notFound, bad } = require('../utils/errors');
const { validateBank } = require('../validators');

function maskAccount(acc) {
  if (!acc) return '';
  const s = String(acc).trim();
  if (s.length <= 4) return s;
  return '•'.repeat(Math.max(0, s.length - 4)) + s.slice(-4);
}

function formatWithdrawal(w) {
  return {
    id: String(w._id),
    amount: w.amount,
    currency: w.currency || '₹',
    status: w.status,
    bankDetails: {
      holder: w.bankDetails?.holder || '',
      name: w.bankDetails?.name || '',
      account: maskAccount(w.bankDetails?.account || ''),
      ifsc: w.bankDetails?.ifsc || '',
    },
    note: w.note || '',
    adminNote: w.adminNote || '',
    utr: w.utr || '',
    requestedAt: w.requestedAt || w.createdAt,
    processedAt: w.processedAt || null,
    user: w.user ? {
      id: String(w.user._id || w.user),
      name: w.user.name || '',
      email: w.user.email || '',
      phone: w.user.phone || ''
    } : null
  };
}

async function getEmployeeSummary(user) {
  const u = await User.findById(user._id).populate('package');
  if (!u) throw notFound('User not found.');

  const withdrawals = await Withdrawal.find({ user: user._id }).sort({ createdAt: -1 });

  const packageBaseAmount = u.package?.amount && u.package.amount > 0 ? u.package.amount : 0;
  const ratePerHour = u.package?.ratePerHour || (packageBaseAmount <= 2000 ? packageBaseAmount : 200);

  // Completed audio tracks and total duration calculation
  const asg = await TrackAssignment.find({ assignee: user._id }).lean();
  const tracks = await AudioTrack.find({ _id: { $in: asg.map((a) => a.track) } }).lean();
  const notes = await NotebookEntry.find({ user: user._id }).lean();

  const completedTracks = tracks.filter((t) => {
    const note = notes.find((n) => String(n.track) === String(t._id));
    return (note?.listenedSeconds && note.listenedSeconds > 0) || (note?.body && note.body.trim().length > 0);
  });

  const totalDurationSec = tracks.reduce((acc, t) => {
    const note = notes.find((n) => String(n.track) === String(t._id));
    const listenedSec = note?.listenedSeconds || 0;
    const maxDur = t.duration || Math.max(60, Math.round((t.size || 0) / 16000));
    return acc + Math.min(listenedSec, maxDur);
  }, 0);

  // Audio Earnings = (Audio Duration in Seconds / 3600) * Hourly Rate
  const audioEarnings = Math.round((totalDurationSec / 3600) * ratePerHour);
  // Total Income = Package Base Amount (e.g. ₹5,000 / ₹3,500) + Audio Earnings
  const totalEarnedCalc = packageBaseAmount + audioEarnings;

  const totalWithdrawn = withdrawals
    .filter((w) => ['completed', 'approved'].includes(w.status))
    .reduce((sum, w) => sum + w.amount, 0);

  const pendingAmount = withdrawals
    .filter((w) => w.status === 'pending')
    .reduce((sum, w) => sum + w.amount, 0);

  // Guarantee totalEarned is at least packageBaseAmount + totalWithdrawn + pendingAmount
  const totalEarned = Math.max(totalEarnedCalc, packageBaseAmount + totalWithdrawn + pendingAmount);
  // Available withdrawal condition: employees can only withdraw what they earn doing transcribe work (after 5k joining package)
  const availableBalance = Math.max(0, audioEarnings - totalWithdrawn - pendingAmount);

  let bankData = null;
  try {
    bankData = await usersSvc.getBank(user, user._id);
  } catch {
    bankData = { details: null, hasDetails: false, locked: false };
  }

  return {
    totalEarned,
    packageBaseAmount,
    audioEarnings,
    totalWithdrawn,
    pendingAmount,
    availableBalance,
    completedAudioCount: completedTracks.length,
    totalDurationSec,
    ratePerHour,
    currency: u.package?.currency || '₹',
    package: dto.pkg(u.package) || { name: 'No package', ratePerHour, amount: packageBaseAmount, currency: '₹' },
    bank: bankData,
    withdrawals: withdrawals.map(formatWithdrawal)
  };
}

async function requestWithdrawal(user, input) {
  const amount = Number(input.amount);
  if (!amount || isNaN(amount) || amount <= 0) {
    throw bad('Please enter a valid withdrawal amount.');
  }
  if (amount < 100) {
    throw bad('Minimum withdrawal amount is ₹100.');
  }

  const summary = await getEmployeeSummary(user);
  if (amount > summary.availableBalance) {
    throw bad(`Requested amount (${summary.currency}${amount}) exceeds available transcribe balance (${summary.currency}${summary.availableBalance}). Only transcribe earnings can be withdrawn.`);
  }

  let bank = null;
  if (input.bankDetails && (input.bankDetails.holder || input.bankDetails.account)) {
    bank = validateBank(input.bankDetails);
    // If user didn't have bank details saved, save now
    if (!summary.bank?.hasDetails) {
      try {
        await usersSvc.saveOwnBank(user, bank);
      } catch (e) {
        // Continue if bank saving had an issue
      }
    }
  } else if (summary.bank?.hasDetails && summary.bank.details) {
    bank = summary.bank.details;
  } else {
    throw bad('Please provide your bank account details for transfer.');
  }

  const withdrawal = await Withdrawal.create({
    user: user._id,
    amount,
    currency: summary.currency || '₹',
    status: 'pending',
    bankDetails: {
      holder: bank.holder,
      name: bank.name,
      account: bank.account,
      ifsc: bank.ifsc
    },
    note: input.note ? String(input.note).slice(0, 500) : ''
  });

  await activity.log(`${user.name} requested withdrawal of ${withdrawal.currency}${amount}.`, {
    actor: user._id,
    rooms: ['admin'],
    type: 'wallet'
  });

  return formatWithdrawal(withdrawal);
}

async function listAll(actor, query = {}) {
  const filter = {};
  if (query.status && ['pending', 'approved', 'completed', 'rejected'].includes(query.status)) {
    filter.status = query.status;
  }
  const rows = await Withdrawal.find(filter).populate('user', 'name email phone role').sort({ createdAt: -1 }).limit(200);
  return rows.map(formatWithdrawal);
}

async function updateStatus(actor, id, input) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const w = await Withdrawal.findById(id).populate('user', 'name email');
  if (!w) throw notFound('Withdrawal request not found.');

  const allowedStatuses = ['pending', 'approved', 'completed', 'rejected'];
  if (input.status && allowedStatuses.includes(input.status)) {
    w.status = input.status;
    w.processedAt = new Date();
    w.processedBy = actor._id;
  }
  if (input.adminNote !== undefined) w.adminNote = String(input.adminNote).slice(0, 500);
  if (input.utr !== undefined) w.utr = String(input.utr).slice(0, 100);

  await w.save();

  await activity.log(`Withdrawal of ${w.currency}${w.amount} for ${w.user?.name || 'User'} marked as ${w.status}.`, {
    actor: actor._id,
    involved: w.user?._id ? [w.user._id] : [],
    rooms: ['admin'],
    type: 'wallet'
  });

  return formatWithdrawal(w);
}

module.exports = {
  getEmployeeSummary,
  requestWithdrawal,
  listAll,
  updateStatus
};
