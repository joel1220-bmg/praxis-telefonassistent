// Rückrufwünsche in SQLite (node:sqlite, in Node enthalten).
const { DatabaseSync } = require('node:sqlite');

class RueckrufSpeicher {
  constructor(datei) {
    this.db = new DatabaseSync(datei);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rueckrufe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eingegangen TEXT NOT NULL,
        vorname TEXT NOT NULL,
        nachname TEXT NOT NULL,
        geburtsdatum TEXT NOT NULL,
        telefon TEXT NOT NULL,
        kategorie TEXT NOT NULL,
        dringend INTEGER NOT NULL,
        anliegen TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offen',
        erledigt_von TEXT,
        erledigt_am TEXT
      )`);
  }

  hinzufuegen(r) {
    const e = this.db.prepare(`INSERT INTO rueckrufe (eingegangen, vorname, nachname, geburtsdatum, telefon, kategorie, dringend, anliegen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(r.eingegangen, r.vorname, r.nachname, r.geburtsdatum, r.telefon, r.kategorie, r.dringend ? 1 : 0, r.anliegen);
    return Number(e.lastInsertRowid);
  }

  liste(status) {
    const reihenfolge = status === 'offen' ? 'dringend DESC, eingegangen ASC' : 'erledigt_am DESC';
    return this.db.prepare(`SELECT * FROM rueckrufe WHERE status = ? ORDER BY ${reihenfolge} LIMIT 500`).all(status)
      .map((r) => ({ ...r, dringend: r.dringend === 1 }));
  }

  erledigen(id, benutzer, zeitpunkt) {
    const e = this.db.prepare("UPDATE rueckrufe SET status = 'erledigt', erledigt_von = ?, erledigt_am = ? WHERE id = ? AND status = 'offen'")
      .run(benutzer, zeitpunkt, id);
    return e.changes === 1;
  }

  zaehlen() {
    const z = this.db.prepare("SELECT COUNT(*) AS offen, COALESCE(SUM(dringend), 0) AS dringend FROM rueckrufe WHERE status = 'offen'").get();
    return { offen: Number(z.offen), dringend: Number(z.dringend) };
  }

  // Datensparsamkeit: erledigte Einträge nach der Aufbewahrungsfrist endgültig löschen.
  aufraeumen(grenzeIso) {
    return this.db.prepare("DELETE FROM rueckrufe WHERE status = 'erledigt' AND erledigt_am < ?").run(grenzeIso).changes;
  }

  demoDaten(jetzt) {
    const iso = (d) => d.toISO({ suppressMilliseconds: true });
    const beispiele = [
      { vor: 25, vorname: 'Klaus', nachname: 'Becker', geburtsdatum: '1956-03-11', telefon: '+491701234567', kategorie: 'rezept', dringend: false, anliegen: 'Folgerezept für das Blutdruckmittel, Packung reicht noch eine Woche.' },
      { vor: 70, vorname: 'Sabine', nachname: 'Wolf', geburtsdatum: '1984-11-02', telefon: '+4915209876543', kategorie: 'krankschreibung', dringend: true, anliegen: 'Braucht heute noch eine Krankschreibung, war letzte Woche wegen Grippe da.' },
      { vor: 130, vorname: 'Mehmet', nachname: 'Yılmaz', geburtsdatum: '1990-07-24', telefon: '+491631112233', kategorie: 'befund', dringend: false, anliegen: 'Fragt nach den Laborwerten von der Blutabnahme am Montag.' },
      { vor: 200, vorname: 'Erika', nachname: 'Schneider', geburtsdatum: '1948-01-30', telefon: '+49301234567', kategorie: 'ueberweisung', dringend: false, anliegen: 'Überweisung zur Augenärztin, Termin dort ist nächste Woche.' },
    ];
    for (const b of beispiele) this.hinzufuegen({ ...b, eingegangen: iso(jetzt.minus({ minutes: b.vor })) });
    const id = this.hinzufuegen({
      eingegangen: iso(jetzt.minus({ days: 1, hours: 2 })), vorname: 'Jonas', nachname: 'Hoffmann', geburtsdatum: '2001-05-05',
      telefon: '+491578889990', kategorie: 'termin', dringend: false, anliegen: 'Wollte wissen, ob er zur Vorsorge nüchtern kommen muss.',
    });
    this.erledigen(id, 'demo', iso(jetzt.minus({ days: 1 })));
  }
}

