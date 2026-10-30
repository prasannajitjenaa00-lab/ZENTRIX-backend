'use strict';
const mongoose = require('mongoose');
const { Project, AudioTrack, TrackAssignment, NotebookEntry, User, Task } = require('../models');
const storage = require('./storage');
const dto = require('./dto');
const H = require('../policy/hierarchy');
const { loadRoster, audienceFor } = require('./roster');
const activity = require('./activity');
const { emit } = require('./realtime');
const { AppError, bad, forbidden, notFound, conflict } = require('../utils/errors');
const { looksLikeMp3, safeMp3Name, estimateDuration } = require('../utils/mp3');
const { parsePage, pageMeta } = require('../utils/pagination');
const { validateTranscriptRules } = require('../utils/transcriptRules');

const isId = (s) => mongoose.isValidObjectId(s);
const oid = (s) => new mongoose.Types.ObjectId(String(s));
const LOCKED = new Set(['submitted', 'reviewed']);

/* ---------- projects ---------- */
async function createProject(actor, { name, description }) {
  const p = await Project.create({ name, description: description || '', createdBy: actor._id });
  await activity.log(`${actor.name} opened project “${p.name}”.`, { actor: actor._id, type: 'project', rooms: ['admin'] });
  return dto.project(p);
}
async function listProjects() {
  const [projects, counts] = await Promise.all([Project.find().sort({ createdAt: -1 }).lean(), AudioTrack.aggregate([{ $group: { _id: '$project', n: { $sum: 1 } } }])]);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  return projects.map((p) => ({ ...dto.project(p), trackCount: n.get(String(p._id)) || 0 }));
}
async function listTracks(projectId) {
  if (!isId(projectId) || !(await Project.exists({ _id: projectId }))) throw notFound('Project not found.');
  const tracks = await AudioTrack.find({ project: projectId }).sort({ createdAt: 1 }).lean();
  const counts = await TrackAssignment.aggregate([{ $match: { track: { $in: tracks.map((t) => t._id) } } }, { $group: { _id: '$track', n: { $sum: 1 } } }]);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  return tracks.map((t) => ({ ...dto.track(t), assignedCount: n.get(String(t._id)) || 0 }));
}

/* ---------- upload (files already on disk in tmp via multer) ---------- */
async function ingestUploads(actor, projectId, files, clientDurations = {}) {
  const project = isId(projectId) ? await Project.findById(projectId) : null;
  if (!project) { await Promise.all(files.map((f) => storage.discard(f.path))); throw notFound('Choose a project section first.'); }
  const tracks = []; const rejected = [];
  for (const f of files) {
    try {
      // Extension and browser MIME are NOT trusted: inspect the bytes.
      const head = await storage.readHead(f.path, 131072);
      if (!looksLikeMp3(head)) { rejected.push({ name: safeMp3Name(f.originalname), reason: 'Not a valid MP3 file.' }); await storage.discard(f.path); continue; }
      let duration = null;
      if (clientDurations && typeof clientDurations[f.originalname] === 'number' && clientDurations[f.originalname] > 0) {
        duration = Math.round(clientDurations[f.originalname]);
      } else {
        duration = estimateDuration(head, f.size);
      }
      const { key, sha256 } = await storage.put(f.path);
      const t = await AudioTrack.create({ project: project._id, originalName: safeMp3Name(f.originalname), storageKey: key, size: f.size, mime: 'audio/mpeg', duration, sha256, uploadedBy: actor._id });
      tracks.push(t);
    } catch (e) { rejected.push({ name: safeMp3Name(f.originalname), reason: 'Could not store this file.' }); await storage.discard(f.path); }
  }
  if (!tracks.length) throw new AppError(400, 'NO_VALID_FILES', 'Only MP3 files can be uploaded to a project.', { rejected });
  await activity.log(tracks.length === 1 ? `${actor.name} uploaded “${tracks[0].originalName}” to “${project.name}”.` : `${actor.name} uploaded ${tracks.length} MP3 files to “${project.name}”.`, { actor: actor._id, type: 'audio', rooms: ['admin'] });
  return { tracks: tracks.map(dto.track), rejected, project: dto.project(project) };
}

