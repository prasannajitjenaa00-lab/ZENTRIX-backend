'use strict';
/* packages, wallet, chat, activity, dashboard, mfa/devices — small resources grouped to keep the tree readable. */
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { validate, rules: r } = require('../validators');
const packages = require('../services/packages');
const usersSvc = require('../services/users');
const chat = require('../services/chat');
const activity = require('../services/activity');
const dashboard = require('../services/dashboard');
const auth = require('../services/auth');
const { User } = require('../models');
const H = require('../policy/hierarchy');
const dto = require('../services/dto');
const { ok } = require('../middleware/respond');
const { requireRole } = require('../middleware/auth');
const { forbidden } = require('../utils/errors');

const admin = requireRole('admin');
const leaders = requireRole('admin', 'floor_manager', 'team_leader');

const pkg = express.Router();
const pkgBody = { name: r.string({ min: 1, max: 80 }), amount: r.number({ min: 0, max: 1e9, optional: true }), ratePerHour: r.number({ min: 0, max: 1e9, optional: true }), currency: r.string({ max: 4, optional: true, allowEmpty: true }), note: r.string({ max: 300, optional: true, allowEmpty: true }) };
pkg.get('/', admin, asyncHandler(async (req, res) => ok(res, await packages.list())));
pkg.post('/', admin, asyncHandler(async (req, res) => ok(res, await packages.create(req.user, validate(req.body, pkgBody)), undefined, 201)));
pkg.patch('/:id', admin, asyncHandler(async (req, res) => ok(res, await packages.update(req.user, req.params.id, validate(req.body, { ...pkgBody, name: r.string({ min: 1, max: 80, optional: true }) })))));
pkg.delete('/:id', admin, asyncHandler(async (req, res) => ok(res, await packages.remove(req.user, req.params.id))));

const wallet = express.Router();
wallet.get('/me', asyncHandler(async (req, res) => ok(res, await usersSvc.walletFor(req.user))));   // the wallet is the employee's own package; no transactions exist in the original

const chatR = express.Router();
chatR.get('/', asyncHandler(async (req, res) => ok(res, await chat.list({ limit: req.query.limit, before: req.query.before }))));
chatR.post('/', admin, asyncHandler(async (req, res) => ok(res, await chat.post(req.user, validate(req.body, { text: r.string({ min: 1, max: 500 }) }).text), undefined, 201)));

const act = express.Router();
act.get('/', asyncHandler(async (req, res) => ok(res, await activity.listFor(req.user, Math.min(Number(req.query.limit) || 40, 100)))));

const dash = express.Router();
dash.get('/', leaders, asyncHandler(async (req, res) => ok(res, await dashboard.overview(req.user))));
dash.get('/me', asyncHandler(async (req, res) => ok(res, await dashboard.mine(req.user))));

const mfa = express.Router();
mfa.post('/recovery-codes', asyncHandler(async (req, res) => ok(res, { recoveryCodes: await auth.regenerateRecoveryCodes(req.user._id) })));   // plaintext shown once; only hashes stored
const devices = express.Router();
devices.get('/', asyncHandler(async (req, res) => {
  const u = await User.findById(req.user._id).select('+mfa.trustedDevices').lean();
  ok(res, (u.mfa?.trustedDevices || []).filter((d) => d.expiresAt > new Date()).map((d) => ({ id: String(d._id), label: d.label, createdAt: d.createdAt, expiresAt: d.expiresAt })));
}));
devices.delete('/', asyncHandler(async (req, res) => { await auth.clearTrustedDevices(req.user._id); res.clearCookie(require('../config/env').getConfig().session.trustedCookieName, { path: '/api/auth' }); ok(res, { cleared: true }); }));

module.exports = { pkg, wallet, chat: chatR, activity: act, dashboard: dash, mfa, devices };
