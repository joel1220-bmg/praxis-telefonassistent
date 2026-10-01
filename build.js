// Erzeugt aus src/ und vapi/system-prompt.de.md:
//   n8n/praxis-telefonassistent.workflow.json  – n8n-Workflow für die Vapi-Werkzeuge
//   n8n/praxis-dashboard-api.workflow.json     – n8n-Workflow, über den das Dashboard den Kalender liest
//   vapi/assistant.json                        – Vapi-Assistent (mit Platzhaltern, siehe vapi/einrichten.js)
// Optionen: --out <ordner> --google-api <url> --kalender <id> --dashboard <url>
//           --google-auth serviceaccount|oauth  (Standard: serviceaccount; Tests und lokal/start.js nutzen oauth)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const config = { ...require('./src/config') };
if (option('--google-api')) config.googleApiBasis = option('--google-api');
if (option('--kalender')) config.kalenderId = option('--kalender');
if (option('--dashboard')) config.dashboardUrl = option('--dashboard');
const ausgabeOrdner = option('--out') || path.join(__dirname, 'n8n');
const googleAuth = option('--google-auth') || 'serviceaccount';
if (!['serviceaccount', 'oauth'].includes(googleAuth)) throw new Error(`--google-auth: unbekannter Wert ${googleAuth}`);

// Service-Account (Server): läuft ohne Ablauf. OAuth: für die Attrappe in Tests und im lokalen Aufbau.
const GOOGLE = googleAuth === 'serviceaccount'
  ? { typ: 'googleApi', credentials: { googleApi: { id: 'praxisGoogleSA01', name: 'Google Service Account Praxis' } } }
  : { typ: 'googleCalendarOAuth2Api', credentials: { googleCalendarOAuth2Api: { id: 'praxisGoogleKal1', name: 'Google Kalender Praxis' } } };

const libQuelle = fs.readFileSync(path.join(__dirname, 'src/lib.js'), 'utf8')
  .replace(/^if \(typeof module[^\n]*\n?/m, '');

// ---------- n8n-Workflow ----------

const CREDENTIALS = {
  vapi: { httpHeaderAuth: { id: 'praxisVapiToken1', name: 'Vapi Bearer-Token' } },
  google: GOOGLE.credentials,
  smtp: { smtp: { id: 'praxisSmtpMail01', name: 'SMTP Praxis' } },
  dashboardIntern: { httpHeaderAuth: { id: 'praxisDashIntern', name: 'Dashboard Intern-Token' } },
  dashboardApi: { httpHeaderAuth: { id: 'praxisDashApi001', name: 'Dashboard API-Token' } },
};

function code(body, vorbName = 'Anfrage vorbereiten') {
  return [
    '// GENERIERT von build.js – Änderungen in src/lib.js bzw. src/config.js vornehmen.',
    `const CONFIG = ${JSON.stringify(config, null, 2)};`,
    libQuelle,
    'const lib = makeLib(DateTime);',
    `const vorb = $('${vorbName}').first().json;`,
    body,
  ].join('\n');
}

function knotenId(name) {
  const h = crypto.createHash('sha1').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

let nodes;
let connections;
function neuerWorkflow() { nodes = []; connections = {}; }
function speichere(datei, workflow) {
  fs.mkdirSync(ausgabeOrdner, { recursive: true });
  const ziel = path.join(ausgabeOrdner, datei);
  fs.writeFileSync(ziel, JSON.stringify(workflow, null, 2) + '\n');
  console.log(`Workflow: ${path.relative(process.cwd(), ziel)} (${workflow.nodes.length} Nodes)`);
}
const EINSTELLUNGEN = {
  executionOrder: 'v1',
  saveDataSuccessExecution: 'none',
  saveDataErrorExecution: 'all',
  saveManualExecutions: false,
  saveExecutionProgress: false,
  executionTimeout: 20,
};
function node(name, type, typeVersion, position, parameters, extra = {}) {
  nodes.push({ id: knotenId(name), name, type, typeVersion, position, parameters, ...extra });
  return name;
}
function verbinde(von, nach, ausgang = 0) {
  connections[von] = connections[von] || { main: [] };
  while (connections[von].main.length <= ausgang) connections[von].main.push([]);
  connections[von].main[ausgang].push({ node: nach, type: 'main', index: 0 });
}
function codeNode(name, position, body, vorbName) {
  return node(name, 'n8n-nodes-base.code', 2, position, { jsCode: code(body, vorbName) });
}
function kalender(name, position, method, urlAusdruck, mitBody) {
  const parameters = {
    method,
    url: `={{ ${urlAusdruck}.url }}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: GOOGLE.typ,
    options: { timeout: 8000 },
  };
  if (mitBody) Object.assign(parameters, { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${urlAusdruck}.body) }}` });
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, position, parameters,
    { credentials: CREDENTIALS.google, onError: 'continueRegularOutput', alwaysOutputData: true });
}
function weiche(name, position, anzahl, ausdruck) {
  return node(name, 'n8n-nodes-base.switch', 3.2, position, { mode: 'expression', numberOutputs: anzahl, output: `={{ ${ausdruck} }}` });
}

