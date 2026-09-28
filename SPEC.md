# Spec: AI phone assistant for a doctor's office (n8n + Vapi + Google Calendar)

## Goal
Patients call the practice number. A German-speaking AI voice assistant (Vapi) answers, finds free
appointments, books, looks up and cancels appointments, and takes callback requests (prescriptions,
referrals, results, sick notes). n8n is the backend ("tools"), Google Calendar is the source of truth.

## Components
| Part | Where | Job |
|---|---|---|
| Vapi assistant | `vapi/assistant.json`, `vapi/system-prompt.de.md` | Voice, speech recognition, conversation, calls the n8n tools |
| n8n workflow | `n8n/praxis-telefonassistent.workflow.json` | One webhook, 5 tools, all logic |
| Logic (source) | `src/` | Slot calculation, validation, name matching. Tested, embedded into n8n Code nodes by `build.js` |
| Practice config | `src/config.js` | Opening hours, appointment types, holidays, vacation, calendar ID, e-mail |
| Hosting | `docker/` | n8n + Postgres + Caddy (HTTPS), EU server |

## Tools (Vapi → n8n)
1. `freie_termine_suchen(terminart, ab_datum?, nur_dieser_tag?, tageszeit?)` → up to N free slots
2. `termin_buchen(terminart, start, vorname, nachname, geburtsdatum, telefon?, versicherung?, anliegen?)`
3. `termine_finden(nachname, geburtsdatum)` → the patient's future appointments
4. `termin_absagen(termin_id, nachname, geburtsdatum)`
5. `rueckruf_notieren(vorname, nachname, geburtsdatum?, telefon?, kategorie, anliegen, dringend?)` → e-mail to the practice
Plus Vapi built-ins: `transferCall` (to the practice staff) and `endCall`.
Rescheduling = find + book new + cancel old (conversation logic, no extra tool).

## Acceptance criteria
- A1 Free slots come only from opening hours, minus Google Calendar busy times, holidays, vacation, lead time and the booking horizon; slot length depends on the appointment type.
- A2 Booking re-checks the slot on the server (valid grid position, still free). Invalid or taken slots are rejected with alternatives suggested by the assistant.
- A3 Only appointments created by the assistant can be found or cancelled. Both require last name + date of birth. Names are matched phonetically (Kölner Phonetik), because speech recognition misspells names.
- A4 Max. open appointments per patient (config) is enforced.
- A5 Callback requests reach the practice by e-mail with category and urgency.
- A6 Webhook is protected (Bearer token). Every input is validated and length-limited.
- A7 n8n does not keep successful executions (patient data), errors are kept for a limited time only.
- A8 Emergency rules in the prompt: 112 for emergencies, 116117 outside opening hours, no medical advice, AI disclosure at the start.
- A9 Logic is covered by automated tests. The generated workflow is checked by an end-to-end test in a real n8n instance with a mocked Google API.

## Non-goals (for now)
- Outbound calls / SMS reminders (possible later via Vapi outbound or an SMS provider)
- Integration of practice management software (PVS), insurance card checks, recurring appointments
- Multiple doctors/calendars (config is prepared for a single calendar)
- Legal compliance sign-off: DPA/AVV contracts, §203 StGB and the privacy notice must be checked by the practice

## Extension: staff dashboard (web app)

Goal: the practice team sees everything in one place: appointments, callback requests, how full each day is, settings and system status.

Architecture: `dashboard/` is its own Node server with no framework and no new dependencies. SQLite comes from `node:sqlite`, and Luxon is already a dependency.
- Appointments: dashboard → n8n workflow "Praxis-Dashboard-API" (webhook with its own token) → Google Calendar. Google access stays in n8n only.
- Callback requests: the phone workflow sends them to the dashboard as well as by e-mail (`POST /intern/rueckruf`, its own token). The dashboard stores them in SQLite.
- Demo mode (`DASHBOARD_MODUS=demo`): same code, with generated sample appointments and callback requests.

Acceptance criteria:
- D1 Login with username and password (scrypt hash). The session cookie is HttpOnly and SameSite=Strict, and Secure over HTTPS. Sessions expire. Login attempts are rate-limited. Every API route except login returns 401 without a session.
- D2 Write requests need the header `X-Praxis-Anfrage: 1` (CSRF protection). Strict CSP with no inline scripts, and framing is forbidden.
- D3 Appointments per day: time, type, name, source (assistant/practice), details (date of birth, phone, insurance, reason). The team can cancel future appointments after a confirmation.
- D4 Callback requests: open/done, urgent ones first, "done" is recorded with user and time. Done entries are deleted automatically after N days (config).
- D5 Utilisation for the next 14 days (share of booked opening time) and the next free appointment per appointment type. Uses the same slot logic as the phone assistant.
- D6 Settings read-only: opening hours, appointment types, holidays, vacation. Changes still go through `src/config.js`.
- D7 Status: mode, n8n reachable, calendar query OK, number of open callback requests, checklist of configuration items.
- D8 If n8n or Google fail, the dashboard shows an understandable error message and doesn't crash.
- D9 Tests: server tests in demo mode (auth, CSRF, rate limit, all APIs). The E2E test is extended: phone booking → visible in the dashboard, callback → in the dashboard, cancelling in the dashboard → gone from the calendar.

Non-goals: editing settings in the browser, user management in the browser (a CLI script is used instead), creating appointments by hand in the dashboard (staff keep using the calendar directly).

