# Matchday

A mobile-first web app for a small football group: player registration, guests, match-day check-in with a waiting list, balanced team selection, live result entry with goals and assists, and a six-month individual league.

One Cloudflare Worker serves both the React frontend (Workers Static Assets) and the JSON API (Hono) from the same origin. Data lives in Cloudflare D1. There is no other server.

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite 8, Tailwind CSS 4, TanStack Query, React Router |
| Backend | Cloudflare Worker + Hono 4 |
| Database | Cloudflare D1 (SQLite) with versioned SQL migrations in `migrations/` |
| Auth | Better Auth 1.7 (email + password, D1 sessions, PBKDF2-SHA256 hashing via WebCrypto) |
| Tests | Vitest 4 + `@cloudflare/vitest-plugin`, running inside the Workers runtime against a real D1 |
| Tooling | Wrangler 4, `@cloudflare/vite-plugin` |

---

## Scoring rules (and the assumptions behind them)

All rules live in **`src/shared/rules.ts`** and are covered by `test/rules.test.ts`. The same list is shown in the app on the **Rules** page.

- A **match day** is a session of several short matches. A **set** is a team picked for that day. Sets can change from one match day to the next.
- The set with the **most match wins** that day is the **daily winner**. Goals don't decide it.
- Each **eligible** player in the winning set earns **3 league points, once per match day**, however many matches the set won. Everyone else earns 0.
- **Ties on wins:** by default the tied sets **share** first place and all their eligible players earn 3 points. Before finalizing, an admin can switch that day to the **playoff** policy. A recorded playoff match between the tied sets then decides it. Playoff matches don't count towards the regular W/D/L table.
- **No winner:** if no set wins a single match (all draws, or nothing completed), there is no daily winner and nobody earns points.
- **Eligibility:** the player is in the winning set's locked roster, is marked present, and was a **member when play started**.
- **Guests** can play and are credited with goals and assists, but earn no league points. **Converting a guest to a member** keeps the same player record and statistics. By default it applies from the next roster lock onwards. An admin can also apply it to the current season's past days as an audited correction.
- **Standings order:** points, then daily wins, then goals, then assists. Players level on all four share the position, shown as `=4`.
- **Own goals** count for the team that benefits. They don't add to the player's scored goals, but they are tracked separately. **Unattributed goals** are allowed so that scores always reconcile.
- **Seasons** last six calendar months, with explicit start and end dates. The default end date is the day before the same day-of-month six months later, clamped to the end of the month: 1 Jan → 30 Jun, 15 Jul → 14 Jan. Dates are interpreted in the season's timezone (default **Africa/Lagos**).
- Only **finalized** match days count. **Cancelled** days award nothing, including a finalized day that is later cancelled.
- **Rosters lock when play starts.** Teams can't be switched after that.
- **Corrections** to a finalized day need a reason. Each one is written to the audit log with the actor, time, reason and before/after values, and that day's records are recomputed from scratch.

### How correctness is enforced

- `day_player_stats` holds one row per player per finalized day, keyed on `(match_day_id, player_id)`, so a player can't be awarded twice for the same day. Finalization and corrections **replace** a day's rows; they never add to them. Standings are `SUM`s over finalized days only.
- Every day-scoped write runs as one **D1 batch** (a single transaction) guarded by the match day's `version` column. A guard statement (`INSERT INTO _batch_guard VALUES (changes())` with `CHECK (ok > 0)`) aborts and rolls back the whole batch if another request changed the day first. A double-clicked "Finalize" therefore finalizes once, and the second request returns the already-finalized result.
- **Capacity** is enforced inside a single `INSERT … SELECT CASE WHEN count < capacity THEN 'confirmed' ELSE 'waitlist' END … ON CONFLICT` statement. D1 runs each statement atomically, so concurrent check-ins can't overbook the day, and `UNIQUE (match_day_id, player_id)` blocks duplicate registrations.
- Goals and matches accept a client-generated UUID, so a retried request is idempotent.
- The server recomputes everything. It never trusts points, roles or totals sent by the client.

---

## Roles and access

| Role | Can |
|---|---|
| **Admin** | Manage seasons, players, guests, match days, attendance, teams, results, corrections, settings and logins. Read the audit log. |
| **Member** | Sign in, check in or withdraw before the deadline, and view teams, results, standings and profiles. |
| **Guest** | Request a place through a match day's shareable link (`/g/<token>`). An admin must approve the request before the guest joins the playing pool. |

