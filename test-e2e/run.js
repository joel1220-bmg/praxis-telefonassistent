// End-to-End-Test: echter n8n-Prozess + gefälschte Google-Calendar-API + gefälschter SMTP-Server.
// Aufruf: N8N_E2E_DIR=<leerer Ordner> npm run e2e   (n8n aus lokal/n8n; anderes n8n: N8N_SKRIPT=<pfad zu n8n/bin/n8n>)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const assert = require('assert/strict');

const N8N_SKRIPT = path.resolve(process.env.N8N_SKRIPT || path.join(__dirname, '..', 'lokal', 'n8n', 'node_modules', 'n8n', 'bin', 'n8n'));
const ORDNER = process.env.N8N_E2E_DIR && path.resolve(process.env.N8N_E2E_DIR);
if (!ORDNER || !fs.existsSync(N8N_SKRIPT)) { console.error('N8N_E2E_DIR setzen; n8n muss in lokal/n8n installiert sein (oder N8N_SKRIPT setzen).'); process.exit(2); }

const PORT_N8N = 15678, PORT_GOOGLE = 18081, PORT_SMTP = 12525, PORT_DASHBOARD = 18090;
const DASH_API_TOKEN = 'e2e-dashboard-api';
const DASH_INTERN_TOKEN = 'e2e-dashboard-intern';
const KALENDER = 'praxis@test';
const TOKEN = 'e2e-geheim-123';

// ---------- Stand-ins (shared with lokal/start.js) ----------
const { erstelleGoogleAttrappe, erstelleSmtpAttrappe } = require('./attrappen');
const googleAttrappe = erstelleGoogleAttrappe({ kalender: KALENDER, token: 'google-test-token' });
const google = googleAttrappe.server;
const termine = googleAttrappe.termine;
const googleAufrufe = googleAttrappe.aufrufe;
const smtpAttrappe = erstelleSmtpAttrappe();
const smtp = smtpAttrappe.server;
const mails = smtpAttrappe.mails;

