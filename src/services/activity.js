'use strict';
const { ActivityLog } = require('../models');
const { emit } = require('./realtime');
const dto = require('./dto');
const H = require('../policy/hierarchy');
const { loadRoster } = require('./roster');

/** Persist an activity row, then notify. `involved` = users who may see it besides admin (actor + subject). */
async function log(text, { actor, involved = [], task, type = 'general', rooms } = {}) {
  const ids = [...new Set([actor, ...involved].filter(Boolean).map(String))];
  const row = await ActivityLog.create({ text, type, actor: actor || undefined, involved: ids, task: task || undefined });
  emit(rooms || ['admin', ...ids.map((i) => `user:${i}`)], 'activity:new', { activity: dto.activity(row) });
  return row;
}

/** Latest rows visible to `viewer`. Admin: all. FM/TL: rows involving anyone in their scope. Employee: rows involving them. */
async function listFor(viewer, limit = 40) {
  const me = dto.toPlain(viewer);
  let filter = {};
  if (me.role !== 'admin') {
    const roster = await loadRoster();
    const scope = H.visibleAssigneeIds(roster, me);
    filter = { involved: { $in: [...scope] } };
  }
  const rows = await ActivityLog.find(filter).sort({ at: -1 }).limit(limit).lean();
  return rows.map(dto.activity);
}
module.exports = { log, listFor };
