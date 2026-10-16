# Deploying Zentrix Pulse backend (Ubuntu VPS, Nginx, PM2, MongoDB)

## 0. Prerequisites
Node 22 LTS, MongoDB 7 (bound to 127.0.0.1 only, auth enabled), Nginx, PM2 (`npm i -g pm2`), certbot, an SMTP account (the app **refuses to start in production without SMTP_HOST** — MFA codes and reset links are emailed).

## 1. MongoDB (not exposed publicly)
```bash
# /etc/mongod.conf
net: { bindIp: 127.0.0.1 }
security: { authorization: enabled }
```
```js
// mongosh (once)
use admin
db.createUser({ user: "pulse", pwd: "<long random>", roles: [{ role: "readWrite", db: "zentrix_pulse" }] })
```
`MONGODB_URI=mongodb://pulse:<pwd>@127.0.0.1:27017/zentrix_pulse?authSource=admin`. Firewall: allow only 22/80/443.
(Optional: run `mongod` as a single-node replica set if you later want multi-document transactions.)

## 2. Layout & secrets
```bash
sudo mkdir -p /srv/pulse/{releases,shared/storage} /var/log/pulse
sudo adduser --system --group pulse && sudo chown -R pulse:pulse /srv/pulse /var/log/pulse
# shared/server.env  (chmod 600, owner pulse) — copy server/.env.example and fill in:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # run twice: DATA_ENCRYPTION_KEY and TOKEN_PEPPER
```
Production values: `NODE_ENV=production`, `TRUST_PROXY=1`, `HOST=127.0.0.1`, `FRONTEND_URL=https://pulse.example.com`, `STORAGE_DIR=/srv/pulse/shared/storage`, `DEV_MAIL_PREVIEW=false`.
**Back up `DATA_ENCRYPTION_KEY` somewhere other than this server** (password manager). Without it bank details cannot be decrypted. Changing `TOKEN_PEPPER` signs everyone out and invalidates pending reset links/recovery codes.

## 3. Release
```bash
REL=/srv/pulse/releases/$(date +%Y%m%d%H%M)
git clone <repo> $REL && cd $REL/server && npm ci --omit=dev
cd ../client && npm ci && VITE_API_URL=/ npm run build     # serves from same origin via Nginx
ln -sfn $REL /srv/pulse/current
cd /srv/pulse/current/server && node --env-file=/srv/pulse/shared/server.env scripts/seed-reference-data.js   # default packages, first time only
pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save && pm2 startup
curl -fsS http://127.0.0.1:8787/health
```
Nginx: copy `deploy/nginx.conf` → `/etc/nginx/sites-available/pulse.conf`, `ln -s` to `sites-enabled`, `sudo certbot --nginx -d pulse.example.com`, `nginx -t && systemctl reload nginx`.
HTTPS is mandatory: session cookies are `Secure` in production and will not be set over plain HTTP.

## 4. First admin (fresh database)
```bash
node --env-file=/srv/pulse/shared/server.env scripts/create-user.js --name "Your Name" --email you@company.com --role admin
```
Prints a temporary password once; you must change it at first sign-in. No demo users are ever created.

## 5. Migrating the old app's data
```bash
cd /srv/pulse/current/server
# 1) Dry run — reads only, touches nothing, no env needed. Review repairs/warnings/errors.
node scripts/migrate-from-json.js --source /path/to/old/zentrix-pulse/data
# 2) Stop the OLD app (so no writes happen mid-copy), then apply:
node --env-file=/srv/pulse/shared/server.env scripts/migrate-from-json.js --source /path/to/old/zentrix-pulse/data --apply
```
`--apply` first makes a **checksum-verified backup** of the source into `backups/<batch>/`, then inserts (insert-only; re-running never overwrites), copies audio into `STORAGE_DIR` after content-checking each MP3, and prints a validation table (counts per collection, every employee has a leader, every task has an owner, no plaintext `password` field). Exit code 1 on any failure.
What is deliberately **not** carried over: plaintext recovery codes and trusted-device tokens (insecure) — users generate new codes and re-verify MFA once; reset tokens, OTP challenges and the mailbox (ephemeral). Every migrated user gets `mustChangePassword=true` (pass `--no-force-change` to skip). **All 7 accounts in the supplied file still use the documented demo passwords** — treat them as compromised and rotate.
**Rollback:** `node ... migrate-from-json.js --rollback <batchId> --yes` removes exactly what that batch inserted (and its audio files). The original JSON files are never modified or deleted; keep them until you have verified the new system for a while.

## 6. Backups & restore
```bash
# nightly (cron): DB + uploads, 14-day retention
mongodump --uri "$MONGODB_URI" --gzip --archive=/srv/backups/pulse-$(date +%F).gz
rsync -a --delete /srv/pulse/shared/storage/ /srv/backups/storage/      # audio files
find /srv/backups -name 'pulse-*.gz' -mtime +14 -delete
# restore
mongorestore --uri "$MONGODB_URI" --gzip --archive=/srv/backups/pulse-YYYY-MM-DD.gz --drop
```
Ship backups off-server. Test a restore on a scratch machine quarterly. Back up `server.env` (encrypted) separately from the DB — the DB backup is useless for bank details without `DATA_ENCRYPTION_KEY`.

## 7. Rollback a bad release
```bash
ln -sfn /srv/pulse/releases/<previous> /srv/pulse/current && pm2 reload pulse-server
```
Schema changes are additive; the previous release keeps working against the same database.

## 8. Operations notes
- Graceful shutdown: SIGTERM stops accepting, closes sockets, disconnects Mongo (15 s cap). PM2 `kill_timeout` is set to allow it.
- Logs are JSON lines (`pm2 logs`), credentials/tokens/OTPs/bank fields redacted.
- Single process: Socket.IO presence is in-memory. To run multiple instances add `@socket.io/redis-adapter` and a shared presence store.
- Uploads stream to disk (never held in memory); Nginx `proxy_request_buffering off`.
- Rate limits: 600 req/min/IP global, 30 logins/15 min/IP, 10 resets/hour/IP, plus per-account lockout (10 failures → 15 min) and MFA limits (5 tries/code, 5 codes/15 min).
