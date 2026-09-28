# AI phone assistant for a doctor's office

Patients call the practice number. A German-speaking AI assistant picks up and can:

- **find free appointments** based on opening hours, the Google Calendar, holidays and vacation
- **book appointments**, with a server-side re-check so nothing gets double-booked
- **find, reschedule and cancel appointments**, after checking last name and date of birth
- **take callback requests** (prescriptions, referrals, results, sick notes) and e-mail them to the front desk
- **transfer the caller to the practice team** during opening hours
- **handle emergencies**: it tells the caller to hang up and dial 112, or 116 117 outside opening hours, and never gives medical advice

The practice team gets a **web dashboard** with appointments, callback requests, utilisation for the next 14 days, settings and system status.

```
Caller ──phone──▶ Vapi (speech recognition, voice, LLM)
                     │  tool call (HTTPS + bearer token)
                     ▼
                  n8n webhook ──▶ Google Calendar (freeBusy / events)
                     │        └─▶ SMTP e-mail to the front desk
                     ▼
                  answer back to Vapi ──▶ assistant speaks

Practice team ──browser──▶ Dashboard (login) ──▶ n8n "Dashboard API" ──▶ Google Calendar
                              ▲
                              └── callback requests from the phone workflow (stored in SQLite)
```

## Folder structure