/* ---------- authorization + streaming ---------- */
async function authorizeTrack(viewer, trackId) {
  if (!isId(trackId)) throw notFound();
  const track = await AudioTrack.findById(trackId);
  if (!track) throw notFound();
  if (H.canViewProjects(dto.toPlain(viewer))) return track;           // admin / floor manager / team leader (original: all projects visible)
  if (await TrackAssignment.exists({ track: track._id, assignee: viewer._id })) return track;
  throw notFound();                                                    // employees: only assigned tracks; 404 hides existence
}

/* ---------- assignments: create ---------- */
async function assign(actor, { trackIds, assigneeIds, deadline }) {
  const roster = await loadRoster(); const me = dto.toPlain(actor);
  if (!H.canAssignWork(me)) throw forbidden();
  const bads = assigneeIds.filter((id) => !H.canAssignTrackTo(roster, me, id));
  if (bads.length) throw forbidden('Some employees are outside your scope or inactive.');
  if (me.role !== 'admin') {
    const missingLeader = assigneeIds.map((id) => roster.find((u) => u.id === id)).filter((e) => !e.leaderId);
    if (missingLeader.length) throw bad(`${missingLeader[0].name} is not under a team leader. Assign a leader first.`);
  }
  const tracks = await AudioTrack.find({ _id: { $in: trackIds } }).select('project').lean();
  if (tracks.length !== trackIds.length) throw notFound('One or more tracks no longer exist.');
  const docs = [];
  for (const t of tracks) for (const a of assigneeIds) docs.push({ track: t._id, project: t.project, assignee: a, assignedBy: actor._id, assignedAt: new Date(), deadline: deadline || null, status: 'assigned' });
  const existing = await TrackAssignment.find({ track: { $in: tracks.map((t) => t._id) }, assignee: { $in: assigneeIds } }).select('track assignee').lean();
  const have = new Set(existing.map((e) => `${e.track}:${e.assignee}`));
  const fresh = docs.filter((d) => !have.has(`${d.track}:${d.assignee}`));
  let added = fresh.length;
  if (fresh.length) {
    try { await TrackAssignment.insertMany(fresh, { ordered: false }); }
    catch (e) {   // a concurrent request may have inserted the same pair; the unique index makes that harmless
      if (e.code !== 11000 && !e.writeErrors) throw e;
      added = fresh.length - (e.writeErrors?.length || 0);
    }
  }
  const newly = new Set(fresh.map((d) => String(d.assignee)));
  if (added) await activity.log(`${actor.name} assigned ${trackIds.length} MP3${trackIds.length === 1 ? '' : 's'} to ${assigneeIds.length} employee${assigneeIds.length === 1 ? '' : 's'}.`, { actor: actor._id, involved: assigneeIds, type: 'audio', rooms: ['admin'] });
  for (const id of newly) emit([`user:${id}`], 'track:assigned', { count: added });
  return { added, alreadyAssigned: docs.length - added };
}

// Sequential 1-by-1 queue for employees:
// When admin assigns multiple audios, an employee only sees completed audios
// plus at most ONE active audio to work on. Future queued audios stay hidden.
function filterEmployeeQueue(assignments) {
  const completed = [];
  const pendingQueue = [];

  for (const a of assignments) {
    const isDone = Boolean(a.submittedAt && ['submitted', 'approved', 'reviewed', 'pending'].includes(a.status));
    if (isDone) {
      completed.push(a);
    } else {
      pendingQueue.push(a);
    }
  }

  pendingQueue.sort((x, y) => {
    const isRevX = x.status === 'revision_requested' || x.status === 'revision' ? 0 : 1;
    const isRevY = y.status === 'revision_requested' || y.status === 'revision' ? 0 : 1;
    return isRevX - isRevY;
  });

  const active = pendingQueue.length > 0 ? [pendingQueue[0]] : [];
  return [...completed, ...active];
}

