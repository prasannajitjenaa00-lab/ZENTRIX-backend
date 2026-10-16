'use strict';
const { User } = require('../models');
const { toPlain } = require('./dto');
const H = require('../policy/hierarchy');

/** Whole-org roster as plain objects. Orgs are small (hundreds); this keeps scope logic in one tested pure module. */
async function loadRoster() {
  const rows = await User.find({}).select('name email role status leader floor package lastLoginAt phone title department joined').lean();
  return rows.map(toPlain);
}
const plainOf = (roster, id) => roster.find((u) => u.id === String(id));
/** Socket rooms that should hear about something that concerns `assignee` (a plain user). */
function audienceFor(assignee) {
  const rooms = ['admin'];
  if (!assignee) return rooms;
  rooms.push(`user:${assignee.id}`);
  if (assignee.leaderId) rooms.push(`team:${assignee.leaderId}`);
  if (assignee.floorId) rooms.push(`floor:${assignee.floorId}`);
  return rooms;
}
module.exports = { loadRoster, plainOf, audienceFor, H };