// ========== Workflow 1: Vapi-Werkzeuge ==========
neuerWorkflow();
const webhook = node('Vapi Webhook', 'n8n-nodes-base.webhook', 2, [0, 400], {
  httpMethod: 'POST',
  path: 'vapi-praxis',
  authentication: 'headerAuth',
  responseMode: 'responseNode',
  options: {},
}, { webhookId: '6c1f3a52-7d0e-4c8b-9a51-2f6e4b7d9c10', credentials: CREDENTIALS.vapi });

const vorbereiten = node('Anfrage vorbereiten', 'n8n-nodes-base.code', 2, [220, 400], {
  jsCode: [
    '// GENERIERT von build.js – Änderungen in src/lib.js bzw. src/config.js vornehmen.',
    `const CONFIG = ${JSON.stringify(config, null, 2)};`,
    libQuelle,
    'const lib = makeLib(DateTime);',
    'return [{ json: lib.vorbereiten(CONFIG, $input.first().json.body, DateTime.now().toISO()) }];',
  ].join('\n'),
});
verbinde(webhook, vorbereiten);

const nachWerkzeug = weiche('Nach Werkzeug', [440, 400], 7, '$json.route');
verbinde(vorbereiten, nachWerkzeug);

const antwort = node('Antwort an Vapi', 'n8n-nodes-base.respondToWebhook', 1.1, [1760, 400], {
  respondWith: 'json',
  responseBody: '={{ JSON.stringify({ results: $json.results }) }}',
  options: {},
});

// 0: freie_termine_suchen
const sucheKal = kalender('Kalender: Belegung', [700, 0], 'POST', '$json.http', true);
const sucheCode = codeNode('Freie Termine berechnen', [920, 0], 'return [{ json: lib.nachSuche(CONFIG, vorb, $input.first().json) }];');
verbinde(nachWerkzeug, sucheKal, 0); verbinde(sucheKal, sucheCode); verbinde(sucheCode, antwort);

// 1: termin_buchen
const slotKal = kalender('Kalender: Slot prüfen', [700, 200], 'POST', '$json.http', true);
const bestehendeKal = kalender('Kalender: Termine der Person', [920, 200], 'GET', "$('Anfrage vorbereiten').first().json.http2", false);
const pruefen = codeNode('Buchung prüfen', [1140, 200], [
  "const p = lib.buchungPruefen(CONFIG, vorb, $('Kalender: Slot prüfen').first().json, $input.first().json);",
  'return [{ json: p.ok ? p : { ok: false, ...p.antwort } }];',
].join('\n'));
const buchbar = weiche('Buchbar?', [1360, 200], 2, '$json.ok ? 0 : 1');
const eintragen = kalender('Kalender: Termin eintragen', [1540, 120], 'POST', '$json.http', true);
const bestaetigen = codeNode('Buchung bestätigen', [1540, 280], 'return [{ json: lib.nachBuchung(CONFIG, vorb, $input.first().json) }];');
verbinde(nachWerkzeug, slotKal, 1); verbinde(slotKal, bestehendeKal); verbinde(bestehendeKal, pruefen); verbinde(pruefen, buchbar);
verbinde(buchbar, eintragen, 0); verbinde(eintragen, bestaetigen); verbinde(bestaetigen, antwort);
verbinde(buchbar, antwort, 1);

