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

module.exports = { RueckrufSpeicher };
