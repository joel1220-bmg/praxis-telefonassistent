// Local test setup: everything for a test call from your smartphone, on your own PC, free of charge.
// Start: node lokal/start.js      Stop: Ctrl+C
//
// Starts: test calendar (instead of Google), test mail server (prints e-mails), n8n, dashboard,
// gatekeeper (only the Vapi webhook reaches the outside) and a free Cloudflare quick tunnel.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { erstelleGoogleAttrappe, erstelleSmtpAttrappe } = require('../test-e2e/attrappen');
const { erstelleDashboard } = require('../dashboard/server');
const { RueckrufSpeicher } = require('../dashboard/speicher');
const { Benutzer } = require('../dashboard/benutzer');
const { N8nKalender } = require('../dashboard/kalender');

const WIN = process.platform === 'win32';
const WURZEL = path.join(__dirname, '..');
const DATEN = path.join(__dirname, 'daten');
const N8N_SKRIPT = path.join(__dirname, 'n8n', 'node_modules', 'n8n', 'bin', 'n8n');
const CLOUDFLARED = path.join(__dirname, 'werkzeuge', WIN ? 'cloudflared.exe' : 'cloudflared');
const PORT = { n8n: 5678, google: 18181, smtp: 12626, dashboard: 8088, torwaechter: 8787 };
const KALENDER = 'praxis-lokal';
const GOOGLE_TOKEN = 'lokaler-testkalender';
const WEBHOOK_PFAD = '/webhook/vapi-praxis';
const MAX_BODY = 256 * 1024;
const INTRO_PFAD = '/audio/begruessung.wav';
const INTRO_DATEI = path.join(DATEN, 'begruessung.wav');

const log = (text) => console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${text}`);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

// Klarer Hinweis statt Absturz, wenn ein Port schon belegt ist (z. B. durch das Demo-Dashboard).
function lauschen(server, port, name) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${port} (${name}) ist schon belegt. Läuft das Skript oder das Demo-Dashboard bereits? Dieses zuerst beenden.`)
      : e));
    server.listen(port, '127.0.0.1', resolve);
  });
}
const prozesse = [];

function voraussetzungen() {
  const fehlt = [];
  if (!fs.existsSync(N8N_SKRIPT)) fehlt.push(`n8n fehlt. Installieren mit:  cd lokal/n8n && npm install n8n@2.40.7`);
  if (!fs.existsSync(CLOUDFLARED)) fehlt.push('cloudflared fehlt: https://github.com/cloudflare/cloudflared/releases → cloudflared-windows-amd64.exe als lokal/werkzeuge/cloudflared.exe speichern');
  if (fehlt.length) { console.error(fehlt.join('\n')); process.exit(1); }
  fs.mkdirSync(DATEN, { recursive: true });
}

// Tokens are created randomly once and stay the same, so the Vapi credential stays valid.
function geheimnisse() {
  const datei = path.join(DATEN, 'geheim.json');
  if (fs.existsSync(datei)) return JSON.parse(fs.readFileSync(datei, 'utf8'));
  const zufall = () => crypto.randomBytes(24).toString('base64url');
  const g = { vapiToken: zufall(), dashboardApi: zufall(), dashboardIntern: zufall(), n8nSchluessel: zufall(), dashboardPasswort: zufall().slice(0, 16) };
  fs.writeFileSync(datei, JSON.stringify(g, null, 2), { mode: 0o600 });
  return g;
}

function n8nUmgebung(g) {
  return {
    ...process.env,
    N8N_USER_FOLDER: path.join(DATEN, 'n8n'),
    N8N_PORT: String(PORT.n8n),
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_ENCRYPTION_KEY: g.n8nSchluessel,
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_SECURE_COOKIE: 'false',
    GENERIC_TIMEZONE: 'Europe/Berlin',
    TZ: 'Europe/Berlin',
    EXECUTIONS_DATA_PRUNE: 'true',
    EXECUTIONS_DATA_MAX_AGE: '72',
    EXECUTIONS_DATA_HARD_DELETE_BUFFER: '0', // marked executions (with request data) deleted for good within 1 minute
    EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL: '1',
  };
}

