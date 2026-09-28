// Benutzerverwaltung für das Dashboard (Passwörter als scrypt-Hash).
// Anlegen/Passwort ändern:  node dashboard/benutzer.js anlegen <name>
// Löschen:                  node dashboard/benutzer.js loeschen <name>
// Auflisten:                node dashboard/benutzer.js liste
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, laenge: 64 };
const MIN_PASSWORT = 10;

function hashen(passwort, salz = crypto.randomBytes(16)) {
  const h = crypto.scryptSync(passwort, salz, SCRYPT.laenge, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salz.toString('base64')}$${h.toString('base64')}`;
}

function vergleichen(passwort, gespeichert) {
  const [art, N, r, p, salz, hash] = String(gespeichert).split('$');
  if (art !== 'scrypt') return false;
  const erwartet = Buffer.from(hash, 'base64');
  const h = crypto.scryptSync(passwort, Buffer.from(salz, 'base64'), erwartet.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(h, erwartet);
}

// Gleiche Rechenzeit auch für unbekannte Namen, damit sich Benutzernamen nicht per Zeitmessung erraten lassen.
const DUMMY_HASH = hashen('dummy-passwort-zum-zeitausgleich');

class Benutzer {
  constructor(datei, daten) {
    this.datei = datei;
    this.stand = null;
    this.daten = daten || {};
    if (!daten) this.neuLaden();
  }

  static demo() {
    return new Benutzer(null, { demo: hashen('demo') });
  }

  // Änderungen über die Kommandozeile (anlegen/löschen) greifen ohne Neustart des Servers.
  neuLaden() {
    if (!this.datei) return;
    let stand = null;
    try { stand = fs.statSync(this.datei).mtimeMs; } catch (e) { this.daten = {}; this.stand = null; return; }
    if (stand === this.stand) return;
    this.daten = JSON.parse(fs.readFileSync(this.datei, 'utf8'));
    this.stand = stand;
  }

  anzahl() { this.neuLaden(); return Object.keys(this.daten).length; }

  existiert(name) {
    this.neuLaden();
    return Object.prototype.hasOwnProperty.call(this.daten, name);
  }

  // Kennung des aktuellen Passworts: ändert sich das Passwort, werden bestehende Sitzungen ungültig.
  passwortStand(name) {
    return this.existiert(name) ? this.daten[name] : null;
  }

  pruefen(name, passwort) {
    this.neuLaden();
    const gespeichert = Object.prototype.hasOwnProperty.call(this.daten, name) ? this.daten[name] : null;
    const ok = vergleichen(passwort, gespeichert || DUMMY_HASH);
    return !!gespeichert && ok;
  }

  setzen(name, passwort) {
    this.daten[name] = hashen(passwort);
    this.speichern();
  }

  loeschen(name) {
    const gab = delete this.daten[name];
    this.speichern();
    return gab;
  }

  speichern() {
    fs.mkdirSync(path.dirname(this.datei), { recursive: true });
    // Erst in eine temporäre Datei schreiben, dann umbenennen: der Server liest nie eine halb geschriebene Datei.
    const tmp = `${this.datei}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.daten, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.datei);
  }
}

function passwortAbfragen(frage) {
  return new Promise((resolve) => {
    process.stdout.write(frage);
    const stdin = process.stdin;
    let wert = '';
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const beiDaten = (zeichen) => {
      for (const c of zeichen) {
        if (c === '\r' || c === '\n') {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', beiDaten);
          process.stdout.write('\n');
          return resolve(wert);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') wert = wert.slice(0, -1);
        else wert += c;
      }
    };
    stdin.on('data', beiDaten);
  });
}

async function cli() {
  const [befehl, rohName] = process.argv.slice(2);
  const datei = path.resolve(process.env.DASHBOARD_DATEN || path.join(__dirname, 'daten'), 'benutzer.json');
  const b = new Benutzer(datei);
  const name = String(rohName || '').trim().toLowerCase();
  if (befehl === 'liste') { console.log(Object.keys(b.daten).join('\n') || '(keine Benutzer)'); return; }
  if (!['anlegen', 'loeschen'].includes(befehl) || !/^[a-z0-9._-]{2,40}$/.test(name)) {
    console.error('Aufruf: node dashboard/benutzer.js anlegen|loeschen <name>   oder   liste');
    process.exit(1);
  }
  if (befehl === 'loeschen') { console.log(b.loeschen(name) ? `Gelöscht: ${name}` : `Nicht vorhanden: ${name}`); return; }
  const pw = process.env.DASHBOARD_PASSWORT || await passwortAbfragen(`Passwort für ${name} (mind. ${MIN_PASSWORT} Zeichen): `);
  if (pw.length < MIN_PASSWORT) { console.error(`Passwort zu kurz (mind. ${MIN_PASSWORT} Zeichen).`); process.exit(1); }
  if (!process.env.DASHBOARD_PASSWORT && pw !== await passwortAbfragen('Wiederholen: ')) { console.error('Passwörter stimmen nicht überein.'); process.exit(1); }
  b.setzen(name, pw);
  console.log(`Gespeichert: ${name} (${datei})`);
}

if (require.main === module) cli();
module.exports = { Benutzer, hashen, vergleichen };
