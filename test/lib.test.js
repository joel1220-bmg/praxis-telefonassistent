const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { makeLib } = require('../src/lib');
const basisConfig = require('../src/config');

const lib = makeLib(DateTime);
const config = { ...basisConfig, kalenderId: 'praxis@test', urlaub: [], feiertage: ['2026-09-30'] };
// Montag, 28.09.2026, 07:00 Uhr Berlin
const JETZT = '2026-09-28T07:00:00+02:00';
const z = (iso) => DateTime.fromISO(iso, { zone: config.zeitzone });

function vapi(name, args, extra = {}) {
  return {
    message: {
      type: 'tool-calls',
      call: { customer: { number: '+4915112345678' } },
      toolCallList: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
      ...extra,
    },
  };
}
const ergebnis = (a) => a.results[0].result;
const freeBusy = (busy) => ({ calendars: { 'praxis@test': { busy } } });

test('Kölner Phonetik: bekannte Werte und Schreibvarianten', () => {
  assert.equal(lib.koelnerPhonetik('Müller-Lüdenscheidt'), '65752682');
  assert.equal(lib.koelnerPhonetik('Wikipedia'), '3412');
  assert.equal(lib.koelnerPhonetik('Meier'), lib.koelnerPhonetik('Meyer'));
  assert.equal(lib.koelnerPhonetik('Meier'), lib.koelnerPhonetik('Mayer'));
  assert.equal(lib.koelnerPhonetik('Schmidt'), lib.koelnerPhonetik('Schmitt'));
  assert.notEqual(lib.koelnerPhonetik('Schmidt'), lib.koelnerPhonetik('Müller'));
});

test('Tagesslots richten sich nach Sprechzeiten, Raster und Dauer', () => {
  const mo = lib.tagesSlots(config, z('2026-09-28T00:00'), 30);
  assert.equal(mo[0].toFormat('HH:mm'), '08:00');
  assert.equal(mo.filter((s) => s.hour < 12).at(-1).toFormat('HH:mm'), '11:30');
  assert.equal(mo.at(-1).toFormat('HH:mm'), '17:30');
  assert.equal(lib.tagesSlots(config, z('2026-10-03T00:00'), 15).length, 0, 'Samstag');
  assert.equal(lib.tagesSlots(config, z('2026-09-30T00:00'), 15).length, 0, 'Feiertag');
  const mitUrlaub = { ...config, urlaub: [{ von: '2026-10-05', bis: '2026-10-09' }] };
  assert.equal(lib.tagesSlots(mitUrlaub, z('2026-10-07T00:00'), 15).length, 0, 'Urlaub');
});

test('Suche: Belegung, Vorlauf, max. 2 pro Tag, max. 3 gesamt', () => {
  const vorb = lib.vorbereiten(config, vapi('freie_termine_suchen', { terminart: 'akut' }), JETZT);
  assert.equal(vorb.route, lib.ROUTE.suche);
  assert.equal(vorb.http.body.items[0].id, 'praxis@test');
  const a = lib.nachSuche(config, vorb, freeBusy([{ start: '2026-09-28T06:00:00Z', end: '2026-09-28T06:30:00Z' }]));
  const text = ergebnis(a);
  assert.match(text, /1\) Montag, 28\. September, 8:30 Uhr \[start=2026-09-28T08:30:00\+02:00\]/);
  assert.match(text, /2\) Montag, 28\. September, 8:40 Uhr/);
  assert.match(text, /3\) Dienstag, 29\. September, 8:00 Uhr/);
  assert.equal(a.results[0].toolCallId, 'call_1');
});

test('Suche: Nachmittag an einem bestimmten Tag, Feiertag ohne Ergebnis', () => {
  const vorb = lib.vorbereiten(config,
    vapi('freie_termine_suchen', { terminart: 'vorsorge', ab_datum: '2026-10-01', nur_dieser_tag: true, tageszeit: 'nachmittag' }), JETZT);
  const text = ergebnis(lib.nachSuche(config, vorb, freeBusy([])));
  assert.match(text, /1\) Donnerstag, 1\. Oktober, 15:00 Uhr/);
  assert.match(text, /2\) Donnerstag, 1\. Oktober, 15:10 Uhr/);
  assert.doesNotMatch(text, /3\)/);

  const feiertag = lib.vorbereiten(config, vapi('freie_termine_suchen', { terminart: 'akut', ab_datum: '2026-09-30', nur_dieser_tag: true }), JETZT);
  assert.match(ergebnis(lib.nachSuche(config, feiertag, freeBusy([]))), /Kein freier Termin/);
});

