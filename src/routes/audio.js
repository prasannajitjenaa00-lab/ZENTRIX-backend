'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const asyncHandler = require('../utils/asyncHandler');
const { validate, rules: r } = require('../validators');
const svc = require('../services/audio');
const storage = require('../services/storage');
const { ok } = require('../middleware/respond');
const { requireRole } = require('../middleware/auth');
const rl = require('../middleware/rateLimit');
const { getConfig } = require('../config/env');
const { parseRange } = require('../utils/range');
const { AppError } = require('../utils/errors');

const admin = requireRole('admin');
const leaders = requireRole('admin', 'floor_manager', 'team_leader');

/* ---- /api/projects ---- */
const projects = express.Router();
projects.get('/', leaders, asyncHandler(async (req, res) => ok(res, await svc.listProjects())));
projects.post('/', admin, asyncHandler(async (req, res) => ok(res, await svc.createProject(req.user, validate(req.body, { name: r.string({ min: 1, max: 120 }), description: r.string({ max: 1000, optional: true, allowEmpty: true }) })), undefined, 201)));
projects.get('/:id/tracks', leaders, asyncHandler(async (req, res) => ok(res, await svc.listTracks(req.params.id))));

function uploader() {
  const cfg = getConfig().storage;
  return multer({
    storage: multer.diskStorage({ destination: (_q, _f, cb) => cb(null, storage.tmpDir()), filename: (_q, _f, cb) => cb(null, `${crypto.randomUUID()}.part`) }),
    limits: { fileSize: cfg.maxFileBytes, files: cfg.maxBatch },   // original: 100 files per batch, 400 MB each
  }).fields([{ name: 'files', maxCount: cfg.maxBatch }, { name: 'file', maxCount: cfg.maxBatch }]);
}
let up;
projects.post('/:id/tracks', admin, rl.upload, (req, res, next) => { up = up || uploader(); up(req, res, next); }, asyncHandler(async (req, res) => {
  const files = [...(req.files?.files || []), ...(req.files?.file || [])];
  if (!files.length) throw new AppError(400, 'NO_FILES', 'No MP3 files were attached.');
  if (files.length > getConfig().storage.maxBatch) { await Promise.all(files.map((f) => storage.discard(f.path))); throw new AppError(400, 'BATCH_TOO_LARGE', `Upload at most ${getConfig().storage.maxBatch} MP3 files at a time.`); }
  let clientDurations = {};
  try { if (req.body?.durations) clientDurations = typeof req.body.durations === 'string' ? JSON.parse(req.body.durations) : req.body.durations; } catch {}
  ok(res, await svc.ingestUploads(req.user, req.params.id, files, clientDurations), undefined, 201);
}));

/* ---- /api/audio ---- */
const audio = express.Router();
audio.get('/all-tracks', leaders, asyncHandler(async (req, res) => ok(res, await svc.listAllTracks(req.user))));
audio.delete('/tracks/:id', leaders, asyncHandler(async (req, res) => ok(res, await svc.deleteTrack(req.user, req.params.id))));
audio.patch('/tracks/:id/duration', leaders, asyncHandler(async (req, res) => ok(res, await svc.updateTrackDuration(req.user, req.params.id, validate(req.body, { duration: r.number({ min: 1, max: 86400 }) }).duration))));
audio.get('/assigned', asyncHandler(async (req, res) => ok(res, await svc.assignedFor(req.user))));
audio.get('/work-history', asyncHandler(async (req, res) => ok(res, await svc.myWorkHistory(req.user))));
audio.post('/assign', leaders, asyncHandler(async (req, res) => ok(res, await svc.assign(req.user, validate(req.body, { trackIds: r.idList({ min: 1, max: 500 }), assigneeIds: r.idList({ min: 1, max: 500 }), deadline: r.dateTime({ optional: true }) })))));

/* ---- /api/audio/assignments: tracking dashboard + review ---- */
audio.get('/assignments/summary', leaders, asyncHandler(async (req, res) => ok(res, await svc.assignmentsSummary(req.user))));
audio.get('/assignments', leaders, asyncHandler(async (req, res) => { const out = await svc.listAssignments(req.user, req.query); ok(res, out.data, out.meta); }));
audio.get('/assignments/:id', asyncHandler(async (req, res) => ok(res, await svc.getAssignment(req.user, req.params.id))));
audio.patch('/assignments/:id/reassign', leaders, asyncHandler(async (req, res) => ok(res, await svc.reassignAssignment(req.user, req.params.id, validate(req.body, { assigneeId: r.objectId() }).assigneeId))));
audio.delete('/assignments/:id', leaders, asyncHandler(async (req, res) => ok(res, await svc.removeAssignment(req.user, req.params.id))));
audio.post('/assignments/:id/submit', asyncHandler(async (req, res) => ok(res, await svc.submitTranslation(req.user, req.params.id))));
audio.post('/assignments/:id/review', leaders, asyncHandler(async (req, res) => ok(res, await svc.reviewAssignment(req.user, req.params.id, validate(req.body, { decision: r.oneOf(['approve', 'revise']), feedback: r.string({ max: 2000, optional: true, allowEmpty: true }) })))));

audio.get('/:id/stream', asyncHandler(async (req, res) => {
  const track = await svc.authorizeTrack(req.user, req.params.id);          // 404 unless admin/FM/TL or assigned employee
  let st; try { st = await storage.stat(track.storageKey); } catch { throw new AppError(404, 'FILE_MISSING', 'Audio file is missing from storage.'); }
  const range = parseRange(req.headers.range, st.size);
  res.set({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  if (range === 'invalid') { res.set('Content-Range', `bytes */${st.size}`); return res.status(416).end(); }
  if (!range) { res.set('Content-Length', String(st.size)); return pipe(storage.stream(track.storageKey), res); }
  res.status(206).set({ 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': String(range.end - range.start + 1) });
  return pipe(storage.stream(track.storageKey, { start: range.start, end: range.end }), res);
}));
function pipe(stream, res) {
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());          // client seeked/aborted: release the file handle
  stream.pipe(res);
}

/* ---- /api/notebooks ---- */
const notebooks = express.Router();
notebooks.get('/:trackId', asyncHandler(async (req, res) => ok(res, await svc.getNote(req.user, req.params.trackId))));
notebooks.put('/:trackId', asyncHandler(async (req, res) => ok(res, await svc.saveNote(req.user, req.params.trackId, validate(req.body, { text: r.string({ max: 100000, allowEmpty: true, optional: true, trim: false }) }).text || ''))));

module.exports = { projects, audio, notebooks };
