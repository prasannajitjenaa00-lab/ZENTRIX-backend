'use strict';
const idOf = (v) => (v == null ? null : String(v._id || v));

/** Normalised plain user used by pure policy functions. Works with documents and lean objects. */
function toPlain(u) {
  return {
    id: idOf(u._id || u.id), name: u.name, email: u.email, role: u.role, status: u.status,
    leaderId: idOf(u.leader), floorId: idOf(u.floor), packageId: idOf(u.package),
    lastLoginAt: u.lastLoginAt || null, phone: u.phone || '', title: u.title, department: u.department, joined: u.joined,
  };
}
/** Minimal public shape for rosters, crew lists and dropdowns. */
const userPublic = (u) => ({ id: idOf(u._id || u.id), name: u.name, role: u.role, title: u.title, department: u.department, status: u.status, leaderId: idOf(u.leader ?? u.leaderId), floorId: idOf(u.floor ?? u.floorId) });

/** Account shape for admin / the user themself. Never includes password material, recovery codes or bank numbers. */
function userFull(u) {
  return {
    ...userPublic(u),
    email: u.email, phone: u.phone || '', joined: u.joined, packageId: idOf(u.package),
    lastLoginAt: u.lastLoginAt || null,
    mfaEnabled: u.mfa?.enabled !== false, mfaLastAt: u.mfa?.lastAt || null,
    passwordChangedAt: u.passwordChangedAt || null, passwordChangedBy: u.passwordChangedBy || null,
    mustChangePassword: !!u.mustChangePassword,
    bank: { hasDetails: !!u.bank?.hasDetails, locked: !!u.bank?.locked, updatedAt: u.bank?.updatedAt || null },
  };
}
const task = (t) => ({
  id: idOf(t._id), title: t.title, description: t.description || '', assigneeId: idOf(t.assignee), assignedById: idOf(t.assignedBy),
  start: t.start || null, due: t.due, status: t.status, priority: t.priority, category: t.category, progress: t.progress, notes: t.notes || '',
  createdAt: t.createdAt, updatedAt: t.updatedAt,
});
const pkg = (p) => (p ? { id: idOf(p._id), key: p.key || null, name: p.name, amount: p.amount, currency: p.currency || '₹', note: p.note || '' } : null);
const project = (p) => ({ id: idOf(p._id), name: p.name, description: p.description || '', createdById: idOf(p.createdBy), createdAt: p.createdAt });
const track = (t) => ({ id: idOf(t._id), projectId: idOf(t.project), originalName: t.originalName, size: t.size, mime: t.mime, duration: t.duration ?? null, uploadedAt: t.createdAt, streamUrl: `/api/audio/${idOf(t._id)}/stream` });
const chat = (m) => ({ id: idOf(m._id), userId: idOf(m.user), name: m.name, text: m.text, at: m.at });
const activity = (a) => ({ id: idOf(a._id), text: a.text, at: a.at, type: a.type, taskId: idOf(a.task) });

/** Derived (never stored) overdue flag + display status reconciling the brief's two status vocabularies. */
const LOCKED = new Set(['submitted', 'reviewed']);
function overdueOf(a, now = new Date()) { return !!a.deadline && new Date(a.deadline) < now && !LOCKED.has(a.status); }
function displayStatusOf(a, now = new Date()) {
  if (overdueOf(a, now)) return 'Overdue';
  return { assigned: 'Pending', in_progress: 'In Progress', submitted: 'Completed', reviewed: 'Completed', revision_requested: 'Revision requested' }[a.status] || a.status;
}
/** Assignment DTO for the tracking dashboard / review page. `extra` may carry track/employee/note data already loaded by the caller. */
function assignment(a, extra = {}) {
  return {
    id: idOf(a._id), trackId: idOf(a.track), projectId: idOf(a.project), employeeId: idOf(a.assignee), assignedById: idOf(a.assignedBy),
    assignedAt: a.assignedAt, deadline: a.deadline || null, status: a.status, displayStatus: displayStatusOf(a), overdue: overdueOf(a),
    startedAt: a.startedAt || null, submittedAt: a.submittedAt || null, reviewedAt: a.reviewedAt || null, reviewedById: idOf(a.reviewedBy),
    reviewFeedback: a.reviewFeedback || '', ...extra,
  };
}

module.exports = { idOf, toPlain, userPublic, userFull, task, pkg, project, track, chat, activity, assignment, overdueOf, displayStatusOf };
