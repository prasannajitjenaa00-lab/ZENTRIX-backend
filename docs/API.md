# Zentrix Pulse API contract

Base: `/api` · JSON · cookie auth (`pulse_sid`, httpOnly, SameSite=Lax) · realtime on `/socket.io`.

**Every state-changing request (POST/PUT/PATCH/DELETE) must send header `X-Pulse-Client: 1`** (CSRF defence) and, with `credentials: 'include'`, comes from `FRONTEND_URL` only.

**Envelope**
```
success: { "ok": true,  "data": <payload>, "meta": { page, limit, total, pages }? }
failure: { "ok": false, "error": { "code": "STRING", "message": "human text", "details": { field: "msg" }? } }
```
Differs from the old app (`{ok, error:string}`): read `error.message`.

**Common error codes** `UNAUTHENTICATED 401` · `FORBIDDEN 403` · `NOT_FOUND 404` (also used instead of 403 when revealing existence would leak data) · `VALIDATION_ERROR 400 (details per field)` · `CSRF 403` · `RATE_LIMITED 429` · `PASSWORD_CHANGE_REQUIRED 403` · `PAYLOAD_TOO_LARGE 413` · `INTERNAL 500`.

Roles: **A** admin · **F** floor_manager · **T** team_leader · **E** employee. "Any" = any signed-in user.

## Auth `/api/auth`
| Method & path | Auth | Body → Result / errors |
|---|---|---|
| POST `/login` | – (rate-limited, account lockout) | `{email,password}` → `{mfaRequired:false,user}` + cookie, or `{mfaRequired:true,challengeId}`. 401 `INVALID_CREDENTIALS` (identical for unknown email), 403 `ACCOUNT_SUSPENDED`, 429 `ACCOUNT_LOCKED`/`MFA_THROTTLED` |
| POST `/mfa/verify` | – | `{challengeId,code,trust?}` — `code` = 6-digit OTP **or** recovery code (`PULSE-XXXX-XXXX`, any case/dashes). → `{user,recoveryUsed,recoveryRemaining?}` + cookie (+ trusted-device cookie if `trust`). 400 `MFA_EXPIRED` / `MFA_INVALID` / `MFA_TOO_MANY_ATTEMPTS` (5 tries) |
| POST `/mfa/resend` | – | `{challengeId}` → `{challengeId}` (old code dies) |
| POST `/forgot` | – | `{email}` → always `{message}` (same for unknown emails) |
| POST `/reset/verify` | – | `{token}` → `{email}`; 400 `RESET_INVALID` |
| POST `/reset` | – | `{token,password}` → `{email}`; single-use, 30 min; revokes all sessions |
| GET `/me` | Any | → `{user}` (`user.mustChangePassword`, `user.recoveryCodesRemaining`) |
| POST `/logout` | Any | server-side session revoke |
| POST `/password` | Any | `{currentPassword,newPassword}`; 400 `WRONG_PASSWORD`. Only endpoint besides `/me`,`/logout` usable while `mustChangePassword` |

`devPreview` (OTP / reset link) appears in responses **only** when `DEV_MAIL_PREVIEW=true` outside production.