// Anruf-Kennzahlen für die ROI-Ansicht. Bewusst ohne Telefonnummer, Namen oder Transkript.
class AnrufSpeicher {
  constructor(datei) {
    this.db = new DatabaseSync(datei);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS anrufe (
        id TEXT PRIMARY KEY,
        start TEXT NOT NULL,
        dauer_sek INTEGER NOT NULL,
        kosten_usd REAL NOT NULL,
        ende_grund TEXT NOT NULL,
        gebucht INTEGER NOT NULL,
        abgesagt INTEGER NOT NULL,
        rueckruf INTEGER NOT NULL,
        weitergeleitet INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS anrufe_start ON anrufe (start);`);
  }

  // start als UTC-ISO ("…Z"), damit Zeitraum-Abfragen als Textvergleich stimmen. Doppelte IDs werden ignoriert.
  hinzufuegen(a) {
    const e = this.db.prepare(`INSERT OR IGNORE INTO anrufe (id, start, dauer_sek, kosten_usd, ende_grund, gebucht, abgesagt, rueckruf, weitergeleitet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.start, a.dauerSek, a.kostenUsd, a.endeGrund,
      a.gebucht ? 1 : 0, a.abgesagt ? 1 : 0, a.rueckruf ? 1 : 0, a.weitergeleitet ? 1 : 0);
    return e.changes === 1;
  }

  zeitraum(vonIso, bisIso) {
    return this.db.prepare('SELECT * FROM anrufe WHERE start >= ? AND start < ? ORDER BY start').all(vonIso, bisIso).map((r) => ({
      id: r.id, start: r.start, dauerSek: Number(r.dauer_sek), kostenUsd: Number(r.kosten_usd), endeGrund: r.ende_grund,
      gebucht: r.gebucht === 1, abgesagt: r.abgesagt === 1, rueckruf: r.rueckruf === 1, weitergeleitet: r.weitergeleitet === 1,
    }));
  }

  aufraeumen(grenzeIso) {
    return this.db.prepare('DELETE FROM anrufe WHERE start < ?').run(grenzeIso).changes;
  }

  // Erzeugte Beispielanrufe der letzten 90 Tage (fester Startwert, damit die Demo immer gleich aussieht).
  demoDaten(jetzt) {
    let zufall = 20260928;
    const z = () => { zufall = (zufall * 1103515245 + 12345) % 2147483648; return zufall / 2147483648; };
    const stundenGewicht = [0, 0, 0, 0, 0, 0, 1, 4, 9, 10, 8, 6, 4, 5, 6, 8, 7, 5, 4, 3, 2, 1, 1, 0];
    const summe = stundenGewicht.reduce((s, g) => s + g, 0);
    const stunde = () => {
      let r = z() * summe;
      for (let h = 0; h < 24; h++) { r -= stundenGewicht[h]; if (r < 0) return h; }
      return 12;
    };
    for (let tag = 89; tag >= 0; tag--) {
      const d = jetzt.minus({ days: tag }).startOf('day');
      const wochenende = d.weekday >= 6;
      const anzahl = Math.round((wochenende ? 3 : 14) + z() * (wochenende ? 4 : 12));
      for (let i = 0; i < anzahl; i++) {
        const start = d.set({ hour: stunde(), minute: Math.floor(z() * 60), second: Math.floor(z() * 60) });
        if (start > jetzt) continue;
        const dauerSek = z() < 0.08 ? Math.round(5 + z() * 12) : Math.round(45 + z() * 200);
        const r = dauerSek < 20 ? 1 : z(); // kurze Anrufe (aufgelegt) ohne Ergebnis
        this.hinzufuegen({
          id: `demo-${tag}-${i}`,
          start: start.toUTC().toISO({ suppressMilliseconds: true }),
          dauerSek,
          kostenUsd: Math.round((dauerSek / 60) * 0.13 * 10000) / 10000,
          endeGrund: r < 0.1 ? 'assistant-forwarded-call' : 'customer-ended-call',
          weitergeleitet: r < 0.1,
          gebucht: r >= 0.1 && r < 0.48,
          rueckruf: r >= 0.48 && r < 0.68,
          abgesagt: r >= 0.68 && r < 0.76,
        });
      }
    }
  }
}

module.exports = { RueckrufSpeicher, AnrufSpeicher };