// 2: termine_finden
const findenKal = kalender('Kalender: Termine suchen', [700, 400], 'GET', '$json.http', false);
const findenCode = codeNode('Termine auflisten', [920, 400], 'return [{ json: lib.nachFinden(CONFIG, vorb, $input.first().json) }];');
verbinde(nachWerkzeug, findenKal, 2); verbinde(findenKal, findenCode); verbinde(findenCode, antwort);

// 3: termin_absagen
const absageKal = kalender('Kalender: Termin laden', [700, 600], 'GET', '$json.http', false);
const absagePruefen = codeNode('Absage prüfen', [920, 600], [
  'const p = lib.absagePruefen(CONFIG, vorb, $input.first().json);',
  'return [{ json: p.ok ? p : { ok: false, ...p.antwort } }];',
].join('\n'));
const absagbar = weiche('Absagbar?', [1140, 600], 2, '$json.ok ? 0 : 1');
const loeschen = kalender('Kalender: Termin löschen', [1360, 520], 'DELETE', '$json.http', false);
const absageOk = codeNode('Absage bestätigen', [1540, 520],
  "return [{ json: lib.nachAbsage(CONFIG, vorb, $('Absage prüfen').first().json, $input.first().json) }];");
verbinde(nachWerkzeug, absageKal, 3); verbinde(absageKal, absagePruefen); verbinde(absagePruefen, absagbar);
verbinde(absagbar, loeschen, 0); verbinde(loeschen, absageOk); verbinde(absageOk, antwort);
verbinde(absagbar, antwort, 1);

// 4: rueckruf_notieren
const mail = node('E-Mail an Praxis', 'n8n-nodes-base.emailSend', 2.1, [700, 800], {
  fromEmail: '={{ $json.email.von }}',
  toEmail: '={{ $json.email.an }}',
  subject: '={{ $json.email.betreff }}',
  emailFormat: 'text',
  text: '={{ $json.email.inhalt }}',
  options: { appendAttribution: false },
}, { credentials: CREDENTIALS.smtp, onError: 'continueRegularOutput', alwaysOutputData: true });
const dashboardSpeichern = node('Dashboard: Rückruf speichern', 'n8n-nodes-base.httpRequest', 4.2, [920, 800], {
  method: 'POST',
  url: "={{ $('Anfrage vorbereiten').first().json.dashboard.url }}",
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: "={{ JSON.stringify($('Anfrage vorbereiten').first().json.dashboard.body) }}",
  options: { timeout: 5000 },
}, { credentials: CREDENTIALS.dashboardIntern, onError: 'continueRegularOutput', alwaysOutputData: true });
const mailOk = codeNode('Rückruf bestätigen', [1140, 800],
  "return [{ json: lib.nachRueckruf(vorb, $('E-Mail an Praxis').first().json, $input.first().json) }];");
verbinde(nachWerkzeug, mail, 4); verbinde(mail, dashboardSpeichern); verbinde(dashboardSpeichern, mailOk); verbinde(mailOk, antwort);

// 5: Validierungsfehler, unbekannte Werkzeuge, andere Vapi-Nachrichten
const direkt = codeNode('Direkte Antwort', [700, 1000], 'return [{ json: lib.direkteAntwort(vorb) }];');
verbinde(nachWerkzeug, direkt, 5); verbinde(direkt, antwort);

// 6: Anrufbericht (end-of-call-report) → nur Kennzahlen ans Dashboard (ROI-Ansicht)
const anrufSpeichern = node('Dashboard: Anruf speichern', 'n8n-nodes-base.httpRequest', 4.2, [700, 1200], {
  method: 'POST',
  url: "={{ $('Anfrage vorbereiten').first().json.dashboard.url }}",
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: "={{ JSON.stringify($('Anfrage vorbereiten').first().json.dashboard.body) }}",
  options: { timeout: 5000 },
}, { credentials: CREDENTIALS.dashboardIntern, onError: 'continueRegularOutput', alwaysOutputData: true });
const anrufQuittieren = node('Anruf quittieren', 'n8n-nodes-base.code', 2, [920, 1200], { jsCode: 'return [{ json: { results: [] } }];' });
verbinde(nachWerkzeug, anrufSpeichern, 6); verbinde(anrufSpeichern, anrufQuittieren); verbinde(anrufQuittieren, antwort);