## Users `/api/users`
| Method & path | Roles | Notes |
|---|---|---|
| GET `/` | A | `?q&role&status&page&limit&includeBank=1` → paginated accounts (admin Accounts page). `includeBank=1` adds decrypted `bankDetails` (as the original admin screen showed) |
| GET `/crew` | A,F,T | scoped active crew |
| GET `/assignable` | A,F,T | employees the caller may assign work/audio to |
| GET `/leaders` | A | active team leaders + floor managers (account form) |
| POST `/` | A | `{name,email,role: employee\|team_leader\|admin, leaderId (req. for employee), floorId?, packageId?, phone?, password?, mfaEnabled?, bank?{holder,name,account,ifsc}, bankUnlock?}` → 201 `{user,temporaryPassword?,recoveryCodes?}`. Blank password ⇒ random temp password shown once; `mustChangePassword=true`. 409 `EMAIL_TAKEN` |
| PATCH `/:id` | A | same fields + optional `password` (admin reset, revokes sessions). Floor Managers keep their role; admins cannot demote themselves |
| POST `/:id/status` | A | `{status: Active\|Suspended}`; admins cannot be suspended; suspending kills sessions/sockets |
| PATCH `/me` | Any | `{name?,title?,mfaEnabled?}` → `{user,recoveryCodes?}` (codes returned once when MFA is switched on) |
| GET `/me/bank` · PUT `/me/bank` | Any | save validates (account 6–20 digits, IFSC `^[A-Z]{4}0[A-Z0-9]{6}$`) and **locks**; 403 `BANK_LOCKED` until admin unlocks |
| GET `/:id/bank` | A | decrypted details |
| PATCH `/:id/bank` | A | `{holder?,name?,account?,ifsc?,unlock?}` — any field saves and sets `locked=!unlock`; only `{unlock:true}` unlocks |

## Tasks `/api/tasks` (scope: A all · F floor · T own team · E own)
| Method & path | Roles | Notes |
|---|---|---|
| GET `/` | Any | `?status&bucket=open\|completed\|overdue&assignee&month=YYYY-MM&q&sort=due\|-due\|updatedAt\|-updatedAt\|title&page&limit(≤500)`; `q` ≥2 chars searches title/description/category/owner name |
| GET `/calendar?month=YYYY-MM&assignee?` | Any | admin: everyone (optional filter); others: only own tasks (original behaviour) |
| GET `/:id` | Any in scope | 404 if outside scope |
| POST `/` | A,F,T | `{title,assigneeId,due,start?,description?,category?,priority?,status?,progress?(default 5),notes?}`; assignee must be an active employee in caller's scope → else 403 |
| PATCH `/:id/status` | assignee or A | `{status?,progress?,notes?}`; `Completed` ⇒ progress 100; 403 for F/T on others' tasks ("another desk") |
| PATCH `/:id` | A | any field incl. `assigneeId` (reassign) |
| DELETE `/:id` | A | |

Status values `Pending · In Progress · On Hold · Completed` (any → any, as in the original). Dates are `YYYY-MM-DD` strings; "today"/overdue use `APP_TIMEZONE`.

## Dashboard / activity
| GET `/api/dashboard` (A,F,T) | KPIs, `statusCounts`, `activeMembers`, `inactiveMembers{reason}`, `upcoming`, `activity`, and for admin `security` (MFA + password-changed metadata; **never passwords**). F/T are scoped to their floor/team |
|---|---|
| GET `/api/dashboard/me` (Any) | employee KPIs, `dueSoon`, `tasks`, `wallet`, `assignedTracks` |
| GET `/api/activity?limit` | A all · F/T their scope · E rows involving them |

Inactive = status ≠ Active, **or** employee with no login and no task update in 7 days.

## Packages / wallet
`GET/POST /api/packages`, `PATCH/DELETE /api/packages/:id` (A; delete moves employees to "standard") · `GET /api/wallet/me` (Any) → `{package}`. (The original wallet is a package display only; no transactions exist.)

## Projects, audio, notebook (translation workflow)
Assignment status pipeline: `assigned → in_progress → submitted → reviewed` (or `revision_requested`, which
re-opens the translation for editing). `overdue` and `displayStatus` (`Pending`/`In Progress`/`Completed`/
`Revision requested`/`Overdue`) are derived from `deadline`+`status`, never stored.