async function assignedFor(viewer) {
  let asg = await TrackAssignment.find({ assignee: viewer._id }).sort({ assignedAt: 1, _id: 1 }).lean();
  if (viewer.role === 'employee') {
    asg = filterEmployeeQueue(asg);
  }
  const [tracks, notes, projects] = await Promise.all([
    AudioTrack.find({ _id: { $in: asg.map((a) => a.track) } }).lean(), NotebookEntry.find({ user: viewer._id }).lean(), Project.find({ _id: { $in: asg.map((a) => a.project) } }).lean(),
  ]);
  return asg.map((a) => {
    const t = tracks.find((x) => String(x._id) === String(a.track)); if (!t) return null;
    const note = notes.find((n) => String(n.track) === String(a.track));
    return {
      assignmentId: String(a._id), assignedAt: a.assignedAt, deadline: a.deadline || null, status: a.status,
      displayStatus: dto.displayStatusOf(a), overdue: dto.overdueOf(a), reviewFeedback: a.reviewFeedback || '',
      track: dto.track(t), projectName: projects.find((p) => String(p._id) === String(a.project))?.name || 'Project',
      notes: note?.text || '', notesUpdatedAt: note?.updatedAt || null, version: note?.version || 0, history: note?.history || [],
    };
  }).filter(Boolean);
}

/* ---------- scoping for the tracking dashboard / review ---------- */
async function scopedAssigneeIds(actor) {
  const me = dto.toPlain(actor);
  if (!H.canAssignWork(me)) throw forbidden();
  const roster = await loadRoster();
  return H.visibleAssigneeIds(roster, me);
}