speichere('praxis-telefonassistent.workflow.json', {
  id: 'PraxisTelefon001',
  name: 'Praxis-Telefonassistent (Vapi-Werkzeuge)',
  active: false,
  nodes,
  connections,
  settings: EINSTELLUNGEN,
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
});

// ========== Workflow 2: Dashboard-API (Kalender lesen, Termine absagen) ==========
neuerWorkflow();
const dWebhook = node('Dashboard Webhook', 'n8n-nodes-base.webhook', 2, [0, 300], {
  httpMethod: 'POST',
  path: 'praxis-dashboard',
  authentication: 'headerAuth',
  responseMode: 'responseNode',
  options: {},
}, { webhookId: '9b2e4d71-3a6f-4e0c-8d15-7c4a2f9e1b30', credentials: CREDENTIALS.dashboardApi });
const dVorbereiten = node('Dashboard-Anfrage prüfen', 'n8n-nodes-base.code', 2, [220, 300], {
  jsCode: [
    '// GENERIERT von build.js – Änderungen in src/lib.js bzw. src/config.js vornehmen.',
    `const CONFIG = ${JSON.stringify(config, null, 2)};`,
    libQuelle,
    'const lib = makeLib(DateTime);',
    'return [{ json: lib.dashboardVorbereiten(CONFIG, $input.first().json.body, DateTime.now().toISO()) }];',
  ].join('\n'),
});
const dWeiche = weiche('Nach Aktion', [440, 300], 3, '$json.route');
const dAntwort = node('Antwort an Dashboard', 'n8n-nodes-base.respondToWebhook', 1.1, [1540, 300], {
  respondWith: 'json',
  responseBody: '={{ JSON.stringify($json.antwort) }}',
  options: {},
});
verbinde(dWebhook, dVorbereiten); verbinde(dVorbereiten, dWeiche);

const dListe = kalender('Kalender: Termine laden', [700, 100], 'GET', '$json.http', false);
const dListeCode = codeNode('Termine aufbereiten', [920, 100],
  'return [{ json: { antwort: lib.dashboardTermine(CONFIG, $input.first().json) } }];', 'Dashboard-Anfrage prüfen');
verbinde(dWeiche, dListe, 0); verbinde(dListe, dListeCode); verbinde(dListeCode, dAntwort);

const dLaden = kalender('Kalender: Termin holen', [700, 300], 'GET', '$json.http', false);
const dPruefen = codeNode('Absage erlaubt?', [920, 300], [
  'const p = lib.dashboardAbsagePruefen(CONFIG, vorb, $input.first().json);',
  'return [{ json: p.ok ? p : { ok: false, antwort: p } }];',
].join('\n'), 'Dashboard-Anfrage prüfen');
const dErlaubt = weiche('Erlaubt?', [1140, 300], 2, '$json.ok ? 0 : 1');
const dLoeschen = kalender('Kalender: Termin entfernen', [1320, 220], 'DELETE', '$json.http', false);
const dFertig = codeNode('Absage melden', [1320, 380],
  "return [{ json: { antwort: lib.dashboardNachAbsage($('Absage erlaubt?').first().json, $input.first().json) } }];",
  'Dashboard-Anfrage prüfen');
verbinde(dWeiche, dLaden, 1); verbinde(dLaden, dPruefen); verbinde(dPruefen, dErlaubt);
verbinde(dErlaubt, dLoeschen, 0); verbinde(dLoeschen, dFertig); verbinde(dFertig, dAntwort);
verbinde(dErlaubt, dAntwort, 1);
verbinde(dWeiche, dAntwort, 2);

speichere('praxis-dashboard-api.workflow.json', {
  id: 'PraxisDashApi001',
  name: 'Praxis-Dashboard-API (Kalender)',
  active: false,
  nodes,
  connections,
  settings: EINSTELLUNGEN,
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
});

// ---------- Vapi-Assistent ----------

