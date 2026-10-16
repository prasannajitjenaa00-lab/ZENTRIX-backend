'use strict';
/*
 * Socket.IO — server-authoritative. Clients can only LISTEN. They never choose rooms, never send mutations,
 * and cannot assert an identity: identity comes from the httpOnly session cookie validated at handshake.
 *
 * Rooms (assigned by the server):
 *   all            every authenticated user          (chat, presence)
 *   user:<id>      that user                          (own tasks, track assignments, account changes)
 *   admin          admins                             (everything)
 *   team:<id>      team leader <id>                   (their employees' task events)
 *   floor:<id>     floor manager <id>                 (their floor's task events)
 *
 * Server -> client events (all payloads include eventId, at):
 *   hello            {user}                         once after connect
 *   presence:update  {online:[{userId,name,role}]}  to all
 *   task:created     {task}
 *   task:updated     {task, reassigned}
 *   task:deleted     {taskId}
 *   activity:new     {activity}
 *   chat:message     {message}
 *   track:assigned   {count}                        to the assignee
 *   user:created / user:updated {user}              admin (and the user for updated)
 * Client -> server: presence:request (ack with list). Anything else is ignored.
 */
const { Server } = require('socket.io');
const cookie = require('cookie');
const { Session } = require('../models');
const sessions = require('../services/sessions');
const realtime = require('../services/realtime');
const { getConfig } = require('../config/env');
const { logger } = require('../config/logger');

const online = new Map(); // userId -> {name, role, count}
const presenceList = () => [...online.entries()].map(([userId, v]) => ({ userId, name: v.name, role: v.role }));

function attach(httpServer) {
  const cfg = getConfig();
  const io = new Server(httpServer, {
    serveClient: false, maxHttpBufferSize: 10_000, pingInterval: 25_000, pingTimeout: 20_000,
    cors: { origin: cfg.frontendOrigin, credentials: true },
    allowRequest: (req, cb) => { const o = req.headers.origin; cb(null, !o || o === cfg.frontendOrigin); },   // blocks cross-site WebSocket hijacking
  });
  realtime.setIo(io);

  io.use(async (socket, next) => {
    try {
      const raw = cookie.parse(socket.handshake.headers.cookie || '')[cfg.session.cookieName];
      const found = await sessions.resolve(raw);
      if (!found || found.user.mustChangePassword) return next(new Error('unauthorized'));
      const u = found.user;
      socket.data = { token: raw, user: { id: String(u._id), name: u.name, role: u.role } };
      next();
    } catch (e) { next(new Error('unauthorized')); }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    socket.join(['all', `user:${u.id}`]);
    if (u.role === 'admin') socket.join('admin');
    if (u.role === 'team_leader') socket.join(`team:${u.id}`);
    if (u.role === 'floor_manager') socket.join(`floor:${u.id}`);

    const cur = online.get(u.id) || { name: u.name, role: u.role, count: 0 };
    cur.count += 1; online.set(u.id, cur);
    socket.emit('hello', { user: u, online: presenceList() });
    io.to('all').emit('presence:update', { online: presenceList() });

    socket.on('presence:request', (ack) => { if (typeof ack === 'function') ack({ online: presenceList() }); });
    socket.on('disconnect', () => {
      const c = online.get(u.id);
      if (c) { c.count -= 1; if (c.count <= 0) online.delete(u.id); }
      io.to('all').emit('presence:update', { online: presenceList() });
    });
  });

  // Close sockets whose session expired or was revoked (without sliding the idle window).
  const sweep = setInterval(async () => {
    try {
      const now = new Date();
      for (const s of await io.fetchSockets()) {
        const ok = await Session.exists({ tokenHash: sessions.hashToken(s.data.token), expiresAt: { $gt: now }, idleExpiresAt: { $gt: now } });
        if (!ok) s.disconnect(true);
      }
    } catch (e) { logger.warn('socket.sweep_failed', { err: e }); }
  }, 60_000);
  sweep.unref();
  io.on('close', () => clearInterval(sweep));
  return io;
}
module.exports = { attach, _presence: presenceList };
