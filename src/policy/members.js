'use strict';
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
/**
 * Active vs Inactive members — rule copied from the original admin dashboard:
 *  inactive if status != Active, OR (employee AND no login in 7d AND no task update in 7d).
 * users: [{id, role, status, lastLoginAt}], tasks: [{assigneeId, updatedAt}]
 */
function classifyMembers(users, tasks, now = Date.now()) {
  const lastWork = new Map();
  for (const t of tasks) {
    if (!t.updatedAt) continue;
    const ts = new Date(t.updatedAt).getTime();
    if (ts > (lastWork.get(t.assigneeId) || 0)) lastWork.set(t.assigneeId, ts);
  }
  const active = []; const inactive = [];
  for (const p of users) {
    if (p.role === 'admin') continue;
    const loginStale = !p.lastLoginAt || now - new Date(p.lastLoginAt).getTime() > SEVEN_DAYS;
    const workStale = now - (lastWork.get(p.id) || 0) > SEVEN_DAYS;
    const byActivity = p.role === 'employee' && loginStale && workStale;
    if (p.status !== 'Active') inactive.push({ user: p, reason: p.status });
    else if (byActivity) inactive.push({ user: p, reason: 'No login or work update in 7 days' });
    else active.push(p);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  active.sort(byName);
  inactive.sort((a, b) => byName(a.user, b.user));
  return { active, inactive };
}
const avgProgress = (tasks) => (tasks.length ? Math.round(tasks.reduce((a, t) => a + (Number(t.progress) || 0), 0) / tasks.length) : 0);
function statusCounts(tasks) {
  const c = { Pending: 0, 'In Progress': 0, 'On Hold': 0, Completed: 0 };
  for (const t of tasks) if (c[t.status] != null) c[t.status] += 1;
  return c;
}
module.exports = { classifyMembers, avgProgress, statusCounts, SEVEN_DAYS };