## Extension: local test setup (free, for a test call from a smartphone)

Goal: one command starts everything on your own PC so you can talk to the assistant through a Vapi web call on your smartphone and see the result in the dashboard.

- `node lokal/start.js` starts: a test calendar (Google API stand-in, saved to `lokal/daten/kalender.json`), a test mail server (prints callback e-mails to the console), n8n (no Docker), the dashboard (live mode, http://127.0.0.1:8088), a gatekeeper proxy and a Cloudflare quick tunnel (free, no account).
- L1 Only `POST /webhook/vapi-praxis` is reachable from the internet (gatekeeper proxy). The n8n editor, the dashboard and the dashboard API stay local.
- L2 Tokens are generated randomly on first start and stored in `lokal/daten/geheim.json` (git-ignored). Nothing is hard-coded.
- L3 The test calendar and test mail server share code with the E2E test (`test-e2e/attrappen.js`), with no duplicate implementation.
- L4 Printed at the end: tunnel URL, token and the exact steps for Vapi (credential, `vapi/einrichten.js`, web call).
- L5 `vapi/einrichten.js` works without a practice number (then there is no transfer tool, which is useful for a test).
- L6 Ctrl+C stops all processes, including n8n and cloudflared.

Non-goals: connecting real Google or SMTP locally (that goes through n8n like on the server), creating a Vapi account (the user does that).

## Extension: hosting (Hetzner, demo operation)

Goal: the system runs permanently and self-hosted as a demo (no real patient data), reachable by phone via the Vapi number.

- Server: Hetzner Cloud CX23 (Germany), Ubuntu 24.04, SSH key only (no password login), Hetzner firewall allows only 22, 80, 443.
- Addresses: free via sslip.io (`n8n-<ip>.sslip.io`, `dashboard-<ip>.sslip.io`), HTTPS through Caddy/Let's Encrypt. Own domain later.
- Google Calendar through a **service account** (a calendar shared with it), no OAuth login that expires. The E2E test keeps using the OAuth variant against the fake calendar (build option).
- Code: private GitHub repo, the server pulls from it (deploy key, read only).
- Secrets are generated on the server only (`.env`, mode 600) and never go into the repo or the chat.

Acceptance criteria:
- H1 `docker compose ps` shows n8n, runners, postgres, dashboard and caddy as healthy/running. HTTPS works on both addresses.
- H2 From outside only 80/443 (plus SSH with a key) are reachable. `/intern/*` and `/webhook/praxis-dashboard*` return 403 from outside.
- H3 A test call through the Vapi number books an appointment in the Google Calendar, and it shows up in the dashboard.
- H4 Monitoring (UptimeRobot, free) checks both addresses. Hetzner backups are on.
- H5 `npm test` and E2E stay green (OAuth variant), the build produces the service account variant by default.

## Extension: ROI view in the dashboard ("Wirkung")

Goal: the practice owner sees what the assistant brings: how many calls it handled (including outside opening hours), what it did (booked, cancelled, took callbacks, forwarded), how much staff time that saved in euros, and what the AI calls cost.

Data flow: after each call, Vapi sends an `end-of-call-report` to the existing n8n webhook (assistant-level `serverMessages` contains only this type). n8n reduces it to numbers and posts them to the dashboard (`POST /intern/anruf`, same intern token as `/intern/rueckruf`). The dashboard stores them in SQLite and computes the ROI.

Acceptance criteria:
- R1 Stored per call only: Vapi call ID (to drop duplicates), start time, duration in seconds, cost in USD, end reason, and four yes/no outcomes (booked, cancelled, callback taken, forwarded). No phone number, no name, no transcript, no recording URL. Outcomes come from the tool results in the report (e.g. a `termin_buchen` result starting with "Gebucht:"), not from what the caller said.
- R2 `/intern/anruf` requires the intern token (401 without), validates and length-limits every field, ignores duplicates, and is blocked from outside by Caddy like all `/intern/*` routes.
- R3 `GET /api/roi?tage=7|30|90` (login required) returns: number of calls, calls outside opening hours (holidays and vacation count as outside), total and average duration, the four outcome counts, staff hours saved, savings in €, AI cost in €, net benefit and ROI factor, calls per day (inside/outside opening hours) and a weekday × hour grid.
- R4 The assumptions are in `src/config.js` (`roi`: hourly staff cost, follow-up minutes per call, USD→EUR rate, retention days) and are shown next to the numbers. Calls that were forwarded or shorter than a minimum length don't count as saved staff time.
- R5 New tab "Wirkung" in the dashboard: KPI tiles, bar chart per day, heatmap of busy hours, assumptions. Demo mode shows generated sample calls. Strict CSP stays (no inline styles/scripts).
- R6 Stored calls are deleted after the retention period.
- R7 Tests: unit tests for extracting the report (including that no phone number/transcript is passed on) and for the ROI calculation (fixed data, opening hours, holiday); server tests for `/intern/anruf` and `/api/roi`. The E2E test sends a report through the real n8n to the dashboard and checks that the transcript and phone number appear neither in the dashboard nor in the n8n database.

Non-goals: live call monitoring, per-caller statistics, exporting reports, changing the assumptions in the browser.

Unverified until the first real call: the exact field names of Vapi's `end-of-call-report` (the extraction is written defensively and tested with a payload modelled on Vapi's documentation).

## Weighting
Security & data minimisation > correctness > maintainability > few dependencies > performance.