// ---------- n8n ----------
const env = {
  ...process.env,
  N8N_USER_FOLDER: ORDNER,
  N8N_PORT: String(PORT_N8N),
  EXECUTIONS_DATA_HARD_DELETE_BUFFER: '0', // wie in Produktion: markierte Ausführungen sofort endgültig löschen
  EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL: '1',
  N8N_RUNNERS_BROKER_PORT: '15679', // eigener Port, damit der Test neben lokal/start.js laufen kann
  N8N_ENCRYPTION_KEY: 'e2e-schluessel-nur-fuer-tests',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_SECURE_COOKIE: 'false',
  GENERIC_TIMEZONE: 'Europe/Berlin',
  TZ: 'Europe/Berlin',
  DB_SQLITE_POOL_SIZE: '1',
};
function n8nCli(...args) {
  return execFileSync(process.execPath, [N8N_SKRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function vapi(name, args, { token = TOKEN, message } = {}) {
  const body = message || {
    message: {
      type: 'tool-calls',
      call: { customer: { number: '+4915112345678' } },
      toolCallList: [{ id: `call_${name}`, type: 'function', function: { name, arguments: args } }],
    },
  };
  const res = await fetch(`http://127.0.0.1:${PORT_N8N}/webhook/vapi-praxis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text, ergebnis: json && json.results && json.results[0] && json.results[0].result };
}

const statusOderNull = (f) => f().then((r) => r.status, () => null);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(ORDNER, { recursive: true });
  await new Promise((r) => google.listen(PORT_GOOGLE, '127.0.0.1', r));
  await new Promise((r) => smtp.listen(PORT_SMTP, '127.0.0.1', r));

  const wfOrdner = path.join(ORDNER, 'workflows');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'build.js'), '--out', wfOrdner, '--google-auth', 'oauth',
    '--google-api', `http://127.0.0.1:${PORT_GOOGLE}`, '--kalender', KALENDER, '--dashboard', `http://127.0.0.1:${PORT_DASHBOARD}`]);
  const credPfad = path.join(ORDNER, 'credentials.json');
  fs.writeFileSync(credPfad, JSON.stringify([
    { id: 'praxisVapiToken1', name: 'Vapi Bearer-Token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${TOKEN}` } },
    { id: 'praxisGoogleKal1', name: 'Google Kalender Praxis', type: 'googleCalendarOAuth2Api',
      data: { clientId: 'x', clientSecret: 'y', oauthTokenData: { access_token: 'google-test-token', token_type: 'Bearer', refresh_token: 'r', expires_in: 3600 } } },
    { id: 'praxisSmtpMail01', name: 'SMTP Praxis', type: 'smtp',
      data: { user: '', password: '', host: '127.0.0.1', port: PORT_SMTP, secure: false, disableStartTls: true } },
    { id: 'praxisDashIntern', name: 'Dashboard Intern-Token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${DASH_INTERN_TOKEN}` } },
    { id: 'praxisDashApi001', name: 'Dashboard API-Token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${DASH_API_TOKEN}` } },
  ]));
  console.log(n8nCli('import:credentials', `--input=${credPfad}`).trim());
  console.log(n8nCli('import:workflow', '--separate', `--input=${wfOrdner}`).trim());
  for (const id of ['PraxisTelefon001', 'PraxisDashApi001']) console.log(n8nCli('publish:workflow', `--id=${id}`).trim());
  const dashboard = await starteDashboard();

  const n8n = spawn(process.execPath, [N8N_SKRIPT, 'start'], { env });
  let log = '';
  n8n.stdout.on('data', (d) => { log += d; });
  n8n.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT_N8N}/healthz`)).ok) break; } catch (e) { /* startet noch */ }
      if (i > 120) throw new Error(`n8n startet nicht:\n${log.slice(-3000)}`);
      await warte(1000);
    }
    // n8n 2.x veröffentlicht Workflows asynchron nach dem Start: warten, bis der Webhook existiert.
    for (let i = 0; ![401, 403].includes(await statusOderNull(() => vapi('warten', {}, { token: null }))); i++) {
      if (i > 120) throw new Error('Webhook wurde nicht registriert');
      await warte(1000);
    }
    for (let i = 0; ![401, 403].includes(await statusOderNull(() => dashboardApi({}, null))); i++) {
      if (i > 120) throw new Error('Dashboard-Webhook wurde nicht registriert');
      await warte(1000);
    }
    await szenarien();
    await dashboardSzenarien(dashboard);
    await datenschutzPruefen();
    console.log('\nALLE E2E-SZENARIEN BESTANDEN');
  } catch (e) {
    console.error('\nn8n-Log (Ende):\n' + log.slice(-4000));
    throw e;
  } finally {
    beenden(n8n);
    google.close(); smtp.close();
    if (dashboard.server.listening) dashboard.server.close();
  }
}

// ---------- Dashboard (echter Server im Live-Modus gegen dieses n8n) ----------
async function starteDashboard() {
  const { erstelleDashboard } = require('../dashboard/server');
  const { RueckrufSpeicher } = require('../dashboard/speicher');
  const { Benutzer, hashen } = require('../dashboard/benutzer');
  const { N8nKalender } = require('../dashboard/kalender');
  const config = { ...require('../src/config'), kalenderId: KALENDER };
  const speicher = new RueckrufSpeicher(':memory:');
  const kalender = new N8nKalender({ url: `http://127.0.0.1:${PORT_N8N}/webhook/praxis-dashboard`, token: DASH_API_TOKEN });
  const server = erstelleDashboard({
    config, modus: 'live', kalender, speicher, benutzer: new Benutzer(null, { team: hashen('e2e-passwort-lang') }),
    internToken: DASH_INTERN_TOKEN, n8nKonfiguriert: true, protokoll: () => {},
  });
  await new Promise((r) => server.listen(PORT_DASHBOARD, '127.0.0.1', r));
  let cookie = '';
  const rufe = async (methode, pfad, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT_DASHBOARD}${pfad}`, {
      method: methode,
      headers: { ...(body ? { 'content-type': 'application/json', 'x-praxis-anfrage': '1' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const c = res.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { server, speicher, rufe };
}

async function dashboardApi(body, token = DASH_API_TOKEN) {
  const res = await fetch(`http://127.0.0.1:${PORT_N8N}/webhook/praxis-dashboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function dashboardSzenarien(d) {
  schritt('Dashboard-API in n8n: ohne/falschen Token abgewiesen, unbekannte Aktion');
  assert.ok([401, 403].includes((await dashboardApi({ aktion: 'termine' }, null)).status));
  assert.ok([401, 403].includes((await dashboardApi({ aktion: 'termine' }, 'falsch')).status));
  const unbekannt = await dashboardApi({ aktion: 'alles_loeschen' });
  assert.equal(unbekannt.status, 200);
  assert.deepEqual(unbekannt.json, { ok: false, fehler: 'unbekannte Aktion' });

  schritt('Telefon-Buchung erscheint im Dashboard, Praxis-Termin ebenfalls');
  const suche = await vapi('freie_termine_suchen', { terminart: 'kontrolle' });
  const start = suche.ergebnis.match(/\[start=([^\]]+)\]/)[1];
  const buchung = await vapi('termin_buchen', { terminart: 'kontrolle', start, vorname: 'Karl', nachname: 'Berg', geburtsdatum: '1970-01-02' });
  assert.match(buchung.ergebnis, /^Gebucht/);
  const tag = start.slice(0, 10);
  termine.set('praxisTermin01', {
    id: 'praxisTermin01', status: 'confirmed', summary: 'Hausbesuch Frau Kurz',
    start: { dateTime: `${tag}T18:00:00+02:00` }, end: { dateTime: `${tag}T18:45:00+02:00` },
  });

  assert.equal((await d.rufe('GET', `/api/termine?von=${tag}`)).status, 401);
  assert.equal((await d.rufe('POST', '/api/login', { benutzer: 'team', passwort: 'e2e-passwort-lang' })).status, 200);
  const liste = await d.rufe('GET', `/api/termine?von=${tag}`);
  assert.equal(liste.status, 200, JSON.stringify(liste.json));
  const tel = liste.json.termine.find((t) => t.titel === 'Kontrolltermin: Berg, Karl');
  assert.ok(tel, JSON.stringify(liste.json));
  assert.equal(tel.quelle, 'telefonassistent');
  assert.match(tel.beschreibung, /Geburtsdatum: 1970-01-02/);
  assert.equal(liste.json.termine.find((t) => t.id === 'praxisTermin01').quelle, 'praxis');
  console.log(liste.json.termine.map((t) => `${t.start.slice(11, 16)} ${t.titel} [${t.quelle}]`).join('\n'));

  schritt('Rückrufwunsch vom Telefon ist im Dashboard gelandet');
  const rueckrufe = (await d.rufe('GET', '/api/rueckrufe')).json;
  assert.equal(rueckrufe.zaehler.offen, 1);
  assert.equal(rueckrufe.rueckrufe[0].nachname, 'Meier');
  assert.equal(rueckrufe.rueckrufe[0].kategorie, 'rezept');
  assert.equal(rueckrufe.rueckrufe[0].dringend, true);
  assert.equal(rueckrufe.rueckrufe[0].telefon, '+4915112345678');

  schritt('Auslastung und Status mit echten Daten aus n8n');
  const a = await d.rufe('GET', '/api/auslastung');
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const tagEintrag = a.json.tage.find((t) => t.datum === tag);
  if (tagEintrag) assert.ok(tagEintrag.gebuchtMinuten >= 15, JSON.stringify(tagEintrag));
  const s = (await d.rufe('GET', '/api/status')).json;
  assert.equal(s.n8n.ok, true);
  assert.equal(s.kalender.ok, true);

  schritt('Absage im Dashboard löscht den Termin im Kalender');
  const abgesagt = await d.rufe('POST', '/api/termine/absagen', { id: tel.id });
  assert.equal(abgesagt.status, 200, JSON.stringify(abgesagt.json));
  assert.equal(termine.has(tel.id), false);
  const nochmal = await d.rufe('POST', '/api/termine/absagen', { id: tel.id });
  assert.equal(nochmal.status, 409);
  assert.match(nochmal.json.fehler, /nicht gefunden/);

  schritt('Google-Ausfall im Dashboard → verständliche Meldung');
  googleAttrappe.zustand.kaputt = true;
  const kaputt = await d.rufe('GET', `/api/termine?von=${tag}`);
  googleAttrappe.zustand.kaputt = false;
  assert.equal(kaputt.status, 502);
  assert.equal(kaputt.json.fehler, 'Kalender nicht erreichbar');

  schritt('Dashboard offline → Rückruf geht trotzdem per E-Mail raus');
  await new Promise((r) => d.server.close(r));
  const mailsVorher = mails.length;
  const offline = await vapi('rueckruf_notieren', { vorname: 'Eva', nachname: 'Lang', kategorie: 'befund', anliegen: 'Befund Röntgen' });
  assert.match(offline.ergebnis, /übermittelt/);
  await warte(300);
  assert.equal(mails.length, mailsVorher + 1);
}

function beenden(proc) {
  if (process.platform !== 'win32') { proc.kill(); return; }
  // Unter Windows startet n8n über eine .cmd-Datei: den ganzen Prozessbaum beenden.
  try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* schon beendet */ }
}

function schritt(name) { console.log(`\n▶ ${name}`); }

async function szenarien() {
  schritt('Ohne Token → abgewiesen');
  const ohne = await vapi('freie_termine_suchen', { terminart: 'akut' }, { token: null });
  assert.ok([401, 403].includes(ohne.status), `Status ${ohne.status}`);
  const falsch = await vapi('freie_termine_suchen', { terminart: 'akut' }, { token: 'falsch' });
  assert.ok([401, 403].includes(falsch.status), `Status ${falsch.status}`);
  assert.equal(googleAufrufe.length, 0);

  schritt('Freie Termine suchen');
  const suche1 = await vapi('freie_termine_suchen', { terminart: 'akut' });
  assert.equal(suche1.status, 200, suche1.text);
  console.log(suche1.ergebnis);
  const start1 = suche1.ergebnis.match(/\[start=([^\]]+)\]/)[1];
  assert.equal(suche1.json.results[0].toolCallId, 'call_freie_termine_suchen');

  schritt('Fremdtermin im Kalender blockiert diesen Slot');
  googleAttrappe.zustand.fremdBelegt = [{ start: start1, end: new Date(Date.parse(start1) + 15 * 60000).toISOString() }];
  const suche2 = await vapi('freie_termine_suchen', { terminart: 'akut' });
  assert.ok(!suche2.ergebnis.includes(start1), suche2.ergebnis);
  const buchenBelegt = await vapi('termin_buchen', {
    terminart: 'akut', start: start1, vorname: 'Anna', nachname: 'Meier', geburtsdatum: '1980-05-17',
  });
  assert.match(buchenBelegt.ergebnis, /inzwischen vergeben/);
  assert.equal(termine.size, 0);
  googleAttrappe.zustand.fremdBelegt = [];

  schritt('Termin buchen');
  const start2 = suche2.ergebnis.match(/\[start=([^\]]+)\]/)[1];
  const buchung = { terminart: 'akut', start: start2, vorname: 'Anna', nachname: 'Meier', geburtsdatum: '17.05.1980', versicherung: 'gesetzlich', anliegen: 'Halsschmerzen' };
  const gebucht = await vapi('termin_buchen', buchung);
  console.log(gebucht.ergebnis);
  assert.match(gebucht.ergebnis, /^Gebucht: Akutsprechstunde/);
  assert.equal(termine.size, 1);
  const ev = [...termine.values()][0];
  assert.equal(ev.summary, 'Akutsprechstunde: Meier, Anna');
  assert.equal(ev.extendedProperties.private.gebdat, '1980-05-17');
  assert.match(ev.description, /Telefon: \+4915112345678/);

  schritt('Doppelte Buchung (z. B. Wiederholung durch Vapi) wird erkannt');
  const doppelt = await vapi('termin_buchen', buchung);
  assert.match(doppelt.ergebnis, /bereits gebucht/);
  assert.equal(termine.size, 1);

  schritt('Ungültiger Slot wird ohne Kalenderzugriff abgelehnt');
  const vorher = googleAufrufe.length;
  const krumm = await vapi('termin_buchen', { ...buchung, start: start2.replace(/:\d0:00/, ':07:00') });
  assert.match(krumm.ergebnis, /kein buchbarer Termin/);
  assert.equal(googleAufrufe.length, vorher);

  schritt('Termine finden (Schreibvariante "Meyer")');
  const gefunden = await vapi('termine_finden', { nachname: 'Meyer', geburtsdatum: '1980-05-17' });
  console.log(gefunden.ergebnis);
  const id = gefunden.ergebnis.match(/termin_id=([^\]]+)\]/)[1];
  assert.equal(id, ev.id);
  const fremd = await vapi('termine_finden', { nachname: 'Schulz', geburtsdatum: '1980-05-17' });
  assert.match(fremd.ergebnis, /Keine zukünftigen Termine/);

  schritt('Absage mit falschem Geburtsdatum wird verweigert');
  const falschAbsage = await vapi('termin_absagen', { termin_id: id, nachname: 'Meier', geburtsdatum: '1981-05-17' });
  assert.match(falschAbsage.ergebnis, /Nichts abgesagt/);
  assert.equal(termine.size, 1);

  schritt('Absage einer unbekannten ID (404 von Google)');
  const unbekannt = await vapi('termin_absagen', { termin_id: 'gibtesnicht1', nachname: 'Meier', geburtsdatum: '1980-05-17' });
  assert.equal(unbekannt.status, 200, unbekannt.text);
  assert.match(unbekannt.ergebnis, /Nichts abgesagt/);

  schritt('Termin absagen');
  const abgesagt = await vapi('termin_absagen', { termin_id: id, nachname: 'Meier', geburtsdatum: '1980-05-17' });
  console.log(abgesagt.ergebnis);
  assert.match(abgesagt.ergebnis, /^Abgesagt: Termin am/);
  assert.equal(termine.size, 0);

  schritt('Rückrufwunsch per E-Mail');
  const rueckruf = await vapi('rueckruf_notieren', {
    vorname: 'Anna', nachname: 'Meier', geburtsdatum: '1980-05-17', kategorie: 'rezept', dringend: true, anliegen: 'Folgerezept Ramipril',
  });
  assert.match(rueckruf.ergebnis, /übermittelt/);
  await warte(300);
  assert.equal(mails.length, 1);
  assert.match(mails[0], /Subject: .*DRINGEND/);
  assert.match(mails[0], /To: empfang@praxis-muster\.de/);
  assert.match(mails[0], /Ramipril/);

  schritt('Ungültige Eingaben und fremde Nachrichtentypen');
  const ungueltig = await vapi('termin_buchen', { terminart: 'akut' });
  assert.match(ungueltig.ergebnis, /^Fehler: /);
  const unbekanntesTool = await vapi('datenbank_loeschen', {});
  assert.match(unbekanntesTool.ergebnis, /Unbekanntes Werkzeug/);
  const status = await vapi(null, null, { message: { message: { type: 'status-update', status: 'in-progress' } } });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { results: [] });

  schritt('Google-Ausfall → verständliche Antwort statt Absturz');
  googleAttrappe.zustand.kaputt = true;
  const ausfall = await vapi('freie_termine_suchen', { terminart: 'akut' });
  assert.equal(ausfall.status, 200, ausfall.text);
  assert.match(ausfall.ergebnis, /Technischer Fehler/);
  const ausfallBuchen = await vapi('termin_buchen', { ...buchung, start: start2 });
  assert.match(ausfallBuchen.ergebnis, /NICHT gebucht/);
  googleAttrappe.zustand.kaputt = false;

}

