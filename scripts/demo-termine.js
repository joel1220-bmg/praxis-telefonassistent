// Spielt realistische Demo-Termine für die nächsten Wochen in den echten Praxis-Kalender ein
// (oder entfernt sie wieder). Alle Termine tragen die private Markierung demo=1.
//
//   node scripts/demo-termine.js --vorschau              nur anzeigen, nichts schreiben
//   node scripts/demo-termine.js --einspielen            Termine anlegen (braucht GOOGLE_SA_DATEI)
//   node scripts/demo-termine.js --entfernen             alle Termine mit demo=1 löschen
//
// GOOGLE_SA_DATEI: JSON mit {client_email, private_key} (Google-Format) oder {email, privateKey} (n8n-Export).
// Der Service-Account braucht Schreibrechte auf config.kalenderId.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DateTime } = require('luxon');
const config = require('../src/config');
const lib = require('../src/lib').makeLib(DateTime);

const TAGE = 28; // = config.horizontTage
const VERGANGENE_TAGE = 90; // Termine der letzten Wochen: daran erkennt der Assistent Bestandspatienten
const ANTEIL_ASSISTENT = 0.3;

// Feste Testperson für Testanrufe ("Ich war schon einmal bei Ihnen"): hat zwei vergangene Termine.
const TESTPERSON = { vorname: 'Erika', nachname: 'Mustermann', geburtsdatum: '1964-08-12', telefon: '+4915100001234', versicherung: 'gesetzlich' };

// Füllgrad wie in einer echten Praxis: die nächsten Tage fast voll, später leerer.
// Es bleiben immer freie Termine, damit Testanrufe buchen können.
const fuellgrad = (tagNr) => (tagNr <= 2 ? 0.7 : tagNr <= 7 ? 0.55 : tagNr <= 14 ? 0.4 : 0.25);

const ANLIEGEN = {
  akut: ['Halsschmerzen und Fieber seit zwei Tagen', 'Rückenschmerzen nach dem Heben', 'Husten, wird nicht besser',
    'Magen-Darm-Infekt', 'Ohrenschmerzen links', 'Kopfschmerzen und Schwindel', 'Harnwegsinfekt'],
  kontrolle: ['Blutdruckkontrolle', 'Befundbesprechung Labor', 'Kontrolle nach Antibiotikum', 'Verlaufskontrolle Diabetes',
    'Wundkontrolle nach Fädenziehen', 'Besprechung Langzeit-EKG'],
  blutabnahme: ['Laborkontrolle Schilddrüse', 'Blutbild und Cholesterin', 'HbA1c-Kontrolle', 'Leberwerte'],
  vorsorge: ['Check-up 35', 'Gesundheitsuntersuchung', 'Hautkrebs-Screening', 'Vorsorge mit Belastungs-EKG'],
  erstgespraech: ['Neu zugezogen, sucht Hausarzt', 'Wechsel von anderer Praxis', 'Neue Patientin, Vorerkrankungen besprechen'],
};
// Gewichte der Terminarten (Akut und Kontrolle sind in einer Hausarztpraxis am häufigsten).
const ARTEN = [['akut', 32], ['kontrolle', 30], ['blutabnahme', 16], ['vorsorge', 14], ['erstgespraech', 8]];

const VORNAMEN = ['Anna', 'Lukas', 'Marie', 'Jonas', 'Sophie', 'Felix', 'Laura', 'Paul', 'Hannah', 'Leon', 'Lea', 'Tim',
  'Julia', 'Max', 'Sarah', 'Ben', 'Lena', 'Elias', 'Mia', 'Noah', 'Emma', 'Finn', 'Klara', 'David', 'Ursula', 'Peter',
  'Monika', 'Wolfgang', 'Renate', 'Jürgen', 'Gisela', 'Dieter', 'Sabine', 'Thomas', 'Petra', 'Andreas', 'Ayşe', 'Mehmet',
  'Olga', 'Piotr', 'Fatima', 'Giulia'];
const NACHNAMEN = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann',
  'Koch', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger', 'Hofmann',
  'Hartmann', 'Lange', 'Schmitt', 'Werner', 'Krause', 'Meier', 'Lehmann', 'Köhler', 'Herrmann', 'Yılmaz', 'Kaya',
  'Nowak', 'Kowalski', 'Rossi', 'Petrov', 'Janssen', 'Vogel', 'Jäger', 'Busch'];

// Reproduzierbarer Zufall: gleiche Eingabe, gleiche Termine.
let zufall = 20261001;
const naechste = () => { zufall = (zufall * 1103515245 + 12345) % 2147483648; return zufall / 2147483648; };
const wahl = (liste) => liste[Math.floor(naechste() * liste.length)];
const gewichtet = (paare) => {
  let r = naechste() * paare.reduce((s, [, g]) => s + g, 0);
  for (const [w, g] of paare) { if ((r -= g) < 0) return w; }
  return paare[paare.length - 1][0];
};