function n8nCli(env, ...args) {
  return execFileSync(process.execPath, [N8N_SKRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function n8nVorbereiten(env, g) {
  const ordner = path.join(DATEN, 'workflows');
  execFileSync(process.execPath, [path.join(WURZEL, 'build.js'), '--out', ordner, '--google-auth', 'oauth',
    '--google-api', `http://127.0.0.1:${PORT.google}`, '--kalender', KALENDER, '--dashboard', `http://127.0.0.1:${PORT.dashboard}`], { stdio: 'ignore' });
  const cred = path.join(DATEN, 'credentials.json');
  fs.writeFileSync(cred, JSON.stringify([
    { id: 'praxisVapiToken1', name: 'Vapi Bearer-Token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${g.vapiToken}` } },
    { id: 'praxisGoogleKal1', name: 'Google Kalender Praxis', type: 'googleCalendarOAuth2Api',
      data: { clientId: 'lokal', clientSecret: 'lokal', oauthTokenData: { access_token: GOOGLE_TOKEN, token_type: 'Bearer', refresh_token: 'lokal', expires_in: 315360000 } } },
    { id: 'praxisSmtpMail01', name: 'SMTP Praxis', type: 'smtp', data: { user: '', password: '', host: '127.0.0.1', port: PORT.smtp, secure: false, disableStartTls: true } },
    { id: 'praxisDashIntern', name: 'Dashboard Intern-Token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${g.dashboardIntern}` } },
    { id: 'praxisDashApi001', name: 'Dashboard API-Token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${g.dashboardApi}` } },
  ]), { mode: 0o600 });
  try {
    n8nCli(env, 'import:credentials', `--input=${cred}`);
  } finally {
    fs.rmSync(cred, { force: true }); // unencrypted copy only exists briefly
  }
  n8nCli(env, 'import:workflow', '--separate', `--input=${ordner}`);
  for (const id of ['PraxisTelefon001', 'PraxisDashApi001']) n8nCli(env, 'publish:workflow', `--id=${id}`);
}

function starte(befehl, args, opt, name) {
  const p = spawn(befehl, args, opt);
  p.name = name;
  prozesse.push(p);
  return p;
}

async function warteAufWebhook() {
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT.n8n}${WEBHOOK_PFAD}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (r.status === 401 || r.status === 403) return;
    } catch (e) { /* n8n startet noch */ }
    await warte(1000);
  }
  throw new Error('n8n-Webhook wurde nicht aktiv (siehe lokal/daten/n8n.log)');
}

// Only POST /webhook/vapi-praxis gets through to n8n. The editor and everything else stay private.
function erstelleTorwaechter() {
  return http.createServer((req, res) => {
    const pfad = String(req.url || '').split('?')[0];
    // Telefon-Intro (vapi/intro/erzeugen.js): Vapi holt es zu Beginn jedes Anrufs.
    if ((req.method === 'GET' || req.method === 'HEAD') && pfad === INTRO_PFAD && fs.existsSync(INTRO_DATEI)) {
      const inhalt = fs.readFileSync(INTRO_DATEI);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': inhalt.length, 'cache-control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : inhalt);
    }
    if (req.method !== 'POST' || pfad !== WEBHOOK_PFAD) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Nicht gefunden');
    }
    const weiter = http.request({
      host: '127.0.0.1', port: PORT.n8n, method: 'POST', path: WEBHOOK_PFAD,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      },
      timeout: 25000,
    }, (antwort) => {
      res.writeHead(antwort.statusCode, { 'content-type': antwort.headers['content-type'] || 'application/json' });
      antwort.pipe(res);
    });
    weiter.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
    weiter.on('timeout', () => weiter.destroy());
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      weiter.destroy();
      res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
      return res.end('Anfrage zu groß');
    }
    let groesse = 0;
    req.on('data', (c) => {
      groesse += c.length;
      if (groesse > MAX_BODY && !res.headersSent) {
        weiter.destroy();
        res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
        res.end('Anfrage zu groß');
        req.unpipe(weiter);
      }
    });
    req.pipe(weiter);
  });
}

