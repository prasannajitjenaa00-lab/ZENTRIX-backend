'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../src/policy/hierarchy');
const { classifyMembers, statusCounts, avgProgress } = require('../../src/policy/members');

const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/pulse-db.redacted.json'), 'utf8')).db;
const users = legacy.users.map((u) => ({ id: u.id, name: u.name, role: u.role, status: u.status, leaderId: u.leaderId || null, floorId: u.floorId || null, lastLoginAt: u.lastLoginAt }));
const by = (id) => users.find((u) => u.id === id);

test('real data: Floor Manager sees floor crew; Team Leader sees only own active team + self', () => {
  const ids = (s) => [...s].sort();
  assert.deepEqual(ids(P.visibleAssigneeIds(users, by('u_ananya'))), ['u_ananya', 'u_arjun', 'u_priya', 'u_rohan']); // neha suspended -> excluded
  assert.deepEqual(ids(P.visibleAssigneeIds(users, by('u_vikram'))), ['u_ananya', 'u_arjun', 'u_priya', 'u_rohan', 'u_vikram']);
  assert.deepEqual(ids(P.visibleAssigneeIds(users, by('u_priya'))), ['u_priya']);
  assert.equal(P.visibleAssigneeIds(users, by('u_admin')), P.ALL);
});

test('IDOR: employee cannot view a colleague\'s task; TL cannot view other team', () => {
  const rohanTask = { assigneeId: 'u_rohan' };
  assert.equal(P.canViewTask(users, by('u_priya'), rohanTask), false);
  assert.equal(P.canViewTask(users, by('u_ananya'), rohanTask), true);
  const outsider = [...users, { id: 'u_tl2', role: 'team_leader', status: 'Active', floorId: 'u_vikram' }, { id: 'u_e9', role: 'employee', status: 'Active', leaderId: 'u_tl2', floorId: 'u_vikram' }];
  assert.equal(P.canViewTask(outsider, outsider.find((u) => u.id === 'u_tl2'), rohanTask), false);
  assert.equal(P.canViewTask(outsider, outsider.find((u) => u.id === 'u_tl2'), { assigneeId: 'u_e9' }), true);
});

test('task rights: only admin edits meta; assignee or admin updates progress', () => {
  const t = { assigneeId: 'u_priya' };
  assert.equal(P.canEditTaskMeta(by('u_admin')), true);
  for (const id of ['u_vikram', 'u_ananya', 'u_priya']) assert.equal(P.canEditTaskMeta(by(id)), false);
  assert.equal(P.canUpdateTaskProgress(by('u_priya'), t), true);
  assert.equal(P.canUpdateTaskProgress(by('u_rohan'), t), false);
  assert.equal(P.canUpdateTaskProgress(by('u_ananya'), t), false); // original: "lives on another desk"
  assert.equal(P.canUpdateTaskProgress(by('u_admin'), t), true);
});

test('role capabilities table', () => {
  const cap = (fn) => ['u_admin', 'u_vikram', 'u_ananya', 'u_priya'].map((id) => fn(by(id)));
  assert.deepEqual(cap(P.canAssignWork), [true, true, true, false]);
  assert.deepEqual(cap(P.canManageAccounts), [true, false, false, false]);
  assert.deepEqual(cap(P.canUploadProjects), [true, false, false, false]);
  assert.deepEqual(cap(P.canSendChat), [true, false, false, false]);
  assert.deepEqual(cap(P.canViewProjects), [true, true, true, false]);
});

test('audio/task assignment scope: suspended and out-of-team employees are not assignable', () => {
  assert.equal(P.canAssignTrackTo(users, by('u_ananya'), 'u_priya'), true);
  assert.equal(P.canAssignTrackTo(users, by('u_ananya'), 'u_neha'), false);   // suspended
  assert.equal(P.canAssignTrackTo(users, by('u_priya'), 'u_rohan'), false);   // employees cannot assign
  assert.equal(P.canAssignTrackTo(users, by('u_admin'), 'u_neha'), false);
  assert.equal(P.canAssignTrackTo(users, by('u_admin'), 'u_ananya'), false);  // leaders are not employees
});

test('floor derivation (normalizeRoster rule)', () => {
  assert.equal(P.derivedFloorFor(users, 'employee', 'u_ananya'), 'u_vikram');
  assert.equal(P.derivedFloorFor(users, 'team_leader', null, null), 'u_vikram');
  assert.equal(P.derivedFloorFor(users, 'admin'), null);
});

test('classifyMembers on real data (now = 2026-10-15): everyone is stale -> employees inactive; Suspended listed with reason', () => {
  const now = new Date('2026-10-15T10:00:00Z').getTime();
  const tasks = legacy.tasks.map((t) => ({ assigneeId: t.assigneeId, updatedAt: t.updatedAt }));
  const { active, inactive } = classifyMembers(users, tasks, now);
  const reason = Object.fromEntries(inactive.map((x) => [x.user.id, x.reason]));
  assert.equal(reason.u_neha, 'Suspended');
  assert.equal(reason.u_priya, 'No login or work update in 7 days');
  assert.deepEqual(active.map((u) => u.id).sort(), ['u_ananya', 'u_vikram']); // leaders/FM are never activity-inactive
});

test('classifyMembers: recent task update OR recent login keeps an employee active', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  const u = [{ id: 'e1', name: 'A', role: 'employee', status: 'Active', lastLoginAt: null }, { id: 'e2', name: 'B', role: 'employee', status: 'Active', lastLoginAt: '2026-09-19T00:00:00Z' }, { id: 'e3', name: 'C', role: 'employee', status: 'Active', lastLoginAt: null }];
  const tasks = [{ assigneeId: 'e1', updatedAt: '2026-09-18T00:00:00Z' }, { assigneeId: 'e3', updatedAt: '2026-09-01T00:00:00Z' }];
  const { active, inactive } = classifyMembers(u, tasks, now);
  assert.deepEqual(active.map((x) => x.id), ['e1', 'e2']);
  assert.deepEqual(inactive.map((x) => x.user.id), ['e3']);
});

test('statusCounts / avgProgress', () => {
  const t = legacy.tasks;
  const c = statusCounts(t);
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), t.length);
  assert.equal(avgProgress([]), 0);
  assert.equal(avgProgress([{ progress: 10 }, { progress: 21 }]), 16);
});
