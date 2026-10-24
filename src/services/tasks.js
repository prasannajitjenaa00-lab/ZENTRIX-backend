'use strict';
const mongoose = require('mongoose');
const { Task } = require('../models');
const dto = require('./dto');
const H = require('../policy/hierarchy');
const { loadRoster, plainOf, audienceFor } = require('./roster');
const activity = require('./activity');
const { emit } = require('./realtime');
const { AppError, forbidden, notFound, bad } = require('../utils/errors');
const { parsePage, pageMeta, escapeRegex } = require('../utils/pagination');
const { todayISO, monthBounds } = require('../utils/dates');
const { getConfig } = require('../config/env');

const oid = (s) => new mongoose.Types.ObjectId(String(s));
const SORTS = { due: { due: 1, _id: 1 }, '-due': { due: -1, _id: 1 }, updatedAt: { updatedAt: 1 }, '-updatedAt': { updatedAt: -1 }, title: { title: 1 } };
const today = () => todayISO(getConfig().timezone);

function scopeFilter(roster, me) {
  const ids = H.visibleAssigneeIds(roster, me);
  return ids === H.ALL ? {} : { assignee: { $in: [...ids].map(oid) } };
}

async function list(viewer, query) {
  const roster = await loadRoster(); const me = dto.toPlain(viewer);
  const pg = parsePage(query, { defaultLimit: 100, maxLimit: 500 });
  const and = [scopeFilter(roster, me)];
  if (query.status) and.push({ status: String(query.status) });
  if (query.bucket === 'open') and.push({ status: { $ne: 'Completed' } });
  if (query.bucket === 'completed') and.push({ status: 'Completed' });
  if (query.bucket === 'overdue') and.push({ status: { $ne: 'Completed' }, due: { $lt: today() } });
  if (query.assignee) and.push({ assignee: /^[a-f0-9]{24}$/i.test(query.assignee) ? oid(query.assignee) : null });
  const mb = query.month && monthBounds(String(query.month));
  if (mb) and.push({ due: { $gte: mb.from, $lte: mb.to } });
  if (query.q) {
    const q = String(query.q).trim().slice(0, 60);
    if (q.length >= 2) {            // original global search: min 2 chars; title+description+category+owner name
      const rx = new RegExp(escapeRegex(q), 'i');
      const ownerIds = roster.filter((u) => rx.test(u.name)).map((u) => oid(u.id));
      and.push({ $or: [{ title: rx }, { description: rx }, { category: rx }, { assignee: { $in: ownerIds } }] });
    }
  }
  const filter = { $and: and };
  const [rows, total] = await Promise.all([
    Task.find(filter).sort(SORTS[query.sort] || SORTS.due).skip(pg.skip).limit(pg.limit).lean(),
    Task.countDocuments(filter),
  ]);
  return { data: rows.map(dto.task), meta: pageMeta(pg, total) };
}

/** Calendar: admin sees everyone (optional per-employee filter); everyone else sees only tasks assigned to themself (original behaviour). */
async function calendar(viewer, { month, assignee }) {
  const mb = monthBounds(String(month || ''));
  if (!mb) throw bad('month must look like 2026-09.', { month: 'Invalid.' });
  const filter = { due: { $gte: mb.from, $lte: mb.to } };
  if (viewer.role === 'admin') { if (assignee && assignee !== 'all' && /^[a-f0-9]{24}$/i.test(assignee)) filter.assignee = oid(assignee); }
  else filter.assignee = viewer._id;
  const rows = await Task.find(filter).sort({ due: 1, _id: 1 }).lean();
  return rows.map(dto.task);
}

async function getVisible(viewer, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Assignment not found.');
  const t = await Task.findById(id);
  if (!t) throw notFound('Assignment not found.');
  const roster = await loadRoster();
  if (!H.canViewTask(roster, dto.toPlain(viewer), { assigneeId: String(t.assignee) })) throw notFound('Assignment not found.'); // 404, not 403: no existence oracle
  return { task: t, roster };
}
async function get(viewer, id) { return dto.task((await getVisible(viewer, id)).task); }

