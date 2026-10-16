'use strict';
/*
 * Pure transform: legacy pulse-db.json  ->  MongoDB-ready documents (+ a full audit report).
 * No I/O, no DB. Hashing/encryption/ObjectId generation are injected so this is unit-testable.
 * Repairs mirror the original client's normalizeRoster(); every repair is reported, never silent.
 */
const crypto = require('node:crypto');
const { isISODate } = require('../utils/dates');

const ROLES = new Set(['admin', 'floor_manager', 'team_leader', 'employee']);
const STATUSES = new Set(['Pending', 'In Progress', 'On Hold', 'Completed']);
const PRIORITIES = new Set(['Low', 'Medium', 'High']);
const LABEL = { admin: 'Admin', floor_manager: 'Floor Manager', team_leader: 'Team Leader', employee: 'Employee' };
const DEFAULT_PACKAGES = [
  { id: 'none', name: 'No package', amount: 0, currency: '₹', note: 'No package assigned' },
  { id: 'starter', name: 'Starter', amount: 5000, currency: '₹', note: 'Starter monthly package' },
  { id: 'standard', name: 'Standard', amount: 10000, currency: '₹', note: 'Standard employee package' },
  { id: 'premium', name: 'Premium', amount: 20000, currency: '₹', note: 'Premium allocation package' },
];
const KNOWN_DEMO_PASSWORDS = new Set(['Admin@123', 'Emp@123']);
const newObjectId = () => crypto.randomBytes(12).toString('hex');
const dateOrNull = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function transformLegacy(legacy, opts) {
  const { batchId, hashPassword, encryptBank, existing = {}, forceChange = true, genId = newObjectId } = opts;
  const db = legacy.db || legacy;
  const rep = { counts: {}, repairs: [], errors: [], warnings: [], dropped: {} };
  const repair = (m) => rep.repairs.push(m);
  const error = (m) => rep.errors.push(m);
  const idFor = (kind, legacyId) => (existing[kind] && existing[kind].get(legacyId)) || genId();
  const skipExisting = (kind, legacyId) => !!(existing[kind] && existing[kind].has(legacyId));
  const out = { users: [], packages: [], tasks: [], activity: [], chat: [], projects: [], tracks: [], assignments: [], notebooks: [] };
  const src = (k) => (Array.isArray(db[k]) ? db[k] : []);

  /* ---- packages (client created the 4 defaults when the key was absent) ---- */
  const pkgSrc = src('packages').length ? src('packages') : DEFAULT_PACKAGES;
  if (!src('packages').length) repair('pulse-db.json had no "packages": created the 4 defaults (none/starter/standard/premium) exactly as the original client did.');
  const pkgByLegacy = new Map();
  for (const p of pkgSrc) {
    if (!p || !p.id || !p.name) { error(`package skipped (missing id/name): ${JSON.stringify(p)}`); continue; }
    if (pkgByLegacy.has(p.id)) { error(`duplicate package id ${p.id}`); continue; }
    const _id = idFor('packages', p.id); pkgByLegacy.set(p.id, _id);
    if (skipExisting('packages', p.id)) continue;
    out.packages.push({ _id, key: p.id, name: String(p.name), amount: Math.max(0, Number(p.amount) || 0), currency: p.currency || '₹', note: p.note || '', migrationBatch: batchId });
  }
  const standardPkg = pkgByLegacy.get('standard') || [...pkgByLegacy.values()][0] || null;

  /* ---- users ---- */
  const emails = new Set(); const userByLegacy = new Map(); const plain = [];
  for (const u of src('users')) {
    if (!u || !u.id || !u.email || !u.name) { error(`user skipped (missing id/email/name): ${u && u.id}`); continue; }
    const email = String(u.email).trim().toLowerCase();
    if (emails.has(email)) { error(`duplicate email ${email} (legacy id ${u.id}) — skipped; its tasks will be reported`); continue; }
    emails.add(email);
    let role = u.role; if (!ROLES.has(role)) { repair(`user ${u.id}: unknown role "${u.role}" -> employee`); role = 'employee'; }
    let status = u.status || 'Active'; if (status !== 'Active' && status !== 'Suspended') { repair(`user ${u.id}: unknown status "${status}" -> Suspended (safer)`); status = 'Suspended'; }
    const _id = idFor('users', u.id); userByLegacy.set(u.id, _id);
    plain.push({ u, email, role, status, _id });
  }
  const activeOf = (role) => plain.filter((p) => p.role === role && p.status !== 'Suspended');
  const defaultLeader = activeOf('team_leader')[0]; const defaultFloor = activeOf('floor_manager')[0];
  const plainByLegacy = new Map(plain.map((p) => [p.u.id, p]));

  for (const p of plain) {
    const { u, email, role, status, _id } = p;
    let leader = null; let floor = null;
    if (role === 'employee') {
      let l = plainByLegacy.get(u.leaderId);
      if (!l || l.role !== 'team_leader') { l = defaultLeader; repair(`employee ${u.id}: missing/invalid team leader -> ${l ? l.u.id : 'NONE AVAILABLE'}`); }
      if (!l) error(`employee ${u.id} has no team leader and none exists`);
      leader = l ? l._id : null;
      const lf = l && (plainByLegacy.get(l.u.floorId) || null);
      floor = lf ? lf._id : (defaultFloor ? defaultFloor._id : null);
    } else if (role === 'team_leader') {
      const f = plainByLegacy.get(u.floorId);
      if (u.floorId && !(f && f.role === 'floor_manager')) repair(`team leader ${u.id}: invalid floorId -> default floor manager`);
      floor = f && f.role === 'floor_manager' ? f._id : defaultFloor ? defaultFloor._id : null;
    }
    let pkg = null;
    if (role === 'employee') {
      pkg = pkgByLegacy.get(u.packageId) || null;
      if (!pkg) { pkg = standardPkg; repair(`employee ${u.id}: missing/invalid packageId "${u.packageId}" -> standard`); }
    }
    if (u.mfaRecovery?.length) rep.dropped.recoveryCodes = (rep.dropped.recoveryCodes || 0) + u.mfaRecovery.length;
    if (u.trustedDevices?.length) rep.dropped.trustedDevices = (rep.dropped.trustedDevices || 0) + u.trustedDevices.length;
    if (KNOWN_DEMO_PASSWORDS.has(u.password)) rep.warnings.push(`user ${email} still has the documented default/demo password — rotate it`);
    if (skipExisting('users', u.id)) continue;

    let passwordHash;
    if (typeof u.password === 'string' && u.password) passwordHash = await hashPassword(u.password);
    else { passwordHash = await hashPassword(crypto.randomBytes(24).toString('hex')); repair(`user ${u.id}: no password in source — set an unguessable one; use "Forgot password"`); }

    const hasBank = !!(u.bankAccount || u.bankIfsc || u.bankHolder || u.bankName);
    const bank = hasBank
      ? { enc: encryptBank({ holder: u.bankHolder || '', name: u.bankName || '', account: u.bankAccount || '', ifsc: u.bankIfsc || '' }), hasDetails: true, locked: !!u.bankLocked, updatedAt: dateOrNull(u.bankUpdatedAt) || undefined }
      : { hasDetails: false, locked: !!u.bankLocked };
    out.users.push({
      _id, legacyId: u.id, migrationBatch: batchId, name: String(u.name).trim(), email, passwordHash,
      passwordChangedAt: dateOrNull(u.passwordChangedAt) || undefined, passwordChangedBy: u.passwordChangedBy || undefined,
      mustChangePassword: !!forceChange,
      role, department: LABEL[role], title: u.title || LABEL[role], phone: u.phone || '', status,
      joined: isISODate(u.joined) ? u.joined : undefined,
      leader: leader || undefined, floor: floor || undefined, package: pkg || undefined,
      lastLoginAt: dateOrNull(u.lastLoginAt) || undefined,
      mfa: { enabled: u.mfaEnabled !== false, lastAt: dateOrNull(u.mfaLastAt) || undefined, recovery: [], trustedDevices: [] },
      bank,
    });
  }

  /* ---- tasks ---- */
  const taskByLegacy = new Map();
  for (const t of src('tasks')) {
    if (!t || !t.id || !t.title) { error(`task skipped (missing id/title): ${t && t.id}`); continue; }
    const assignee = userByLegacy.get(t.assigneeId);
    if (!assignee) { error(`task ${t.id} "${t.title}": assignee ${t.assigneeId} not found (user missing/duplicate) — skipped`); continue; }
    if (!isISODate(t.due)) { error(`task ${t.id}: invalid due date "${t.due}" — skipped`); continue; }
    const _id = idFor('tasks', t.id); taskByLegacy.set(t.id, _id);
    if (skipExisting('tasks', t.id)) continue;
    let status = t.status; if (!STATUSES.has(status)) { repair(`task ${t.id}: unknown status "${status}" -> Pending`); status = 'Pending'; }
    let priority = t.priority; if (!PRIORITIES.has(priority)) { repair(`task ${t.id}: unknown priority "${priority}" -> Medium`); priority = 'Medium'; }
    const updatedAt = dateOrNull(t.updatedAt) || new Date();
    out.tasks.push({
      _id, legacyId: t.id, migrationBatch: batchId, title: String(t.title).slice(0, 200), description: t.description || '', assignee,
      assignedBy: userByLegacy.get(t.assignedBy) || undefined, start: isISODate(t.start) ? t.start : undefined, due: t.due, status, priority,
      category: t.category || 'General', progress: Math.max(0, Math.min(100, Number(t.progress) || 0)), notes: t.notes || '',
      createdAt: updatedAt, updatedAt,      // legacy has no createdAt; updatedAt is preserved exactly (drives the 7-day inactivity rule)
    });
  }

  /* ---- activity & chat ---- */
  const seenAct = new Set();
  for (const a of src('activity')) {
    const at = dateOrNull(a && a.at); if (!a || !a.text || !at) { error(`activity row skipped: ${JSON.stringify(a)}`); continue; }
    const legacyId = sha1(`${a.at}|${a.text}`); if (seenAct.has(legacyId)) continue; seenAct.add(legacyId);
    if (skipExisting('activity', legacyId)) continue;
    out.activity.push({ _id: idFor('activity', legacyId), legacyId, migrationBatch: batchId, text: String(a.text).slice(0, 500), at, type: 'legacy', involved: [] });   // admin-only visibility
  }
  for (const m of src('chat')) {
    const user = userByLegacy.get(m && m.userId); const at = dateOrNull(m && m.at);
    if (!m || !m.id || !m.text || !user || !at) { error(`chat message skipped: ${m && m.id}`); continue; }
    if (skipExisting('chat', m.id)) continue;
    out.chat.push({ _id: idFor('chat', m.id), legacyId: m.id, migrationBatch: batchId, user, name: m.name || '', text: String(m.text).slice(0, 500), at });
  }

  /* ---- projects, tracks, assignments, notebooks ---- */
  const projByLegacy = new Map(); const projCreator = new Map();
  for (const p of src('projects')) {
    if (!p || !p.id || !p.name) { error(`project skipped: ${p && p.id}`); continue; }
    const _id = idFor('projects', p.id); projByLegacy.set(p.id, _id); projCreator.set(p.id, userByLegacy.get(p.createdBy));
    if (skipExisting('projects', p.id)) continue;
    out.projects.push({ _id, legacyId: p.id, migrationBatch: batchId, name: p.name, description: p.description || '', createdBy: userByLegacy.get(p.createdBy) || undefined, createdAt: dateOrNull(p.createdAt) || undefined, updatedAt: dateOrNull(p.createdAt) || undefined });
  }
  const trackByLegacy = new Map();
  for (const t of src('tracks')) {
    const project = projByLegacy.get(t && t.projectId);
    if (!t || !t.id || !project || !t.fileName) { error(`track skipped (missing project/file): ${t && t.id}`); continue; }
    const _id = idFor('tracks', t.id); trackByLegacy.set(t.id, _id);
    if (skipExisting('tracks', t.id)) continue;
    // storageKey is assigned by the apply step after the file is copied and content-verified.
    out.tracks.push({ _id, legacyId: t.id, migrationBatch: batchId, project, originalName: t.originalName || t.fileName, legacyFile: t.fileName, size: Number(t.size) || 0, mime: 'audio/mpeg', uploadedBy: projCreator.get(t.projectId) || undefined, createdAt: dateOrNull(t.uploadedAt) || undefined });
  }
  const seenPair = new Set();
  for (const a of src('assignments')) {
    const track = trackByLegacy.get(a && a.trackId); const assignee = userByLegacy.get(a && a.assigneeId); const project = projByLegacy.get(a && a.projectId);
    if (!a || !a.id || !track || !assignee || !project) { error(`assignment skipped (dangling reference): ${a && a.id}`); continue; }
    const pair = `${a.trackId}:${a.assigneeId}`; if (seenPair.has(pair)) { repair(`assignment ${a.id}: duplicate (track,assignee) merged`); continue; } seenPair.add(pair);
    if (skipExisting('assignments', a.id)) continue;
    out.assignments.push({ _id: idFor('assignments', a.id), legacyId: a.id, migrationBatch: batchId, track, project, assignee, assignedBy: userByLegacy.get(a.assignedBy) || undefined, assignedAt: dateOrNull(a.assignedAt) || undefined, status: a.status === 'Written' ? 'Written' : 'Assigned' });
  }
  const seenNote = new Set();
  for (const n of src('notebooks')) {
    const user = userByLegacy.get(n && n.userId); const track = trackByLegacy.get(n && n.trackId);
    if (!n || !n.id || !user || !track) { error(`notebook skipped (dangling reference): ${n && n.id}`); continue; }
    const pair = `${n.userId}:${n.trackId}`; if (seenNote.has(pair)) { repair(`notebook ${n.id}: duplicate (user,track) skipped`); continue; } seenNote.add(pair);
    if (skipExisting('notebooks', n.id)) continue;
    out.notebooks.push({ _id: idFor('notebooks', n.id), legacyId: n.id, migrationBatch: batchId, user, track, text: n.text || '', updatedAt: dateOrNull(n.updatedAt) || new Date() });
  }

  rep.counts = {
    source: Object.fromEntries(['users', 'packages', 'tasks', 'activity', 'chat', 'projects', 'tracks', 'assignments', 'notebooks'].map((k) => [k, src(k).length])),
    toInsert: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
  };
  const skippedAlready = Object.entries(existing).reduce((n, [, m]) => n + (m ? m.size : 0), 0);
  if (skippedAlready) rep.warnings.push(`${skippedAlready} records already migrated earlier were left untouched (insert-only; nothing overwritten).`);
  return { docs: out, report: rep };
}
module.exports = { transformLegacy, DEFAULT_PACKAGES, newObjectId };
