'use strict';
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { validate, rules: r, ENUMS } = require('../validators');
const svc = require('../services/tasks');
const { ok } = require('../middleware/respond');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const leaders = requireRole('admin', 'floor_manager', 'team_leader');
const admin = requireRole('admin');

router.get('/', asyncHandler(async (req, res) => { const out = await svc.list(req.user, req.query); ok(res, out.data, out.meta); }));
router.get('/calendar', asyncHandler(async (req, res) => ok(res, await svc.calendar(req.user, req.query))));
router.get('/:id', asyncHandler(async (req, res) => ok(res, await svc.get(req.user, req.params.id))));

router.post('/', leaders, asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    title: r.string({ min: 1, max: 200 }), description: r.string({ max: 4000, optional: true, allowEmpty: true }), assigneeId: r.objectId(),
    category: r.string({ max: 60, optional: true, allowEmpty: true }), start: r.isoDate({ optional: true }), due: r.isoDate(),
    priority: r.oneOf(ENUMS.priorities, { optional: true }), status: r.oneOf(ENUMS.statuses, { optional: true }),
    progress: r.int({ min: 0, max: 100, clamp: true, optional: true }), notes: r.string({ max: 4000, optional: true, allowEmpty: true }),
  });
  ok(res, await svc.create(req.user, { ...b, category: b.category || 'General' }), undefined, 201);
}));
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    title: r.string({ min: 1, max: 200, optional: true }),
    description: r.string({ max: 4000, optional: true, allowEmpty: true }),
    status: r.oneOf(ENUMS.statuses, { optional: true }),
    progress: r.int({ min: 0, max: 100, clamp: true, optional: true }),
    notes: r.string({ max: 4000, optional: true, allowEmpty: true }),
  });
  ok(res, await svc.updateStatus(req.user, req.params.id, b));
}));
router.patch('/:id', admin, asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    title: r.string({ min: 1, max: 200, optional: true }), description: r.string({ max: 4000, optional: true, allowEmpty: true }), assigneeId: r.objectId({ optional: true }),
    category: r.string({ max: 60, optional: true }), start: r.isoDate({ optional: true }), due: r.isoDate({ optional: true }),
    priority: r.oneOf(ENUMS.priorities, { optional: true }), status: r.oneOf(ENUMS.statuses, { optional: true }),
    progress: r.int({ min: 0, max: 100, clamp: true, optional: true }), notes: r.string({ max: 4000, optional: true, allowEmpty: true }),
  });
  if (b.category === '') b.category = 'General';      // original: blank category falls back to General
  ok(res, await svc.updateMeta(req.user, req.params.id, b));
}));
router.delete('/:id', admin, asyncHandler(async (req, res) => { await svc.remove(req.user, req.params.id); ok(res, { deleted: true }); }));
module.exports = router;
