'use strict';
const { ChatMessage } = require('../models');
const dto = require('./dto');
const { emit } = require('./realtime');
const activity = require('./activity');

async function list({ limit = 200, before } = {}) {
  const filter = before ? { at: { $lt: new Date(before) } } : {};
  const rows = await ChatMessage.find(filter).sort({ at: -1 }).limit(Math.min(Number(limit) || 200, 200)).lean();
  return rows.reverse().map(dto.chat);
}
/** Original rule: only admin posts; everyone reads. Persist, then broadcast. */
async function post(actor, text) {
  const m = await ChatMessage.create({ user: actor._id, name: actor.name, text: text.slice(0, 500) });
  emit(['all'], 'chat:message', { message: dto.chat(m) });
  await activity.log(`${actor.name} posted in studio chat.`, { actor: actor._id, type: 'chat', rooms: ['admin'] });
  return dto.chat(m);
}
module.exports = { list, post };
