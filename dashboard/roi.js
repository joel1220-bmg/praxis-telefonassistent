// ROI-Berechnung für die Ansicht "Wirkung". Reine Funktion: Anrufe + Annahmen aus der Config → Kennzahlen.
const { DateTime } = require('luxon');

const runde = (x, stellen = 2) => Math.round(x * 10 ** stellen) / 10 ** stellen;

// anrufe: Einträge aus AnrufSpeicher.zeitraum(); von/bis: DateTime (Tagesanfang, bis exklusiv) in Praxis-Zeitzone.
function roiBerechnen(config, lib, anrufe, { von, bis }) {
  const a = config.roi;
  const proTag = new Map();
  for (let d = von; d < bis; d = d.plus({ days: 1 })) proTag.set(d.toISODate(), { datum: d.toISODate(), drinnen: 0, draussen: 0 });
  const raster = Array.from({ length: 7 }, () => Array(24).fill(0)); // Wochentag (Mo=0) × Stunde

  const k = {
    anrufe: 0, ausserhalbSprechzeit: 0, sekundenGesamt: 0,
    gebucht: 0, abgesagt: 0, rueckrufe: 0, weitergeleitet: 0, gezaehlt: 0, personalMinuten: 0, kostenUsd: 0,
  };
  for (const anruf of anrufe) {
    const start = DateTime.fromISO(anruf.start, { zone: 'utc' }).setZone(config.zeitzone);
    if (!start.isValid) continue;
    const drinnen = lib.inSprechzeit(config, start);
    k.anrufe += 1;
    if (!drinnen) k.ausserhalbSprechzeit += 1;
    k.sekundenGesamt += anruf.dauerSek;
    k.kostenUsd += anruf.kostenUsd;
    if (anruf.gebucht) k.gebucht += 1;
    if (anruf.abgesagt) k.abgesagt += 1;
    if (anruf.rueckruf) k.rueckrufe += 1;
    if (anruf.weitergeleitet) k.weitergeleitet += 1;
    // Gesparte Zeit nur, wenn der Assistent das Gespräch selbst geführt hat.
    if (!anruf.weitergeleitet && anruf.dauerSek >= a.mindestSekunden) {
      k.gezaehlt += 1;
      k.personalMinuten += anruf.dauerSek / 60 + a.nacharbeitMinuten;
    }
    const tag = proTag.get(start.toISODate());
    if (tag) tag[drinnen ? 'drinnen' : 'draussen'] += 1;
    raster[start.weekday - 1][start.hour] += 1;
  }

  const personalStunden = k.personalMinuten / 60;
  const ersparnisEuro = personalStunden * a.stundensatzEuro;
  const kiKostenEuro = k.kostenUsd * a.usdInEur;
  return {
    zeitraum: { von: von.toISODate(), bis: bis.minus({ days: 1 }).toISODate(), tage: Math.round(bis.diff(von, 'days').days) },
    annahmen: { ...a },
    kennzahlen: {
      anrufe: k.anrufe,
      ausserhalbSprechzeit: k.ausserhalbSprechzeit,
      minutenGesamt: runde(k.sekundenGesamt / 60, 1),
      durchschnittSekunden: k.anrufe ? Math.round(k.sekundenGesamt / k.anrufe) : 0,
      gebucht: k.gebucht,
      abgesagt: k.abgesagt,
      rueckrufe: k.rueckrufe,
      weitergeleitet: k.weitergeleitet,
      alsErsparnisGezaehlt: k.gezaehlt,
      personalStunden: runde(personalStunden, 1),
      ersparnisEuro: runde(ersparnisEuro),
      kiKostenEuro: runde(kiKostenEuro),
      nettoEuro: runde(ersparnisEuro - kiKostenEuro),
      roiFaktor: kiKostenEuro > 0 ? runde(ersparnisEuro / kiKostenEuro, 1) : null,
    },
    proTag: [...proTag.values()],
    stundenRaster: raster,
  };
}

module.exports = { roiBerechnen };