function patientenListe(anzahl) {
  const gesehen = new Set();
  const liste = [];
  while (liste.length < anzahl) {
    const vorname = wahl(VORNAMEN);
    const nachname = wahl(NACHNAMEN);
    if (gesehen.has(vorname + nachname)) continue;
    gesehen.add(vorname + nachname);
    const geburt = DateTime.fromObject({ year: 1940 + Math.floor(naechste() * 66), month: 1 + Math.floor(naechste() * 12), day: 1 + Math.floor(naechste() * 28) });
    liste.push({
      vorname, nachname,
      geburtsdatum: geburt.toISODate(),
      // Erfundene Nummern im Block +49 151 0000 xxxx.
      telefon: `+491510000${String(1000 + Math.floor(naechste() * 9000))}`,
      versicherung: naechste() < 0.88 ? 'gesetzlich' : 'privat',
      offen: 0,
    });
  }
  return liste;
}

function planen(jetzt, bestehende) {
  const patienten = patientenListe(220);
  const termine = [];
  for (let i = -VERGANGENE_TAGE; i <= TAGE; i++) {
    if (i === 0) continue;
    const tag = jetzt.startOf('day').plus({ days: i });
    const kuerzel = lib.WOCHENTAGE[tag.weekday - 1];
    const bloecke = config.sprechzeiten[kuerzel] || [];
    if (!bloecke.length || config.feiertage.includes(tag.toISODate())) continue;
    const belegt = bestehende.filter((b) => b.start.hasSame(tag, 'day'));
    for (const start of lib.tagesSlots(config, tag, config.rasterMinuten)) {
      // Vergangenheit nur dünn (dient als Patientenhistorie), Zukunft wie in einer echten Praxis.
      const grad = i < 0 ? 0.12 : fuellgrad(i);
      if (naechste() > grad / 1.6) continue; // pro Rasterplatz würfeln; Termine sind länger als das Raster
      let art = gewichtet(ARTEN);
      if (art === 'blutabnahme' && start.hour >= 10) art = 'kontrolle'; // Blutabnahme nüchtern morgens
      const dauer = config.terminarten[art].dauer;
      const ende = start.plus({ minutes: dauer });
      const block = bloecke.find(([von, bis]) => start.toFormat('HH:mm') >= von && start.toFormat('HH:mm') < bis);
      if (!block || ende.toFormat('HH:mm') > block[1]) continue;
      if (belegt.some((b) => start < b.ende && b.start < ende)) continue;
      const kandidaten = i < 0 ? patienten : patienten.filter((p) => p.offen < config.maxOffeneTerminePatient);
      const p = wahl(kandidaten);
      if (i > 0) p.offen += 1;
      belegt.push({ start, ende });
      termine.push({ start, ende, art, patient: p, vomAssistenten: naechste() < ANTEIL_ASSISTENT, anliegen: wahl(ANLIEGEN[art]) });
    }
  }
  // Testperson: zwei vergangene Termine (vor ca. 3 und 7 Wochen), keine zukünftigen.
  for (const [wochen, art, anliegen] of [[7, 'akut', 'Rückenschmerzen nach dem Heben'], [3, 'kontrolle', 'Kontrolle Rücken']]) {
    let tag = jetzt.startOf('day').minus({ weeks: wochen });
    while (!lib.tagesSlots(config, tag, 15).length) tag = tag.plus({ days: 1 });
    const start = lib.tagesSlots(config, tag, 15).find((s) => ![...termine, ...bestehende].some((t) => s < t.ende && t.start < s.plus({ minutes: 15 })));
    if (start) termine.push({ start, ende: start.plus({ minutes: 15 }), art, patient: TESTPERSON, vomAssistenten: false, anliegen });
  }
  return termine.sort((a, b) => a.start - b.start);
}

function eventAus(t, jetzt) {
  const art = config.terminarten[t.art];
  const p = t.patient;
  const iso = (d) => d.toISO({ suppressMilliseconds: true });
  const zeilen = [
    `Terminart: ${art.bezeichnung}`,
    `Geburtsdatum: ${p.geburtsdatum}`,
    `Telefon: ${p.telefon}`,
    `Versicherung: ${p.versicherung}`,
    `Anliegen: ${t.anliegen}`,
  ];
  if (t.vomAssistenten) {
    const gebucht = DateTime.min(jetzt, t.start).minus({ days: 1 + Math.floor(naechste() * 6), minutes: Math.floor(naechste() * 600) });
    zeilen.push('', `Gebucht vom Telefonassistenten am ${gebucht.setLocale('de').toFormat("dd.LL.yyyy, HH:mm 'Uhr'")}.`);
  }
  // gebdat und nachnameCode bei allen Terminen: so erkennt termin_buchen Bestandspatienten (in einer echten Praxis
  // käme das aus dem Praxisverwaltungssystem). quelle nur bei Buchungen des Telefonassistenten.
  const privat = { demo: '1', gebdat: p.geburtsdatum, nachnameCode: lib.koelnerPhonetik(p.nachname) };
  if (t.vomAssistenten) privat.quelle = lib.QUELLE;
  return {
    summary: `${art.bezeichnung}: ${p.nachname}, ${p.vorname}`,
    description: zeilen.join('\n'),
    start: { dateTime: iso(t.start), timeZone: config.zeitzone },
    end: { dateTime: iso(t.ende), timeZone: config.zeitzone },
    extendedProperties: { private: privat },
  };
}

