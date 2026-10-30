'use strict';
const { User, Package } = require('../models');
const C = require('../utils/crypto');
const { AppError, bad, conflict, notFound, forbidden } = require('../utils/errors');
const { getConfig } = require('../config/env');
const { validateBank } = require('../validators');
const dto = require('./dto');
const H = require('../policy/hierarchy');
const { loadRoster } = require('./roster');
const auth = require('./auth');
const sessions = require('./sessions');
const activity = require('./activity');
const { emit, disconnectUser } = require('./realtime');
const { parsePage, pageMeta, escapeRegex } = require('../utils/pagination');
const { todayISO } = require('../utils/dates');

const ROLE_LABEL = { admin: 'Admin', floor_manager: 'Floor Manager', team_leader: 'Team Leader', employee: 'Employee' };
const todayLocal = () => todayISO(getConfig().timezone);
const encryptBank = (b) => C.encryptJSON(b, getConfig().encKey);
const decryptBank = (enc) => (enc ? C.decryptJSON(enc, getConfig().encKey) : null);
const encryptPassword = (p) => C.encryptJSON(p, getConfig().encKey);
const decryptPassword = (enc) => (enc ? C.decryptJSON(enc, getConfig().encKey) : null);

async function defaultPackageId() {
  const p = (await Package.findOne({ key: 'standard' }).select('_id')) || (await Package.findOne().sort({ createdAt: 1 }).select('_id'));
  return p?._id || null;
}

/* ---------- lists ---------- */
/** Admin: every account (filter/sort/paginate). Others get scoped crew via listCrew. */
async function listAll(query, { includeBank = false } = {}) {
  const pg = parsePage(query, { defaultLimit: 100, maxLimit: 500 });
  const filter = {};
  if (query.role) filter.role = String(query.role);
  if (query.status) filter.status = String(query.status);
  if (query.q) { const rx = new RegExp(escapeRegex(String(query.q).slice(0, 60)), 'i'); filter.$or = [{ name: rx }, { email: rx }, { legacyId: rx }]; }
  const roleOrder = { admin: 0, floor_manager: 1, team_leader: 2, employee: 3 };
  const [rows, total] = await Promise.all([
    User.find(filter).select(includeBank ? '+bank.enc' : '').sort({ name: 1 }).skip(pg.skip).limit(pg.limit),
    User.countDocuments(filter),
  ]);
  rows.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.name.localeCompare(b.name));  // original Accounts ordering
  const data = rows.map((u) => {
    const out = dto.userFull(u);
    if (includeBank && u.bank?.enc) { try { out.bankDetails = { ...decryptBank(u.bank.enc) }; } catch { out.bankDetails = null; } }
    return out;
  });
  return { data, meta: pageMeta(pg, total) };
}
async function listCrew(viewer) {
  const roster = await loadRoster();
  const me = dto.toPlain(viewer);
  return H.activeCrew(roster, me).map(dto.userPublic);
}
/** Employees the viewer may assign work/audio to (dropdowns). */
async function listAssignable(viewer) {
  const roster = await loadRoster();
  return H.managedEmployees(roster, dto.toPlain(viewer)).map(dto.userPublic);
}
/** Active team leaders / floor managers for the account form (admin). */
async function listLeaders() {
  const rows = await User.find({ role: { $in: ['team_leader', 'floor_manager'] }, status: 'Active' }).sort({ name: 1 });
  return rows.map(dto.userPublic);
}

/* ---------- create / update (admin) ---------- */
async function resolveLeaderFloor(role, leaderId, floorId) {
  const roster = await loadRoster();
  if (role === 'employee') {
    if (!leaderId) return { leader: null, floor: null };
    const leader = roster.find((u) => u.id === leaderId);
    if (!leader || leader.role !== 'team_leader' || leader.status !== 'Active') throw bad('Pick a valid team leader.', { leaderId: 'Pick an active team leader.' });
    return { leader: leader.id, floor: leader.floorId || null };
  }
  if (role === 'team_leader') {
    if (floorId) {
      const f = roster.find((u) => u.id === floorId);
      if (!f || f.role !== 'floor_manager') throw bad('Pick a valid floor manager.', { floorId: 'Invalid.' });
    }
    return { leader: null, floor: H.derivedFloorFor(roster, 'team_leader', null, floorId) };
  }
  return { leader: null, floor: null };
}

