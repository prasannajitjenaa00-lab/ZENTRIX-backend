'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let org; let A; let FM; let TLA; let TLB; let E_A1; let E_A2; let E_B1; let project;
test.before(async () => {
  await H.boot(); org = await H.seedOrg();
  [A, FM, TLA, TLB, E_A1, E_A2, E_B1] = await Promise.all(['admin', 'fm', 'tla', 'tlb', 'a1', 'a2', 'b1'].map((n) => H.login(`${n}@t.io`)));
  project = (await H.call(A, 'post', '/api/projects', { name: 'Translation set' })).body.data;
});
test.after(() => H.shutdown());

const upload = async (n = 1) => {
  let r = A.post(`/api/projects/${project.id}/tracks`).set('X-Pulse-Client', '1').set('Origin', H.ORIGIN);
  for (let i = 0; i < n; i++) r = r.attach('files', H.mp3Buffer(), `t-${Date.now()}-${i}.mp3`);
  return (await r).body.data.tracks;
};
const past = () => new Date(Date.now() - 86400e3).toISOString();
const future = () => new Date(Date.now() + 86400e3).toISOString();

test('assign accepts a deadline; it is visible to the employee and on the tracking dashboard', async () => {
  const [t] = await upload();
  const dl = future();
  const r = await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id)], deadline: dl });
  assert.equal(r.status, 200); assert.equal(r.body.data.added, 1);
  const mine = (await H.call(E_A1, 'get', '/api/audio/assigned')).body.data.find((x) => x.track.id === t.id);
  assert.equal(mine.status, 'assigned'); assert.equal(mine.displayStatus, 'Pending'); assert.equal(mine.overdue, false);
  assert.equal(new Date(mine.deadline).toISOString(), new Date(dl).toISOString());
  const dash = (await H.call(A, 'get', '/api/audio/assignments')).body.data;
  assert.ok(dash.some((a) => a.trackId === t.id && a.employeeId === String(org.a1._id)));
});

test('draft save moves assigned -> in_progress; submit locks it; further draft saves are rejected', async () => {
  const [t] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a2._id)] });
  const afterDraft = await H.call(E_A2, 'put', `/api/notebooks/${t.id}`, { text: 'hello there' });
  assert.equal(afterDraft.status, 200); assert.equal(afterDraft.body.data.status, 'in_progress');

  const noSubmit = await H.call(E_A2, 'post', `/api/audio/assignments/doesnotexist000/submit`);
  assert.equal(noSubmit.status, 404);

  const asg = (await H.call(E_A2, 'get', '/api/audio/assigned')).body.data.find((x) => x.track.id === t.id);
  const submitted = await H.call(E_A2, 'post', `/api/audio/assignments/${asg.assignmentId}/submit`);
  assert.equal(submitted.status, 200); assert.equal(submitted.body.data.status, 'submitted'); assert.equal(submitted.body.data.version, 1);

  const blocked = await H.call(E_A2, 'put', `/api/notebooks/${t.id}`, { text: 'edit after submit' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'TRANSLATION_LOCKED');

  const reSubmit = await H.call(E_A2, 'post', `/api/audio/assignments/${asg.assignmentId}/submit`);
  assert.equal(reSubmit.status, 409); assert.equal(reSubmit.body.error.code, 'TRANSLATION_LOCKED');
});

test('submit requires non-empty text', async () => {
  const [t] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id)] });
  const asg = (await H.call(E_A1, 'get', '/api/audio/assigned')).body.data.find((x) => x.track.id === t.id);
  const r = await H.call(E_A1, 'post', `/api/audio/assignments/${asg.assignmentId}/submit`);
  assert.equal(r.status, 400);
});

test('review: approve completes it; revise requires feedback and reopens editing', async () => {
  const [t] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id)] });
  let asg = (await H.call(E_A1, 'get', '/api/audio/assigned')).body.data.find((x) => x.track.id === t.id);
  await H.call(E_A1, 'put', `/api/notebooks/${t.id}`, { text: 'I heard good morning' });
  await H.call(E_A1, 'post', `/api/audio/assignments/${asg.assignmentId}/submit`);

  const noFeedback = await H.call(TLA, 'post', `/api/audio/assignments/${asg.assignmentId}/review`, { decision: 'revise' });
  assert.equal(noFeedback.status, 400);

  const approved = await H.call(TLA, 'post', `/api/audio/assignments/${asg.assignmentId}/review`, { decision: 'approve' });
  assert.equal(approved.status, 200); assert.equal(approved.body.data.status, 'reviewed');

  const again = await H.call(TLA, 'post', `/api/audio/assignments/${asg.assignmentId}/review`, { decision: 'approve' });
  assert.equal(again.status, 409); assert.equal(again.body.error.code, 'NOT_SUBMITTED');

  // second track: request a revision, then confirm the employee can edit and resubmit
  const [t2] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t2.id], assigneeIds: [String(org.a1._id)] });
  asg = (await H.call(E_A1, 'get', '/api/audio/assigned')).body.data.find((x) => x.track.id === t2.id);
  await H.call(E_A1, 'put', `/api/notebooks/${t2.id}`, { text: 'first attempt' });
  await H.call(E_A1, 'post', `/api/audio/assignments/${asg.assignmentId}/submit`);
  const revised = await H.call(TLA, 'post', `/api/audio/assignments/${asg.assignmentId}/review`, { decision: 'revise', feedback: 'Please re-check the ending.' });
  assert.equal(revised.status, 200); assert.equal(revised.body.data.status, 'revision_requested');
  const edited = await H.call(E_A1, 'put', `/api/notebooks/${t2.id}`, { text: 'fixed attempt' });
  assert.equal(edited.status, 200); assert.equal(edited.body.data.status, 'revision_requested');   // editing doesn't change status
  const note = await H.call(E_A1, 'get', `/api/notebooks/${t2.id}`);
  assert.equal(note.body.data.reviewFeedback, 'Please re-check the ending.');
  const resubmitted = await H.call(E_A1, 'post', `/api/audio/assignments/${asg.assignmentId}/submit`);
  assert.equal(resubmitted.status, 200); assert.equal(resubmitted.body.data.status, 'submitted'); assert.equal(resubmitted.body.data.version, 2);
});

