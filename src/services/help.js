'use strict';
const { HelpMessage } = require('../models');
const dto = require('./dto');
const { emit } = require('./realtime');
const activity = require('./activity');
const { notFound } = require('../utils/errors');

/** Admin sees every query; employees see only their own. */
async function list(viewer, { limit = 200 } = {}) {
  const filter = viewer.role === 'admin' ? {} : { user: viewer._id };
  const rows = await HelpMessage.find(filter)
    .populate('user', 'name email legacyId')
    .sort({ at: -1 })
    .limit(Math.min(Number(limit) || 200, 200))
    .lean();
  return rows.reverse().map(dto.help);
}

/** Anyone can post a query; admin is notified in real time. */
async function post(actor, text) {
  const m = await HelpMessage.create({
    user: actor._id,
    name: actor.name,
    role: actor.role,
    text: text.slice(0, 500),
    status: 'pending',
  });
  const populated = await HelpMessage.findById(m._id).populate('user', 'name email legacyId').lean();
  const d = dto.help(populated || m);
  emit(['admin', `user:${actor._id}`], 'help:message', { message: d });
  await activity.log(`${actor.name} sent a query: "${text.slice(0, 40)}..."`, { actor: actor._id, type: 'help', rooms: ['admin'] });
  return d;
}

/** Admin marks query as resolved. */
async function resolve(actor, id, { reply = '' } = {}) {
  const m = await HelpMessage.findById(id);
  if (!m) throw notFound('Query not found');
  m.status = 'resolved';
  m.resolvedAt = new Date();
  m.resolvedBy = actor._id;
  if (reply) m.adminReply = String(reply).slice(0, 500);
  await m.save();

  const populated = await HelpMessage.findById(m._id).populate('user', 'name email legacyId').lean();
  const d = dto.help(populated || m);
  // Real-time notification to admin and the specific user room
  emit(['admin', `user:${m.user}`], 'help:resolved', { message: d });
  emit(['admin', `user:${m.user}`], 'help:message', { message: d });
  await activity.log(`Query from ${m.name} was marked as resolved by ${actor.name}.`, { actor: actor._id, type: 'help', rooms: ['admin', `user:${m.user}`] });
  return d;
}

module.exports = { list, post, resolve };
