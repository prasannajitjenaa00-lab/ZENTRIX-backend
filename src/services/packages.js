'use strict';
const { Package, User } = require('../models');
const dto = require('./dto');
const { notFound, bad } = require('../utils/errors');
const activity = require('./activity');
const mongoose = require('mongoose');

const DEFAULTS = [
  { key: 'none', name: 'No package', amount: 0, note: 'No package assigned' },
  { key: 'starter', name: 'Starter', amount: 5000, note: 'Starter monthly package' },
  { key: 'standard', name: 'Standard', amount: 10000, note: 'Standard employee package' },
  { key: 'premium', name: 'Premium', amount: 20000, note: 'Premium allocation package' },
];
const list = async () => (await Package.find().sort({ amount: 1, name: 1 })).map(dto.pkg);
async function create(actor, input) {
  const p = await Package.create({ name: input.name, amount: input.amount ?? 0, currency: input.currency || '₹', note: input.note || '' });
  await activity.log(`${actor.name} created package “${p.name}”.`, { actor: actor._id, rooms: ['admin'], type: 'package' });
  return dto.pkg(p);
}
async function update(actor, id, input) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const p = await Package.findById(id); if (!p) throw notFound('Package not found.');
  for (const k of ['name', 'amount', 'currency', 'note']) if (input[k] !== undefined) p[k] = input[k];
  await p.save();
  return dto.pkg(p);
}
/** Original: deleted packages leave employees on the "standard" package (normalizeRoster). */
async function remove(actor, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const p = await Package.findById(id); if (!p) throw notFound('Package not found.');
  const fallback = (await Package.findOne({ key: 'standard', _id: { $ne: p._id } })) || (await Package.findOne({ _id: { $ne: p._id } }).sort({ createdAt: 1 }));
  const res = await User.updateMany({ package: p._id }, fallback ? { $set: { package: fallback._id } } : { $unset: { package: 1 } });
  await p.deleteOne();
  await activity.log(`${actor.name} deleted package “${p.name}”.`, { actor: actor._id, rooms: ['admin'], type: 'package' });
  return { reassigned: res.modifiedCount };
}
module.exports = { list, create, update, remove, DEFAULTS };
