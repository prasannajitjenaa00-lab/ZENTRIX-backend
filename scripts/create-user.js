#!/usr/bin/env node
'use strict';
/*
 * Create one account from the command line (first admin on a fresh production database; floor managers).
 *   node scripts/create-user.js --name "Ada" --email ada@corp.com --role admin [--password ...]
 * Without --password a strong temporary one is generated and printed ONCE. The user must change it at first sign-in.
 */
const { getConfig } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { User } = require('../src/models');
const C = require('../src/utils/crypto');
const { todayISO } = require('../src/utils/dates');
const a = process.argv.slice(2); const o = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const LABEL = { admin: 'Admin', floor_manager: 'Floor Manager', team_leader: 'Team Leader', employee: 'Employee' };
(async () => {
  const cfg = getConfig();
  const role = o('role') || 'admin'; const email = (o('email') || '').toLowerCase().trim(); const name = o('name');
  if (!LABEL[role] || !email || !name) { console.error('Usage: --name <n> --email <e> --role admin|floor_manager|team_leader [--password <p>]'); process.exit(2); }
  if (role === 'employee') { console.error('Create employees in the app (they need a team leader).'); process.exit(2); }
  await connectDb(cfg.mongoUri);
  if (await User.exists({ email })) { console.error('That email already exists.'); process.exit(1); }
  const password = o('password') || C.temporaryPassword();
  if (password.length < cfg.auth.passwordMin) { console.error(`Password must be at least ${cfg.auth.passwordMin} characters.`); process.exit(2); }
  const floor = role === 'team_leader' ? (await User.findOne({ role: 'floor_manager', status: 'Active' }))?._id : undefined;
  await User.create({ name, email, passwordHash: await C.hashPassword(password), visiblePasswordEnc: C.encryptJSON({ password }, cfg.encKey), passwordChangedAt: new Date(), passwordChangedBy: 'cli', mustChangePassword: true, role, department: LABEL[role], title: LABEL[role], status: 'Active', joined: todayISO(cfg.timezone), floor, mfa: { enabled: true } });
  console.log(`Created ${LABEL[role]} ${email}${o('password') ? '' : `\nTemporary password (shown once): ${password}`}`);
  await disconnectDb();
})().catch((e) => { console.error(e.message); process.exit(1); });
