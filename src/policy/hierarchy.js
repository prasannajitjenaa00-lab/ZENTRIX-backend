'use strict';
/*
 * Pure permission & scope rules, ported 1:1 from the original app.js
 * (teamOfLeader, floorTeam, managedEmployees, visibleTasks, canAssignWork …).
 * Input users are plain objects: { id, role, status, leaderId, floorId }.
 */
const ROLES = { ADMIN: 'admin', FLOOR: 'floor_manager', LEADER: 'team_leader', EMPLOYEE: 'employee' };
const ALL = Symbol('ALL');

const isActive = (u) => u && u.status === 'Active';
const canAssignWork = (u) => !!u && [ROLES.ADMIN, ROLES.FLOOR, ROLES.LEADER].includes(u.role);
const canManageAccounts = (u) => u?.role === ROLES.ADMIN;
const canManagePackages = canManageAccounts;
const canUploadProjects = (u) => u?.role === ROLES.ADMIN;
const canSendChat = (u) => u?.role === ROLES.ADMIN;
const canViewProjects = (u) => canAssignWork(u); // employees use the Notebook instead

const teamOfLeader = (users, leaderId) =>
  users.filter((u) => u.role === ROLES.EMPLOYEE && u.leaderId === leaderId && isActive(u));

function floorTeam(users, floorId) {
  const leaders = users.filter((u) => u.role === ROLES.LEADER && u.floorId === floorId && isActive(u));
  const leaderIds = new Set(leaders.map((l) => l.id));
  const employees = users.filter(
    (u) => u.role === ROLES.EMPLOYEE && isActive(u) && (u.floorId === floorId || leaderIds.has(u.leaderId))
  );
  return { leaders, employees };
}

/** Employees this person may assign work / audio to. */
function managedEmployees(users, user) {
  if (!user) return [];
  if (user.role === ROLES.ADMIN) return users.filter((u) => u.role === ROLES.EMPLOYEE && isActive(u));
  if (user.role === ROLES.FLOOR) return floorTeam(users, user.id).employees;
  if (user.role === ROLES.LEADER) return teamOfLeader(users, user.id);
  return [];
}

/** Assignee ids whose tasks the user may see, or ALL for admin. */
function visibleAssigneeIds(users, user) {
  if (!user) return new Set();
  if (user.role === ROLES.ADMIN) return ALL;
  if (user.role === ROLES.FLOOR) {
    const pack = floorTeam(users, user.id);
    return new Set([...pack.employees.map((u) => u.id), ...pack.leaders.map((l) => l.id), user.id]);
  }
  if (user.role === ROLES.LEADER) return new Set([...teamOfLeader(users, user.id).map((u) => u.id), user.id]);
  return new Set([user.id]);
}

/** "Active crew": who the dashboard/crew pages list. */
function activeCrew(users, user) {
  if (!user) return [];
  if (user.role === ROLES.ADMIN) return users.filter((p) => p.role !== ROLES.ADMIN && isActive(p));
  if (user.role === ROLES.FLOOR) { const p = floorTeam(users, user.id); return [...p.leaders, ...p.employees]; }
  if (user.role === ROLES.LEADER) return teamOfLeader(users, user.id);
  return [];
}

/** People shown in the Active/Inactive member panels (includes non-Active accounts). Admin: everyone but admins. */
function memberScope(users, user) {
  if (user.role === ROLES.ADMIN) return users.filter((p) => p.role !== ROLES.ADMIN);
  const crewIds = new Set(activeCrew(users, user).map((p) => p.id));
  const scoped = users.filter((p) => p.role !== ROLES.ADMIN && (p.leaderId === user.id || p.floorId === user.id || crewIds.has(p.id)));
  return scoped.filter((p) => p.id !== user.id);
}

/** May `viewer` read this task? (admin / own / within scope) */
function canViewTask(users, viewer, task) {
  const ids = visibleAssigneeIds(users, viewer);
  return ids === ALL || ids.has(task.assigneeId);
}
/** Only admin edits task metadata/reassigns/deletes; the assignee (or admin) updates status, progress, notes. */
const canEditTaskMeta = (u) => u?.role === ROLES.ADMIN;
const canUpdateTaskProgress = (u, task) => !!u && (u.role === ROLES.ADMIN || task.assigneeId === u.id);

/** Role-change safety: who a viewer's audio can be assigned to. */
function canAssignTrackTo(users, user, employeeId) {
  return managedEmployees(users, user).some((e) => e.id === employeeId);
}

/** normalizeRoster rule: an employee's floor comes from their team leader. */
function derivedFloorFor(users, role, leaderId, requestedFloorId) {
  if (role === ROLES.EMPLOYEE) return users.find((l) => l.id === leaderId)?.floorId || null;
  if (role === ROLES.LEADER) {
    if (requestedFloorId) return requestedFloorId;
    return users.find((u) => u.role === ROLES.FLOOR && isActive(u))?.id || null; // original default: first active floor manager
  }
  return null;
}

module.exports = {
  ROLES, ALL, canAssignWork, canManageAccounts, canManagePackages, canUploadProjects, canSendChat, canViewProjects,
  teamOfLeader, floorTeam, managedEmployees, visibleAssigneeIds, activeCrew, memberScope,
  canViewTask, canEditTaskMeta, canUpdateTaskProgress, canAssignTrackTo, derivedFloorFor,
};