// n8n first only marks successful executions for deletion (with the request data still in them).
// With EXECUTIONS_DATA_HARD_DELETE_BUFFER=0 they must be gone for good within a few minutes.
async function datenschutzPruefen() {
  schritt('Keine Anfragedaten (Token, Patientendaten) bleiben in der n8n-Datenbank');
  const { DatabaseSync } = require('node:sqlite');
  const spuren = ['e2e-geheim-123', 'Ramipril', 'Berg', '1980-05-17'];
  let stand = null;
  for (let i = 0; i < 40; i++) {
    const db = new DatabaseSync(path.join(ORDNER, '.n8n', 'database.sqlite'), { readOnly: true });
    const ausfuehrungen = db.prepare('SELECT COUNT(*) AS n FROM execution_entity').get().n;
    const mitDaten = db.prepare(`SELECT COUNT(*) AS n FROM execution_data WHERE ${spuren.map(() => 'data LIKE ?').join(' OR ')}`)
      .get(...spuren.map((s) => `%${s}%`)).n;
    db.close();
    stand = { ausfuehrungen, mitDaten };
    if (ausfuehrungen === 0 && mitDaten === 0) break;
    await warte(5000);
  }
  console.log(`Ausführungen in der Datenbank: ${stand.ausfuehrungen}, davon mit Anfragedaten: ${stand.mitDaten}`);
  assert.deepEqual(stand, { ausfuehrungen: 0, mitDaten: 0 }, 'n8n hält noch Ausführungsdaten vor');
}

main().catch((e) => { console.error(e); process.exit(1); });