| Method & path | Roles | Notes |
|---|---|---|
| GET `/api/projects` | A,F,T | with `trackCount` |
| POST `/api/projects` | A | `{name,description?}` |
| GET `/api/projects/:id/tracks` | A,F,T | with `assignedCount`, `duration` (seconds, best-effort, may be `null`), `streamUrl` |
| POST `/api/projects/:id/tracks` | A | `multipart/form-data`, **one request**, field `files` (or `file`) ×≤100, ≤400 MB each. Content-verified MP3 only. → 201 `{tracks,rejected[{name,reason}],project}`; 400 `NO_VALID_FILES`/`BATCH_TOO_LARGE`; 413 `FILE_TOO_LARGE`. The limit is enforced per request; splitting one logical batch across multiple requests is not a supported way to exceed it |
| POST `/api/audio/assign` | A,F,T | `{trackIds[],assigneeIds[],deadline?}` → `{added,alreadyAssigned}` (idempotent) |
| GET `/api/audio/assigned` | Any | caller's assigned tracks with translation text/status/deadline/overdue |
| GET `/api/audio/assignments` | A,F,T | `?employee&status(assigned\|in_progress\|submitted\|reviewed\|revision_requested\|overdue)&from&to&page&limit` → paginated, scoped to caller's team/floor (admin: all) — Assignment Tracking Dashboard |
| GET `/api/audio/assignments/:id` | owner employee, or A,F,T in scope | full detail incl. submitted text and history — Translation Review Page |
| PATCH `/api/audio/assignments/:id/reassign` | A,F,T in scope | `{assigneeId}`; 409 `ASSIGNMENT_LOCKED` once submitted/reviewed |
| DELETE `/api/audio/assignments/:id` | A,F,T in scope | 409 `ASSIGNMENT_LOCKED` once submitted/reviewed |
| POST `/api/audio/assignments/:id/submit` | owner employee | locks the translation; 400 if empty, 409 `TRANSLATION_LOCKED` if already submitted |
| POST `/api/audio/assignments/:id/review` | A,F,T in scope | `{decision:approve\|revise,feedback?}` (feedback required for `revise`); 409 `NOT_SUBMITTED` unless status is `submitted` |
| GET `/api/audio/:id/stream` | A,F,T any track · E assigned only (else 404) | `Range` supported (206/416); use directly as `<audio src>` (cookie auth) |
| GET/PUT `/api/notebooks/:trackId` | owner only | `{text}` (draft save); first save moves `assigned`→`in_progress`; 409 `TRANSLATION_LOCKED` once submitted/reviewed |

## Chat
`GET /api/chat?limit≤200&before=ISO` (Any) · `POST /api/chat {text≤500}` (A only; everyone reads).

## MFA / devices
`POST /api/mfa/recovery-codes` → `{recoveryCodes[6]}` (**shown once**; only hashes stored) · `GET /api/devices` · `DELETE /api/devices` (forget all trusted devices).

## Health
`GET /health` → `{ok,db,uptime}` (503 when DB down).

## Socket.IO (`/socket.io`, same cookie)
Handshake fails without a valid session or from a foreign Origin. Server assigns rooms; clients only listen.
`hello`, `presence:update{online[]}`, `task:created|updated{task}|deleted{taskId}`, `activity:new{activity}`, `chat:message{message}`, `track:assigned{count}`, `user:created|updated{user}` (admin / the user). Each payload carries `eventId` (dedupe) and `at`. Events are emitted only **after** the DB write succeeds. Client may send `presence:request` (ack). On reconnect, refetch lists (`/tasks`, `/chat`, `/dashboard`) — events are hints, REST is truth.
Audience: task events → admin, assignee, assignee's team leader room, floor manager room.

## Frontend changes this contract requires
1. Send `credentials:'include'` and `X-Pulse-Client: 1`; no `localStorage` session.
2. MFA input `maxlength` ≥ 16 (recovery codes are `PULSE-XXXX-XXXX`).
3. Recovery codes are displayed **once** at generation (hashed afterwards).
4. Handle `mustChangePassword` (force a change-password screen) and `ACCOUNT_SUSPENDED`.
5. Admin "Security credentials" shows MFA state + password-changed info, not passwords.
6. Ids are Mongo ObjectId strings.
