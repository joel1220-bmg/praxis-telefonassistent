// Praxis-Konfiguration. Nach jeder Änderung: `npm run build` und den Workflow in n8n neu importieren.
module.exports = {
  praxisName: 'Hausarztpraxis Dr. Muster',
  zeitzone: 'Europe/Berlin',

  // Google-Kalender, in den gebucht wird ("primary" = Hauptkalender des verbundenen Kontos).
  kalenderId: 'primary',
  googleApiBasis: 'https://www.googleapis.com',

  // Erster Satz am Telefon. Danach folgen automatisch der KI-Hinweis (Pflicht, EU AI Act) und der Notfall-Hinweis.
  begruessung: 'Moin, Apo Red am Start!',

  // Allgemeine Auskünfte, die der Assistent geben darf.
  praxisInfos: [
    'Adresse: Musterstraße 1, 12345 Musterstadt, 1. Stock, Aufzug vorhanden.',
    'Bitte zu jedem Termin die Versichertenkarte mitbringen.',
    'Außerhalb der Sprechzeiten: ärztlicher Bereitschaftsdienst unter 116 117.',
  ],

  // Rückrufwünsche gehen an diese Adresse.
  email: {
    von: 'telefonassistent@praxis-muster.de',
    an: 'empfang@praxis-muster.de',
  },

  // Mitarbeiter-Dashboard: Adresse, unter der n8n das Dashboard erreicht (Docker-Netz),
  // und wie lange erledigte Rückrufwünsche gespeichert bleiben.
  dashboardUrl: 'http://dashboard:8080',
  rueckrufeAufbewahrenTage: 30,

  // Sprechzeiten je Wochentag (mo..so), mehrere Blöcke pro Tag möglich.
  sprechzeiten: {
    mo: [['08:00', '12:00'], ['15:00', '18:00']],
    di: [['08:00', '12:00'], ['15:00', '18:00']],
    mi: [['08:00', '12:00']],
    do: [['08:00', '12:00'], ['15:00', '19:00']],
    fr: [['08:00', '13:00']],
    sa: [],
    so: [],
  },

  // Terminarten: Schlüssel = Wert, den der Assistent übergibt. dauer in Minuten.
  terminarten: {
    akut: { bezeichnung: 'Akutsprechstunde', dauer: 15, beschreibung: 'neue Beschwerden, Infekte, Schmerzen' },
    kontrolle: { bezeichnung: 'Kontrolltermin', dauer: 15, beschreibung: 'Verlaufskontrolle, Blutdruck, Befundbesprechung' },
    blutabnahme: { bezeichnung: 'Blutabnahme', dauer: 10, beschreibung: 'Labor, nüchtern morgens' },
    vorsorge: { bezeichnung: 'Vorsorgeuntersuchung', dauer: 30, beschreibung: 'Check-up, Gesundheitsuntersuchung' },
    erstgespraech: { bezeichnung: 'Erstgespräch', dauer: 30, beschreibung: 'neue Patientinnen und Patienten' },
  },

  rasterMinuten: 10,          // Termine beginnen nur auf diesem Raster ab Beginn des Sprechzeitblocks
  vorlaufMinuten: 60,         // frühestens so viele Minuten ab jetzt buchbar
  horizontTage: 28,           // so weit im Voraus wird gesucht/gebucht
  maxVorschlaege: 3,          // so viele Termine nennt der Assistent auf einmal
  maxVorschlaegeProTag: 2,    // Vorschläge über mehrere Tage streuen
  maxOffeneTerminePatient: 2, // Missbrauchsschutz: so viele zukünftige Termine pro Person
  absageMindestStunden: 0,    // Absage per Telefonassistent nur bis X Stunden vorher (0 = immer)

  // Feiertage und Brückentage (YYYY-MM-DD), an denen keine Termine vergeben werden.
  feiertage: [
    '2026-10-03', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-31',
    '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-01', '2027-05-06', '2027-05-17',
  ],

  // Praxisurlaub (inklusive beider Tage).
  urlaub: [
    // { von: '2026-12-27', bis: '2027-01-03' },
  ],
};