function starteTunnel() {
  return new Promise((resolve, reject) => {
    const p = starte(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT.torwaechter}`], {}, 'cloudflared');
    const tunnelLog = fs.createWriteStream(path.join(DATEN, 'tunnel.log'));
    let fertig = false;
    const pruefen = (d) => {
      tunnelLog.write(d);
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !fertig) { fertig = true; resolve(m[0]); }
    };
    p.stdout.on('data', pruefen);
    p.stderr.on('data', pruefen);
    p.on('exit', (code) => { if (!fertig) reject(new Error(`cloudflared beendet (Code ${code}), siehe lokal/daten/tunnel.log`)); });
    setTimeout(() => { if (!fertig) reject(new Error('Tunnel-Adresse kam nicht innerhalb von 60 s (siehe lokal/daten/tunnel.log)')); }, 60000);
  });
}

async function warteBisTunnelErreichbar(url) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${url}${WEBHOOK_PFAD}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (r.status === 401 || r.status === 403) return true;
    } catch (e) { /* DNS braucht einen Moment */ }
    await warte(2000);
  }
  return false;
}

let beendenLaeuft = false;
function beenden() {
  beendenLaeuft = true;
  for (const p of prozesse) {
    if (p.exitCode !== null) continue;
    if (WIN) { try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* schon beendet */ } } else p.kill();
  }
}

async function main() {
  voraussetzungen();
  const g = geheimnisse();
  const env = n8nUmgebung(g);

  log('Testkalender und Test-Mailserver starten …');
  const google = erstelleGoogleAttrappe({ kalender: KALENDER, token: GOOGLE_TOKEN, speicherDatei: path.join(DATEN, 'kalender.json') });
  await lauschen(google.server, PORT.google, 'Testkalender');
  const smtp = erstelleSmtpAttrappe({
    beiMail: (mail) => {
      const betreff = (mail.match(/^Subject: (.*)$/m) || [])[1] || '(ohne Betreff)';
      log(`E-Mail an die Praxis: ${betreff.replace(/=\?utf-8\?[BQ]\?.*?\?=/gi, '(kodiert)')}`);
    },
  });
  await lauschen(smtp.server, PORT.smtp, 'Test-Mailserver');

  log('n8n vorbereiten (Workflows und Zugangsdaten importieren) …');
  n8nVorbereiten(env, g);
  log('n8n starten (dauert beim ersten Mal bis zu einer Minute) …');
  const n8nLog = fs.createWriteStream(path.join(DATEN, 'n8n.log'));
  const n8n = starte(process.execPath, [N8N_SKRIPT, 'start'], { env }, 'n8n');
  n8n.stdout.pipe(n8nLog);
  n8n.stderr.pipe(n8nLog);
  await warteAufWebhook();
  log('n8n läuft, Workflows sind aktiv.');

  const benutzer = new Benutzer(path.join(DATEN, 'benutzer.json'));
  if (!benutzer.existiert('praxis')) benutzer.setzen('praxis', g.dashboardPasswort);
  const config = { ...require('../src/config'), kalenderId: KALENDER };
  const dashboard = erstelleDashboard({
    config, modus: 'live', benutzer,
    kalender: new N8nKalender({ url: `http://127.0.0.1:${PORT.n8n}/webhook/praxis-dashboard`, token: g.dashboardApi }),
    speicher: new RueckrufSpeicher(path.join(DATEN, 'rueckrufe.sqlite')),
    internToken: g.dashboardIntern, n8nKonfiguriert: true, protokoll: log,
  });
  await lauschen(dashboard, PORT.dashboard, 'Dashboard');

  const torwaechter = erstelleTorwaechter();
  await lauschen(torwaechter, PORT.torwaechter, 'Torwächter');
  log('Tunnel öffnen (Cloudflare, kostenlos) …');
  const tunnel = await starteTunnel();
  const erreichbar = await warteBisTunnelErreichbar(tunnel);

  for (const p of [n8n, prozesse.find((x) => x.name === 'cloudflared')]) {
    p.on('exit', (code) => {
      if (beendenLaeuft) return;
      console.error(`\nFehler: ${p.name} wurde unerwartet beendet (Code ${code}). Alles wird gestoppt – bitte neu starten.`);
      beenden();
      process.exit(1);
    });
  }

  const webhook = `${tunnel}${WEBHOOK_PFAD}`;
  // Für vapi/einrichten.js --lokal: aktuelle Tunnel-Adresse (ändert sich bei jedem Start).
  fs.writeFileSync(path.join(DATEN, 'aktuell.json'), JSON.stringify({ webhook, gestartet: new Date().toISOString() }, null, 2));
  console.log(`
════════════════════════════════════════════════════════════════════════
 Alles läuft.${erreichbar ? '' : '  (Tunnel noch nicht bestätigt, ggf. eine Minute warten)'}

 DASHBOARD      http://127.0.0.1:${PORT.dashboard}
                Benutzer: praxis   Passwort: ${g.dashboardPasswort}

 VAPI-WEBHOOK   ${webhook}
                (ändert sich bei jedem Start dieses Skripts)

 Assistent bei Vapi anlegen bzw. auf die neue Adresse umstellen
 (zweites PowerShell-Fenster im Projektordner; Key: dashboard.vapi.ai → API Keys → Private Key):
   $env:VAPI_API_KEY="<privater Key>"
   node vapi/einrichten.js --lokal
 Das Skript holt Adresse und Token selbst und merkt sich alles Weitere.

 Anrufen: auf dem Smartphone dashboard.vapi.ai öffnen → Assistants →
 "Praxis-Telefonassistent" → "Talk to Assistant". Buchungen erscheinen
 sofort im Dashboard (Reiter Termine), Rückrufwünsche unter Rückrufe.

 Beenden: Strg+C
════════════════════════════════════════════════════════════════════════
`);
}

process.on('SIGINT', () => { log('Beende …'); beenden(); process.exit(0); });
process.on('exit', beenden);
main().catch((e) => { console.error(`\nFehler: ${e.message}`); beenden(); process.exit(1); });