async function create(actor, input) {
  if (await User.exists({ email: input.email })) throw conflict('That email already holds a Pulse seat.', 'EMAIL_TAKEN');
  const { leader, floor } = await resolveLeaderFloor(input.role, input.leaderId, input.floorId);
  const tempProvided = !!input.password;
  const password = input.password || C.temporaryPassword();
  auth.checkPasswordPolicy(password);
  const bankIn = input.bank || {};
  const hasBank = !!(bankIn.holder || bankIn.name || bankIn.account || bankIn.ifsc || bankIn.upi || bankIn.aadharPan);
  let bankDoc = { hasDetails: false, locked: false };
  if (hasBank) {
    const b = validateBank(bankIn);
    bankDoc = { enc: encryptBank(b), hasDetails: true, locked: !input.bankUnlock, updatedAt: new Date() };
  }
  const user = await User.create({
    name: input.name, email: input.email, passwordHash: await C.hashPassword(password),
    passwordPlain: { enc: encryptPassword(password), updatedAt: new Date() },
    passwordChangedAt: new Date(), passwordChangedBy: actor.name, mustChangePassword: false,   // password change on login disabled
    role: input.role, department: ROLE_LABEL[input.role], title: ROLE_LABEL[input.role], phone: input.phone || '',
    status: 'Active', joined: todayLocal(), leader: leader || undefined, floor: floor || undefined,
    package: input.role === 'employee' ? (input.packageId || (await defaultPackageId()) || undefined) : undefined,
    mfa: { enabled: input.mfaEnabled !== false }, bank: bankDoc,
  });
  let recoveryCodes;
  if (user.mfa.enabled) recoveryCodes = await auth.regenerateRecoveryCodes(user._id);
  await activity.log(`${actor.name} created ${ROLE_LABEL[input.role].toLowerCase()} account for ${user.name}.`, { actor: actor._id, involved: [user._id], rooms: ['admin'] });
  emit(['admin'], 'user:created', { user: dto.userFull(user) });
  return { user: dto.userFull(user), temporaryPassword: tempProvided ? undefined : password, recoveryCodes };
}

async function update(actor, id, input) {
  const user = await User.findById(id);
  if (!user) throw notFound('Account not found.');
  const role = input.role || user.role;
  // Only admin<->team_leader<->employee changes are allowed; a Floor Manager keeps their role (fixes original demotion bug).
  if (user.role === 'floor_manager' && role !== 'floor_manager') throw bad('Floor Manager accounts keep their role.', { role: 'Not changeable.' });
  if (role === 'floor_manager' && user.role !== 'floor_manager') throw bad('Floor Manager accounts cannot be created from the account form.', { role: 'Not allowed.' });
  if (String(user._id) === String(actor._id) && role !== 'admin') throw forbidden('You cannot remove your own admin access.');
  if (input.email && input.email !== user.email && (await User.exists({ email: input.email, _id: { $ne: user._id } }))) throw conflict('That email already holds a Pulse seat.', 'EMAIL_TAKEN');

  const leaderId = role === 'employee' ? (input.leaderId ?? (user.leader && String(user.leader))) : null;
  const { leader, floor } = await resolveLeaderFloor(role, leaderId, input.floorId ?? (user.floor && String(user.floor)));
  if (input.name !== undefined) user.name = input.name;
  if (input.email !== undefined) user.email = input.email;
  if (input.phone !== undefined) user.phone = input.phone;
  user.role = role; user.department = ROLE_LABEL[role]; user.title = ROLE_LABEL[role];
  user.leader = leader || undefined; user.floor = floor || undefined;
  user.package = role === 'employee' ? (input.packageId || user.package || (await defaultPackageId()) || undefined) : undefined;
  let recoveryCodes;
  if (input.mfaEnabled !== undefined) {
    const was = user.mfa.enabled !== false;
    user.mfa.enabled = input.mfaEnabled;
    if (input.mfaEnabled && !was) recoveryCodes = true;
  }
  await user.save();
  if (recoveryCodes) recoveryCodes = await auth.regenerateRecoveryCodes(user._id);
  if (input.password) {
    await auth.setPassword(user._id, input.password, { by: actor.name, mustChange: true });
    await sessions.revokeAllForUser(user._id); disconnectUser(String(user._id));
    await activity.log(`${actor.name} replaced the password for ${user.name}. Previous password deleted.`, { actor: actor._id, involved: [user._id], rooms: ['admin'] });
  }
  await activity.log(`${actor.name} updated ${user.name}'s account.`, { actor: actor._id, involved: [user._id], rooms: ['admin', `user:${user._id}`] });
  const fresh = await User.findById(user._id);
  emit(['admin', `user:${user._id}`], 'user:updated', { user: dto.userFull(fresh) });
  return { user: dto.userFull(fresh), recoveryCodes: Array.isArray(recoveryCodes) ? recoveryCodes : undefined };
}

async function setStatus(actor, id, status) {
  const user = await User.findById(id);
  if (!user) throw notFound('Account not found.');
  if (user.role === 'admin') throw forbidden('Admin accounts cannot be suspended.');    // original hides the button for admins
  user.status = status; await user.save();
  if (status !== 'Active') { await sessions.revokeAllForUser(user._id); disconnectUser(String(user._id)); }
  await activity.log(`${actor.name} set ${user.name} to ${status}.`, { actor: actor._id, involved: [user._id], rooms: ['admin', `user:${user._id}`] });
  emit(['admin'], 'user:updated', { user: dto.userFull(user) });
  return dto.userFull(user);
}

