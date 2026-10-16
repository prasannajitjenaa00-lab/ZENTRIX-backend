'use strict';
const { Task, AudioTrack, Project, TrackAssignment, NotebookEntry, User } = require('../models');
const dto = require('./dto');
const H = require('../policy/hierarchy');
const { classifyMembers, avgProgress, statusCounts } = require('../policy/members');
const { loadRoster } = require('./roster');
const activity = require('./activity');
const { todayISO, addDays, isOverdue } = require('../utils/dates');
const { getConfig } = require('../config/env');
const mongoose = require('mongoose');

async function scopedTasks(roster, me) {
  const ids = H.visibleAssigneeIds(roster, me);
  const filter = ids === H.ALL ? {} : { assignee: { $in: [...ids].map((i) => new mongoose.Types.ObjectId(i)) } };
  return (await Task.find(filter).lean()).map(dto.task);
}

/** Command center for Admin / Floor Manager / Team Leader. FM & TL are scoped to their own floor/team (decision Q3). */
async function overview(viewer) {
  const roster = await loadRoster(); const me = dto.toPlain(viewer);
  const today = todayISO(getConfig().timezone);
  const tasks = await scopedTasks(roster, me);
  const counts = statusCounts(tasks);
  const crew = H.activeCrew(roster, me);
  const late = tasks.filter((t) => isOverdue(t, today));
  const { active, inactive } = classifyMembers(H.memberScope(roster, me), tasks.map((t) => ({ assigneeId: t.assigneeId, updatedAt: t.updatedAt })));
  const byId = new Map(roster.map((u) => [u.id, u]));
  const load = (p) => { const mine = tasks.filter((t) => t.assigneeId === p.id); return { pct: avgProgress(mine), open: mine.filter((t) => t.status !== 'Completed').length }; };
  const upcoming = tasks.filter((t) => t.status !== 'Completed').sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6)
    .map((t) => ({ ...t, assigneeName: byId.get(t.assigneeId)?.name || 'Unassigned' }));
  const out = {
    today,
    kpis: {
      activeCrew: crew.length, accounts: me.role === 'admin' ? roster.length : crew.length,
      openWork: tasks.filter((t) => t.status !== 'Completed').length, totalTasks: tasks.length, avgProgress: avgProgress(tasks),
      completed: counts.Completed, completionRate: tasks.length ? Math.round((counts.Completed / tasks.length) * 100) : 0, overdue: late.length,
    },
    statusCounts: counts,
    activeMembers: active.map((p) => ({ ...dto.userPublic(p), email: p.email, phone: p.phone, lastLoginAt: p.lastLoginAt, ...load(p) })),
    inactiveMembers: inactive.map(({ user, reason }) => ({ ...dto.userPublic(user), email: user.email, lastLoginAt: user.lastLoginAt, reason })),
    upcoming,
    activity: await activity.listFor(viewer, 7),
  };
  if (me.role === 'admin') {     // security panel: MFA state & password metadata only — passwords are hashed and can never be shown
    const rows = await User.find({}).select('name email role mfa.enabled mfa.lastAt passwordChangedAt passwordChangedBy').lean();
    out.security = rows.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)).map((u) => ({
      id: String(u._id), name: u.name, email: u.email, role: u.role, mfaEnabled: u.mfa?.enabled !== false, mfaLastAt: u.mfa?.lastAt || null,
      passwordChangedAt: u.passwordChangedAt || null, passwordChangedBy: u.passwordChangedBy || null }));
  }
  return out;
}

async function mine(viewer) {
  const today = todayISO(getConfig().timezone);
  const tasks = (await Task.find({ assignee: viewer._id }).lean()).map(dto.task);
  const counts = statusCounts(tasks);
  const open = tasks.filter((t) => t.status !== 'Completed');
  const dueSoon = open.filter((t) => t.due <= addDays(today, 7)).sort((a, b) => a.due.localeCompare(b.due));
  const u = await User.findById(viewer._id).populate('package');
  const asg = await TrackAssignment.find({ assignee: viewer._id }).lean();
  const [tracks, notes, projects] = await Promise.all([
    AudioTrack.find({ _id: { $in: asg.map((a) => a.track) } }).lean(),
    NotebookEntry.find({ user: viewer._id }).lean(),
    Project.find({ _id: { $in: asg.map((a) => a.project) } }).lean(),
  ]);
  return {
    today, kpis: { assigned: tasks.length, inMotion: counts['In Progress'], cleared: counts.Completed, completionRate: tasks.length ? Math.round((counts.Completed / tasks.length) * 100) : 0 },
    statusCounts: counts, dueSoon, tasks: tasks.sort((a, b) => a.due.localeCompare(b.due)),
    wallet: dto.pkg(u.package) || { id: null, key: 'none', name: 'No package', amount: 0, currency: '₹', note: 'No package assigned' },
    assignedTracks: tracks.map((t) => ({ ...dto.track(t), projectName: projects.find((p) => String(p._id) === String(t.project))?.name || 'Project',
      notesWritten: (notes.find((n) => String(n.track) === String(t._id))?.text || '').trim().length > 0 })),
  };
}
module.exports = { overview, mine };
