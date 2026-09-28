// Kalenderquellen für das Dashboard: echte Daten über n8n oder Demo-Daten im Speicher.
// Beide liefern dasselbe Format wie lib.dashboardTermine: { ok, termine: [...] } bzw. { ok: false, fehler }.

class N8nKalender {
  constructor({ url, token, gesundUrl, timeoutMs = 10000 }) {
    this.url = url;
    this.token = token;
    this.gesundUrl = gesundUrl || new URL('/healthz', url).toString();
    this.timeoutMs = timeoutMs;
  }

  async anfrage(body) {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) return { ok: false, fehler: 'n8n lehnt den Dashboard-Token ab' };
      if (res.status === 404) return { ok: false, fehler: 'Dashboard-Workflow in n8n nicht aktiv' };
      try { return JSON.parse(text); } catch (e) { return { ok: false, fehler: `Unerwartete Antwort von n8n (HTTP ${res.status})` }; }
    } catch (e) {
      return { ok: false, fehler: e.name === 'TimeoutError' ? 'n8n antwortet nicht (Zeitüberschreitung)' : 'n8n nicht erreichbar' };
    }
  }

  termine(von, bis) { return this.anfrage({ aktion: 'termine', von, bis }); }

  absagen(id) { return this.anfrage({ aktion: 'absagen', id }); }

  async erreichbar() {
    try {
      const res = await fetch(this.gesundUrl, { signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, fehler: res.ok ? null : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, fehler: 'nicht erreichbar' };
    }
  }
}

// Erzeugt reproduzierbare Beispieltermine im Google-Calendar-Format und nutzt dieselbe Aufbereitung wie n8n.
class DemoKalender {
  constructor(config, lib, jetzt) {
    this.config = config;
    this.lib = lib;
    this.events = new Map();
    this.erzeugen(jetzt || require('luxon').DateTime.now().setZone(config.zeitzone));
  }

  erzeugen(jetzt) {
    const namen = [
      ['Anna', 'Meier'], ['Peter', 'Schulz'], ['Lena', 'Fischer'], ['Tobias', 'Weber'], ['Maria', 'Wagner'],
      ['Ali', 'Kaya'], ['Sophie', 'Koch'], ['Jan', 'Richter'], ['Laura', 'Klein'], ['Heinz', 'Schröder'],
      ['Nina', 'Neumann'], ['Olga', 'Petrova'], ['Felix', 'Braun'], ['Greta', 'Zimmermann'], ['Paul', 'Krüger'],
    ];
    const arten = Object.entries(this.config.terminarten);
    let zufall = 20260927;
    const naechste = () => { zufall = (zufall * 1103515245 + 12345) % 2147483648; return zufall / 2147483648; };
    let nr = 1;
    for (let i = -3; i < 21; i++) {
      const tag = jetzt.startOf('day').plus({ days: i });
      const belegt = [];
      // Füllgrad: heute und die nächsten Tage voller, später leerer – wie in einer echten Praxis.
      const fuellgrad = i <= 2 ? 0.95 : i <= 7 ? 0.6 : 0.3;
      for (const start of this.lib.tagesSlots(this.config, tag, 15)) {
        if (naechste() > fuellgrad) continue;
        const [schluessel, art] = arten[Math.floor(naechste() * arten.length)];
        const ende = start.plus({ minutes: art.dauer });
        if (belegt.some((b) => start < b.ende && b.start < ende)) continue;
        const bloecke = this.config.sprechzeiten[this.lib.WOCHENTAGE[tag.weekday - 1]] || [];
        const block = bloecke.find(([von, bis]) => start.toFormat('HH:mm') >= von && start.toFormat('HH:mm') < bis);
        if (!block || ende.toFormat('HH:mm') > block[1]) continue;
        belegt.push({ start, ende });
        const [vorname, nachname] = namen[Math.floor(naechste() * namen.length)];
        const vomAssistenten = naechste() < 0.45;
        const id = `demo${String(nr++).padStart(5, '0')}`;
        const iso = (d) => d.toISO({ suppressMilliseconds: true });
        this.events.set(id, {
          id,
          status: 'confirmed',
          summary: `${art.bezeichnung}: ${nachname}, ${vorname}`,
          description: vomAssistenten
            ? [`Terminart: ${art.bezeichnung}`, `Geburtsdatum: 19${50 + Math.floor(naechste() * 50)}-0${1 + Math.floor(naechste() * 9)}-1${Math.floor(naechste() * 9)}`,
              `Telefon: +4915${Math.floor(10000000 + naechste() * 89999999)}`, `Versicherung: ${naechste() < 0.85 ? 'gesetzlich' : 'privat'}`,
              'Anliegen: Beispieldaten', '', 'Gebucht vom Telefonassistenten.'].join('\n')
            : '',
          start: { dateTime: iso(start) },
          end: { dateTime: iso(ende) },
          extendedProperties: vomAssistenten ? { private: { quelle: this.lib.QUELLE } } : undefined,
          terminart: schluessel,
        });
      }
    }
  }

  async termine(von, bis) {
    const items = [...this.events.values()]
      .filter((e) => e.start.dateTime.slice(0, 10) >= von && e.start.dateTime.slice(0, 10) <= bis)
      .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
    return this.lib.dashboardTermine(this.config, { items });
  }

  async absagen(id) {
    const e = this.events.get(String(id));
    const pruefung = this.lib.dashboardAbsagePruefen(this.config, {
      id, jetzt: require('luxon').DateTime.now().setZone(this.config.zeitzone).toISO(),
    }, e || { error: { code: 404 } });
    if (!pruefung.ok) return pruefung;
    this.events.delete(String(id));
    return this.lib.dashboardNachAbsage(pruefung, {});
  }

  async erreichbar() { return { ok: false, fehler: 'Demo-Modus, nicht verbunden' }; }
}

module.exports = { N8nKalender, DemoKalender };