test('Suche: Datum außerhalb des Horizonts und Kalenderfehler', () => {
  const weit = lib.vorbereiten(config, vapi('freie_termine_suchen', { terminart: 'akut', ab_datum: '2027-06-01' }), JETZT);
  assert.equal(weit.route, lib.ROUTE.direkt);
  assert.match(ergebnis(lib.direkteAntwort(weit)), /außerhalb des buchbaren Zeitraums/);
  const vorb = lib.vorbereiten(config, vapi('freie_termine_suchen', { terminart: 'akut' }), JETZT);
  assert.match(ergebnis(lib.nachSuche(config, vorb, { error: { message: '401' } })), /Technischer Fehler/);
});

test('Vorbereitung: Argumente als JSON-String, unbekanntes Tool, andere Nachrichtentypen', () => {
  const s = lib.vorbereiten(config, vapi('freie_termine_suchen', '{"terminart":"kontrolle"}'), JETZT);
  assert.equal(s.suche.terminart, 'kontrolle');
  const u = lib.vorbereiten(config, vapi('rm_rf', {}), JETZT);
  assert.equal(u.route, lib.ROUTE.direkt);
  assert.match(ergebnis(u.antwort), /Unbekanntes Werkzeug/);
  const status = lib.vorbereiten(config, { message: { type: 'status-update' } }, JETZT);
  assert.deepEqual(status.antwort, { results: [] });
  const falscheArt = lib.vorbereiten(config, vapi('freie_termine_suchen', { terminart: 'op' }), JETZT);
  assert.match(ergebnis(falscheArt.antwort), /terminart muss/);
});

const buchungsArgs = {
  terminart: 'akut', start: '2026-09-28T08:30:00+02:00', vorname: 'Anna', nachname: 'Meier',
  geburtsdatum: '1980-05-17', versicherung: 'gesetzlich', anliegen: 'Halsschmerzen\nseit 3 Tagen',
};

test('Buchen: Validierung von Slot und Personendaten', () => {
  const gut = lib.vorbereiten(config, vapi('termin_buchen', buchungsArgs), JETZT);
  assert.equal(gut.route, lib.ROUTE.buchen);
  assert.equal(gut.buchung.telefon, '+4915112345678', 'Anrufernummer als Standard');
  assert.equal(gut.buchung.anliegen, 'Halsschmerzen seit 3 Tagen', 'Steuerzeichen entfernt');
  assert.equal(gut.buchung.ende, '2026-09-28T08:45:00+02:00');

  const fall = (args, muster) => {
    const v = lib.vorbereiten(config, vapi('termin_buchen', { ...buchungsArgs, ...args }), JETZT);
    assert.equal(v.route, lib.ROUTE.direkt, JSON.stringify(args));
    assert.match(ergebnis(v.antwort), muster);
  };
  fall({ start: '2026-09-28T08:35:00+02:00' }, /kein buchbarer Termin/);
  fall({ start: '2026-09-28T07:30:00+02:00' }, /kein buchbarer Termin/);
  fall({ start: '2026-09-30T08:00:00+02:00' }, /kein buchbarer Termin/);
  fall({ start: '2026-12-01T08:00:00+01:00' }, /kein buchbarer Termin/);
  fall({ start: undefined }, /start fehlt/);
  fall({ nachname: '123' }, /Nachname fehlt/);
  fall({ geburtsdatum: '2030-01-01' }, /unplausibel/);
  fall({ geburtsdatum: '17.5.80' }, /Geburtsdatum ungültig/);
  fall({ versicherung: 'beamte' }, /versicherung muss/);
  const deutschesDatum = lib.vorbereiten(config, vapi('termin_buchen', { ...buchungsArgs, geburtsdatum: '17.05.1980' }), JETZT);
  assert.equal(deutschesDatum.buchung.geburtsdatum, '1980-05-17');
  const ohneNummer = lib.vorbereiten(config, { message: { ...vapi('termin_buchen', buchungsArgs).message, call: {} } }, JETZT);
  assert.match(ergebnis(ohneNummer.antwort), /Telefonnummer fehlt/);
});