test('reassign: scope enforced, blocked once submitted, duplicate target rejected', async () => {
  const [t] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id), String(org.a2._id)] });
  const list = (await H.call(A, 'get', '/api/audio/assignments', undefined)).body.data;
  const asgA1 = list.find((x) => x.trackId === t.id && x.employeeId === String(org.a1._id));

  assert.equal((await H.call(TLB, 'patch', `/api/audio/assignments/${asgA1.id}/reassign`, { assigneeId: String(org.b1._id) })).status, 403);   // not TLB's assignment
  assert.equal((await H.call(TLA, 'patch', `/api/audio/assignments/${asgA1.id}/reassign`, { assigneeId: String(org.b1._id) })).status, 403);   // b1 outside TLA's team
  assert.equal((await H.call(TLA, 'patch', `/api/audio/assignments/${asgA1.id}/reassign`, { assigneeId: String(org.a2._id) })).status, 409);   // a2 already has it

  const [t2] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t2.id], assigneeIds: [String(org.a1._id)] });
  const asg2 = (await H.call(A, 'get', '/api/audio/assignments')).body.data.find((x) => x.trackId === t2.id);
  const ok = await H.call(TLA, 'patch', `/api/audio/assignments/${asg2.id}/reassign`, { assigneeId: String(org.a2._id) });
  assert.equal(ok.status, 200); assert.equal(ok.body.data.employeeId, String(org.a2._id)); assert.equal(ok.body.data.status, 'assigned');

  await H.call(E_A2, 'put', `/api/notebooks/${t2.id}`, { text: 'done' });
  const asg2Id = ok.body.data.id;
  await H.call(E_A2, 'post', `/api/audio/assignments/${asg2Id}/submit`);
  const lockedReassign = await H.call(A, 'patch', `/api/audio/assignments/${asg2Id}/reassign`, { assigneeId: String(org.a1._id) });
  assert.equal(lockedReassign.status, 409); assert.equal(lockedReassign.body.error.code, 'ASSIGNMENT_LOCKED');
});

test('remove: allowed pre-submission, blocked after, permission scope enforced', async () => {
  const [t] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id)] });
  const asg = (await H.call(A, 'get', '/api/audio/assignments')).body.data.find((x) => x.trackId === t.id);
  assert.equal((await H.call(TLB, 'delete', `/api/audio/assignments/${asg.id}`)).status, 403);
  assert.equal((await H.call(TLA, 'delete', `/api/audio/assignments/${asg.id}`)).status, 200);

  const [t2] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t2.id], assigneeIds: [String(org.a1._id)] });
  const asg2 = (await H.call(A, 'get', '/api/audio/assignments')).body.data.find((x) => x.trackId === t2.id);
  await H.call(E_A1, 'put', `/api/notebooks/${t2.id}`, { text: 'done' });
  await H.call(E_A1, 'post', `/api/audio/assignments/${asg2.id}/submit`);
  const blocked = await H.call(A, 'delete', `/api/audio/assignments/${asg2.id}`);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'ASSIGNMENT_LOCKED');
});

test('GET /api/audio/assignments: scoping (admin all, FM floor, TL own team) + status/employee/date filters + overdue', async () => {
  const [t] = await upload();
  await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.b1._id)], deadline: past() });
  const all = (await H.call(A, 'get', '/api/audio/assignments')).body.data;
  const fm = (await H.call(FM, 'get', '/api/audio/assignments')).body.data;
  const tla = (await H.call(TLA, 'get', '/api/audio/assignments')).body.data;
  const tlb = (await H.call(TLB, 'get', '/api/audio/assignments')).body.data;
  assert.ok(all.some((a) => a.employeeId === String(org.b1._id)));
  assert.ok(fm.some((a) => a.employeeId === String(org.b1._id)));          // FM sees whole floor
  assert.ok(!tla.some((a) => a.employeeId === String(org.b1._id)));        // TLA cannot see TLB's employee
  assert.ok(tlb.some((a) => a.employeeId === String(org.b1._id)));

  const overdue = (await H.call(A, 'get', '/api/audio/assignments?status=overdue')).body.data;
  assert.ok(overdue.some((a) => a.trackId === t.id && a.overdue === true && a.displayStatus === 'Overdue'));

  const byEmployee = (await H.call(A, 'get', `/api/audio/assignments?employee=${org.b1._id}`)).body.data;
  assert.ok(byEmployee.every((a) => a.employeeId === String(org.b1._id)));

  assert.equal((await H.call(E_A1, 'get', '/api/audio/assignments')).status, 403);   // employees cannot browse the dashboard
});
