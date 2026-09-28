// Gesamte Logik des Telefonassistenten. Reine Funktionen ohne I/O.
// Wird von build.js unverändert in die n8n-Code-Nodes eingebettet (dort ist `DateTime` = Luxon global)
// und in den Tests mit `require('luxon').DateTime` aufgerufen.
function makeLib(DateTime) {
  const ROUTE = { suche: 0, buchen: 1, finden: 2, absagen: 3, rueckruf: 4, direkt: 5 };
  const TOOL_ROUTE = {
    freie_termine_suchen: ROUTE.suche,
    termin_buchen: ROUTE.buchen,
    termine_finden: ROUTE.finden,
    termin_absagen: ROUTE.absagen,
    rueckruf_notieren: ROUTE.rueckruf,
  };
  const WOCHENTAGE = ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'];
  const VERSICHERUNGEN = ['gesetzlich', 'privat', 'selbstzahler', 'unbekannt'];
  const KATEGORIEN = {
    rezept: 'Rezept',
    ueberweisung: 'Überweisung',
    befund: 'Befund / Ergebnis',
    krankschreibung: 'Krankschreibung',
    termin: 'Terminfrage',
    sonstiges: 'Sonstiges',
  };
  const QUELLE = 'telefonassistent';

  class Eingabefehler extends Error {}

  // ---------- Eingaben säubern ----------

  function text(wert, maxLaenge) {
    if (wert === undefined || wert === null) return '';
    return String(wert)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLaenge);
  }

  function name(wert, feld) {
    const n = text(wert, 60).replace(/[^\p{L}\p{M} .'\-]/gu, '').trim();
    if (!/\p{L}/u.test(n) || !koelnerPhonetik(n)) throw new Eingabefehler(`${feld} fehlt oder ist ungültig. Bitte nachfragen und buchstabieren lassen.`);
    return n;
  }

  function geburtsdatum(wert, jetzt) {
    const s = text(wert, 20);
    let d = DateTime.invalid('Format');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = DateTime.fromISO(s, { zone: 'UTC' });
    else if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) d = DateTime.fromFormat(s, 'd.M.yyyy', { zone: 'UTC' });
    if (!d.isValid) {
      throw new Eingabefehler('Geburtsdatum ungültig. Bitte Tag, Monat und vierstelliges Jahr erfragen (Format JJJJ-MM-TT).');
    }
    const heute = jetzt.setZone('UTC').startOf('day');
    if (d > heute || d < heute.minus({ years: 120 })) {
      throw new Eingabefehler('Geburtsdatum unplausibel. Bitte noch einmal nachfragen.');
    }
    return d.toISODate();
  }

  function telefon(wert, anrufer) {
    const roh = text(wert, 30) || text(anrufer, 30);
    const t = roh.replace(/[\s\-\/().]/g, '');
    if (!/^\+?[0-9]{6,15}$/.test(t)) {
      throw new Eingabefehler('Telefonnummer fehlt oder ist ungültig. Bitte eine Rückrufnummer erfragen.');
    }
    return t;
  }

  function auswahl(wert, erlaubt, feld, standard) {
    const w = text(wert, 30).toLowerCase();
    if (!w && standard !== undefined) return standard;
    if (!erlaubt.includes(w)) throw new Eingabefehler(`${feld} muss einer dieser Werte sein: ${erlaubt.join(', ')}.`);
    return w;
  }

  function terminart(config, wert) {
    const art = auswahl(wert, Object.keys(config.terminarten), 'terminart');
    return { schluessel: art, ...config.terminarten[art] };
  }

  // ---------- Kölner Phonetik (für Namen aus der Spracherkennung) ----------

  function koelnerPhonetik(eingabe) {
    const s = String(eingabe || '')
      .toUpperCase()
      .replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U').replace(/ß/g, 'S')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z]/g, '');
    const codes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const vor = s[i - 1] || '';
      const nach = s[i + 1] || '';
      let code = '';
      if ('AEIJOUY'.includes(c)) code = '0';
      else if (c === 'H') code = '';
      else if (c === 'B') code = '1';
      else if (c === 'P') code = nach === 'H' ? '3' : '1';
      else if (c === 'D' || c === 'T') code = 'CSZ'.includes(nach) && nach ? '8' : '2';
      else if ('FVW'.includes(c)) code = '3';
      else if ('GKQ'.includes(c)) code = '4';
      else if (c === 'C') {
        if (i === 0) code = 'AHKLOQRUX'.includes(nach) && nach ? '4' : '8';
        else code = 'AHKOQUX'.includes(nach) && nach && !'SZ'.includes(vor) ? '4' : '8';
      } else if (c === 'X') code = 'CKQ'.includes(vor) && vor ? '8' : '48';
      else if (c === 'L') code = '5';
      else if (c === 'M' || c === 'N') code = '6';
      else if (c === 'R') code = '7';
      else if (c === 'S' || c === 'Z') code = '8';
      codes.push(code);
    }
    const roh = codes.join('');
    let ohneDoppelte = '';
    for (const z of roh) if (z !== ohneDoppelte[ohneDoppelte.length - 1]) ohneDoppelte += z;
    return ohneDoppelte.charAt(0) + ohneDoppelte.slice(1).replace(/0/g, '');
  }

  function nameCode(n) {
    return koelnerPhonetik(n);
  }

  // ---------- Zeit & Slots ----------

  function zeit(config, iso) {
    return DateTime.fromISO(iso, { zone: config.zeitzone });
  }

  function isoOhneMs(d) {
    return d.toISO({ suppressMilliseconds: true });
  }

  function sprechTag(d) {
    return d.setLocale('de').toFormat('cccc, d. LLLL');
  }

  function sprechZeit(d) {
    return `${sprechTag(d)}, ${d.toFormat('H:mm')} Uhr`;
  }

  function istFrei(config, tag) {
    const datum = tag.toISODate();
    if ((config.feiertage || []).includes(datum)) return false;
    return !(config.urlaub || []).some((u) => datum >= u.von && datum <= u.bis);
  }

  // Alle Startzeiten eines Tages laut Sprechzeiten und Raster (ohne Belegung).
  function tagesSlots(config, tag, dauer) {
    if (!istFrei(config, tag)) return [];
    const bloecke = config.sprechzeiten[WOCHENTAGE[tag.weekday - 1]] || [];
    const slots = [];
    for (const [von, bis] of bloecke) {
      const [vh, vm] = von.split(':').map(Number);
      const [bh, bm] = bis.split(':').map(Number);
      const start = tag.set({ hour: vh, minute: vm, second: 0, millisecond: 0 });
      const ende = tag.set({ hour: bh, minute: bm, second: 0, millisecond: 0 });
      for (let t = start; t.plus({ minutes: dauer }) <= ende; t = t.plus({ minutes: config.rasterMinuten })) {
        slots.push(t);
      }
    }
    return slots;
  }

  function ueberschneidet(start, ende, belegt) {
    return belegt.some((b) => start < b.ende && b.start < ende);
  }

  function belegungLesen(config, antwort) {
    if (!antwort || antwort.error) throw new Error('Kalenderabfrage fehlgeschlagen');
    const kalender = antwort.calendars || {};
    const eintrag = kalender[config.kalenderId] || Object.values(kalender)[0];
    if (!eintrag || (eintrag.errors && eintrag.errors.length)) throw new Error('Kalender nicht lesbar');
    return (eintrag.busy || []).map((b) => ({ start: zeit(config, b.start), ende: zeit(config, b.end) }));
  }

  function fruehesterStart(config, jetzt) {
    return jetzt.plus({ minutes: config.vorlaufMinuten });
  }

  function horizontEnde(config, jetzt) {
    return jetzt.startOf('day').plus({ days: config.horizontTage }).endOf('day');
  }

  function freieSlots(config, { jetzt, von, bis, dauer, tageszeit, belegt }) {
    const ergebnis = [];
    const proTag = {};
    for (let tag = von.startOf('day'); tag <= bis; tag = tag.plus({ days: 1 })) {
      for (const start of tagesSlots(config, tag, dauer)) {
        const ende = start.plus({ minutes: dauer });
        if (start < von || ende > bis || start < fruehesterStart(config, jetzt)) continue;
        if (tageszeit === 'vormittag' && start.hour >= 12) continue;
        if (tageszeit === 'nachmittag' && start.hour < 12) continue;
        if (ueberschneidet(start, ende, belegt)) continue;
        const key = tag.toISODate();
        if ((proTag[key] || 0) >= config.maxVorschlaegeProTag) break;
        proTag[key] = (proTag[key] || 0) + 1;
        ergebnis.push(start);
        if (ergebnis.length >= config.maxVorschlaege) return ergebnis;
      }
    }
    return ergebnis;
  }

  function istGueltigerSlot(config, start, dauer, jetzt) {
    if (start < fruehesterStart(config, jetzt) || start > horizontEnde(config, jetzt)) return false;
    return tagesSlots(config, start.startOf('day'), dauer).some((s) => s.toMillis() === start.toMillis());
  }

  // ---------- Google-Calendar-Requests ----------

  function kalenderUrl(config, pfad) {
    return `${config.googleApiBasis}/calendar/v3/calendars/${encodeURIComponent(config.kalenderId)}${pfad}`;
  }

  function freeBusyRequest(config, von, bis) {
    return {
      method: 'POST',
      url: `${config.googleApiBasis}/calendar/v3/freeBusy`,
      body: {
        timeMin: isoOhneMs(von),
        timeMax: isoOhneMs(bis),
        timeZone: config.zeitzone,
        items: [{ id: config.kalenderId }],
      },
    };
  }

  function patientenTermineRequest(config, gebdat, jetzt) {
    const q = [
      `privateExtendedProperty=${encodeURIComponent(`quelle=${QUELLE}`)}`,
      `privateExtendedProperty=${encodeURIComponent(`gebdat=${gebdat}`)}`,
      `timeMin=${encodeURIComponent(isoOhneMs(jetzt))}`,
      'singleEvents=true',
      'orderBy=startTime',
      'maxResults=50',
    ].join('&');
    return { method: 'GET', url: kalenderUrl(config, `/events?${q}`), body: {} };
  }

  function patientTermine(config, antwort, nachname) {
    if (!antwort || antwort.error) throw new Error('Kalenderabfrage fehlgeschlagen');
    const code = nameCode(nachname);
    return (antwort.items || [])
      .filter((e) => e.status !== 'cancelled')
      .filter((e) => ((e.extendedProperties || {}).private || {}).nachnameCode === code)
      .map((e) => ({ id: e.id, start: zeit(config, e.start.dateTime), summary: e.summary || '' }));
  }

  // ---------- Vapi ----------

  function antwort(toolCallId, ergebnis) {
    return { results: [{ toolCallId, result: ergebnis }] };
  }

  function argumenteLesen(roh) {
    if (typeof roh === 'string') {
      try { return JSON.parse(roh) || {}; } catch (e) { return {}; }
    }
    return roh && typeof roh === 'object' ? roh : {};
  }

  // Erster Schritt jeder Ausführung: Vapi-Nachricht lesen, validieren, Requests vorbereiten.
  function vorbereiten(config, body, jetztIso) {
    const jetzt = zeit(config, jetztIso);
    const nachricht = (body && body.message) || {};
    const aufruf = (nachricht.toolCallList || [])[0];
    if (nachricht.type !== 'tool-calls' || !aufruf || !aufruf.function) {
      return { route: ROUTE.direkt, antwort: { results: [] } };
    }
    const tool = aufruf.function.name;
    const toolCallId = text(aufruf.id, 100);
    const args = argumenteLesen(aufruf.function.arguments);
    const anrufer = ((nachricht.call || {}).customer || {}).number || (nachricht.customer || {}).number || '';
    const basis = { tool, toolCallId, jetzt: isoOhneMs(jetzt) };

    if (!(tool in TOOL_ROUTE)) {
      return { ...basis, route: ROUTE.direkt, antwort: antwort(toolCallId, `Unbekanntes Werkzeug: ${text(tool, 60)}`) };
    }
    try {
      return { ...basis, route: TOOL_ROUTE[tool], ...VORBEREITUNG[tool](config, args, jetzt, anrufer) };
    } catch (e) {
      if (!(e instanceof Eingabefehler)) throw e;
      return { ...basis, route: ROUTE.direkt, antwort: antwort(toolCallId, `Fehler: ${e.message}`) };
    }
  }

  const VORBEREITUNG = {
    freie_termine_suchen(config, args, jetzt) {
      const art = terminart(config, args.terminart);
      const tageszeit = auswahl(args.tageszeit, ['vormittag', 'nachmittag', 'egal'], 'tageszeit', 'egal');
      let von = fruehesterStart(config, jetzt);
      let bis = horizontEnde(config, jetzt);
      if (text(args.ab_datum, 20)) {
        const ab = DateTime.fromISO(text(args.ab_datum, 20), { zone: config.zeitzone });
        if (!ab.isValid) throw new Eingabefehler('ab_datum muss im Format JJJJ-MM-TT sein.');
        if (ab.startOf('day') > von) von = ab.startOf('day');
        if (args.nur_dieser_tag === true || args.nur_dieser_tag === 'true') bis = DateTime.min(bis, ab.endOf('day'));
      }
      if (von >= bis) {
        return { route: ROUTE.direkt, antwort: null, keinZeitraum: true };
      }
      return {
        suche: { terminart: art.schluessel, dauer: art.dauer, tageszeit, von: isoOhneMs(von), bis: isoOhneMs(bis) },
        http: freeBusyRequest(config, von, bis),
      };
    },

    termin_buchen(config, args, jetzt, anrufer) {
      const art = terminart(config, args.terminart);
      const start = zeit(config, text(args.start, 40));
      if (!start.isValid) throw new Eingabefehler('start fehlt. Zuerst freie_termine_suchen aufrufen und den genauen start-Wert verwenden.');
      const ende = start.plus({ minutes: art.dauer });
      const buchung = {
        terminart: art.schluessel,
        start: isoOhneMs(start),
        ende: isoOhneMs(ende),
        vorname: name(args.vorname, 'Vorname'),
        nachname: name(args.nachname, 'Nachname'),
        geburtsdatum: geburtsdatum(args.geburtsdatum, jetzt),
        telefon: telefon(args.telefon, anrufer),
        versicherung: auswahl(args.versicherung, VERSICHERUNGEN, 'versicherung', 'unbekannt'),
        anliegen: text(args.anliegen, 200),
      };
      if (!istGueltigerSlot(config, start, art.dauer, jetzt)) {
        throw new Eingabefehler('Diese Uhrzeit ist kein buchbarer Termin. Bitte mit freie_termine_suchen einen freien Termin suchen.');
      }
      return {
        buchung,
        http: freeBusyRequest(config, start, ende),
        http2: patientenTermineRequest(config, buchung.geburtsdatum, jetzt),
      };
    },

    termine_finden(config, args, jetzt) {
      const suche = { nachname: name(args.nachname, 'Nachname'), geburtsdatum: geburtsdatum(args.geburtsdatum, jetzt) };
      return { suche, http: patientenTermineRequest(config, suche.geburtsdatum, jetzt) };
    },

    termin_absagen(config, args, jetzt) {
      const id = text(args.termin_id, 1024);
      if (!/^[A-Za-z0-9_\-]{5,1024}$/.test(id)) {
        throw new Eingabefehler('termin_id fehlt oder ist ungültig. Zuerst termine_finden aufrufen.');
      }
      const absage = { id, nachname: name(args.nachname, 'Nachname'), geburtsdatum: geburtsdatum(args.geburtsdatum, jetzt) };
      return { absage, http: { method: 'GET', url: kalenderUrl(config, `/events/${encodeURIComponent(id)}`), body: {} } };
    },

    rueckruf_notieren(config, args, jetzt, anrufer) {
      const kategorie = auswahl(args.kategorie, Object.keys(KATEGORIEN), 'kategorie', 'sonstiges');
      const anliegen = text(args.anliegen, 500);
      if (!anliegen) throw new Eingabefehler('anliegen fehlt. Bitte kurz erfragen, worum es geht.');
      const r = {
        vorname: name(args.vorname, 'Vorname'),
        nachname: name(args.nachname, 'Nachname'),
        geburtsdatum: text(args.geburtsdatum, 20) ? geburtsdatum(args.geburtsdatum, jetzt) : 'nicht angegeben',
        telefon: telefon(args.telefon, anrufer),
        kategorie,
        dringend: args.dringend === true || args.dringend === 'true',
        anliegen,
      };
      const betreff = `${r.dringend ? '[DRINGEND] ' : ''}Rückruf: ${KATEGORIEN[kategorie]} – ${r.nachname}, ${r.vorname}`;
      const inhalt = [
        `Rückrufwunsch vom Telefonassistenten (${jetzt.setLocale('de').toFormat("dd.LL.yyyy, HH:mm 'Uhr'")})`,
        '',
        `Name:          ${r.vorname} ${r.nachname}`,
        `Geburtsdatum:  ${r.geburtsdatum}`,
        `Rückrufnummer: ${r.telefon}`,
        `Kategorie:     ${KATEGORIEN[kategorie]}`,
        `Dringend:      ${r.dringend ? 'ja' : 'nein'}`,
        '',
        'Anliegen:',
        r.anliegen,
        '',
        'Hinweis: Angaben stammen aus einem automatisierten Telefonat und sind nicht verifiziert.',
      ].join('\n');
      return {
        email: { von: config.email.von, an: config.email.an, betreff, inhalt },
        dashboard: {
          url: `${config.dashboardUrl}/intern/rueckruf`,
          body: { ...r, eingegangen: isoOhneMs(jetzt) },
        },
      };
    },
  };

  // ---------- Schritte nach den Kalender-Aufrufen ----------

  function nachSuche(config, vorb, freeBusyAntwort) {
    const jetzt = zeit(config, vorb.jetzt);
    let belegt;
    try {
      belegt = belegungLesen(config, freeBusyAntwort);
    } catch (e) {
      return antwort(vorb.toolCallId, 'Technischer Fehler beim Kalender. Biete einen Rückruf an (rueckruf_notieren) oder die Weiterleitung an das Praxisteam.');
    }
    const s = vorb.suche;
    const slots = freieSlots(config, {
      jetzt,
      von: zeit(config, s.von),
      bis: zeit(config, s.bis),
      dauer: s.dauer,
      tageszeit: s.tageszeit,
      belegt,
    });
    const bezeichnung = config.terminarten[s.terminart].bezeichnung;
    if (!slots.length) {
      return antwort(vorb.toolCallId,
        `Kein freier Termin (${bezeichnung}) im gesuchten Zeitraum. Frag nach einem anderen Tag oder einer anderen Tageszeit, `
        + 'oder biete einen Rückruf an.');
    }
    const liste = slots.map((d, i) => `${i + 1}) ${sprechZeit(d)} [start=${isoOhneMs(d)}]`).join('\n');
    return antwort(vorb.toolCallId,
      `Freie Termine (${bezeichnung}, ${s.dauer} Minuten):\n${liste}\n`
      + 'Nenne nur diese Termine, ohne den start-Wert vorzulesen. Für termin_buchen den start-Wert exakt übernehmen.');
  }

  function buchungPruefen(config, vorb, freeBusyAntwort, bestehendeAntwort) {
    const b = vorb.buchung;
    let belegt;
    let bestehende;
    try {
      belegt = belegungLesen(config, freeBusyAntwort);
      bestehende = patientTermine(config, bestehendeAntwort, b.nachname);
    } catch (e) {
      return { ok: false, antwort: antwort(vorb.toolCallId, 'Technischer Fehler beim Kalender. Termin wurde NICHT gebucht. Biete einen Rückruf an.') };
    }
    const start = zeit(config, b.start);
    const schonGebucht = bestehende.find((t) => t.start.toMillis() === start.toMillis());
    if (schonGebucht) {
      return { ok: false, antwort: antwort(vorb.toolCallId, `Dieser Termin ist für die Person bereits gebucht: ${sprechZeit(start)}. Termin-ID: ${schonGebucht.id}`) };
    }
    if (bestehende.length >= config.maxOffeneTerminePatient) {
      return { ok: false, antwort: antwort(vorb.toolCallId,
        `Nicht gebucht: Die Person hat bereits ${bestehende.length} offene Termine (Maximum ${config.maxOffeneTerminePatient}). `
        + 'Biete an, einen bestehenden Termin zu verlegen, oder verbinde mit dem Praxisteam.') };
    }
    if (belegt.length) {
      return { ok: false, antwort: antwort(vorb.toolCallId, 'Dieser Termin ist inzwischen vergeben. Nicht gebucht. Rufe freie_termine_suchen erneut auf und biete Alternativen an.') };
    }
    const art = config.terminarten[b.terminart];
    const beschreibung = [
      `Terminart: ${art.bezeichnung}`,
      `Geburtsdatum: ${b.geburtsdatum}`,
      `Telefon: ${b.telefon}`,
      `Versicherung: ${b.versicherung}`,
      b.anliegen ? `Anliegen: ${b.anliegen}` : null,
      '',
      `Gebucht vom Telefonassistenten am ${zeit(config, vorb.jetzt).setLocale('de').toFormat("dd.LL.yyyy, HH:mm 'Uhr'")}.`,
    ].filter((z) => z !== null).join('\n');
    return {
      ok: true,
      http: {
        method: 'POST',
        url: kalenderUrl(config, '/events?sendUpdates=none'),
        body: {
          summary: `${art.bezeichnung}: ${b.nachname}, ${b.vorname}`,
          description: beschreibung,
          start: { dateTime: b.start, timeZone: config.zeitzone },
          end: { dateTime: b.ende, timeZone: config.zeitzone },
          extendedProperties: { private: { quelle: QUELLE, gebdat: b.geburtsdatum, nachnameCode: nameCode(b.nachname) } },
        },
      },
    };
  }

  function nachBuchung(config, vorb, eventAntwort) {
    if (!eventAntwort || eventAntwort.error || !eventAntwort.id) {
      return antwort(vorb.toolCallId, 'Technischer Fehler: Termin wurde NICHT gebucht. Biete einen Rückruf an.');
    }
    const start = zeit(config, vorb.buchung.start);
    return antwort(vorb.toolCallId,
      `Gebucht: ${config.terminarten[vorb.buchung.terminart].bezeichnung} am ${sprechZeit(start)} für ${vorb.buchung.vorname} ${vorb.buchung.nachname}. `
      + `Termin-ID: ${eventAntwort.id}. Bestätige Datum und Uhrzeit und erinnere an die Versichertenkarte.`);
  }

  function nachFinden(config, vorb, listeAntwort) {
    let termine;
    try {
      termine = patientTermine(config, listeAntwort, vorb.suche.nachname);
    } catch (e) {
      return antwort(vorb.toolCallId, 'Technischer Fehler beim Kalender. Biete einen Rückruf an.');
    }
    if (!termine.length) {
      return antwort(vorb.toolCallId,
        'Keine zukünftigen Termine zu diesem Namen und Geburtsdatum gefunden. Prüfe Schreibweise und Geburtsdatum. '
        + 'Termine, die direkt in der Praxis vereinbart wurden, kann nur das Praxisteam ändern.');
    }
    const liste = termine.map((t, i) => `${i + 1}) ${sprechZeit(t.start)} – ${t.summary.split(':')[0]} [termin_id=${t.id}]`).join('\n');
    return antwort(vorb.toolCallId, `Gefundene Termine:\n${liste}\nDie termin_id nicht vorlesen.`);
  }

  function absagePruefen(config, vorb, eventAntwort) {
    const jetzt = zeit(config, vorb.jetzt);
    const e = eventAntwort || {};
    const privat = (e.extendedProperties || {}).private || {};
    const passt = !e.error && e.status !== 'cancelled' && privat.quelle === QUELLE
      && privat.gebdat === vorb.absage.geburtsdatum && privat.nachnameCode === nameCode(vorb.absage.nachname);
    if (!passt) {
      return { ok: false, antwort: antwort(vorb.toolCallId, 'Termin nicht gefunden oder Name/Geburtsdatum passen nicht. Nichts abgesagt. Rufe termine_finden auf.') };
    }
    const start = zeit(config, e.start.dateTime);
    if (start < jetzt.plus({ hours: config.absageMindestStunden })) {
      return { ok: false, antwort: antwort(vorb.toolCallId, 'Dieser Termin ist zu kurzfristig für eine Absage über den Telefonassistenten. Verbinde mit dem Praxisteam.') };
    }
    return {
      ok: true,
      startIso: isoOhneMs(start),
      http: { method: 'DELETE', url: kalenderUrl(config, `/events/${encodeURIComponent(vorb.absage.id)}?sendUpdates=none`), body: {} },
    };
  }

  function nachAbsage(config, vorb, pruefung, loeschAntwort) {
    if (loeschAntwort && loeschAntwort.error) {
      return antwort(vorb.toolCallId, 'Technischer Fehler: Termin wurde NICHT abgesagt. Biete einen Rückruf an.');
    }
    return antwort(vorb.toolCallId, `Abgesagt: Termin am ${sprechZeit(zeit(config, pruefung.startIso))}.`);
  }

  // Erfolgreich, wenn mindestens einer der Wege (E-Mail, Dashboard) funktioniert hat.
  function nachRueckruf(vorb, mailAntwort, dashboardAntwort) {
    const mailOk = !(mailAntwort && mailAntwort.error);
    const dashboardOk = !!(dashboardAntwort && dashboardAntwort.ok === true);
    if (!mailOk && !dashboardOk) {
      return antwort(vorb.toolCallId, 'Technischer Fehler: Rückrufwunsch konnte nicht übermittelt werden. Bitte an das Praxisteam weiterverbinden.');
    }
    return antwort(vorb.toolCallId, 'Rückrufwunsch wurde an das Praxisteam übermittelt. Sage, dass sich die Praxis meldet; nenne keine feste Uhrzeit.');
  }

  function direkteAntwort(vorb) {
    if (vorb.keinZeitraum) {
      return antwort(vorb.toolCallId, 'Das gewünschte Datum liegt außerhalb des buchbaren Zeitraums. Frag nach einem anderen Tag.');
    }
    return vorb.antwort;
  }

  // ---------- Dashboard-API (zweiter n8n-Workflow) ----------

  const DASHBOARD_ROUTE = { termine: 0, absagen: 1, direkt: 2 };

  function dashboardVorbereiten(config, body, jetztIso) {
    const jetzt = zeit(config, jetztIso);
    const b = body || {};
    const fehler = (meldung) => ({ route: DASHBOARD_ROUTE.direkt, antwort: { ok: false, fehler: meldung } });
    if (b.aktion === 'termine') {
      const von = DateTime.fromISO(text(b.von, 10), { zone: config.zeitzone });
      const bis = DateTime.fromISO(text(b.bis, 10), { zone: config.zeitzone });
      if (!von.isValid || !bis.isValid || bis < von) return fehler('von/bis ungültig (JJJJ-MM-TT)');
      if (bis.diff(von, 'days').days > 31) return fehler('Zeitraum höchstens 31 Tage');
      const q = [
        `timeMin=${encodeURIComponent(isoOhneMs(von.startOf('day')))}`,
        `timeMax=${encodeURIComponent(isoOhneMs(bis.endOf('day')))}`,
        'singleEvents=true', 'orderBy=startTime', 'maxResults=2500',
      ].join('&');
      return { route: DASHBOARD_ROUTE.termine, http: { method: 'GET', url: kalenderUrl(config, `/events?${q}`), body: {} } };
    }
    if (b.aktion === 'absagen') {
      const id = text(b.id, 1024);
      if (!/^[A-Za-z0-9_\-]{5,1024}$/.test(id)) return fehler('Termin-ID ungültig');
      return {
        route: DASHBOARD_ROUTE.absagen,
        id,
        jetzt: isoOhneMs(jetzt),
        http: { method: 'GET', url: kalenderUrl(config, `/events/${encodeURIComponent(id)}`), body: {} },
      };
    }
    return fehler('unbekannte Aktion');
  }

  function terminFuerDashboard(config, e) {
    const privat = (e.extendedProperties || {}).private || {};
    const ganztaegig = !(e.start && e.start.dateTime);
    return {
      id: e.id,
      titel: text(e.summary, 200) || '(ohne Titel)',
      beschreibung: text(e.description, 2000).replace(/ (?=(Terminart|Geburtsdatum|Telefon|Versicherung|Anliegen|Gebucht):)/g, '\n'),
      start: ganztaegig ? e.start.date : isoOhneMs(zeit(config, e.start.dateTime)),
      ende: ganztaegig ? e.end.date : isoOhneMs(zeit(config, e.end.dateTime)),
      ganztaegig,
      frei: e.transparency === 'transparent', // in Google als "verfügbar" markiert: blockiert keine Termine
      quelle: privat.quelle === QUELLE ? 'telefonassistent' : 'praxis',
    };
  }

  function dashboardTermine(config, antwortGoogle) {
    if (!antwortGoogle || antwortGoogle.error || !Array.isArray(antwortGoogle.items)) {
      return { ok: false, fehler: 'Kalender nicht erreichbar' };
    }
    return {
      ok: true,
      termine: antwortGoogle.items.filter((e) => e.status !== 'cancelled').map((e) => terminFuerDashboard(config, e)),
    };
  }

  function dashboardAbsagePruefen(config, vorb, eventAntwort) {
    const e = eventAntwort || {};
    if (e.error || !e.id || e.status === 'cancelled') return { ok: false, fehler: 'Termin nicht gefunden' };
    if (!(e.start && e.start.dateTime) || zeit(config, e.start.dateTime) < zeit(config, vorb.jetzt)) {
      return { ok: false, fehler: 'Nur zukünftige Termine mit Uhrzeit können hier abgesagt werden' };
    }
    return {
      ok: true,
      termin: terminFuerDashboard(config, e),
      http: { method: 'DELETE', url: kalenderUrl(config, `/events/${encodeURIComponent(vorb.id)}?sendUpdates=none`), body: {} },
    };
  }

  function dashboardNachAbsage(pruefung, loeschAntwort) {
    if (loeschAntwort && loeschAntwort.error) return { ok: false, fehler: 'Löschen im Kalender fehlgeschlagen' };
    return { ok: true, abgesagt: pruefung.termin };
  }

  return {
    DASHBOARD_ROUTE, dashboardVorbereiten, dashboardTermine, dashboardAbsagePruefen, dashboardNachAbsage,
    ROUTE, Eingabefehler, KATEGORIEN, QUELLE, WOCHENTAGE, koelnerPhonetik, tagesSlots, freieSlots, istGueltigerSlot, istFrei,
    sprechZeit, fruehesterStart, horizontEnde, text,
    vorbereiten, nachSuche, buchungPruefen, nachBuchung, nachFinden, absagePruefen, nachAbsage, nachRueckruf, direkteAntwort,
  };
}

if (typeof module !== 'undefined') module.exports = { makeLib };