| Path | Contents |
|---|---|
| `src/config.js` | **Your practice data**: opening hours, appointment types, holidays, vacation, calendar, e-mail |
| `src/lib.js` | All the logic (slots, validation, name matching), covered by tests |
| `vapi/system-prompt.de.md` | Conversation rules for the assistant (German) |
| `build.js` | Generates the files below from the files above |
| `n8n/praxis-telefonassistent.workflow.json` | Workflow for the phone tools (generated, don't edit by hand) |
| `n8n/praxis-dashboard-api.workflow.json` | Workflow the dashboard uses to read the calendar and cancel appointments (generated) |
| `dashboard/` | Web dashboard for the practice team (Node, no extra dependencies) |
| `vapi/assistant.json` | Vapi assistant with placeholders (generated) |
| `vapi/einrichten.js` | Creates or updates the assistant in Vapi |
| `docker/` | Hosting: n8n + task runner + Postgres + dashboard + Caddy (HTTPS) |
| `test/`, `test-e2e/` | Unit tests and the end-to-end test against a real n8n |

After every change to `src/` or the prompt: `npm run build`, then re-import the workflows, run `vapi/einrichten.js` again and restart the dashboard.

## Try the dashboard right away (demo data)

```bash
npm install
```
```bash
npm run dashboard
```
Open http://127.0.0.1:8080 and log in with user **demo**, password **demo**. Everything you see is sample data; nothing is connected. In demo mode the server only listens on your own PC.

## Test call from your smartphone (local, free)

Everything runs on your PC. A test calendar stands in for Google, so no Google setup is needed. Vapi gives new accounts free starting credit.

1. Once: `npm install`. n8n is already in `lokal/n8n` (otherwise `cd lokal/n8n && npm install n8n@2.40.7`), and `cloudflared.exe` in `lokal/werkzeuge/`.
2. Start:
```bash
node lokal/start.js
```
3. Create a free account at dashboard.vapi.ai and copy the **private** key under API Keys. Then, in a second PowerShell window in the project folder:
```bash
$env:VAPI_API_KEY="<private key>"
```
```bash
node vapi/einrichten.js --lokal
```
The script gets the tunnel address and token from `lokal/daten/` itself, creates the credential and the assistant at Vapi, and remembers their IDs in `lokal/daten/vapi.json`. After every restart of `lokal/start.js` (new tunnel address), just run the same command again. If Vapi rejects creating the credential automatically, the script shows the manual way.
4. To call: on your smartphone, open dashboard.vapi.ai → your assistant → **Talk to Assistant**. That's a free web call in the browser. A real phone number would be an extra cost, because Vapi's free numbers are US numbers.

From the internet, only the Vapi webhook can be reached (a gatekeeper proxy sits in front of n8n); the n8n editor and the dashboard stay local. The tunnel address changes on every start; `node vapi/einrichten.js --lokal` updates the assistant. Test data is in `lokal/daten/` (git-ignored); delete it to start from scratch.

## Setup

### 1. Adjust the practice data
Edit `src/config.js`: name, address, opening hours, appointment types and lengths, holidays **including your state's regional holidays**, vacation, e-mail addresses. Then:

```bash
npm install
```
```bash
npm test
```
```bash
npm run build
```

### 2. Host n8n (EU server, e.g. Hetzner or IONOS)
You need a server with Docker and two domains whose DNS points to the server, e.g. `n8n.praxis-muster.de` and `dashboard.praxis-muster.de`.

```bash
cd docker && cp .env.example .env
```
Fill in `.env` (both domains and five random values, e.g. `openssl rand -hex 32` each), then:
```bash
docker compose up -d
```
Open `https://<your-domain>`, create the owner account and **turn on two-factor authentication**.

### 3. Create the credentials in n8n
1. **Header Auth** named `Vapi Bearer-Token`: name `Authorization`, value `Bearer <long random token>`.
2. **Google Calendar OAuth2 API** named `Google Kalender Praxis`: create an OAuth client in Google Cloud (enable the Calendar API) with the redirect URL shown in n8n. Use a **Google Workspace** account with a data processing agreement, not a private Gmail account.
3. **SMTP** named `SMTP Praxis`: the practice's mail server, with TLS.
4. **Header Auth** named `Dashboard API-Token`: name `Authorization`, value `Bearer <DASHBOARD_API_TOKEN from .env>`.
5. **Header Auth** named `Dashboard Intern-Token`: name `Authorization`, value `Bearer <DASHBOARD_INTERN_TOKEN from .env>`.

### 4. Import and activate the workflows
```bash
docker compose exec n8n n8n import:workflow --separate --input=/import
```
Open each workflow in n8n and pick the right credential in each red node, then **publish** it:
- **Praxis-Telefonassistent**: the webhook (`Vapi Bearer-Token`), the 7 calendar nodes, the e-mail node and "Dashboard: Rückruf speichern" (`Dashboard Intern-Token`). Webhook URL: `https://<n8n-domain>/webhook/vapi-praxis`.
- **Praxis-Dashboard-API**: the webhook (`Dashboard API-Token`) and the 3 calendar nodes.

### 4b. Create dashboard users
One login per team member (password at least 10 characters, typed invisibly):
```bash
docker compose run --rm dashboard node dashboard/benutzer.js anlegen anna
```
`liste` shows all users, and `loeschen <name>` removes one. Changes take effect immediately: a deleted user is logged out right away, and no restart is needed. The dashboard is then at `https://<dashboard-domain>`.

Only set `DASHBOARD_HINTER_PROXY=1` (already set in `docker-compose.yml`) when Caddy sits in front. Without a proxy, a client could fake its IP address and get around the login lockout.

### 5. Set up Vapi
1. In the Vapi dashboard, create a **Bearer Token credential** with the same token as in step 3.1 and copy its ID.
2. Buy or connect a German phone number (Vapi, Twilio, or forwarding from the practice's phone system).
3. Pick a German voice in ElevenLabs (via Vapi) and copy its voice ID.
4. Set the environment variables `VAPI_API_KEY`, `N8N_WEBHOOK_URL`, `VAPI_CREDENTIAL_ID`, `PRAXIS_TELEFON` and `ELEVENLABS_VOICE_ID`, then:
```bash
node vapi/einrichten.js
```
5. In the dashboard, assign the assistant to the phone number. Test it first with the **web call** in the dashboard, then with a real call.

**Model:** `claude-sonnet-5`. Vapi does not offer `claude-opus-5` (as of 09/2026). For even shorter pauses, run `vapi/einrichten.js` with `VAPI_MODELL=claude-haiku-4-5-20251001`. If a model name is invalid, Vapi lists the allowed names in its error message.

## Tests

```bash
npm test
```
```bash
N8N_E2E_DIR=<empty folder> npm run e2e
```
`npm test` covers the logic and the dashboard server: login, lockout after 5 failed attempts, CSRF protection, all API routes, error cases.

The E2E test starts a real n8n (2.40.7) with a fake Google Calendar and a fake mail server, plus the real dashboard in live mode. It covers search, booking, double booking, a slot taken by someone else, find (with name variants), cancellation, wrong date of birth, callback e-mail, invalid input, Google outage and missing token, and it checks that **successful executions are not stored**. On the dashboard side it checks that a phone booking shows up in the dashboard, that callbacks from the phone land there, that cancelling in the dashboard deletes the appointment in the calendar, and that callbacks still go out by e-mail when the dashboard is offline.

## Security & data protection (please read)

What is built in:
- The webhook only accepts requests with the bearer token. Every input is validated and length-limited, and e-mail header injection is blocked.
- The assistant can only find or cancel appointments it booked itself, and only with last name + date of birth.
- At most 2 open appointments per person (configurable), to prevent abuse.
- n8n does **not keep successful executions**: it only marks them for deletion at first, and the settings in `docker-compose.yml` delete them for good within about a minute. Errors are deleted after 72 hours. Recording is turned off in Vapi.
- Only minimal data is asked for: a keyword for the reason, not symptoms in detail.
- **Dashboard:** personal logins (passwords as scrypt hashes), lockout after 5 failed attempts, session cookie HttpOnly/SameSite=Strict/Secure, CSRF protection, strict content security policy. Done callback requests are deleted automatically after 30 days (`rueckrufeAufbewahrenTage`). The internal endpoints are blocked from outside by Caddy. Recommended: make the dashboard reachable only from the practice network (see `docker/Caddyfile`).

**Must be sorted out before going live**, because this is health data (GDPR Art. 9) and medical confidentiality (§ 203 StGB):
- **Data processing agreements (AVV)** with Vapi, the LLM provider (Anthropic), ElevenLabs, Deepgram, Google and the server host. Vapi is a US provider, so check the data transfer basis (EU-US Data Privacy Framework or standard contractual clauses) and data residency.
- A privacy notice on the practice website plus a short notice at the start of the call. The AI disclosure is already in the greeting (EU AI Act).
- Retention in Vapi: check transcripts and call logs in the dashboard, and set the shortest retention.
- Have a data protection officer or lawyer review everything. **This is not legal advice.**

## Limitations

- Only appointments booked by the assistant can be found or cancelled by it. Appointments made at the desk stay with the team.
- One calendar (one doctor or a shared calendar). Multiple doctors would be an extension.
- Only incoming calls. SMS or phone reminders are not included.
- Double bookings in the exact same second (two callers, same slot) are unlikely but theoretically possible.
- The dashboard only shows settings; they are changed in `src/config.js`. Users are managed with the command-line script, not in the browser.
- The Docker setup and the connection to real Vapi and Google have **not yet been tested live**. The n8n workflows and the dashboard were tested end to end, with fake Google and mail services.
