// Mitarbeiter-Dashboard der Praxis. Node ohne Framework; Daten: n8n (Kalender) + SQLite (Rückrufwünsche).
// Start: node dashboard/server.js   (Umgebungsvariablen siehe README, Abschnitt "Dashboard")
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { makeLib } = require('../src/lib');
const { RueckrufSpeicher, AnrufSpeicher } = require('./speicher');
const { Benutzer } = require('./benutzer');
const { DemoKalender, N8nKalender } = require('./kalender');
const { roiBerechnen } = require('./roi');

const lib = makeLib(DateTime);
const SESSION_STUNDEN = 10;
const LOGIN_VERSUCHE = 5;
const LOGIN_SPERRE_MIN = 15;
const MAX_BODY = 16 * 1024;
const STATISCH = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const SICHERHEITS_HEADER = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

class HttpFehler extends Error {
  constructor(status, meldung) { super(meldung); this.status = status; }
}

function erstelleDashboard(opt) {
  const config = opt.config;
  const jetzt = opt.jetzt || (() => DateTime.now().setZone(config.zeitzone));
  const anrufe = opt.anrufe || new AnrufSpeicher(':memory:');
  const sessions = new Map();
  const fehlversuche = new Map();
  const statischeDateien = Object.fromEntries(Object.entries(STATISCH).map(([pfad, [datei, typ]]) =>
    [pfad, { inhalt: fs.readFileSync(path.join(__dirname, 'public', datei)), typ }]));

  // ---------- Hilfen ----------
  function sende(res, status, daten, extraHeader = {}) {
    const body = daten === undefined ? '' : JSON.stringify(daten);
    res.writeHead(status, {
      ...SICHERHEITS_HEADER,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeader,
    });
    res.end(body);
  }

  function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
  }

  function lesen(req) {
    return new Promise((resolve, reject) => {
      let groesse = 0;
      let zuGross = false;
      const teile = [];
      req.on('data', (c) => {
        if (zuGross) return; // Rest verwerfen, ohne zu puffern; Antwort 413 geht sofort raus
        groesse += c.length;
        if (groesse > MAX_BODY) { zuGross = true; teile.length = 0; reject(new HttpFehler(413, 'Anfrage zu groß')); return; }
        teile.push(c);
      });
      req.on('end', () => {
        if (zuGross) return;
        const roh = Buffer.concat(teile).toString('utf8');
        if (!roh) return resolve({});
        let wert;
        try { wert = JSON.parse(roh); } catch (e) { return reject(new HttpFehler(400, 'Ungültiges JSON')); }
        if (!wert || typeof wert !== 'object' || Array.isArray(wert)) return reject(new HttpFehler(400, 'JSON-Objekt erwartet'));
        resolve(wert);
      });
      req.on('error', reject);
    });
  }

  function sitzung(req) {
    const sid = cookies(req).praxis_sid;
    const s = sid && sessions.get(sid);
    if (!s) return null;
    // Gelöschte Benutzer und geänderte Passwörter beenden die Sitzung sofort, nicht erst nach Ablauf.
    if (s.ablauf < Date.now() || opt.benutzer.passwortStand(s.benutzer) !== s.passwortStand) { sessions.delete(sid); return null; }
    return { sid, ...s };
  }

  function clientIp(req) {
    // Nur hinter Caddy (DASHBOARD_HINTER_PROXY=1): Caddy ersetzt X-Forwarded-For von Clients durch die echte Adresse.
    // Ohne vorgeschalteten Proxy darf die Option NICHT gesetzt sein, sonst lässt sich die Login-Sperre umgehen.
    return opt.hinterProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  }

  // Fehlversuche zählen innerhalb eines Zeitfensters; danach verfallen sie.
  function gesperrt(schluessel) {
    const f = fehlversuche.get(schluessel);
    if (!f) return false;
    if (f.bis > Date.now()) return true;
    if (f.bis || f.fensterEnde <= Date.now()) fehlversuche.delete(schluessel);
    return false;
  }

  function fehlversuch(schluessel) {
    const jetztMs = Date.now();
    let f = fehlversuche.get(schluessel);
    if (!f || f.fensterEnde <= jetztMs) f = { anzahl: 0, fensterEnde: jetztMs + LOGIN_SPERRE_MIN * 60000, bis: 0 };
    f.anzahl += 1;
    if (f.anzahl >= LOGIN_VERSUCHE) f.bis = jetztMs + LOGIN_SPERRE_MIN * 60000;
    fehlversuche.set(schluessel, f);
  }

  // Überlappende Intervalle zusammenfassen, damit parallele Termine nicht doppelt zählen.
  function zusammenfassen(intervalle) {
    const sortiert = [...intervalle].sort((a, b) => a.start - b.start);
    const ergebnis = [];
    for (const i of sortiert) {
      const letztes = ergebnis[ergebnis.length - 1];
      if (letztes && i.start <= letztes.ende) letztes.ende = DateTime.max(letztes.ende, i.ende);
      else ergebnis.push({ start: i.start, ende: i.ende });
    }
    return ergebnis;
  }

  // Wie Googles freeBusy (das der Telefonassistent nutzt): "frei" markierte Termine zählen nicht,
  // ganztägige belegte Termine blockieren den ganzen Tag.
  function belegung(termine) {
    return termine.filter((t) => !t.frei).map((t) => (t.ganztaegig
      ? { start: DateTime.fromISO(t.start, { zone: config.zeitzone }).startOf('day'), ende: DateTime.fromISO(t.ende, { zone: config.zeitzone }).startOf('day') }
      : { start: DateTime.fromISO(t.start, { zone: config.zeitzone }), ende: DateTime.fromISO(t.ende, { zone: config.zeitzone }) }));
  }

  function datum(wert, feld) {
    const d = DateTime.fromISO(String(wert || ''), { zone: config.zeitzone });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(wert || '')) || !d.isValid) throw new HttpFehler(400, `${feld} ungültig (JJJJ-MM-TT)`);
    return d;
  }

  // ---------- Fachlogik ----------
  function sprechbloecke(tag) {
    if (!lib.istFrei(config, tag)) return [];
    return (config.sprechzeiten[lib.WOCHENTAGE[tag.weekday - 1]] || []).map(([von, bis]) => {
      const [vh, vm] = von.split(':').map(Number);
      const [bh, bm] = bis.split(':').map(Number);
      return { start: tag.set({ hour: vh, minute: vm }), ende: tag.set({ hour: bh, minute: bm }) };
    });
  }

  function schliessgrund(tag) {
    const d = tag.toISODate();
    if ((config.feiertage || []).includes(d)) return 'Feiertag';
    if ((config.urlaub || []).some((u) => d >= u.von && d <= u.bis)) return 'Praxisurlaub';
    return 'geschlossen';
  }

  async function auslastung() {
    const heute = jetzt().startOf('day');
    const tage = 14;
    const bis = heute.plus({ days: tage - 1 });
    const antwort = await opt.kalender.termine(heute.toISODate(), bis.toISODate());
    if (!antwort.ok) throw new HttpFehler(502, antwort.fehler || 'Kalender nicht erreichbar');
    const belegt = zusammenfassen(belegung(antwort.termine));
    const liste = [];
    for (let i = 0; i < tage; i++) {
      const tag = heute.plus({ days: i });
      const bloecke = sprechbloecke(tag);
      const kapazitaet = bloecke.reduce((s, b) => s + b.ende.diff(b.start, 'minutes').minutes, 0);
      let gebucht = 0;
      for (const b of bloecke) {
        for (const t of belegt) {
          const von = DateTime.max(b.start, t.start);
          const bisZeit = DateTime.min(b.ende, t.ende);
          if (bisZeit > von) gebucht += bisZeit.diff(von, 'minutes').minutes;
        }
      }
      liste.push({
        datum: tag.toISODate(),
        kapazitaetMinuten: kapazitaet,
        gebuchtMinuten: gebucht,
        prozent: kapazitaet ? Math.round((gebucht / kapazitaet) * 100) : null,
        termine: antwort.termine.filter((t) => t.start.slice(0, 10) === tag.toISODate()).length,
        geschlossen: kapazitaet === 0 ? schliessgrund(tag) : null,
      });
    }
    const suchConfig = { ...config, maxVorschlaege: 1, maxVorschlaegeProTag: 1 };
    const von = lib.fruehesterStart(config, jetzt());
    const suchEnde = DateTime.min(lib.horizontEnde(config, jetzt()), bis.endOf('day'));
    const naechsteFreie = Object.entries(config.terminarten).map(([schluessel, art]) => {
      const [slot] = von < suchEnde
        ? lib.freieSlots(suchConfig, { jetzt: jetzt(), von, bis: suchEnde, dauer: art.dauer, tageszeit: 'egal', belegt })
        : [];
      return { terminart: schluessel, bezeichnung: art.bezeichnung, dauer: art.dauer, start: slot ? slot.toISO({ suppressMilliseconds: true }) : null };
    });
    return { tage: liste, naechsteFreie, zeitraumTage: tage };
  }

  function einstellungen() {
    return {
      praxisName: config.praxisName,
      zeitzone: config.zeitzone,
      sprechzeiten: config.sprechzeiten,
      terminarten: config.terminarten,
      rasterMinuten: config.rasterMinuten,
      vorlaufMinuten: config.vorlaufMinuten,
      horizontTage: config.horizontTage,
      maxOffeneTerminePatient: config.maxOffeneTerminePatient,
      absageMindestStunden: config.absageMindestStunden,
      feiertage: config.feiertage,
      urlaub: config.urlaub,
      praxisInfos: config.praxisInfos,
      rueckrufEmail: config.email.an,
      rueckrufeAufbewahrenTage: config.rueckrufeAufbewahrenTage,
    };
  }

  async function status() {
    const heute = jetzt().toISODate();
    const kalender = await opt.kalender.termine(heute, heute).catch((e) => ({ ok: false, fehler: e.message }));
    const n8n = await opt.kalender.erreichbar();
    return {
      modus: opt.modus,
      zeit: jetzt().toISO({ suppressMilliseconds: true }),
      n8n,
      kalender: { ok: !!kalender.ok, fehler: kalender.ok ? null : kalender.fehler },
      rueckrufe: opt.speicher.zaehlen(),
      checkliste: [
        { punkt: 'Live-Modus (echte Kalenderdaten)', ok: opt.modus === 'live' },
        { punkt: 'Verbindung zu n8n konfiguriert', ok: opt.modus === 'live' && !!opt.n8nKonfiguriert },
        { punkt: 'Token für Rückrufe aus n8n gesetzt', ok: !!opt.internToken },
        { punkt: 'Zugriff nur über HTTPS (sichere Cookies)', ok: !!opt.https },
        { punkt: 'Mindestens ein Benutzer angelegt', ok: opt.benutzer.anzahl() > 0 },
        { punkt: `Erledigte Rückrufe werden nach ${config.rueckrufeAufbewahrenTage} Tagen gelöscht`, ok: config.rueckrufeAufbewahrenTage > 0 },
      ],
    };
  }

  // ---------- Routen ----------
  async function api(req, res, url, s) {
    const r = `${req.method} ${url.pathname}`;
    if (r === 'GET /api/ich') {
      return sende(res, 200, { benutzer: s.benutzer, modus: opt.modus, praxisName: config.praxisName, zeitzone: config.zeitzone });
    }
    if (r === 'POST /api/logout') {
      sessions.delete(s.sid);
      return sende(res, 200, { ok: true }, { 'Set-Cookie': 'praxis_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (r === 'GET /api/termine') {
      const von = datum(url.searchParams.get('von'), 'von');
      const bis = datum(url.searchParams.get('bis') || url.searchParams.get('von'), 'bis');
      if (bis < von || bis.diff(von, 'days').days > 31) throw new HttpFehler(400, 'Zeitraum ungültig (max. 31 Tage)');
      const a = await opt.kalender.termine(von.toISODate(), bis.toISODate());
      if (!a.ok) throw new HttpFehler(502, a.fehler || 'Kalender nicht erreichbar');
      return sende(res, 200, { termine: a.termine });
    }
    if (r === 'POST /api/termine/absagen') {
      const body = await lesen(req);
      const a = await opt.kalender.absagen(lib.text(body.id, 1024));
      if (!a.ok) throw new HttpFehler(409, a.fehler || 'Absage nicht möglich');
      opt.protokoll(`Termin abgesagt von ${s.benutzer}: ${a.abgesagt.start}`);
      return sende(res, 200, a);
    }
    if (r === 'GET /api/rueckrufe') {
      const st = url.searchParams.get('status') === 'erledigt' ? 'erledigt' : 'offen';
      return sende(res, 200, { rueckrufe: opt.speicher.liste(st), zaehler: opt.speicher.zaehlen() });
    }
    if (r === 'POST /api/rueckrufe/erledigt') {
      const body = await lesen(req);
      const id = Number(body.id);
      if (!Number.isInteger(id) || !opt.speicher.erledigen(id, s.benutzer, jetzt().toISO({ suppressMilliseconds: true }))) {
        throw new HttpFehler(404, 'Rückrufwunsch nicht gefunden oder schon erledigt');
      }
      return sende(res, 200, { ok: true });
    }
    if (r === 'GET /api/auslastung') return sende(res, 200, await auslastung());
    if (r === 'GET /api/roi') {
      const tage = Number(url.searchParams.get('tage') || 30);
      if (![7, 30, 90].includes(tage)) throw new HttpFehler(400, 'tage muss 7, 30 oder 90 sein');
      const bis = jetzt().startOf('day').plus({ days: 1 });
      const von = bis.minus({ days: tage });
      const utc = (d) => d.toUTC().toISO({ suppressMilliseconds: true });
      return sende(res, 200, roiBerechnen(config, lib, anrufe.zeitraum(utc(von), utc(bis)), { von, bis }));
    }
    if (r === 'GET /api/einstellungen') return sende(res, 200, einstellungen());
    if (r === 'GET /api/status') return sende(res, 200, await status());
    throw new HttpFehler(404, 'Nicht gefunden');
  }

  async function login(req, res) {
    const body = await lesen(req);
    const name = lib.text(body.benutzer, 60).toLowerCase();
    const schluessel = `${clientIp(req)}|${name}`;
    const ipSchluessel = `${clientIp(req)}|*`;
    if (gesperrt(schluessel) || gesperrt(ipSchluessel)) {
      throw new HttpFehler(429, `Zu viele Fehlversuche. Bitte ${LOGIN_SPERRE_MIN} Minuten warten.`);
    }
    if (!opt.benutzer.pruefen(name, String(body.passwort || ''))) {
      fehlversuch(schluessel);
      fehlversuch(ipSchluessel);
      opt.protokoll(`Fehlgeschlagener Login für "${name}" von ${clientIp(req)}`);
      throw new HttpFehler(401, 'Benutzername oder Passwort falsch');
    }
    fehlversuche.delete(schluessel);
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { benutzer: name, passwortStand: opt.benutzer.passwortStand(name), ablauf: Date.now() + SESSION_STUNDEN * 3600000 });
    const secure = opt.https ? '; Secure' : '';
    return sende(res, 200, { ok: true, benutzer: name }, {
      'Set-Cookie': `praxis_sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_STUNDEN * 3600}${secure}`,
    });
  }

  // Nur n8n (im Docker-Netz) kennt den Intern-Token; von außen blockt Caddy /intern/* zusätzlich.
  function internPruefen(req) {
    const auth = Buffer.from(String(req.headers.authorization || ''));
    const erwartet = Buffer.from(`Bearer ${opt.internToken || ''}`);
    // Längen in Bytes vergleichen: timingSafeEqual wirft sonst bei Nicht-ASCII-Zeichen (→ 500 statt 401).
    const ok = opt.internToken && auth.length === erwartet.length && crypto.timingSafeEqual(auth, erwartet);
    if (!ok) throw new HttpFehler(401, 'Nicht berechtigt');
  }

  async function internAnruf(req, res) {
    internPruefen(req);
    const b = await lesen(req);
    const id = lib.text(b.id, 100);
    if (!/^[A-Za-z0-9_\-.:]{1,100}$/.test(id)) throw new HttpFehler(400, 'id fehlt oder ist ungültig');
    const start = DateTime.fromISO(String(b.start || ''), { setZone: true });
    if (!start.isValid) throw new HttpFehler(400, 'start ungültig');
    const zahl = (wert, max) => (Number.isFinite(Number(wert)) ? Math.min(Math.max(Number(wert), 0), max) : 0);
    const neu = anrufe.hinzufuegen({
      id,
      // Auf volle Sekunden, damit der Textvergleich mit den Zeitraum-Grenzen ("…:00Z") stimmt.
      start: start.toUTC().startOf('second').toISO({ suppressMilliseconds: true }),
      dauerSek: Math.round(zahl(b.dauerSek, 7200)),
      kostenUsd: zahl(b.kostenUsd, 100),
      endeGrund: lib.text(b.endeGrund, 80),
      gebucht: b.gebucht === true,
      abgesagt: b.abgesagt === true,
      rueckruf: b.rueckruf === true,
      weitergeleitet: b.weitergeleitet === true,
    });
    return sende(res, neu ? 201 : 200, { ok: true, neu });
  }

  async function internRueckruf(req, res) {
    internPruefen(req);
    const b = await lesen(req);
    const eingegangen = DateTime.fromISO(String(b.eingegangen || ''));
    const eintrag = {
      eingegangen: eingegangen.isValid ? eingegangen.setZone(config.zeitzone).toISO({ suppressMilliseconds: true }) : jetzt().toISO({ suppressMilliseconds: true }),
      vorname: lib.text(b.vorname, 60),
      nachname: lib.text(b.nachname, 60),
      geburtsdatum: lib.text(b.geburtsdatum, 20),
      telefon: lib.text(b.telefon, 30),
      kategorie: Object.keys(lib.KATEGORIEN).includes(b.kategorie) ? b.kategorie : 'sonstiges',
      dringend: b.dringend === true,
      anliegen: lib.text(b.anliegen, 500),
    };
    if (!eintrag.nachname || !eintrag.anliegen) throw new HttpFehler(400, 'nachname und anliegen sind Pflicht');
    const id = opt.speicher.hinzufuegen(eintrag);
    return sende(res, 201, { ok: true, id });
  }

  async function behandeln(req, res) {
    let url = { pathname: '?' };
    try {
      try { url = new URL(req.url, 'http://dashboard'); } catch (e) { throw new HttpFehler(400, 'Ungültige Adresse'); }
      if (req.method === 'GET' && STATISCH[url.pathname]) {
        const d = statischeDateien[url.pathname];
        res.writeHead(200, { ...SICHERHEITS_HEADER, 'Content-Type': d.typ, 'Cache-Control': 'no-cache' });
        return res.end(d.inhalt);
      }
      if (req.method === 'GET' && url.pathname === '/gesund') return sende(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/modus') return sende(res, 200, { modus: opt.modus });
      const schreibend = req.method !== 'GET';
      if (schreibend && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new HttpFehler(415, 'Content-Type application/json erforderlich');
      }
      if (req.method === 'POST' && url.pathname === '/intern/rueckruf') return await internRueckruf(req, res);
      if (req.method === 'POST' && url.pathname === '/intern/anruf') return await internAnruf(req, res);
      if (!url.pathname.startsWith('/api/')) throw new HttpFehler(404, 'Nicht gefunden');
      if (schreibend && req.headers['x-praxis-anfrage'] !== '1') throw new HttpFehler(403, 'Anfrage abgelehnt (CSRF-Schutz)');
      if (req.method === 'POST' && url.pathname === '/api/login') return await login(req, res);
      const s = sitzung(req);
      if (!s) throw new HttpFehler(401, 'Bitte anmelden');
      return await api(req, res, url, s);
    } catch (e) {
      if (e instanceof HttpFehler) return sende(res, e.status, { fehler: e.message });
      opt.protokoll(`Fehler bei ${req.method} ${url.pathname}: ${e.stack || e}`);
      return sende(res, 500, { fehler: 'Interner Fehler' });
    }
  }

  // Letzte Sicherung: kein Fehler in einer einzelnen Anfrage darf den Prozess beenden.
  const server = http.createServer((req, res) => {
    behandeln(req, res).catch((e) => {
      opt.protokoll(`Unerwarteter Fehler: ${e && e.stack ? e.stack : e}`);
      if (!res.headersSent) sende(res, 500, { fehler: 'Interner Fehler' });
      else res.destroy();
    });
  });
  const aufraeumen = setInterval(() => {
    const grenze = jetzt().minus({ days: config.rueckrufeAufbewahrenTage }).toISO();
    opt.speicher.aufraeumen(grenze);
    anrufe.aufraeumen(jetzt().minus({ days: config.roi.aufbewahrenTage }).toUTC().toISO({ suppressMilliseconds: true }));
    for (const [sid, s] of sessions) if (s.ablauf < Date.now()) sessions.delete(sid);
    for (const schluessel of [...fehlversuche.keys()]) gesperrt(schluessel); // entfernt abgelaufene Einträge
  }, 3600000);
  aufraeumen.unref();
  server.on('close', () => clearInterval(aufraeumen));
  return server;
}

// ---------- Start über die Kommandozeile ----------
function start() {
  const env = process.env;
  const config = require('../src/config');
  const modus = env.DASHBOARD_MODUS === 'live' ? 'live' : 'demo';
  const datenOrdner = path.resolve(env.DASHBOARD_DATEN || path.join(__dirname, 'daten'));
  const protokoll = (m) => console.log(`${new Date().toISOString()} ${m}`);
  let kalender;
  let benutzer;
  let speicher;
  let anrufe;

  if (modus === 'live') {
    const fehlend = ['N8N_DASHBOARD_URL', 'N8N_DASHBOARD_TOKEN', 'DASHBOARD_INTERN_TOKEN'].filter((k) => !env[k]);
    if (fehlend.length) { console.error(`Live-Modus: fehlende Umgebungsvariablen: ${fehlend.join(', ')}`); process.exit(1); }
    fs.mkdirSync(datenOrdner, { recursive: true });
    benutzer = new Benutzer(path.join(datenOrdner, 'benutzer.json'));
    if (benutzer.anzahl() === 0) {
      console.error('Kein Benutzer angelegt. Zuerst: node dashboard/benutzer.js anlegen <name>');
      process.exit(1);
    }
    speicher = new RueckrufSpeicher(path.join(datenOrdner, 'rueckrufe.sqlite'));
    anrufe = new AnrufSpeicher(path.join(datenOrdner, 'anrufe.sqlite'));
    kalender = new N8nKalender({ url: env.N8N_DASHBOARD_URL, token: env.N8N_DASHBOARD_TOKEN, gesundUrl: env.N8N_HEALTH_URL });
  } else {
    benutzer = Benutzer.demo();
    speicher = new RueckrufSpeicher(':memory:');
    speicher.demoDaten(DateTime.now().setZone(config.zeitzone));
    anrufe = new AnrufSpeicher(':memory:');
    anrufe.demoDaten(DateTime.now().setZone(config.zeitzone));
    kalender = new DemoKalender(config, lib);
  }

  const server = erstelleDashboard({
    config, modus, kalender, benutzer, speicher, anrufe, protokoll,
    internToken: env.DASHBOARD_INTERN_TOKEN || (modus === 'demo' ? 'demo-intern-token' : ''),
    n8nKonfiguriert: modus === 'live',
    https: env.DASHBOARD_HTTPS === '1',
    hinterProxy: env.DASHBOARD_HINTER_PROXY === '1',
  });
  const port = Number(env.DASHBOARD_PORT || 8080);
  const host = env.DASHBOARD_HOST || (modus === 'demo' ? '127.0.0.1' : '0.0.0.0');
  server.listen(port, host, () => {
    protokoll(`Praxis-Dashboard (${modus}) läuft auf http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (modus === 'demo') protokoll('Demo-Zugang: Benutzer "demo", Passwort "demo" – nur Beispieldaten.');
  });
}

if (require.main === module) start();
module.exports = { erstelleDashboard };