- **Public sign-up is disabled.** Accounts are created in exactly two ways: first-admin setup (which needs the `SETUP_TOKEN` secret), or a player's personal **invite link** generated by an admin. An invite links the new login to the existing player record, so history is never duplicated.
- The `role` field can't be set by clients (`input: false`). Only admins can promote another user, and the last admin can't be demoted.
- Guest contact details, skill ratings and goalkeeper preferences are returned only to admins.
- Request protection: SameSite=Lax httpOnly cookies, `Secure` on HTTPS, an Origin check on every state-changing request, and JSON-only bodies. CSP and other security headers come from `public/_headers`.
- Public forms are protected by a honeypot field, a minimum fill time, D1-backed rate limiting per hashed IP (also used for sign-in), a duplicate-name check, and a cap on pending guests per day.

---

## Local development

Requirements: Node.js 22+ (developed on Node 24) and npm.

```bash
npm install
cp .dev.vars.example .dev.vars          # then edit the values
npm run db:migrate:local                # creates the local D1 under .wrangler/
npm run dev                             # http://localhost:5173 (Worker runs in workerd)
```

Open http://localhost:5173. On an empty database you're sent to **/setup**. Enter the `SETUP_TOKEN` from `.dev.vars` to create the first admin.

### Optional local demo data

```bash
npm run db:seed:demo
```

This **wipes the local database** and loads sample players, a season, two finalized match days and one open match day. The seed computes points with the real rules module. Demo logins (local only): `admin@demo.local` and `bola@demo.local`, both with password `matchday-demo-pass`. The script refuses `--remote`. Production never contains this data.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with the Worker running in the local Workers runtime |
| `npm run typecheck` | Type-checks the client, worker and tests |
| `npm test` | All tests (unit, integration and end-to-end) inside workerd with a fresh D1 |
| `npm run build` | Production build (`dist/client` for static assets, `dist/worker` for the Worker) |
| `npm run preview` | Build, then serve the production bundle locally in workerd |
| `npm run check` | Typecheck, test and build |
| `npm run db:migrate:local` / `db:migrate:remote` | Apply migrations to the local or remote D1 |
| `npm run db:reset:local` | Delete the local D1 and re-run migrations |
| `npm run db:seed:demo` | Local demo data (see above) |
| `npm run db:export:remote` | Download a full SQL backup into `backups/` |
| `npm run deploy` | Build and `wrangler deploy` |

### Tests

`npm test` runs 67 tests:

- `test/rules.test.ts`: most-wins winner, both tie policies, exactly 3 points once per eligible player, absent players and guests excluded, own goals, goal validation and reconciliation, finalization blockers, standings tie-breaks, six-month season boundaries (including leap years), balanced and random team selection without duplicates, and timezone conversion.
- `test/flow.e2e.test.ts`: the full flow through the real Worker, auth sessions and D1. Create season → create match day → member check-in → guest approval → generate and publish teams → confirm attendance → record matches and goals → finalize (including two concurrent finalize requests) → verify standings. It then applies audited corrections and checks the recalculated standings, converts the guest, and closes the season.
- `test/registration.test.ts`: 16 concurrent check-ins against capacity 10 (exactly 10 confirmed and 6 waitlisted), concurrent duplicate check-ins, explicit waitlist promotion, deadlines, the guest honeypot, rate limiting and approval, and cancellation.
- `test/access.test.ts`: the setup token, single first admin, blocked public sign-up, a member unable to self-promote, 401s on protected reads, a 403 on every admin mutation for members, private-field hiding, cross-origin and non-JSON blocking, sign-in and sign-out, sign-in rate limiting, password hashing, keeping the last admin, and single-use invites.

The end-to-end test drives the HTTP API rather than a browser. The UI flow was checked by hand in a browser against the local Workers runtime.

---

## Deploying to Cloudflare

You need a Cloudflare account. Everything used here fits the Workers Free plan for a small group.

1. **Log in**
   ```bash
   npx wrangler login
   ```
2. **Create the D1 database**
   ```bash
   npx wrangler d1 create matchday-db
   ```
   Copy the printed `database_id` into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`. The binding name must stay `DB`.
3. **Apply migrations to the remote database**
   ```bash
   npm run db:migrate:remote
   ```
4. **Set secrets.** These are never committed and never go in `wrangler.jsonc`.
   ```bash
   openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
   openssl rand -base64 24 | tee /dev/stderr | npx wrangler secret put SETUP_TOKEN   # note the printed value
   echo "https://matchday.<your-subdomain>.workers.dev" | npx wrangler secret put BETTER_AUTH_URL
   ```
   `BETTER_AUTH_URL` must be the exact public origin users will visit. Update it when you add a custom domain.
5. **Deploy**
   ```bash
   npm run deploy
   ```
6. **Create the first admin.** Open `https://<your-app>/setup`, enter the `SETUP_TOKEN` value, and create your account. Setup works only while no admin exists. After that, delete the token:
   ```bash
   npx wrangler secret delete SETUP_TOKEN
   ```