test('Buchen: Prüfung vor dem Eintragen', () => {
  const vorb = lib.vorbereiten(config, vapi('termin_buchen', buchungsArgs), JETZT);
  const leer = { items: [] };

  const ok = lib.buchungPruefen(config, vorb, freeBusy([]), leer);
  assert.equal(ok.ok, true);
  assert.equal(ok.http.method, 'POST');
  assert.equal(ok.http.url, 'https://www.googleapis.com/calendar/v3/calendars/praxis%40test/events?sendUpdates=none');
  assert.equal(ok.http.body.summary, 'Akutsprechstunde: Meier, Anna');
  assert.deepEqual(ok.http.body.extendedProperties.private,
    { quelle: 'telefonassistent', gebdat: '1980-05-17', nachnameCode: lib.koelnerPhonetik('Meier') });

  const vergeben = lib.buchungPruefen(config, vorb, freeBusy([{ start: '2026-09-28T06:30:00Z', end: '2026-09-28T06:45:00Z' }]), leer);
  assert.equal(vergeben.ok, false);
  assert.match(ergebnis(vergeben.antwort), /inzwischen vergeben/);

  const termin = (id, start, nachname = 'Meyer') => ({
    id, status: 'confirmed', summary: 'Akutsprechstunde: X', start: { dateTime: start },
    extendedProperties: { private: { quelle: 'telefonassistent', gebdat: '1980-05-17', nachnameCode: lib.koelnerPhonetik(nachname) } },
  });
  const doppelt = lib.buchungPruefen(config, vorb, freeBusy([{ start: '2026-09-28T06:30:00Z', end: '2026-09-28T06:45:00Z' }]),
    { items: [termin('abc123', '2026-09-28T08:30:00+02:00')] });
  assert.match(ergebnis(doppelt.antwort), /bereits gebucht.*abc123/);

  const zuViele = lib.buchungPruefen(config, vorb, freeBusy([]),
    { items: [termin('a1b2c3', '2026-10-01T08:00:00+02:00'), termin('d4e5f6', '2026-10-02T08:00:00+02:00')] });
  assert.match(ergebnis(zuViele.antwort), /bereits 2 offene Termine/);

  const andererName = lib.buchungPruefen(config, vorb, freeBusy([]),
    { items: [termin('a1b2c3', '2026-10-01T08:00:00+02:00', 'Schulz'), termin('d4e5f6', '2026-10-02T08:00:00+02:00', 'Schulz')] });
  assert.equal(andererName.ok, true, 'gleiches Geburtsdatum, andere Person');

  assert.match(ergebnis(lib.nachBuchung(config, vorb, { id: 'neu123' })), /Gebucht: Akutsprechstunde am Montag, 28\. September, 8:30 Uhr.*neu123/);
  assert.match(ergebnis(lib.nachBuchung(config, vorb, { error: {} })), /NICHT gebucht/);
});

test('Finden und Absagen mit phonetischem Namensabgleich', () => {
  const eintrag = {
    id: 'evt12345', status: 'confirmed', summary: 'Kontrolltermin: Meier, Anna', start: { dateTime: '2026-10-01T09:00:00+02:00' },
    extendedProperties: { private: { quelle: 'telefonassistent', gebdat: '1980-05-17', nachnameCode: lib.koelnerPhonetik('Meier') } },
  };
  const finden = lib.vorbereiten(config, vapi('termine_finden', { nachname: 'Mayer', geburtsdatum: '1980-05-17' }), JETZT);
  assert.match(decodeURIComponent(finden.http.url), /privateExtendedProperty=gebdat=1980-05-17/);
  assert.match(ergebnis(lib.nachFinden(config, finden, { items: [eintrag] })), /Donnerstag, 1\. Oktober, 9:00 Uhr – Kontrolltermin \[termin_id=evt12345\]/);
  const fremd = lib.vorbereiten(config, vapi('termine_finden', { nachname: 'Schulz', geburtsdatum: '1980-05-17' }), JETZT);
  assert.match(ergebnis(lib.nachFinden(config, fremd, { items: [eintrag] })), /Keine zukünftigen Termine/);

  const absagen = lib.vorbereiten(config, vapi('termin_absagen', { termin_id: 'evt12345', nachname: 'Meyer', geburtsdatum: '1980-05-17' }), JETZT);
  assert.equal(absagen.http.url, 'https://www.googleapis.com/calendar/v3/calendars/praxis%40test/events/evt12345');
  const ok = lib.absagePruefen(config, absagen, eintrag);
  assert.equal(ok.ok, true);
  assert.equal(ok.http.method, 'DELETE');
  assert.match(ergebnis(lib.nachAbsage(config, absagen, ok, {})), /Abgesagt: Termin am Donnerstag, 1\. Oktober, 9:00 Uhr/);

  const falschesDatum = lib.vorbereiten(config, vapi('termin_absagen', { termin_id: 'evt12345', nachname: 'Meier', geburtsdatum: '1980-05-18' }), JETZT);
  assert.equal(lib.absagePruefen(config, falschesDatum, eintrag).ok, false);
  assert.equal(lib.absagePruefen(config, absagen, { ...eintrag, extendedProperties: {} }).ok, false, 'manuell eingetragener Termin');
  assert.equal(lib.absagePruefen(config, absagen, { error: { message: '404' } }).ok, false);
  const knapp = lib.absagePruefen({ ...config, absageMindestStunden: 24 * 5 }, absagen, eintrag);
  assert.match(ergebnis(knapp.antwort), /zu kurzfristig/);
  const boeseId = lib.vorbereiten(config, vapi('termin_absagen', { termin_id: '../../x', nachname: 'Meier', geburtsdatum: '1980-05-17' }), JETZT);
  assert.match(ergebnis(boeseId.antwort), /termin_id fehlt oder ist ungültig/);
});

