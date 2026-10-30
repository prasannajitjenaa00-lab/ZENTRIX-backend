'use strict';
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { validate, rules: r } = require('../validators');
const svc = require('../services/withdrawals');
const { ok } = require('../middleware/respond');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const admin = requireRole('admin');

router.get('/me', asyncHandler(async (req, res) => {
  ok(res, await svc.getMyWithdrawals(req.user));
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    amount: r.number({ min: 1, max: 1e8 }),
    note: r.string({ max: 500, optional: true, allowEmpty: true }),
  });
  ok(res, await svc.requestWithdrawal(req.user, b), undefined, 201);
}));

router.get('/', admin, asyncHandler(async (req, res) => {
  ok(res, await svc.listAllWithdrawals(req.user, req.query));
}));

router.patch('/:id', admin, asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    status: r.oneOf(['approved', 'completed', 'rejected']),
    adminNote: r.string({ max: 500, optional: true, allowEmpty: true }),
    utr: r.string({ max: 100, optional: true, allowEmpty: true }),
  });
  ok(res, await svc.updateWithdrawalStatus(req.user, req.params.id, b));
}));

module.exports = router;