7. **Start using it.** As admin: **Admin → Seasons** to create a season, **Admin → Players** to add players and send each one an **Invite link**, then **Matches → New match day**.

### Bindings and configuration

| Name | Kind | Where | Purpose |
|---|---|---|---|
| `DB` | D1 binding | `wrangler.jsonc` | All application data |
| `APP_ENV` | var | `wrangler.jsonc` | `production` / `development` / `test` |
| `BETTER_AUTH_SECRET` | secret | `wrangler secret put` | Signs session cookies (≥ 32 chars) |
| `BETTER_AUTH_URL` | secret or var | `wrangler secret put` | Public origin (used for auth and invite links) |
| `SETUP_TOKEN` | secret | `wrangler secret put` | One-time first-admin setup; delete after use |

`.dev.vars.example` lists the same values for local development. The timezone, group name and match-day defaults are changed in the app under **Admin → Settings**.

### Custom domain

1. Add your domain to Cloudflare (Dashboard → **Add a domain**) so that its DNS is managed by Cloudflare.
2. Dashboard → **Workers & Pages** → `matchday` → **Settings → Domains & Routes → Add → Custom domain**, then enter e.g. `matchday.example.com`. Cloudflare creates the DNS record and certificate.
   (Alternatively, add `"routes": [{ "pattern": "matchday.example.com", "custom_domain": true }]` to `wrangler.jsonc` and redeploy.)
3. Update the auth origin and redeploy:
   ```bash
   echo "https://matchday.example.com" | npx wrangler secret put BETTER_AUTH_URL
   ```
   Invite links generated before the change still point to the old host. Generate new ones.

### Upgrading

Add new SQL files as `migrations/000N_description.sql`. Never edit an applied migration. Then run:

```bash
npm run db:migrate:remote && npm run deploy
```

---

## Backups and recovery

- **Point-in-time recovery (built in):** D1 Time Travel can restore the database to any minute in the last 30 days (7 days on the Free plan).
  ```bash
  npx wrangler d1 time-travel info matchday-db                     # current bookmark
  npx wrangler d1 time-travel restore matchday-db --timestamp=2026-11-07T09:00:00Z
  ```
  A restore overwrites the live database. Take an export first.
- **Full SQL export:**
  ```bash
  npm run db:export:remote        # writes backups/matchday-YYYYMMDD-HHMMSS.sql
  ```
  Keep exports somewhere safe, for example after every match day or before a season close. They contain personal data such as emails and guest phone numbers.
- **Restore an export into a fresh database:**
  ```bash
  npx wrangler d1 create matchday-db-restore
  npx wrangler d1 execute matchday-db-restore --remote --file=backups/matchday-XXXX.sql
  ```
  Then point `database_id` in `wrangler.jsonc` at the new database and redeploy. The export includes the `d1_migrations` table, so later migrations continue from the right version.
- **Load an export locally for debugging:** `rm -rf .wrangler/state && npx wrangler d1 execute matchday-db --local --file=backups/matchday-XXXX.sql` (the export contains the schema, so don't run migrations first).

---

## Project layout

```
migrations/             D1 schema (versioned SQL)
src/shared/rules.ts     Business rules: scoring, ties, eligibility, standings, seasons, team selection
src/shared/time.ts      Timezone helpers (UTC storage, local display/input)
src/worker/             Hono API: auth, routes, D1 helpers, standings
src/client/             React app: pages and components
scripts/demo-seed.ts    Local-only demo data generator
test/                   Vitest suites (run in workerd)
public/_headers         Security headers for static assets
```

## Known limitations

- A goal's assister is optional and limited to one player. Minute-by-minute timelines aren't recorded.
- Balanced selection is a simple greedy algorithm based on admin ratings. It aims to be explainable, not optimal.
- Notifications (email or WhatsApp) aren't included. Share the guest link and invite links manually.
- Password reset by email isn't wired up, because no email provider is configured. An admin can use **Unlink login** on the player and send a fresh invite. The player's history is kept.