async function listAssignments(actor, query = {}) {
  const ids = await scopedAssigneeIds(actor);
  const pg = parsePage(query, { defaultLimit: 50, maxLimit: 200 });
  const and = [];
  if (ids !== H.ALL) and.push({ assignee: { $in: [...ids].map(oid) } });
  if (query.employee && /^[a-f0-9]{24}$/i.test(String(query.employee))) and.push({ assignee: oid(query.employee) });
  if (query.status === 'overdue') and.push({ deadline: { $lt: new Date() }, status: { $nin: ['submitted', 'reviewed'] } });
  else if (query.status) and.push({ status: String(query.status) });
  const from = query.from && new Date(query.from); const to = query.to && new Date(query.to);
  if (from && !Number.isNaN(from.getTime())) and.push({ assignedAt: { $gte: from } });
  if (to && !Number.isNaN(to.getTime())) and.push({ assignedAt: { $lte: to } });
  const filter = and.length ? { $and: and } : {};
  const [rows, total] = await Promise.all([
    TrackAssignment.find(filter).sort({ assignedAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    TrackAssignment.countDocuments(filter),
  ]);
  const [tracks, employees, notes] = await Promise.all([
    AudioTrack.find({ _id: { $in: rows.map((a) => a.track) } }).lean(),
    User.find({ _id: { $in: rows.map((a) => a.assignee) } }).select('name email').lean(),
    NotebookEntry.find({ track: { $in: rows.map((a) => a.track) }, user: { $in: rows.map((a) => a.assignee) } }).lean(),
  ]);
  const data = rows.map((a) => {
    const t = tracks.find((x) => String(x._id) === String(a.track));
    const e = employees.find((x) => String(x._id) === String(a.assignee));
    const note = notes.find((n) => String(n.track) === String(a.track) && String(n.user) === String(a.assignee));
    return dto.assignment(a, { track: t ? dto.track(t) : null, employeeName: e?.name || 'Former employee', text: note?.text || '', submittedText: note?.submittedText || '', version: note?.version || 0 });
  });
  return { data, meta: pageMeta(pg, total) };
}

async function getAssignment(actor, id) {
  if (!isId(id)) throw notFound();
  const a = await TrackAssignment.findById(id).lean();
  if (!a) throw notFound();
  const me = dto.toPlain(actor);
  const owner = String(a.assignee) === String(actor._id);
  if (!owner) {
    if (!H.canAssignWork(me)) throw forbidden();
    const ids = await scopedAssigneeIds(actor);
    if (ids !== H.ALL && !ids.has(String(a.assignee))) throw notFound();
  }
  const [t, e, note] = await Promise.all([AudioTrack.findById(a.track).lean(), User.findById(a.assignee).select('name email').lean(), NotebookEntry.findOne({ track: a.track, user: a.assignee }).lean()]);
  return dto.assignment(a, { track: t ? dto.track(t) : null, employeeName: e?.name || 'Former employee', text: note?.text || '', submittedText: note?.submittedText || '', version: note?.version || 0, history: note?.history || [] });
}

/* ---------- reassign / remove (pre-submission only) ---------- */
async function reassignAssignment(actor, id, assigneeId) {
  const me = dto.toPlain(actor);
  if (!H.canAssignWork(me)) throw forbidden();
  if (!isId(id)) throw notFound();
  const a = await TrackAssignment.findById(id);
  if (!a) throw notFound();
  const roster = await loadRoster();
  if (!H.canAssignTrackTo(roster, me, String(a.assignee)) && me.role !== 'admin') throw forbidden();   // must currently manage the existing assignee (scope check)
  if (LOCKED.has(a.status)) throw conflict('This translation has already been submitted and cannot be reassigned.', 'ASSIGNMENT_LOCKED');
  if (!H.canAssignTrackTo(roster, me, assigneeId)) throw forbidden('That employee is outside your scope or inactive.');
  const newEmployee = roster.find((u) => u.id === assigneeId);
  if (me.role !== 'admin' && !newEmployee?.leaderId) throw bad(`${newEmployee?.name || 'That employee'} is not under a team leader. Assign a leader first.`);
  if (await TrackAssignment.exists({ track: a.track, assignee: assigneeId, _id: { $ne: a._id } })) throw conflict('That employee already has this MP3 assigned.', 'DUPLICATE_ASSIGNMENT');
  const prevAssignee = String(a.assignee);
  a.assignee = assigneeId; a.assignedBy = actor._id; a.assignedAt = new Date(); a.status = 'assigned'; a.startedAt = null; a.submittedAt = null; a.reviewedAt = null; a.reviewedBy = null; a.reviewFeedback = '';
  await a.save();
  await activity.log(`${actor.name} reassigned an MP3 to ${newEmployee.name}.`, { actor: actor._id, involved: [prevAssignee, assigneeId], type: 'audio' });
  emit([`user:${assigneeId}`], 'track:assigned', { count: 1 });
  return dto.assignment(a.toObject());
}

async function removeAssignment(actor, id) {
  const me = dto.toPlain(actor);
  if (!H.canAssignWork(me)) throw forbidden();
  if (!isId(id)) throw notFound();
  const a = await TrackAssignment.findById(id);
  if (!a) throw notFound();
  const roster = await loadRoster();
  if (me.role !== 'admin' && !H.canAssignTrackTo(roster, me, String(a.assignee))) throw forbidden();
  if (LOCKED.has(a.status)) throw conflict('This translation has already been submitted and cannot be removed.', 'ASSIGNMENT_LOCKED');
  await a.deleteOne();
  await activity.log(`${actor.name} removed an audio assignment.`, { actor: actor._id, involved: [String(a.assignee)], type: 'audio', rooms: ['admin', `user:${a.assignee}`] });
  return { deleted: true };
}

/* ---------- notebook / translation (owner-only) ---------- */
async function getNote(viewer, trackId) {
  if (!isId(trackId)) throw notFound('That MP3 is no longer available.');
  const asg = await TrackAssignment.findOne({ track: trackId, assignee: viewer._id }).lean();
  if (!asg) throw notFound('That MP3 is no longer available.');
  const n = await NotebookEntry.findOne({ user: viewer._id, track: trackId }).lean();
  return {
    trackId, text: n?.text || '', updatedAt: n?.updatedAt || null, version: n?.version || 0, submittedAt: n?.submittedAt || null,
    history: n?.history || [], status: asg.status, locked: false, reviewFeedback: asg.reviewFeedback || '',
  };
}
async function saveNote(viewer, trackId, text) {
  if (!isId(trackId)) throw notFound();
  const asg = await TrackAssignment.findOne({ track: trackId, assignee: viewer._id });
  if (!asg) throw notFound('That MP3 is no longer available.');
  const clean = text.trim();
  const prev = await NotebookEntry.findOne({ user: viewer._id, track: trackId }).lean();
  const n = await NotebookEntry.findOneAndUpdate({ user: viewer._id, track: trackId }, { $set: { text: clean, updatedAt: new Date() } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  if (asg.status === 'assigned' && clean) { asg.status = 'in_progress'; asg.startedAt = asg.startedAt || new Date(); await asg.save(); }
  const track = await AudioTrack.findById(trackId).select('originalName').lean();
  if (clean && clean !== prev?.text) {
    await activity.log(`${viewer.name} updated the translation draft for ${track?.originalName || 'an assigned MP3'}.`, { actor: viewer._id, type: 'notebook', rooms: ['admin'] });
  }
  return { trackId, text: n.text, updatedAt: n.updatedAt, status: asg.status };
}

/** Employee submits the current draft as the translation. */
async function submitTranslation(viewer, assignmentId) {
  if (!isId(assignmentId)) throw notFound();
  const asg = await TrackAssignment.findOne({ _id: assignmentId, assignee: viewer._id });
  if (!asg) throw notFound('That assignment is no longer available.');
  const n = await NotebookEntry.findOne({ user: viewer._id, track: asg.track });
  const text = (n?.text || '').trim();
  if (!text) throw bad('Write your translation before submitting.');
  const now = new Date(); const version = (n.version || 0) + 1;
  n.history = [...(n.history || []), { text, version, submittedAt: now }].slice(-5);
  n.version = version; n.submittedAt = now; n.submittedText = text; n.text = text;
  await n.save();

  // Validate all 6 transcription rules:
  const validation = validateTranscriptRules(text);
  const passedAllRules = validation.passed;

  // Automatic approval if ALL rules pass, otherwise pending
  asg.status = passedAllRules ? 'approved' : 'pending';
  asg.submittedAt = now;
  asg.reviewFeedback = validation.feedback;
  await asg.save();

  const track = await AudioTrack.findById(asg.track).select('originalName project').lean();
  const proj = track?.project ? await Project.findById(track.project).select('name').lean() : null;

  // Update any matching Task in Task collection for this employee
  const targetTaskStatus = passedAllRules ? 'Approved' : 'Pending';
  const targetTaskProgress = passedAllRules ? 100 : 50;

  const rxTrack = track?.originalName ? new RegExp(track.originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const rxProj = proj?.name ? new RegExp(proj.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

  const taskFilter = {
    assignee: viewer._id,
    $or: [
      { notes: { $regex: String(asg._id) } },
      { notes: { $regex: String(asg.track) } },
      ...(rxTrack ? [{ title: rxTrack }, { description: rxTrack }] : []),
      ...(rxProj ? [{ title: rxProj }, { category: rxProj }] : []),
    ],
  };

  const matchedTasks = await Task.find(taskFilter);
  for (const t of matchedTasks) {
    t.status = targetTaskStatus;
    t.progress = targetTaskProgress;
    t.updatedAt = now;
    await t.save();
    emit(audienceFor(viewer), 'task:updated', { task: dto.task(t), reassigned: false });
  }

  const verb = passedAllRules ? 'submitted and auto-approved' : 'submitted (pending)';
  await activity.log(`${viewer.name} ${verb} a translation for ${track?.originalName || 'an assigned MP3'}.`, { actor: viewer._id, type: 'notebook', rooms: ['admin', `user:${viewer._id}`] });
  return dto.assignment(asg.toObject(), { version, submittedText: text, passedAllRules, taskStatus: targetTaskStatus });
}

/** Admin/leader reviews a submitted translation. */
async function reviewAssignment(actor, assignmentId, { decision, feedback }) {
  const me = dto.toPlain(actor);
  if (!H.canAssignWork(me)) throw forbidden();
  if (!isId(assignmentId)) throw notFound();
  const asg = await TrackAssignment.findById(assignmentId);
  if (!asg) throw notFound();
  if (me.role !== 'admin') {
    const roster = await loadRoster();
    if (!H.canAssignTrackTo(roster, me, String(asg.assignee))) throw forbidden();
  }
  if (!['submitted', 'pending', 'approved'].includes(asg.status)) throw conflict('Only a submitted translation can be reviewed.', 'NOT_SUBMITTED');
  if (decision === 'revise' && !feedback?.trim()) throw bad('Explain what needs correcting before requesting a revision.');
  asg.status = decision === 'approve' ? 'reviewed' : 'revision_requested';
  asg.reviewedAt = new Date(); asg.reviewedBy = actor._id; asg.reviewFeedback = decision === 'revise' ? feedback.trim() : '';
  await asg.save();
  const track = await AudioTrack.findById(asg.track).select('originalName').lean();
  const verb = decision === 'approve' ? 'approved' : 'requested a revision on';
  await activity.log(`${actor.name} ${verb} the translation for ${track?.originalName || 'an MP3'}.`, { actor: actor._id, involved: [String(asg.assignee)], type: 'notebook' });
  return dto.assignment(asg.toObject());
}


async function listAllTracks(actor) {
  const [tracks, projects, assignments, users] = await Promise.all([
    AudioTrack.find().sort({ createdAt: -1 }).lean(),
    Project.find().select('name').lean(),
    TrackAssignment.find().select('track assignee status assignedAt').lean(),
    User.find().select('name email').lean(),
  ]);

  const pMap = new Map(projects.map((p) => [String(p._id), p.name]));
  const uMap = new Map(users.map((u) => [String(u._id), u.name]));

  return tracks.map((t) => {
    const asgs = assignments.filter((a) => String(a.track) === String(t._id));
    return {
      ...dto.track(t),
      project: String(t.project),
      projectName: pMap.get(String(t.project)) || 'Project',
      isAssigned: asgs.length > 0,
      assignedCount: asgs.length,
      assignments: asgs.map((a) => ({
        id: String(a._id),
        assigneeId: String(a.assignee),
        assigneeName: uMap.get(String(a.assignee)) || 'Employee',
        status: a.status,
        assignedAt: a.assignedAt,
      })),
    };
  });
}

async function updateTrackDuration(actor, trackId, duration) {
  if (!isId(trackId)) throw notFound('Track not found.');
  const dur = Math.round(Number(duration));
  if (!dur || dur <= 0) throw bad('Invalid duration.');
  const t = await AudioTrack.findByIdAndUpdate(trackId, { duration: dur }, { new: true });
  if (!t) throw notFound('Track not found.');
  return dto.track(t);
}

async function deleteTrack(actor, trackId) {
  if (!isId(trackId)) throw notFound('Track not found.');
  const track = await AudioTrack.findById(trackId);
  if (!track) throw notFound('Track not found.');

  await Promise.all([
    AudioTrack.deleteOne({ _id: track._id }),
    TrackAssignment.deleteMany({ track: track._id }),
    NotebookEntry.deleteMany({ track: track._id }),
  ]);

  try {
    if (track.storageKey) await storage.discard(track.storageKey);
  } catch (e) {
    // Ignore if file missing from disk
  }

  await activity.log(`${actor.name} deleted audio track "${track.originalName}".`, {
    actor: actor._id,
    type: 'audio',
    rooms: ['admin'],
  });

  return { deleted: true };
}

async function assignmentsSummary(actor) {
  const ids = await scopedAssigneeIds(actor);
  const match = ids === H.ALL ? {} : { assignee: { $in: [...ids].map(oid) } };

  const employees = await User.find({ role: 'employee' }).select('name email legacyId status').sort({ name: 1 }).lean();
  const assignments = await TrackAssignment.find(match).populate('track', 'duration size sha256 storageKey originalName').lean();

  const DONE_STATUSES = new Set(['submitted', 'reviewed', 'approved']);

  const map = new Map();
  for (const emp of employees) {
    map.set(String(emp._id), {
      id: String(emp._id),
      name: emp.name,
      email: emp.email,
      legacyId: emp.legacyId || null,
      totalAudioGiven: 0,
      totalAudioDone: 0,
      totalDurationGivenSec: 0,
      totalDurationDoneSec: 0,
    });
  }

  const seenGiven = new Map();
  const seenDone = new Map();

  for (const a of assignments) {
    const empId = String(a.assignee);
    let row = map.get(empId);
    if (!row) {
      row = {
        id: empId,
        name: 'Employee',
        email: 'employee@pulse.test',
        legacyId: null,
        totalAudioGiven: 0,
        totalAudioDone: 0,
        totalDurationGivenSec: 0,
        totalDurationDoneSec: 0,
      };
      map.set(empId, row);
    }
    let dur = 0;
    if (a.track) {
      if (typeof a.track.duration === 'number' && a.track.duration > 0) {
        dur = a.track.duration;
      } else if (a.track.size && a.track.size > 0) {
        dur = Math.round(a.track.size / 24000);
      } else {
        dur = 30;
      }
    }
    row.totalAudioGiven += 1;
    if (!seenGiven.has(empId)) seenGiven.set(empId, new Set());
    if (!seenDone.has(empId)) seenDone.set(empId, new Set());
    const t = a.track;
    const trackKey = t?.sha256 || t?.storageKey || (t?.size ? `${t.size}_${t.duration}` : String(t?._id || a.track));
    if (!seenGiven.get(empId).has(trackKey)) {
      seenGiven.get(empId).add(trackKey);
      row.totalDurationGivenSec += dur;
    }
    if (DONE_STATUSES.has(a.status)) {
      row.totalAudioDone += 1;
      if (!seenDone.get(empId).has(trackKey)) {
        seenDone.get(empId).add(trackKey);
        row.totalDurationDoneSec += dur;
      }
    }
  }

  return [...map.values()];
}


async function myWorkHistory(viewer) {
  const asgs = await TrackAssignment.find({ assignee: viewer._id }).sort({ submittedAt: -1, assignedAt: -1, _id: -1 }).lean();
  const trackIds = asgs.map((a) => a.track);
  const [tracks, notes, projects] = await Promise.all([
    AudioTrack.find({ _id: { $in: trackIds } }).lean(),
    NotebookEntry.find({ user: viewer._id, track: { $in: trackIds } }).lean(),
    Project.find({ _id: { $in: asgs.map((a) => a.project) } }).lean(),
  ]);

  const trackMap = new Map(tracks.map((t) => [String(t._id), t]));
  const noteMap = new Map(notes.map((n) => [String(n.track), n]));
  const projMap = new Map(projects.map((p) => [String(p._id), p.name]));

  const submitted = asgs.filter(
    (a) => a.submittedAt || ['submitted', 'approved', 'reviewed', 'pending', 'revision_requested', 'revision'].includes(a.status)
  );

  return submitted.map((a) => {
    const t = trackMap.get(String(a.track));
    const n = noteMap.get(String(a.track));
    const durSec = t?.duration || (t?.size ? Math.round(t.size / 24000) : 180);
    const dateObj = a.submittedAt || a.assignedAt || new Date();

    let statusText = 'Pending';
    if (a.status === 'approved' || a.status === 'reviewed') statusText = 'Approved';
    else if (a.status === 'revision_requested' || a.status === 'revision') statusText = 'Revision';
    else statusText = 'Pending';

    return {
      id: String(a._id),
      assignmentId: String(a._id),
      trackId: String(a.track),
      trackName: t?.originalName || 'Audio Track',
      track: t ? dto.track(t) : null,
      projectName: projMap.get(String(a.project)) || 'Project',
      text: (n?.submittedText || n?.text || '').trim(),
      durationSec: durSec,
      status: statusText,
      rawStatus: a.status,
      date: dateObj,
      submittedAt: dateObj,
      reviewFeedback: a.reviewFeedback || '',
    };
  });
}

module.exports = {
  myWorkHistory,
  filterEmployeeQueue,
  listAllTracks,
  deleteTrack,
  updateTrackDuration,
  assignmentsSummary,
  createProject, listProjects, listTracks, ingestUploads, authorizeTrack, assign, assignedFor, getNote, saveNote,
  listAssignments, getAssignment, reassignAssignment, removeAssignment, submitTranslation, reviewAssignment,
};