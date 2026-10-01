// Legt den Vapi-Assistenten an bzw. aktualisiert ihn.
//
// Lokaler Test (lokal/start.js läuft):   node vapi/einrichten.js --lokal
//   Nur VAPI_API_KEY nötig. Webhook-Adresse und Token kommen aus lokal/daten/; Credential- und
//   Assistenten-ID werden in lokal/daten/vapi.json gemerkt, spätere Aufrufe aktualisieren nur.
//
// Server:  N8N_WEBHOOK_URL + VAPI_CREDENTIAL_ID (+ VAPI_ASSISTANT_ID zum Aktualisieren) setzen, dann ohne --lokal.
//          Statt VAPI_CREDENTIAL_ID geht VAPI_WEBHOOK_TOKEN (aus docker/.env): dann wird die Credential angelegt.
// Probelauf ohne API-Aufruf: --nur-datei
//
// Optional: PRAXIS_TELEFON       Nummer für Weiterleitungen; ohne sie gibt es kein Weiterleiten (gut für Tests)
//           ELEVENLABS_VOICE_ID  eigene ElevenLabs-Stimme (Flash v2.5); ohne Angabe die deutsche Azure-Stimme aus build.js.
//                                Bibliotheksstimmen gehen nur mit bezahltem ElevenLabs-Plan und ElevenLabs-Key in Vapi
//           VAPI_NUMMER_ID       ID einer Vapi-Telefonnummer; wird mit dem Assistenten verknüpft (lokal gemerkt)
//           VAPI_MODELL          anderes Claude-Modell, z. B. claude-haiku-4-5-20251001 (schneller, günstiger); Vapi nennt bei ungültigen Werten die erlaubte Liste
const fs = require('fs');
const path = require('path');

const VAPI = 'https://api.vapi.ai';
const LOKAL = path.join(__dirname, '..', 'lokal', 'daten');
const argv = process.argv.slice(2);
const nurDatei = argv.includes('--nur-datei');
const lokal = argv.includes('--lokal');

// Kein process.exit(): unter Windows bricht Node sonst mit einer Assertion ab, wenn noch fetch-Verbindungen schließen.
class Abbruch extends Error {}
function abbruch(text) { throw new Abbruch(text); }
const lesenJson = (datei) => (fs.existsSync(datei) ? JSON.parse(fs.readFileSync(datei, 'utf8')) : null);

