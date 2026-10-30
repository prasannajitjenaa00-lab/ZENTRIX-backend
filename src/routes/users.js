'use strict';
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { validate, rules: r, ENUMS } = require('../validators');
const svc = require('../services/users');
const { ok } = require('../middleware/respond');
const { requireRole } = require('../middleware/auth');
const dto = require('../services/dto');

const router = express.Router();
const admin = requireRole('admin');
const leaders = requireRole('admin', 'floor_manager', 'team_leader');
const bankFields = {
  holder: r.string({ max: 120, optional: true, allowEmpty: true }),
  name: r.string({ max: 120, optional: true, allowEmpty: true }),
  account: r.string({ max: 40, optional: true, allowEmpty: true }),
  ifsc: r.string({ max: 20, optional: true, allowEmpty: true }),
  upi: r.string({ max: 120, optional: true, allowEmpty: true }),
  aadharPan: r.string({ max: 200, optional: true, allowEmpty: true }),
};

router.get('/', admin, asyncHandler(async (req, res) => { const out = await svc.listAll(req.query, { includeBank: req.query.includeBank === '1' }); ok(res, out.data, out.meta); }));
router.get('/crew', leaders, asyncHandler(async (req, res) => ok(res, await svc.listCrew(req.user))));
router.get('/assignable', leaders, asyncHandler(async (req, res) => ok(res, await svc.listAssignable(req.user))));
router.get('/leaders', admin, asyncHandler(async (req, res) => ok(res, await svc.listLeaders())));

router.post('/', admin, asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    name: r.string({ min: 1, max: 120 }), email: r.email(), phone: r.string({ max: 30, optional: true, allowEmpty: true }),
    role: r.oneOf(['employee', 'team_leader', 'admin']), leaderId: r.objectId({ optional: true, allowEmpty: true }), floorId: r.objectId({ optional: true, allowEmpty: true }),
    packageId: r.objectId({ optional: true, allowEmpty: true }), password: r.string({ max: 200, optional: true, allowEmpty: true, trim: false }),
    mfaEnabled: r.bool({ optional: true }), bankUnlock: r.bool({ optional: true }),
  });
  const bank = validate(req.body.bank || {}, bankFields);
  const out = await svc.create(req.user, { ...b, leaderId: b.leaderId || undefined, floorId: b.floorId || undefined, packageId: b.packageId || undefined, password: b.password || undefined, bank });
  ok(res, out, undefined, 201);
}));

/* /me routes MUST precede /:id */
router.patch('/me', asyncHandler(async (req, res) => {
  const b = validate(req.body, { name: r.string({ min: 1, max: 120, optional: true }), title: r.string({ min: 1, max: 80, optional: true }), mfaEnabled: r.bool({ optional: true }) });
  ok(res, await svc.updateSelf(req.user, b));
}));
router.get('/me/bank', asyncHandler(async (req, res) => ok(res, await svc.getBank(req.user, req.user._id))));
router.put('/me/bank', asyncHandler(async (req, res) => ok(res, await svc.saveOwnBank(req.user, validate(req.body, bankFields)))));

router.get('/:id/bank', admin, asyncHandler(async (req, res) => ok(res, await svc.getBank(req.user, req.params.id))));
router.get('/:id/password', admin, asyncHandler(async (req, res) => ok(res, await svc.getPassword(req.user, req.params.id))));
router.patch('/:id/bank', admin, asyncHandler(async (req, res) => ok(res, await svc.adminSetBank(req.user, req.params.id, { ...validate(req.body, bankFields), ...validate(req.body, { unlock: r.bool({ optional: true }), legacyId: r.string({ max: 50, optional: true, allowEmpty: true }), userName: r.string({ max: 120, optional: true, allowEmpty: true }) }) }))));
router.post('/:id/status', admin, asyncHandler(async (req, res) => ok(res, await svc.setStatus(req.user, req.params.id, validate(req.body, { status: r.oneOf(ENUMS.userStatus) }).status))));
router.patch('/:id', admin, asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    name: r.string({ min: 1, max: 120, optional: true }), email: r.email({ optional: true }), phone: r.string({ max: 30, optional: true, allowEmpty: true }),
    role: r.oneOf(ENUMS.roles, { optional: true }), leaderId: r.objectId({ optional: true, allowEmpty: true }), floorId: r.objectId({ optional: true, allowEmpty: true }),
    packageId: r.objectId({ optional: true, allowEmpty: true }), password: r.string({ max: 200, optional: true, allowEmpty: true, trim: false }), mfaEnabled: r.bool({ optional: true }),
  });
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Account not found.' } });
  ok(res, await svc.update(req.user, req.params.id, { ...b, leaderId: b.leaderId === '' ? undefined : b.leaderId, floorId: b.floorId === '' ? undefined : b.floorId, packageId: b.packageId || undefined, password: b.password || undefined }));
}));
router.delete('/:id', admin, asyncHandler(async (req, res) => ok(res, await svc.remove(req.user, req.params.id))));
module.exports = router;