if (!option('--out')) {
  const tage = { mo: 'Montag', di: 'Dienstag', mi: 'Mittwoch', do: 'Donnerstag', fr: 'Freitag', sa: 'Samstag', so: 'Sonntag' };
  const sprechzeiten = Object.entries(tage).map(([k, t]) => {
    const b = config.sprechzeiten[k] || [];
    return `- ${t}: ${b.length ? b.map(([v, bis]) => `${v}–${bis} Uhr`).join(' und ') : 'geschlossen'}`;
  }).join('\n');
  const terminarten = Object.entries(config.terminarten)
    .map(([k, a]) => `- ${k}: ${a.bezeichnung}, ${a.dauer} Minuten (${a.beschreibung})`).join('\n');
  const prompt = fs.readFileSync(path.join(__dirname, 'vapi/system-prompt.de.md'), 'utf8')
    .replace('<<PRAXIS_NAME>>', config.praxisName)
    .replace('<<SPRECHZEITEN>>', sprechzeiten)
    .replace('<<TERMINARTEN>>', terminarten)
    .replace('<<PRAXIS_INFOS>>', config.praxisInfos.map((i) => `- ${i}`).join('\n'));

  const server = { url: '<<N8N_WEBHOOK_URL>>', credentialId: '<<VAPI_CREDENTIAL_ID>>', timeoutSeconds: 20 };
  const s = (typ, beschreibung, extra = {}) => ({ type: typ, description: beschreibung, ...extra });
  const datum = (b) => s('string', `${b} Format JJJJ-MM-TT.`);
  const tool = (name, beschreibung, properties, required, wartetext) => ({
    type: 'function',
    async: false,
    server,
    messages: [{ type: 'request-start', content: wartetext, blocking: false }],
    function: { name, description: beschreibung, parameters: { type: 'object', properties, required } },
  });
  const terminartParam = s('string', 'Art des Termins.', { enum: Object.keys(config.terminarten) });
  const personParams = {
    vorname: s('string', 'Vorname der Patientin / des Patienten.'),
    nachname: s('string', 'Nachname, wie buchstabiert.'),
    geburtsdatum: datum('Geburtsdatum.'),
  };

  const assistant = {
    name: 'Praxis-Telefonassistent',
    // Begrüßung aus der Config; KI-Hinweis (EU AI Act) und Notfall-Hinweis werden immer angehängt.
    firstMessage: `${config.begruessung || `Guten Tag, hier ist der digitale Telefonassistent der ${config.praxisName}.`} `
      + 'Ich bin übrigens eine künstliche Intelligenz. Bei einem Notfall bitte auflegen und die 112 wählen. Was kann ich für Sie tun?',
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-5', // von Vapi unterstützt (Stand 09/2026); claude-opus-5 bietet Vapi noch nicht an
      // Vapi begrenzt Antworten sonst auf 250 Tokens. Eine gesprochene Zusammenfassung plus termin_buchen passte
      // nicht hinein: Die Antwort wurde abgeschnitten (finish_reason "length") und das Werkzeug kam mit {} an.
      maxTokens: 1500,
      messages: [{ role: 'system', content: prompt }],
      tools: [
        tool('freie_termine_suchen', 'Sucht freie Termine im Praxiskalender. Immer vor dem Buchen aufrufen.', {
          terminart: terminartParam,
          ab_datum: datum('Optional: frühestes Wunschdatum.'),
          nur_dieser_tag: s('boolean', 'Optional: true, wenn nur an ab_datum gesucht werden soll.'),
          tageszeit: s('string', 'Optional: Wunsch-Tageszeit.', { enum: ['vormittag', 'nachmittag', 'egal'] }),
        }, ['terminart'], 'Einen Moment, ich schaue in den Kalender.'),
        tool('termin_buchen', 'Bucht einen Termin, den freie_termine_suchen geliefert hat, nach Bestätigung durch den Anrufer.', {
          terminart: terminartParam,
          start: s('string', 'Exakter start-Wert aus freie_termine_suchen.'),
          ...personParams,
          bestandspatient: s('boolean', 'true, wenn die Person schon einmal in der Praxis war. Dann telefon und versicherung weglassen: sie werden aus früheren Terminen übernommen.'),
          telefon: s('string', 'Nur bei neuen Personen: Rückrufnummer. Leer lassen, wenn die Anrufernummer bestätigt wurde.'),
          versicherung: s('string', 'Nur bei neuen Personen: Versicherungsart.', { enum: ['gesetzlich', 'privat', 'selbstzahler', 'unbekannt'] }),
          anliegen: s('string', 'Anliegen in wenigen Worten, keine Details.'),
        }, ['terminart', 'start', 'vorname', 'nachname', 'geburtsdatum', 'bestandspatient'], 'Einen Moment, ich trage den Termin ein.'),
        tool('patient_pruefen', 'Prüft gleich zu Gesprächsbeginn, ob eine Person, die schon in der Praxis war, mit Nachname und Geburtsdatum bekannt ist.', {
          vorname: personParams.vorname,
          nachname: personParams.nachname,
          geburtsdatum: personParams.geburtsdatum,
        }, ['nachname', 'geburtsdatum'], 'Einen Moment, ich schaue nach.'),
        tool('termine_finden', 'Findet zukünftige Termine einer Person (nur über den Telefonassistenten gebuchte).', {
          nachname: personParams.nachname,
          geburtsdatum: personParams.geburtsdatum,
        }, ['nachname', 'geburtsdatum'], 'Einen Moment, ich suche Ihre Termine.'),
        tool('termin_absagen', 'Sagt einen Termin ab. termin_id stammt aus termine_finden.', {
          termin_id: s('string', 'termin_id aus termine_finden.'),
          nachname: personParams.nachname,
          geburtsdatum: personParams.geburtsdatum,
        }, ['termin_id', 'nachname', 'geburtsdatum'], 'Einen Moment bitte.'),
        tool('rueckruf_notieren', 'Übermittelt einen Rückrufwunsch an das Praxisteam.', {
          ...personParams,
          telefon: s('string', 'Rückrufnummer. Leer lassen, wenn die Anrufernummer bestätigt wurde.'),
          kategorie: s('string', 'Art des Anliegens.', { enum: ['rezept', 'ueberweisung', 'befund', 'krankschreibung', 'termin', 'sonstiges'] }),
          dringend: s('boolean', 'true nur, wenn heute noch erledigt werden muss.'),
          anliegen: s('string', 'Anliegen in einem Satz.'),
        }, ['vorname', 'nachname', 'kategorie', 'anliegen'], 'Einen Moment, ich notiere das.'),
        {
          type: 'transferCall',
          destinations: [{
            type: 'number',
            number: '<<PRAXIS_TELEFON>>',
            message: 'Ich verbinde Sie jetzt mit dem Praxisteam. Einen Moment bitte.',
            description: 'Praxisteam am Empfang, nur während der Sprechzeiten.',
          }],
        },
        { type: 'endCall' },
      ],
    },
    // Nach jedem Anruf ein Bericht an n8n (nur dieser Typ). n8n gibt daraus nur Zahlen ans Dashboard weiter.
    server,
    serverMessages: ['end-of-call-report'],
    // Muttersprachlich deutsche Stimme ohne eigenes ElevenLabs-Konto (läuft über Vapi). Die englischen
    // ElevenLabs-Standardstimmen hatten am Telefon einen amerikanischen Akzent. Eigene ElevenLabs-Stimme:
    // ELEVENLABS_VOICE_ID in vapi/einrichten.js (Bibliotheksstimmen brauchen einen bezahlten ElevenLabs-Plan).
    voice: { provider: 'azure', voiceId: 'de-DE-SeraphinaMultilingualNeural', speed: 1.15 }, // 1.0 klang am Telefon zu langsam
    // nova-3 erkennt deutsche Telefonate besser als nova-2; keyterm hebt Wörter hervor, die im Gespräch zählen
    // (z. B. wurde "privat" mit nova-2 als "Prima" erkannt).
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'de',
      keyterm: ['privat', 'gesetzlich', 'Selbstzahler', 'Geburtsdatum', 'Rückruf', 'Überweisung', 'Rezept', 'Krankschreibung',
        ...Object.values(config.terminarten).map((a) => a.bezeichnung)],
    },
    artifactPlan: { recordingEnabled: false },
    compliancePlan: { hipaaEnabled: true },
    endCallPhrases: ['Auf Wiederhören'],
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
  };
  const assistantPfad = path.join(__dirname, 'vapi/assistant.json');
  fs.writeFileSync(assistantPfad, JSON.stringify(assistant, null, 2) + '\n');
  console.log(`Vapi-Assistent: ${path.relative(process.cwd(), assistantPfad)} (${assistant.model.tools.length} Werkzeuge)`);
}