async function vapi(methode, pfad, body) {
  const res = await fetch(VAPI + pfad, {
    method: methode,
    headers: { authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* kein JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

// Einstellungen zusammentragen: lokal aus lokal/daten, sonst aus Umgebungsvariablen.
function einstellungen() {
  if (!nurDatei && !process.env.VAPI_API_KEY) {
    abbruch('VAPI_API_KEY fehlt. In PowerShell:  $env:VAPI_API_KEY="<privater Key aus dashboard.vapi.ai → API Keys>"');
  }
  if (lokal) {
    const geheim = lesenJson(path.join(LOKAL, 'geheim.json'));
    const aktuell = lesenJson(path.join(LOKAL, 'aktuell.json'));
    if (!geheim || !aktuell) abbruch('Lokaler Testaufbau nicht gefunden. Zuerst in einem anderen Fenster starten:  node lokal/start.js');
    const gemerkt = lesenJson(path.join(LOKAL, 'vapi.json')) || {};
    return {
      webhook: aktuell.webhook,
      credentialId: process.env.VAPI_CREDENTIAL_ID || gemerkt.credentialId,
      assistantId: process.env.VAPI_ASSISTANT_ID || gemerkt.assistantId,
      nummerId: gemerkt.nummerId,
      token: geheim.vapiToken,
      merken: (werte) => fs.writeFileSync(path.join(LOKAL, 'vapi.json'), JSON.stringify({ ...gemerkt, ...werte }, null, 2)),
    };
  }
  const fehlend = ['N8N_WEBHOOK_URL'].filter((k) => !process.env[k]);
  if (!process.env.VAPI_CREDENTIAL_ID && !process.env.VAPI_WEBHOOK_TOKEN) fehlend.push('VAPI_CREDENTIAL_ID oder VAPI_WEBHOOK_TOKEN');
  if (fehlend.length) abbruch(`Fehlende Umgebungsvariablen: ${fehlend.join(', ')} (für den lokalen Test stattdessen --lokal verwenden)`);
  return {
    webhook: process.env.N8N_WEBHOOK_URL,
    credentialId: process.env.VAPI_CREDENTIAL_ID,
    assistantId: process.env.VAPI_ASSISTANT_ID,
    token: process.env.VAPI_WEBHOOK_TOKEN,
    merken: () => {},
  };
}

// Legt die Bearer-Token-Credential an, mit der Vapi sich bei n8n ausweist.
async function credentialAnlegen(token) {
  console.log('Lege die Zugangs-Credential für n8n bei Vapi an …');
  const r = await vapi('POST', '/credential', {
    provider: 'custom-credential',
    name: 'Praxis-Assistent n8n',
    authenticationPlan: { type: 'bearer', token, headerName: 'Authorization', bearerPrefixEnabled: true },
  });
  if (r.ok && r.json && r.json.id) return r.json.id;
  if (r.status === 401) abbruch(`Vapi lehnt den API-Key ab (HTTP 401): ${r.text.slice(0, 300)}\nBitte den PRIVATE Key aus dashboard.vapi.ai → API Keys verwenden.`);
  abbruch([
    `Vapi hat das automatische Anlegen abgelehnt (HTTP ${r.status}): ${r.text.slice(0, 400)}`,
    '',
    'Dann bitte von Hand (einmalig):',
    '  1. dashboard.vapi.ai → Einstellungen/Integrations → "Custom Credential" hinzufügen',
    lokal
      ? '  2. Typ "Bearer Token", Name beliebig, Token = Wert "vapiToken" aus lokal/daten/geheim.json'
      : '  2. Typ "Bearer Token", Name beliebig, Token = Wert VAPI_WEBHOOK_TOKEN aus docker/.env auf dem Server',
    lokal
      ? '  3. Die angezeigte ID kopieren und in PowerShell setzen:  $env:VAPI_CREDENTIAL_ID="<ID>"'
      : '  3. Die angezeigte ID als VAPI_CREDENTIAL_ID=<ID> in docker/.env eintragen',
    lokal ? '  4. node vapi/einrichten.js --lokal  erneut ausführen' : '  4. docker/vapi-einrichten.sh erneut ausführen',
  ].join('\n'));
}

function assistentBauen(webhook, credentialId) {
  if (!/^https:\/\//.test(webhook)) abbruch('Die Webhook-Adresse muss mit https:// beginnen.');
  let json = fs.readFileSync(path.join(__dirname, 'assistant.json'), 'utf8');
  const werte = {
    N8N_WEBHOOK_URL: webhook,
    VAPI_CREDENTIAL_ID: credentialId,
    PRAXIS_TELEFON: process.env.PRAXIS_TELEFON || '',
  };
  for (const [k, v] of Object.entries(werte)) json = json.split(`<<${k}>>`).join(v);
  const assistent = JSON.parse(json);
  if (!werte.PRAXIS_TELEFON) {
    assistent.model.tools = assistent.model.tools.filter((t) => t.type !== 'transferCall');
    const vorher = assistent.model.messages[0].content;
    const prompt = vorher
      .replace(/Weiterverbinden \(transferCall\)[^\n]*/, 'Eine Weiterleitung an das Praxisteam ist nicht möglich; notiere stattdessen einen Rückruf.')
      .replace(' oder (während der Sprechzeiten) die Weiterleitung an', ' an');
    if (prompt === vorher || /transferCall|Weiterleitung an\./.test(prompt)) {
      abbruch('Prompt-Stellen zur Weiterleitung nicht gefunden – vapi/system-prompt.de.md geändert? Bitte einrichten.js anpassen.');
    }
    assistent.model.messages[0].content = prompt;
    console.log('Hinweis: PRAXIS_TELEFON nicht gesetzt – Weiterleiten ist deaktiviert.');
  }
  if (process.env.VAPI_MODELL) assistent.model.model = process.env.VAPI_MODELL;
  if (process.env.ELEVENLABS_VOICE_ID) {
    assistent.voice = { provider: '11labs', model: 'eleven_flash_v2_5', voiceId: process.env.ELEVENLABS_VOICE_ID };
  }
  // Lokaler Test: selbst erzeugtes Intro (Beat + Begrüßung) statt gesprochener Begrüßung, falls vorhanden.
  if (lokal && fs.existsSync(path.join(LOKAL, 'begruessung.wav'))) {
    assistent.firstMessage = `${new URL(webhook).origin}/audio/begruessung.wav`;
    console.log('Begrüßung: Intro mit Beat (lokal/daten/begruessung.wav).');
  }
  const rest = JSON.stringify(assistent).match(/<<[A-Z_]+>>/g);
  if (rest) abbruch(`Nicht ersetzte Platzhalter: ${[...new Set(rest)].join(', ')}`);
  return assistent;
}

async function main() {
  const e = einstellungen();
  if (nurDatei) {
    const a = assistentBauen(e.webhook, e.credentialId || 'PROBELAUF');
    fs.writeFileSync(path.join(__dirname, 'assistant.local.json'), JSON.stringify(a, null, 2));
    console.log(`Probelauf: vapi/assistant.local.json geschrieben (Modell: ${a.model.model})`);
    return;
  }
  let credentialId = e.credentialId;
  if (!credentialId) {
    credentialId = await credentialAnlegen(e.token);
    e.merken({ credentialId });
    console.log(`Credential angelegt: ${credentialId}`);
    if (!lokal) console.log('Für spätere Aufrufe merken (keine Geheimnisse):  VAPI_CREDENTIAL_ID=' + credentialId);
  }
  const assistent = assistentBauen(e.webhook, credentialId);
  let r = e.assistantId ? await vapi('PATCH', `/assistant/${encodeURIComponent(e.assistantId)}`, assistent) : null;
  if (r && r.status === 404) { console.log('Gemerkter Assistent existiert nicht mehr – lege neu an.'); r = null; }
  const neu = !r;
  if (neu) r = await vapi('POST', '/assistant', assistent);
  if (!r.ok) {
    const tipp = /model/i.test(r.text) ? '\nTipp: anderes Modell versuchen:  $env:VAPI_MODELL="claude-haiku-4-5-20251001"  (die erlaubten Namen stehen in der Fehlermeldung oben)' : '';
    abbruch(`Vapi-Fehler ${r.status}: ${r.text.slice(0, 600)}${tipp}`);
  }
  e.merken({ assistantId: r.json.id });
  console.log(`\n${neu ? 'Angelegt' : 'Aktualisiert'}: Assistent "${r.json.name}" (${r.json.id}), Modell ${assistent.model.model}.`);
  console.log(`Webhook: ${e.webhook}`);

  // Telefonnummer mit dem Assistenten verknüpfen (ID aus dashboard.vapi.ai → Phone Numbers).
  const nummerId = process.env.VAPI_NUMMER_ID || e.nummerId;
  if (!nummerId) {
    console.log('\nJetzt auf dem Smartphone: dashboard.vapi.ai → Assistants → "Praxis-Telefonassistent" → "Talk to Assistant".');
    return;
  }
  const n = await vapi('PATCH', `/phone-number/${encodeURIComponent(nummerId)}`, { assistantId: r.json.id });
  if (!n.ok) {
    abbruch([
      `Assistent ist fertig, aber die Nummer ließ sich nicht verknüpfen (HTTP ${n.status}): ${n.text.slice(0, 400)}`,
      'Von Hand: dashboard.vapi.ai → Phone Numbers → Nummer öffnen → Inbound Settings → "Praxis-Telefonassistent" → Save',
    ].join('\n'));
  }
  e.merken({ nummerId });
  console.log(`Telefonnummer ${n.json.number || nummerId} ist mit dem Assistenten verknüpft.`);
  console.log(`\nJetzt anrufen: ${n.json.number || '(Nummer siehe Vapi-Dashboard)'} – von einem deutschen Handy mit +1 davor.`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Abbruch ? err.message : `Fehler: ${err.message}`}`);
  process.exitCode = 1;
});