test('Rückruf: E-Mail ohne Header-Injection, Pflichtfelder', () => {
  const v = lib.vorbereiten(config, vapi('rueckruf_notieren', {
    vorname: 'Anna', nachname: 'Meier\r\nBcc: x@evil.test', kategorie: 'rezept', dringend: true, anliegen: 'Ramipril 5 mg',
  }), JETZT);
  assert.equal(v.route, lib.ROUTE.rueckruf);
  assert.equal(v.email.betreff.includes('\n'), false);
  assert.match(v.email.betreff, /^\[DRINGEND\] Rückruf: Rezept – Meier Bcc/);
  assert.match(v.email.inhalt, /Rückrufnummer: \+4915112345678/);
  assert.match(ergebnis(lib.nachRueckruf(v, {})), /übermittelt/);
  assert.match(ergebnis(lib.nachRueckruf(v, { error: {} }, { ok: true })), /übermittelt/, 'Mail kaputt, Dashboard ok');
  assert.match(ergebnis(lib.nachRueckruf(v, { error: {} }, { error: {} })), /Technischer Fehler/);
  assert.equal(v.dashboard.url, 'http://dashboard:8080/intern/rueckruf');
  assert.equal(v.dashboard.body.kategorie, 'rezept');
  assert.equal(v.dashboard.body.dringend, true);
  assert.equal(v.dashboard.body.eingegangen, '2026-09-28T07:00:00+02:00');
  const leer = lib.vorbereiten(config, vapi('rueckruf_notieren', { vorname: 'Anna', nachname: 'Meier' }), JETZT);
  assert.match(ergebnis(leer.antwort), /anliegen fehlt/);
});

test('Randfälle: Zeitumstellung, Horizont, ausgebuchter Tag, UTC-Eingabe', () => {
  // Zeitumstellung: Montag nach Ende der Sommerzeit bzw. Dienstag nach Beginn
  assert.equal(lib.tagesSlots(config, z('2026-10-26T00:00'), 15)[0].toISO(), '2026-10-26T08:00:00.000+01:00');
  assert.equal(lib.tagesSlots(config, z('2027-03-30T00:00'), 15)[0].toISO(), '2027-03-30T08:00:00.000+02:00');

  // Horizont: 28 Tage ab heute buchbar, der 29. nicht
  const jetzt = z(JETZT);
  assert.equal(lib.istGueltigerSlot(config, z('2026-10-26T08:00'), 15, jetzt), true);
  assert.equal(lib.istGueltigerSlot(config, z('2026-10-27T08:00'), 15, jetzt), false);

  // Erster Tag komplett belegt → Vorschläge beginnen am nächsten Tag
  const vorb = lib.vorbereiten(config, vapi('freie_termine_suchen', { terminart: 'akut' }), JETZT);
  const text = ergebnis(lib.nachSuche(config, vorb, freeBusy([{ start: '2026-09-28T06:00:00Z', end: '2026-09-28T17:00:00Z' }])));
  assert.match(text, /1\) Dienstag, 29\. September, 8:00 Uhr/);
  assert.match(text, /3\) Donnerstag, 1\. Oktober, 8:00 Uhr/, 'Mittwoch ist Feiertag');

  // Startzeit in UTC wird in Berliner Zeit umgerechnet
  const utc = lib.vorbereiten(config, vapi('termin_buchen', { ...buchungsArgs, start: '2026-09-28T06:30:00Z' }), JETZT);
  assert.equal(utc.buchung.start, '2026-09-28T08:30:00+02:00');
});

test('Härtung: toolCallId-Länge, strenges Geburtsdatum, Name ohne Lautcode', () => {
  const lang = lib.vorbereiten(config, {
    message: { type: 'tool-calls', toolCallList: [{ id: 'x'.repeat(100000), function: { name: 'rm', arguments: {} } }] },
  }, JETZT);
  assert.equal(lang.antwort.results[0].toolCallId.length, 100);
  for (const gebdat of ['1980-W20', '19800517', '1980-5-17']) {
    const v = lib.vorbereiten(config, vapi('termine_finden', { nachname: 'Meier', geburtsdatum: gebdat }), JETZT);
    assert.match(ergebnis(v.antwort), /Geburtsdatum ungültig/, gebdat);
  }
  const h = lib.vorbereiten(config, vapi('termine_finden', { nachname: 'H', geburtsdatum: '1980-05-17' }), JETZT);
  assert.match(ergebnis(h.antwort), /Nachname fehlt/);
});