/* ---------- self-service ---------- */
async function updateSelf(user, input) {
  const u = await User.findById(user._id);
  if (input.name) u.name = input.name;
  if (input.title) u.title = input.title;
  let recoveryCodes;
  if (input.mfaEnabled !== undefined) {
    const was = u.mfa.enabled !== false; u.mfa.enabled = input.mfaEnabled;
    if (input.mfaEnabled && !was) recoveryCodes = true;
  }
  await u.save();
  if (recoveryCodes) recoveryCodes = await auth.regenerateRecoveryCodes(u._id);
  return { user: dto.userFull(u), recoveryCodes: Array.isArray(recoveryCodes) ? recoveryCodes : undefined };
}

/* ---------- bank details ---------- */
async function getBank(viewer, targetId) {
  const isSelf = String(viewer._id) === String(targetId);
  if (!isSelf && viewer.role !== 'admin') throw forbidden();      // IDOR guard: only the owner or an admin
  const u = await User.findById(targetId).select('+bank.enc');
  if (!u) throw notFound();
  return { details: decryptBank(u.bank?.enc), locked: !!u.bank?.locked, hasDetails: !!u.bank?.hasDetails, updatedAt: u.bank?.updatedAt || null };
}

/** Original: first successful save locks. Locked => only admin may change. */
async function saveOwnBank(viewer, input) {
  const u = await User.findById(viewer._id);
  if (u.bank?.locked && viewer.role !== 'admin') throw new AppError(403, 'BANK_LOCKED', 'Bank details are locked. Contact admin.');
  const b = validateBank(input);
  u.bank = { enc: encryptBank(b), hasDetails: true, locked: true, updatedAt: new Date() };
  await u.save();
  await activity.log(`${u.name} updated bank details.`, { actor: u._id, type: 'bank', rooms: ['admin'] });
  return { locked: true, updatedAt: u.bank.updatedAt };
}

/** Admin path from the account modal: any non-empty field saves + sets lock = !unlock; only-unlock just unlocks. */
async function adminSetBank(actor, id, input) {
  const u = await User.findById(id);
  if (!u) throw notFound('Account not found.');
  const any = ['holder', 'name', 'account', 'ifsc', 'upi', 'aadharPan'].some((k) => input[k] !== undefined && input[k] !== '');
  if (any) {
    const b = validateBank(input);
    u.bank = { enc: encryptBank(b), hasDetails: true, locked: !input.unlock, updatedAt: new Date() };
  } else if (input.unlock) {
    u.bank.locked = false;
  } else if (input.unlock === false && u.bank?.hasDetails) {
    u.bank.locked = true;
  }
  if (input.legacyId !== undefined) {
    u.legacyId = input.legacyId ? String(input.legacyId).trim() : undefined;
  }
  if (input.userName !== undefined && input.userName.trim()) {
    u.name = String(input.userName).trim();
  }
  await u.save();
  await activity.log(`${actor.name} ${input.unlock ? 'unlocked' : 'updated'} KYC details for ${u.name}.`, { actor: actor._id, involved: [u._id], type: 'bank', rooms: ['admin'] });
  emit([`user:${u._id}`, 'admin'], 'user:updated', { user: dto.userFull(u) });
  return { locked: !!u.bank.locked, hasDetails: !!u.bank.hasDetails, bankDetails: decryptBank(u.bank?.enc), legacyId: u.legacyId, name: u.name };
}

/** Admin-only: current plaintext password, decrypted on demand. Every reveal is audit-logged. */
async function getPassword(actor, targetId) {
  const u = await User.findById(targetId).select('+passwordPlain.enc');
  if (!u) throw notFound('Account not found.');
  await activity.log(`${actor.name} viewed the password for ${u.name}.`, { actor: actor._id, involved: [u._id], type: 'password', rooms: ['admin'] });
  return { password: decryptPassword(u.passwordPlain?.enc), updatedAt: u.passwordPlain?.updatedAt || null };
}

/* ---------- wallet / package ---------- */
async function walletFor(user) {
  const u = await User.findById(user._id).populate('package');
  const fallback = { id: null, key: 'none', name: 'No package', amount: 0, currency: '₹', note: 'No package assigned' };
  return { package: dto.pkg(u.package) || fallback };
}

async function remove(actor, id) {
  if (String(actor._id) === String(id)) throw bad('You cannot delete your own admin account.');
  const u = await User.findById(id);
  if (!u) throw notFound('Account not found.');
  await User.deleteOne({ _id: u._id });
  await activity.log(`${actor.name} deleted account for ${u.name}.`, { actor: actor._id, type: 'user', rooms: ['admin'] });
  return { deleted: true };
}

module.exports = { listAll, listCrew, listAssignable, listLeaders, create, update, setStatus, remove, updateSelf, getBank, saveOwnBank, adminSetBank, getPassword, walletFor, ROLE_LABEL };
