'use strict';
// Praxis-Dashboard – Oberfläche. Alle Daten werden per textContent eingesetzt (kein innerHTML mit Fremddaten).

const zustand = { ich: null, ansicht: 'termine', tag: null, rueckrufStatus: 'offen', zeitzone: 'Europe/Berlin' };
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'breite') e.style.width = v; // über CSSOM, damit die strenge CSP (keine Inline-Styles) greift
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kinder.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

// ---------- Datum & Zeit (immer in Praxis-Zeitzone) ----------
const fmt = (opt) => new Intl.DateTimeFormat('de-DE', { timeZone: zustand.zeitzone, ...opt });
const uhrzeit = (iso) => fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const tagLang = (iso) => fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const tagKurz = (iso) => fmt({ weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(iso));
const zeitpunkt = (iso) => fmt({ weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
function heuteIso() {
  const t = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const w = (typ) => t.find((p) => p.type === typ).value;
  return `${w('year')}-${w('month')}-${w('day')}`;
}
function tagVerschieben(iso, tage) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}
const mittag = (isoDatum) => `${isoDatum}T12:00:00Z`;

// ---------- Server ----------
async function anfrage(methode, pfad, body) {
  const res = await fetch(pfad, {
    method: methode,
    headers: body ? { 'content-type': 'application/json', 'x-praxis-anfrage': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const daten = await res.json().catch(() => ({}));
  if (res.status === 401 && pfad !== '/api/login') { zeigeLogin(); throw new Error('Bitte erneut anmelden'); }
  if (!res.ok) throw new Error(daten.fehler || `Fehler ${res.status}`);
  return daten;
}

function melden(text, ok = false) {
  const m = $('#meldung');
  m.textContent = text;
  m.classList.toggle('ok', ok);
  m.hidden = !text;
  clearTimeout(melden.t);
  if (text) melden.t = setTimeout(() => { m.hidden = true; }, ok ? 4000 : 10000);
}

// ---------- Login ----------
function zeigeLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const fehler = $('#login-fehler');
  fehler.hidden = true;
  try {
    await anfrage('POST', '/api/login', { benutzer: f.get('benutzer'), passwort: f.get('passwort') });
    ev.target.reset();
    await starten();
  } catch (e) {
    fehler.textContent = e.message;
    fehler.hidden = false;
  }
});

$('#abmelden').addEventListener('click', async () => {
  await anfrage('POST', '/api/logout', {}).catch(() => {});
  zeigeLogin();
});

// ---------- Navigation ----------
document.querySelectorAll('.reiter button').forEach((b) => b.addEventListener('click', () => zeigeAnsicht(b.dataset.ansicht)));

function zeigeAnsicht(name) {
  zustand.ansicht = name;
  try { localStorage.setItem('praxis-ansicht', name); } catch (e) { /* egal */ }
  document.querySelectorAll('.reiter button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ansicht === name)));
  document.querySelectorAll('.ansicht').forEach((s) => { s.hidden = s.id !== `ansicht-${name}`; });
  melden('');
  laden();
}

function laden() {
  const f = { termine: ladeTermine, rueckrufe: ladeRueckrufe, auslastung: ladeAuslastung, einstellungen: ladeEinstellungen, status: ladeStatus }[zustand.ansicht];
  return f().catch((e) => melden(e.message));
}

// ---------- Termine ----------
$('#tag-zurueck').addEventListener('click', () => { zustand.tag = tagVerschieben(zustand.tag, -1); ladeTermine(); });
$('#tag-vor').addEventListener('click', () => { zustand.tag = tagVerschieben(zustand.tag, 1); ladeTermine(); });
$('#tag-heute').addEventListener('click', () => { zustand.tag = heuteIso(); ladeTermine(); });
$('#tag-wahl').addEventListener('change', (e) => { if (e.target.value) { zustand.tag = e.target.value; ladeTermine(); } });

async function ladeTermine() {
  const tag = zustand.tag;
  $('#tag-wahl').value = tag;
  $('#tag-titel').textContent = tagLang(mittag(tag)) + (tag === heuteIso() ? ' (heute)' : '');
  const liste = $('#termine-liste');
  const { termine } = await anfrage('GET', `/api/termine?von=${tag}&bis=${tag}`);
  if (zustand.tag !== tag) return;
  liste.replaceChildren();
  if (!termine.length) { liste.append(el('div', { class: 'leer' }, 'Keine Termine an diesem Tag.')); return; }
  const jetzt = Date.now();
  for (const t of termine) liste.append(terminZeile(t, jetzt));
}

function terminZeile(t, jetzt) {
  const [art, ...rest] = t.titel.split(':');
  const name = rest.length ? rest.join(':').trim() : art;
  const vorbei = !t.ganztaegig && new Date(t.ende).getTime() < jetzt;
  const details = el('div', { class: 'termin-details', hidden: true },
    t.beschreibung ? el('pre', {}, t.beschreibung) : el('span', { class: 'leise' }, 'Keine weiteren Angaben.'),
    !t.ganztaegig && new Date(t.start).getTime() > jetzt
      ? el('div', {}, el('button', { class: 'klein gefahr', onclick: () => absagen(t) }, 'Termin absagen'))
      : null);
  const zeile = el('button', {
    class: 'termin-zeile',
    'aria-expanded': 'false',
    onclick: () => {
      details.hidden = !details.hidden;
      zeile.setAttribute('aria-expanded', String(!details.hidden));
    },
  },
  el('span', { class: 'termin-zeit' }, t.ganztaegig ? 'ganztägig' : `${uhrzeit(t.start)}–${uhrzeit(t.ende)}`),
  el('span', {}, el('span', {}, name), rest.length ? el('span', { class: 'termin-art' }, art) : null),
  el('span', { class: `chip ${t.quelle === 'telefonassistent' ? 'assistent' : ''}` }, t.quelle === 'telefonassistent' ? 'Telefonassistent' : 'Praxis'));
  return el('div', { class: `termin${vorbei ? ' vorbei' : ''}` }, zeile, details);
}

async function absagen(t) {
  if (!confirm(`Termin „${t.titel}“ am ${zeitpunkt(t.start)} wirklich absagen?\nDer Termin wird aus dem Kalender gelöscht. Die Person wird nicht automatisch benachrichtigt.`)) return;
  try {
    await anfrage('POST', '/api/termine/absagen', { id: t.id });
    melden('Termin abgesagt. Bitte die Person informieren.', true);
    ladeTermine();
  } catch (e) { melden(e.message); }
}

// ---------- Rückrufe ----------
document.querySelectorAll('.umschalter button').forEach((b) => b.addEventListener('click', () => {
  zustand.rueckrufStatus = b.dataset.status;
  document.querySelectorAll('.umschalter button').forEach((x) => x.classList.toggle('aktiv', x === b));
  ladeRueckrufe();
}));

const KATEGORIEN = { rezept: 'Rezept', ueberweisung: 'Überweisung', befund: 'Befund', krankschreibung: 'Krankschreibung', termin: 'Terminfrage', sonstiges: 'Sonstiges' };

async function ladeRueckrufe() {
  const status = zustand.rueckrufStatus;
  const { rueckrufe, zaehler } = await anfrage('GET', `/api/rueckrufe?status=${status}`);
  zeigeZaehler(zaehler);
  const liste = $('#rueckrufe-liste');
  liste.replaceChildren();
  if (!rueckrufe.length) {
    liste.append(el('div', { class: 'karte leer' }, status === 'offen' ? 'Keine offenen Rückrufwünsche.' : 'Keine erledigten Rückrufwünsche.'));
    return;
  }
  for (const r of rueckrufe) {
    liste.append(el('article', { class: `karte${r.dringend && status === 'offen' ? ' dringend' : ''}` },
      el('div', { class: 'karte-kopf' },
        el('span', { class: 'name' }, `${r.nachname}, ${r.vorname}`),
        el('span', { class: 'chip' }, KATEGORIEN[r.kategorie] || r.kategorie),
        r.dringend ? el('span', { class: 'chip dringend' }, 'dringend') : null,
        el('span', { class: 'zeit' }, zeitpunkt(r.eingegangen))),
      el('p', {}, r.anliegen),
      el('div', { class: 'karte-fuss' },
        el('a', { href: `tel:${r.telefon}` }, r.telefon),
        el('span', {}, `geb. ${r.geburtsdatum}`),
        status === 'offen'
          ? el('button', { class: 'klein', onclick: (e) => erledigen(r.id, e.target) }, 'Erledigt')
          : el('span', {}, `erledigt von ${r.erledigt_von}, ${zeitpunkt(r.erledigt_am)}`))));
  }
}

async function erledigen(id, knopf) {
  knopf.disabled = true;
  try {
    await anfrage('POST', '/api/rueckrufe/erledigt', { id });
    ladeRueckrufe();
  } catch (e) { knopf.disabled = false; melden(e.message); }
}

function zeigeZaehler(z) {
  const b = $('#rueckruf-zaehler');
  b.hidden = !z.offen;
  b.textContent = z.offen;
  b.classList.toggle('dringend', z.dringend > 0);
  b.title = z.dringend ? `${z.dringend} dringend` : '';
}

// ---------- Auslastung ----------
async function ladeAuslastung() {
  const a = await anfrage('GET', '/api/auslastung');
  $('#naechste-freie').replaceChildren(...a.naechsteFreie.map((n) => el('div', { class: 'karte' },
    el('span', { class: 'leise' }, `${n.bezeichnung} (${n.dauer} Min.)`),
    el('strong', {}, n.start ? zeitpunkt(n.start) : `nichts frei in ${a.zeitraumTage} Tagen`))));
  $('#auslastung-liste').replaceChildren(...a.tage.map((t) => {
    const p = t.prozent;
    return el('div', { class: 'balken-zeile' },
      el('span', {}, tagKurz(mittag(t.datum))),
      el('div', { class: 'balken', role: 'img', 'aria-label': p === null ? t.geschlossen : `${p} Prozent belegt` },
        p === null ? null : el('span', { class: p >= 90 ? 'voll' : p >= 70 ? 'mittel' : '', breite: `${p}%` })),
      el('span', { class: 'balken-zahl' }, p === null ? t.geschlossen : `${p} % · ${t.termine} T.`));
  }));
}

// ---------- Einstellungen ----------
const TAGE = { mo: 'Montag', di: 'Dienstag', mi: 'Mittwoch', do: 'Donnerstag', fr: 'Freitag', sa: 'Samstag', so: 'Sonntag' };
const karte = (titel, ...inhalt) => el('div', { class: 'karte' }, el('h3', {}, titel), ...inhalt);
const tabelle = (zeilen) => el('table', {}, el('tbody', {}, zeilen.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v)))));

async function ladeEinstellungen() {
  const e = await anfrage('GET', '/api/einstellungen');
  $('#einstellungen-inhalt').replaceChildren(
    karte('Sprechzeiten', tabelle(Object.entries(TAGE).map(([k, t]) => [t,
      (e.sprechzeiten[k] || []).length ? e.sprechzeiten[k].map(([v, b]) => `${v}–${b}`).join(', ') : 'geschlossen']))),
    karte('Terminarten', tabelle(Object.values(e.terminarten).map((a) => [a.bezeichnung, `${a.dauer} Min. – ${a.beschreibung}`]))),
    karte('Buchungsregeln', tabelle([
      ['Raster', `${e.rasterMinuten} Minuten`],
      ['Frühestens', `${e.vorlaufMinuten} Minuten ab jetzt`],
      ['Buchbar bis', `${e.horizontTage} Tage im Voraus`],
      ['Offene Termine pro Person', String(e.maxOffeneTerminePatient)],
      ['Absage per Telefon bis', e.absageMindestStunden ? `${e.absageMindestStunden} Std. vorher` : 'jederzeit'],
      ['Rückrufe per E-Mail an', e.rueckrufEmail],
      ['Erledigte Rückrufe löschen nach', `${e.rueckrufeAufbewahrenTage} Tagen`],
    ])),
    karte('Feiertage & Urlaub',
      el('ul', { class: 'einfach' }, e.feiertage.map((d) => el('li', {}, tagLang(mittag(d))))),
      e.urlaub.length ? el('p', {}, 'Urlaub:') : el('p', { class: 'leise' }, 'Kein Praxisurlaub eingetragen.'),
      el('ul', { class: 'einfach' }, e.urlaub.map((u) => el('li', {}, `${tagKurz(mittag(u.von))} – ${tagKurz(mittag(u.bis))}`)))),
    karte('Auskünfte des Assistenten', el('ul', { class: 'einfach' }, e.praxisInfos.map((i) => el('li', {}, i)))),
  );
}

// ---------- Status ----------
const pruef = (ok, text, zusatz) => el('div', { class: `pruef ${ok ? 'ok' : 'nein'}` },
  el('span', { class: 'zeichen' }, ok ? '✓' : '✗'), el('span', {}, text, zusatz ? el('span', { class: 'leise' }, ` – ${zusatz}`) : null));

async function ladeStatus() {
  const s = await anfrage('GET', '/api/status');
  $('#status-inhalt').replaceChildren(
    karte('Verbindungen',
      pruef(s.n8n.ok, 'n8n erreichbar', s.n8n.hinweis || s.n8n.fehler),
      pruef(s.kalender.ok, 'Kalenderabfrage', s.kalender.fehler),
      el('p', { class: 'leise' }, `Stand: ${zeitpunkt(s.zeit)}`)),
    karte('Rückrufwünsche', tabelle([['Offen', String(s.rueckrufe.offen)], ['Davon dringend', String(s.rueckrufe.dringend)]])),
    karte('Einrichtung', ...s.checkliste.map((c) => pruef(c.ok, c.punkt))),
  );
}

// ---------- Start ----------
async function starten() {
  try {
    zustand.ich = await anfrage('GET', '/api/ich');
  } catch (e) {
    return;
  }
  zustand.zeitzone = zustand.ich.zeitzone;
  zustand.tag = zustand.tag || heuteIso();
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#praxis-name').textContent = zustand.ich.praxisName;
  document.title = `Dashboard – ${zustand.ich.praxisName}`;
  const modus = $('#modus');
  modus.textContent = zustand.ich.modus === 'demo' ? 'Demo-Daten' : 'Live';
  modus.className = `chip ${zustand.ich.modus}`;
  $('#benutzer-name').textContent = zustand.ich.benutzer;
  let gespeichert = null;
  try { gespeichert = localStorage.getItem('praxis-ansicht'); } catch (e) { /* egal */ }
  zeigeAnsicht(['termine', 'rueckrufe', 'auslastung', 'einstellungen', 'status'].includes(gespeichert) ? gespeichert : 'termine');
  anfrage('GET', '/api/rueckrufe?status=offen').then((d) => zeigeZaehler(d.zaehler)).catch(() => {});
}

// Alle 60 Sekunden aktualisieren (nur wenn die Seite sichtbar ist).
setInterval(() => {
  if (document.hidden || $('#app').hidden) return;
  anfrage('GET', '/api/rueckrufe?status=offen').then((d) => zeigeZaehler(d.zaehler)).catch(() => {});
  if (['termine', 'rueckrufe', 'status'].includes(zustand.ansicht)) laden();
}, 60000);

(async () => {
  await starten();
  if (!$('#app').hidden) return;
  zeigeLogin();
  // Zugangsdaten-Hinweis nur, wenn der Server im Demo-Modus läuft.
  try { $('#demo-hinweis').hidden = (await fetch('/modus').then((r) => r.json())).modus !== 'demo'; } catch (e) { /* bleibt verborgen */ }
})();
