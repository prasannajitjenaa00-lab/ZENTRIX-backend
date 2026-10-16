'use strict';
/* Integration harness: in-memory MongoDB + real Express app. Requires: npm install (supertest, mongodb-memory-server). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { loadConfig, setConfigForTests } = require('../../src/config/env');
const C = require('../../src/utils/crypto');

const FAST = { N: 1 << 10, r: 8, p: 1 };
const PASSWORD = 'Passw0rd!';
const ORIGIN = 'http://localhost:5173';
let mongod; let app; let cfg;

async function boot(extraEnv = {}) {
  mongod = await MongoMemoryServer.create();
  cfg = loadConfig({
    NODE_ENV: 'test', MONGODB_URI: mongod.getUri(), FRONTEND_URL: ORIGIN, DEV_MAIL_PREVIEW: 'true',
    DATA_ENCRYPTION_KEY: 'a'.repeat(64), TOKEN_PEPPER: 'p'.repeat(48), STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-')), ...extraEnv,
  });
  setConfigForTests(cfg);
  await mongoose.connect(mongod.getUri());
  const M = require('../../src/models');
  await Promise.all(Object.values(M).map((m) => m.init()));
  await require('../../src/services/storage').init();
  app = require('../../src/app').createApp();
  return { app, cfg, M };
}
async function shutdown() { await mongoose.disconnect(); await mongod.stop(); }

/** Build the org used by every test: admin, floor manager, 2 team leaders (A,B), employees under each, a suspended one. */
async function seedOrg() {
  const { User, Package } = require('../../src/models');
  const passwordHash = await C.hashPassword(PASSWORD, FAST);
  const std = await Package.create({ key: 'standard', name: 'Standard', amount: 10000 });
  const mk = (o) => User.create({ passwordHash, status: 'Active', joined: '2026-01-01', mfa: { enabled: false }, ...o });
  const admin = await mk({ name: 'Admin', email: 'admin@t.io', role: 'admin' });
  const fm = await mk({ name: 'Floor', email: 'fm@t.io', role: 'floor_manager' });
  const tlA = await mk({ name: 'Lead A', email: 'tla@t.io', role: 'team_leader', floor: fm._id });
  const tlB = await mk({ name: 'Lead B', email: 'tlb@t.io', role: 'team_leader', floor: fm._id });
  const a1 = await mk({ name: 'Emp A1', email: 'a1@t.io', role: 'employee', leader: tlA._id, floor: fm._id, package: std._id });
  const a2 = await mk({ name: 'Emp A2', email: 'a2@t.io', role: 'employee', leader: tlA._id, floor: fm._id, package: std._id });
  const b1 = await mk({ name: 'Emp B1', email: 'b1@t.io', role: 'employee', leader: tlB._id, floor: fm._id, package: std._id });
  const sus = await mk({ name: 'Suspended', email: 'sus@t.io', role: 'employee', leader: tlA._id, floor: fm._id, status: 'Suspended' });
  return { admin, fm, tlA, tlB, a1, a2, b1, sus, std };
}

const call = (agent, method, url, body) => {
  const r = agent[method](url).set('X-Pulse-Client', '1').set('Origin', ORIGIN);
  return body === undefined ? r : r.send(body);
};
async function login(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await call(agent, 'post', '/api/auth/login', { email, password });
  if (res.status !== 200 || res.body.data.mfaRequired) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
const futureDate = (d = 10) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
const mp3Buffer = (extra = 2048) => Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'), Buffer.alloc(extra, 1)]);

module.exports = { boot, shutdown, seedOrg, call, login, request, futureDate, mp3Buffer, PASSWORD, ORIGIN, FAST, get app() { return app; }, get cfg() { return cfg; } };
