const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { makeLib } = require('../src/lib');
const basisConfig = require('../src/config');
const { erstelleDashboard } = require('../dashboard/server');
const { RueckrufSpeicher } = require('../dashboard/speicher');
const { Benutzer } = require('../dashboard/benutzer');
const { DemoKalender } = require('../dashboard/kalender');

const lib = makeLib(DateTime);
const config = { ...basisConfig, kalenderId: 'praxis@test' };
const INTERN = 'intern-token-test';
const protokoll = [];

async function starteServer(extra = {}) {
  const speicher = new RueckrufSpeicher(':memory:');
  const benutzer = extra.benutzer || new Benutzer(null, { anna: require('../dashboard/benutzer').hashen('richtig-langes-passwort') });
  const kalender = extra.kalender || new DemoKalender(config, lib);
  const server = erstelleDashboard({
    config, modus: 'demo', kalender, benutzer, speicher, internToken: INTERN,
    protokoll: (m) => protokoll.push(m), https: !!extra.https, ...extra,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const rufe = async (methode, pfad, body, header = {}) => {
    const res = await fetch(basis + pfad, {
      method: methode,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json', 'x-praxis-anfrage': '1' } : {}),
        ...(cookie ? { cookie } : {}),
        ...header,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* HTML */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const anmelden = async (benutzerName = 'anna', passwort = 'richtig-langes-passwort') => {
    const r = await rufe('POST', '/api/login', { benutzer: benutzerName, passwort });
    const c = r.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return r;
  };
  return { server, speicher, kalender, rufe, anmelden, schliessen: () => new Promise((r) => server.close(r)) };
}

test('Statische Seite mit Sicherheits-Headern, API nur mit Anmeldung', async () => {
  const d = await starteServer();
  try {
    const seite = await d.rufe('GET', '/');
    assert.equal(seite.status, 200);
    assert.match(seite.text, /Praxis-Dashboard/);
    assert.match(seite.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(seite.headers.get('x-frame-options'), 'DENY');
    for (const pfad of ['/api/ich', '/api/termine?von=2026-09-28', '/api/rueckrufe', '/api/auslastung', '/api/einstellungen', '/api/status']) {
      assert.equal((await d.rufe('GET', pfad)).status, 401, pfad);
    }
    assert.equal((await d.rufe('GET', '/etc/passwd')).status, 404);
    assert.equal((await d.rufe('GET', '/../src/config.js')).status, 404);
  } finally { await d.schliessen(); }
});

test('Login: falsches Passwort, Sperre nach 5 Fehlversuchen, Cookie-Attribute, Abmelden', async () => {
  const d = await starteServer();
  try {
    assert.equal((await d.anmelden('anna', 'falsch')).status, 401);
    assert.equal((await d.anmelden('gibtsnicht', 'falsch')).status, 401);
    const ok = await d.anmelden();
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.equal((await d.rufe('GET', '/api/ich')).json.benutzer, 'anna');
    assert.equal((await d.rufe('POST', '/api/logout', {})).status, 200);
    assert.equal((await d.rufe('GET', '/api/ich')).status, 401, 'Sitzung nach Abmelden ungültig');

    for (let i = 0; i < 5; i++) await d.anmelden('anna', 'falsch');
    const gesperrt = await d.anmelden();
    assert.equal(gesperrt.status, 429, 'auch richtiges Passwort während der Sperre abgelehnt');
    assert.ok(protokoll.some((m) => m.includes('Fehlgeschlagener Login')));
  } finally { await d.schliessen(); }
});

test('Secure-Cookie bei HTTPS', async () => {
  const d = await starteServer({ https: true });
  try {
    assert.match((await d.anmelden()).headers.get('set-cookie'), /; Secure/);
  } finally { await d.schliessen(); }
});

test('CSRF-Schutz und Anfragegrenzen', async () => {
  const d = await starteServer();
  try {
    await d.anmelden();
    const ohneHeader = await d.rufe('POST', '/api/rueckrufe/erledigt', undefined, { 'content-type': 'application/json' });
    assert.equal(ohneHeader.status, 403);
    const formular = await d.rufe('POST', '/api/logout', undefined, { 'content-type': 'application/x-www-form-urlencoded', 'x-praxis-anfrage': '1' });
    assert.equal(formular.status, 415);
    const riesig = await d.rufe('POST', '/api/termine/absagen', { id: 'x'.repeat(20000) });
    assert.equal(riesig.status, 413);
    const kaputt = await d.rufe('POST', '/api/termine/absagen', '{kein json');
    assert.equal(kaputt.status, 400);
  } finally { await d.schliessen(); }
});

test('Termine: Tagesliste, Validierung, Absage nur für zukünftige Termine', async () => {
  const d = await starteServer();
  try {
    await d.anmelden();
    const heute = DateTime.now().setZone(config.zeitzone);
    // einen Werktag mit Terminen in der Zukunft suchen
    let tag = heute.plus({ days: 1 });
    let liste = [];
    for (let i = 0; i < 10 && !liste.length; i++, tag = tag.plus({ days: 1 })) {
      liste = (await d.rufe('GET', `/api/termine?von=${tag.toISODate()}`)).json.termine;
    }
    assert.ok(liste.length > 0, 'Demo-Daten enthalten Termine');
    const t = liste[0];
    assert.ok(t.id && t.titel && t.start && t.ende);
    assert.ok(['telefonassistent', 'praxis'].includes(t.quelle));
    assert.ok(liste.some((x) => x.quelle === 'telefonassistent') || liste.length < 3);

    assert.equal((await d.rufe('GET', '/api/termine?von=28.09.2026')).status, 400);
    assert.equal((await d.rufe('GET', `/api/termine?von=${heute.toISODate()}&bis=${heute.plus({ days: 40 }).toISODate()}`)).status, 400);

    const abgesagt = await d.rufe('POST', '/api/termine/absagen', { id: t.id });
    assert.equal(abgesagt.status, 200, abgesagt.text);
    assert.equal(abgesagt.json.abgesagt.id, t.id);
    const danach = (await d.rufe('GET', `/api/termine?von=${t.start.slice(0, 10)}`)).json.termine;
    assert.ok(!danach.some((x) => x.id === t.id));
    assert.equal((await d.rufe('POST', '/api/termine/absagen', { id: t.id })).status, 409, 'zweimal absagen');

    let vergangen = [];
    for (let i = 1; i <= 5 && !vergangen.length; i++) {
      vergangen = (await d.rufe('GET', `/api/termine?von=${heute.minus({ days: i }).toISODate()}`)).json.termine;
    }
    if (vergangen.length) {
      const r = await d.rufe('POST', '/api/termine/absagen', { id: vergangen[0].id });
      assert.equal(r.status, 409);
      assert.match(r.json.fehler, /zukünftige/);
    }
    assert.ok(protokoll.some((m) => m.includes('Termin abgesagt von anna')));
  } finally { await d.schliessen(); }
});

test('Rückrufe: n8n-Endpunkt mit Token, Liste, erledigen, Aufräumen', async () => {
  const d = await starteServer();
  try {
    const eintrag = { vorname: 'Anna', nachname: 'Meier', geburtsdatum: '1980-05-17', telefon: '+4915112345678', kategorie: 'rezept', dringend: false, anliegen: 'Folgerezept', eingegangen: '2026-09-28T09:00:00+02:00' };
    const ohne = await d.rufe('POST', '/intern/rueckruf', JSON.stringify(eintrag), { 'content-type': 'application/json' });
    assert.equal(ohne.status, 401);
    const falsch = await d.rufe('POST', '/intern/rueckruf', JSON.stringify(eintrag), { 'content-type': 'application/json', authorization: 'Bearer falsch' });
    assert.equal(falsch.status, 401);
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${INTERN}` };
    assert.equal((await d.rufe('POST', '/intern/rueckruf', JSON.stringify(eintrag), auth)).status, 201);
    const dringend = { ...eintrag, nachname: 'Wolf', kategorie: 'unsinn', dringend: true, anliegen: 'x'.repeat(900) };
    assert.equal((await d.rufe('POST', '/intern/rueckruf', JSON.stringify(dringend), auth)).status, 201);
    assert.equal((await d.rufe('POST', '/intern/rueckruf', JSON.stringify({ vorname: 'X' }), auth)).status, 400);

    await d.anmelden();
    const offen = (await d.rufe('GET', '/api/rueckrufe')).json;
    assert.deepEqual(offen.zaehler, { offen: 2, dringend: 1 });
    assert.equal(offen.rueckrufe[0].nachname, 'Wolf', 'dringende zuerst');
    assert.equal(offen.rueckrufe[0].kategorie, 'sonstiges', 'unbekannte Kategorie abgefangen');
    assert.equal(offen.rueckrufe[0].anliegen.length, 500, 'Länge begrenzt');

    const id = offen.rueckrufe[0].id;
    assert.equal((await d.rufe('POST', '/api/rueckrufe/erledigt', { id })).status, 200);
    assert.equal((await d.rufe('POST', '/api/rueckrufe/erledigt', { id })).status, 404, 'schon erledigt');
    assert.equal((await d.rufe('POST', '/api/rueckrufe/erledigt', { id: 'abc' })).status, 404);
    const erledigt = (await d.rufe('GET', '/api/rueckrufe?status=erledigt')).json.rueckrufe;
    assert.equal(erledigt.length, 1);
    assert.equal(erledigt[0].erledigt_von, 'anna');

    assert.equal(d.speicher.aufraeumen('2000-01-01T00:00:00Z'), 0, 'junge Einträge bleiben');
    assert.equal(d.speicher.aufraeumen('2999-01-01T00:00:00Z'), 1, 'alte erledigte werden gelöscht');
    assert.equal(d.speicher.zaehlen().offen, 1, 'offene bleiben immer');
  } finally { await d.schliessen(); }
});

test('Auslastung, Einstellungen, Status', async () => {
  const d = await starteServer();
  try {
    await d.anmelden();
    const a = (await d.rufe('GET', '/api/auslastung')).json;
    assert.equal(a.tage.length, 14);
    for (const t of a.tage) {
      const wt = DateTime.fromISO(t.datum).weekday;
      if (wt >= 6) assert.equal(t.prozent, null, `${t.datum} Wochenende`);
      if (t.prozent !== null) assert.ok(t.prozent >= 0 && t.prozent <= 100);
    }
    assert.equal(a.naechsteFreie.length, Object.keys(config.terminarten).length);
    assert.ok(a.naechsteFreie.some((n) => n.start), 'irgendein freier Termin in 14 Tagen');

    const e = (await d.rufe('GET', '/api/einstellungen')).json;
    assert.deepEqual(e.sprechzeiten, config.sprechzeiten);
    assert.doesNotMatch(JSON.stringify(e), /token|googleApi|kalenderId/i, 'keine internen Werte');

    const s = (await d.rufe('GET', '/api/status')).json;
    assert.equal(s.kalender.ok, true);
    assert.equal(s.checkliste.find((c) => c.punkt.startsWith('Live-Modus')).ok, false);
  } finally { await d.schliessen(); }
});

test('Kalender-Ausfall: verständliche Fehlermeldung statt Absturz', async () => {
  const kaputt = {
    termine: async () => ({ ok: false, fehler: 'n8n nicht erreichbar' }),
    absagen: async () => ({ ok: false, fehler: 'n8n nicht erreichbar' }),
    erreichbar: async () => ({ ok: false, fehler: 'nicht erreichbar' }),
  };
  const d = await starteServer({ kalender: kaputt });
  try {
    await d.anmelden();
    const t = await d.rufe('GET', '/api/termine?von=2026-09-28');
    assert.equal(t.status, 502);
    assert.equal(t.json.fehler, 'n8n nicht erreichbar');
    assert.equal((await d.rufe('GET', '/api/auslastung')).status, 502);
    const s = await d.rufe('GET', '/api/status');
    assert.equal(s.status, 200);
    assert.equal(s.json.n8n.ok, false);
    assert.equal(s.json.kalender.ok, false);
    assert.equal((await d.rufe('GET', '/api/rueckrufe')).status, 200, 'Rückrufe funktionieren weiter');
  } finally { await d.schliessen(); }
});

test('n8n-Dashboard-API: Validierung und Aufbereitung', () => {
  const jetzt = '2026-09-28T07:00:00+02:00';
  const t = lib.dashboardVorbereiten(config, { aktion: 'termine', von: '2026-09-28', bis: '2026-09-30' }, jetzt);
  assert.equal(t.route, lib.DASHBOARD_ROUTE.termine);
  assert.match(decodeURIComponent(t.http.url), /calendars\/praxis@test\/events\?timeMin=2026-09-28T00:00:00\+02:00&timeMax=2026-09-30T23:59:59/);
  for (const [body, muster] of [
    [{ aktion: 'termine', von: '2026-09-30', bis: '2026-09-28' }, /ungültig/],
    [{ aktion: 'termine', von: '2026-09-01', bis: '2026-12-01' }, /31 Tage/],
    [{ aktion: 'absagen', id: '../x' }, /ungültig/],
    [{ aktion: 'loeschen_alles' }, /unbekannte Aktion/],
    [null, /unbekannte Aktion/],
  ]) {
    const v = lib.dashboardVorbereiten(config, body, jetzt);
    assert.equal(v.route, lib.DASHBOARD_ROUTE.direkt);
    assert.match(v.antwort.fehler, muster);
  }
  const liste = lib.dashboardTermine(config, { items: [
    { id: 'a1', status: 'confirmed', summary: 'Kontrolltermin: Meier, Anna', description: 'Terminart: X\nTelefon: +49',
      start: { dateTime: '2026-09-28T06:00:00Z' }, end: { dateTime: '2026-09-28T06:15:00Z' },
      extendedProperties: { private: { quelle: 'telefonassistent' } } },
    { id: 'b2', status: 'confirmed', summary: 'Fortbildung', start: { date: '2026-09-29' }, end: { date: '2026-09-30' } },
    { id: 'c3', status: 'cancelled', start: { dateTime: '2026-09-28T07:00:00Z' }, end: { dateTime: '2026-09-28T07:15:00Z' } },
  ] });
  assert.equal(liste.termine.length, 2);
  assert.equal(liste.termine[0].start, '2026-09-28T08:00:00+02:00');
  assert.equal(liste.termine[0].quelle, 'telefonassistent');
  assert.equal(liste.termine[0].beschreibung, 'Terminart: X\nTelefon: +49');
  assert.equal(liste.termine[1].ganztaegig, true);
  assert.equal(liste.termine[1].quelle, 'praxis');
  assert.equal(lib.dashboardTermine(config, { error: {} }).ok, false);

  const absage = lib.dashboardVorbereiten(config, { aktion: 'absagen', id: 'abc123' }, jetzt);
  const zukunft = { id: 'abc123', start: { dateTime: '2026-09-29T08:00:00+02:00' }, end: { dateTime: '2026-09-29T08:15:00+02:00' } };
  assert.equal(lib.dashboardAbsagePruefen(config, absage, zukunft).http.method, 'DELETE');
  assert.equal(lib.dashboardAbsagePruefen(config, absage, { ...zukunft, start: { dateTime: '2026-09-27T08:00:00+02:00' } }).ok, false);
  assert.equal(lib.dashboardAbsagePruefen(config, absage, { error: { code: 404 } }).ok, false);
  assert.equal(lib.dashboardNachAbsage({ termin: { id: 'abc123' } }, { error: {} }).ok, false);
});

test('Kaputte Anfrage-Adresse bringt den Server nicht zum Absturz', async () => {
  const d = await starteServer();
  try {
    const net = require('node:net');
    const { port } = d.server.address();
    for (const zeile of ['GET //[x/api/status HTTP/1.1', 'GET http://[kaputt/api HTTP/1.1']) {
      const antwort = await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`${zeile}\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let daten = '';
        s.on('data', (c) => { daten += c; });
        s.on('end', () => resolve(daten));
        s.on('error', reject);
      });
      assert.match(antwort, /^HTTP\/1\.1 400/, zeile);
    }
    assert.equal((await d.rufe('GET', '/gesund')).status, 200, 'Server läuft weiter');
    assert.equal((await d.rufe('POST', '/api/login', 'null')).status, 400, 'JSON null → 400 statt 500');
  } finally { await d.schliessen(); }
});

test('Auslastung: Überlappungen, als frei markierte und ganztägige Termine', async () => {
  const termin = (start, ende, extra = {}) => ({ id: `t${start}`, titel: 'X', start, ende, ganztaegig: false, frei: false, quelle: 'praxis', ...extra });
  const kalender = {
    termine: async () => ({ ok: true, termine: [
      termin('2026-09-28T08:00:00+02:00', '2026-09-28T09:00:00+02:00'),
      termin('2026-09-28T08:00:00+02:00', '2026-09-28T09:00:00+02:00'), // parallel, darf nicht doppelt zählen
      termin('2026-09-28T08:30:00+02:00', '2026-09-28T08:45:00+02:00'), // liegt innerhalb
      termin('2026-09-28T10:00:00+02:00', '2026-09-28T11:00:00+02:00', { frei: true }), // "verfügbar" in Google
      termin('2026-09-29', '2026-09-30', { ganztaegig: true }), // Dienstag ganztägig belegt
      termin('2026-09-30', '2026-10-01', { ganztaegig: true, frei: true }), // Mittwoch ganztägig, aber frei
    ] }),
    absagen: async () => ({ ok: false }),
    erreichbar: async () => ({ ok: true }),
  };
  const d = await starteServer({ kalender, jetzt: () => DateTime.fromISO('2026-09-28T07:00:00+02:00', { zone: config.zeitzone }) });
  try {
    await d.anmelden();
    const a = (await d.rufe('GET', '/api/auslastung')).json;
    const mo = a.tage.find((t) => t.datum === '2026-09-28');
    assert.equal(mo.kapazitaetMinuten, 420);
    assert.equal(mo.gebuchtMinuten, 60, 'überlappende Termine zählen einmal, freie gar nicht');
    assert.equal(mo.prozent, 14);
    assert.equal(a.tage.find((t) => t.datum === '2026-09-29').prozent, 100, 'ganztägig belegt');
    assert.equal(a.tage.find((t) => t.datum === '2026-09-30').prozent, 0, 'ganztägig, aber frei');
    const akut = a.naechsteFreie.find((n) => n.terminart === 'akut');
    assert.equal(akut.start, '2026-09-28T09:00:00+02:00', 'erster freier Slot nach dem belegten Block');
  } finally { await d.schliessen(); }
});

test('Benutzer löschen wirkt sofort: laufende Sitzung endet, Login scheitert', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-')), 'benutzer.json');
  new Benutzer(datei).setzen('bernd', 'ein-langes-passwort');
  const d = await starteServer({ benutzer: new Benutzer(datei) });
  try {
    assert.equal((await d.anmelden('bernd', 'ein-langes-passwort')).status, 200);
    assert.equal((await d.rufe('GET', '/api/ich')).status, 200);
    new Benutzer(datei).loeschen('bernd'); // wie: node dashboard/benutzer.js loeschen bernd
    assert.equal((await d.rufe('GET', '/api/ich')).status, 401, 'Sitzung sofort ungültig');
    assert.equal((await d.anmelden('bernd', 'ein-langes-passwort')).status, 401);
    new Benutzer(datei).setzen('clara', 'noch-ein-langes-passwort');
    assert.equal((await d.anmelden('clara', 'noch-ein-langes-passwort')).status, 200, 'neuer Benutzer ohne Neustart');
    assert.equal((await d.rufe('GET', '/api/ich')).status, 200);
    new Benutzer(datei).setzen('clara', 'ganz-neues-passwort-123'); // Passwort geändert
    assert.equal((await d.rufe('GET', '/api/ich')).status, 401, 'Passwortänderung beendet Sitzung');
    assert.equal((await d.anmelden('clara', 'ganz-neues-passwort-123')).status, 200);
    assert.deepEqual(fs.readdirSync(path.dirname(datei)).filter((f) => f.endsWith('.tmp')), [], 'keine Temp-Dateien übrig');
  } finally { await d.schliessen(); }
});
