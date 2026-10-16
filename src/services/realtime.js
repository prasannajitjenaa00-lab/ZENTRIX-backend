'use strict';
const crypto = require('node:crypto');
let io = null;
const setIo = (instance) => { io = instance; };
/**
 * Emit to rooms AFTER the change is persisted. Every event carries a unique eventId so clients can de-duplicate
 * (e.g. an event arriving via two overlapping rooms).
 */
function emit(rooms, event, payload) {
  if (!io) return;
  const list = [...new Set(rooms.filter(Boolean))];
  if (!list.length) return;
  io.to(list).emit(event, { eventId: crypto.randomUUID(), at: new Date().toISOString(), ...payload });
}
const disconnectUser = (userId) => { if (io) io.in(`user:${userId}`).disconnectSockets(true); };
module.exports = { setIo, emit, disconnectUser };
