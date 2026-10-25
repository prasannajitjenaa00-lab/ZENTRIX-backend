'use strict';
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { validate, rules: r } = require('../validators');
const withdrawalsSvc = require('../services/withdrawals');
const { ok } = require('../middleware/respond');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const admin = requireRole('admin');

// Employee: get balance, earnings summary, and withdrawal history
router.get('/me', asyncHandler(async (req, res) => {
  ok(res, await withdrawalsSvc.getEmployeeSummary(req.user));
}));

// Employee: submit a withdrawal request
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  ok(res, await withdrawalsSvc.requestWithdrawal(req.user, b), undefined, 201);
}));

// Admin: list all withdrawal requests across the system
router.get('/', admin, asyncHandler(async (req, res) => {
  ok(res, await withdrawalsSvc.listAll(req.user, req.query));
}));

// Admin: approve, mark completed (with UTR), or reject
router.patch('/:id', admin, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    status: r.oneOf(['pending', 'approved', 'completed', 'rejected'], { optional: true }),
    adminNote: r.string({ max: 500, optional: true, allowEmpty: true }),
    utr: r.string({ max: 100, optional: true, allowEmpty: true })
  });
  ok(res, await withdrawalsSvc.updateStatus(req.user, req.params.id, body));
}));

module.exports = router;
