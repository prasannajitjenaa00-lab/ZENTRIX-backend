# Zentrix Pulse — backend (Node 22 · Express 4 · MongoDB/Mongoose 8 · Socket.IO 4)

JavaScript only. Migrates the original `server.js` + the client-side business logic in `app.js` into an authenticated, role-enforcing API.
See `docs/API.md` (contract), `docs/DEPLOY.md` (VPS), `../MIGRATION_PLAN.md` (inventory, decisions, defects found in the original).

## Run locally
```bash
cd server && cp .env.example .env     # fill DATA_ENCRYPTION_KEY and TOKEN_PEPPER (see file), set DEV_MAIL_PREVIEW=true for dev
npm install
mongod --dbpath ./.mongo &            # or use Docker / Atlas
npm run seed:reference                # default wallet packages
npm run create-user -- --name "Dev Admin" --email admin@local.test --role admin     # prints a temp password
npm run dev                           # http://127.0.0.1:8787  (GET /health)
npm test                              # unit tests (no DB needed)
npm run test:integration              # needs `npm install` (supertest, mongodb-memory-server: downloads mongod on first run)
```

## What changed from the original (and why)
| Original | Now |
|---|---|
| Passwords plaintext, sent to every client | scrypt hashes, never returned |
| Login/MFA/"session" decided in the browser | Server-side login → MFA challenge → httpOnly session cookie (8 h idle / 7 d absolute) |
| Whole DB pushed by any client over WebSocket | Per-resource REST + server-authoritative, room-scoped Socket.IO events |
| `/api/password`, `/api/mailbox`, `/uploads/*` unauthenticated | Removed / authenticated |
| Suspended user silently reactivated by logging in | Suspended users cannot sign in (sessions & sockets killed on suspend) |
| Recovery codes `PULSE-XXXX` plaintext | `PULSE-XXXX-XXXX`, hashed, single-use, shown once |
| Bank details plaintext | AES-256-GCM at rest (key outside DB); owner/admin only; lock/unlock rules preserved |
| Audio: any bytes stored as .mp3, public URL, no Range | Content-verified MP3, random storage keys, authorised streaming with 206 Range |
| FM/TL dashboards used studio-wide data + all passwords | Scoped to floor/team; no passwords anywhere |

## Verification status — read this
Environment used to build this had **no network, no MongoDB**: `express`, `mongoose`, `socket.io`, `multer`, `supertest` could not be installed, so **the server has never been executed**.

| Area | Status |
|---|---|
| Pure logic: crypto (scrypt, AES-GCM, recovery/OTP), validators, role/scope policy on your real data, inactivity rule, date/TZ, Range parser, MP3 signature check, config guards, log redaction | **Tested — 43 unit tests pass** (`npm test`) |
| Migration transform on your real `pulse-db.json` (+ messy/duplicate/dangling synthetic data, idempotency, no source mutation) | **Tested** (10 tests) and **dry-run executed** on the real file: 7 users, 15 tasks, 3 activity rows → 0 errors |
| Every source file parses; no undefined identifiers (tsc `checkJs` sweep) | **Checked** (static only) |
| Express app, Mongoose models/indexes, services, routes, sessions, MFA flow, uploads/streaming, Socket.IO rooms, `--apply` migration, rollback | **UNTESTED.** Code is complete. `tests/integration/*` (≈45 scenarios) are written to exercise these but **have not been run**. Expect to fix some small bugs on first run. |
| SMTP delivery, Nginx/PM2/HTTPS, real MongoDB auth | **Requires your credentials/server** — untested |
Run `npm run test:integration` first; treat any failure there as a real bug to fix before go-live.

## Known limitations
- Wallet = package display only (the original has no transactions); no notifications/unread counts/pagination UI existed — realtime events + paginated REST are provided instead.
- No multi-document transactions (standalone MongoDB); migration uses insert-only + `--rollback`.
- Single process (see DEPLOY.md §8). Local-disk audio storage behind a small driver interface (`services/storage.js`) — swap for S3 if needed.
- Express 4 is required (`req.query` is reassigned by the sanitiser).
- The frontend is not part of this deliverable; see "Frontend changes this contract requires" in `docs/API.md`.