async function create(actor, input) {
  if (!H.canAssignWork(dto.toPlain(actor))) throw forbidden('Only a floor manager, team leader, or admin can assign work.');
  const roster = await loadRoster();
  const allowed = H.managedEmployees(roster, dto.toPlain(actor));
  const assignee = allowed.find((e) => e.id === input.assigneeId);
  if (!assignee) throw forbidden('That teammate is not in your scope.');
  const task = await Task.create({
    title: input.title, description: input.description || '', assignee: oid(assignee.id), assignedBy: actor._id,
    start: input.start || today(), due: input.due, status: input.status || 'Pending', priority: input.priority || 'Medium',
    category: input.category || 'General', progress: input.progress ?? 5, notes: input.notes || '',
  });
  await activity.log(`${actor.name} assigned “${task.title}” to ${assignee.name}.`, { actor: actor._id, involved: [assignee.id], task: task._id, type: 'task', rooms: audienceFor(assignee) });
  emit(audienceFor(assignee), 'task:created', { task: dto.task(task) });
  return dto.task(task);
}

/** Admin only: metadata, reassignment, any field. */
async function updateMeta(actor, id, input) {
  if (!H.canEditTaskMeta(dto.toPlain(actor))) throw forbidden('That assignment lives on another desk.');
  const { task, roster } = await getVisible(actor, id);
  const before = plainOf(roster, task.assignee);
  let after = before;
  if (input.assigneeId && input.assigneeId !== String(task.assignee)) {
    after = H.managedEmployees(roster, dto.toPlain(actor)).find((e) => e.id === input.assigneeId);
    if (!after) throw bad('Pick an active employee.', { assigneeId: 'Invalid assignee.' });
    task.assignee = oid(after.id);
  }
  for (const k of ['title', 'description', 'category', 'start', 'due', 'priority', 'status', 'progress', 'notes']) if (input[k] !== undefined) task[k] = input[k];
  if (task.status === 'Completed') task.progress = 100;
  task.updatedAt = new Date();
  await task.save();
  const rooms = [...new Set([...audienceFor(before), ...audienceFor(after)])];
  await activity.log(`${actor.name} revised “${task.title}” (${task.progress}% · ${task.status}).`, { actor: actor._id, involved: [after?.id].filter(Boolean), task: task._id, type: 'task', rooms });
  emit(rooms, 'task:updated', { task: dto.task(task), reassigned: before?.id !== after?.id });
  return dto.task(task);
}

/** Assignee (or admin): status, progress, notes only. */
async function updateStatus(actor, id, input) {
  const { task, roster } = await getVisible(actor, id);
  if (!H.canUpdateTaskProgress(dto.toPlain(actor), { assigneeId: String(task.assignee) })) throw forbidden('That assignment lives on another desk.');
  if (input.title !== undefined) task.title = input.title;
  if (input.description !== undefined) task.description = input.description;
  if (input.status !== undefined) task.status = input.status;
  if (input.progress !== undefined) task.progress = input.progress;
  if (input.notes !== undefined) task.notes = input.notes;
  if (task.status === 'Completed') task.progress = 100;
  task.updatedAt = new Date();
  await task.save();
  const owner = plainOf(roster, task.assignee);
  const rooms = audienceFor(owner);
  await activity.log(`${actor.name} updated “${task.title}” to ${task.status} at ${task.progress}%.`, { actor: actor._id, involved: [owner?.id].filter(Boolean), task: task._id, type: 'task', rooms });
  emit(rooms, 'task:updated', { task: dto.task(task), reassigned: false });
  return dto.task(task);
}

async function remove(actor, id) {
  if (!H.canEditTaskMeta(dto.toPlain(actor))) throw forbidden();
  const { task, roster } = await getVisible(actor, id);
  const owner = plainOf(roster, task.assignee);
  await task.deleteOne();
  const rooms = audienceFor(owner);
  await activity.log(`${actor.name} removed “${task.title}”.`, { actor: actor._id, involved: [owner?.id].filter(Boolean), task: task._id, type: 'task', rooms });
  emit(rooms, 'task:deleted', { taskId: String(task._id) });
}
module.exports = { list, calendar, get, create, updateMeta, updateStatus, remove, today };