// ---------- Google Calendar (Service-Account, ohne Zusatzbibliotheken) ----------
async function zugriffstoken() {
  const datei = process.env.GOOGLE_SA_DATEI;
  if (!datei) throw new Error('GOOGLE_SA_DATEI fehlt.');
  const sa = JSON.parse(fs.readFileSync(datei, 'utf8'));
  const email = sa.client_email || sa.email;
  const schluessel = (sa.private_key || sa.privateKey || '').replace(/\\n/g, '\n');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64({ alg: 'RS256', typ: 'JWT' });
  const inhalt = b64({ iss: email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat: jetzt, exp: jetzt + 3600 });
  const signatur = crypto.createSign('RSA-SHA256').update(`${kopf}.${inhalt}`).sign(schluessel).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${kopf}.${inhalt}.${signatur}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Token-Fehler: ${j.error || r.status}`);
  return j.access_token;
}

async function google(token, methode, pfad, body) {
  const url = `${config.googleApiBasis}/calendar/v3/calendars/${encodeURIComponent(config.kalenderId)}${pfad}`;
  for (let versuch = 0; ; versuch++) {
    const r = await fetch(url, { method: methode, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    if ((r.status === 403 || r.status === 429) && versuch < 5) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** versuch)); continue; }
    if (r.status === 204) return {};
    const j = await r.json();
    if (!r.ok) throw new Error(`${methode} ${pfad}: ${r.status} ${j.error && j.error.message}`);
    return j;
  }
}

async function alleEvents(token, von, bis, extra = '') {
  const items = [];
  let seite = '';
  do {
    const j = await google(token, 'GET', `/events?singleEvents=true&maxResults=2500&timeMin=${encodeURIComponent(von)}&timeMax=${encodeURIComponent(bis)}${extra}${seite ? `&pageToken=${seite}` : ''}`);
    items.push(...(j.items || []));
    seite = j.nextPageToken || '';
  } while (seite);
  return items;
}

async function main() {
  const modus = process.argv[2];
  const jetzt = DateTime.now().setZone(config.zeitzone);
  const von = jetzt.startOf("day").minus({ days: VERGANGENE_TAGE }).toISO();
  const bis = jetzt.startOf('day').plus({ days: TAGE + 1 }).toISO();

  if (modus === '--entfernen') {
    const token = await zugriffstoken();
    const demo = await alleEvents(token, jetzt.minus({ days: VERGANGENE_TAGE + 30 }).toISO(), jetzt.plus({ days: 120 }).toISO(), '&privateExtendedProperty=demo%3D1');
    for (const e of demo) await google(token, 'DELETE', `/events/${e.id}?sendUpdates=none`);
    console.log(`Entfernt: ${demo.length} Demo-Termine.`);
    return;
  }
  if (!['--vorschau', '--einspielen'].includes(modus)) {
    console.error('Aufruf: node scripts/demo-termine.js --vorschau | --einspielen | --entfernen');
    process.exit(1);
  }

  let token = null;
  let bestehende = [];
  if (modus === '--einspielen') {
    token = await zugriffstoken();
    const events = await alleEvents(token, von, bis);
    if (events.some((e) => ((e.extendedProperties || {}).private || {}).demo === '1')) {
      console.error('Es gibt schon Demo-Termine. Erst --entfernen, dann neu einspielen.');
      process.exit(1);
    }
    bestehende = events.filter((e) => e.status !== 'cancelled' && e.start && e.start.dateTime)
      .map((e) => ({ start: DateTime.fromISO(e.start.dateTime).setZone(config.zeitzone), ende: DateTime.fromISO(e.end.dateTime).setZone(config.zeitzone) }));
  }

  const termine = planen(jetzt, bestehende);
  const proWoche = {};
  for (const t of termine) { const w = `KW ${t.start.weekNumber}`; proWoche[w] = (proWoche[w] || 0) + 1; }
  console.log(`${termine.length} Demo-Termine (${termine.filter((t) => t.start > jetzt).length} kommende, ${termine.filter((t) => t.vomAssistenten).length} vom Telefonassistenten), ${bestehende.length} bestehende Termine bleiben unberührt.`);
  console.log(Object.entries(proWoche).map(([w, n]) => `${w}: ${n}`).join(' · '));

  if (modus === '--vorschau') {
    for (const t of termine.slice(0, 12)) console.log(`  ${t.start.setLocale('de').toFormat('ccc dd.LL. HH:mm')}  ${config.terminarten[t.art].bezeichnung.padEnd(21)} ${t.patient.nachname}, ${t.patient.vorname}${t.vomAssistenten ? '  (Telefonassistent)' : ''}`);
    return;
  }
  let n = 0;
  for (const t of termine) {
    await google(token, 'POST', '/events?sendUpdates=none', eventAus(t, jetzt));
    if (++n % 25 === 0) console.log(`  ${n}/${termine.length}`);
  }
  console.log(`Eingespielt: ${n} Demo-Termine.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
