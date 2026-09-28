// Stand-ins for Google Calendar and an SMTP server, used by the E2E test and by the local test setup (lokal/start.js).
const http = require('http');
const net = require('net');
const fs = require('fs');

function sende(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

// Mimics the parts of the Google Calendar API v3 that n8n uses: freeBusy, list/insert/get/delete events.
// With `speicherDatei`, appointments survive a restart.
function erstelleGoogleAttrappe({ kalender, token, speicherDatei }) {
  const termine = new Map();
  const zustand = { fremdBelegt: [], kaputt: false, naechsteId: 1 };
  const aufrufe = [];
  if (speicherDatei && fs.existsSync(speicherDatei)) {
    const gespeichert = JSON.parse(fs.readFileSync(speicherDatei, 'utf8'));
    for (const t of gespeichert.termine) termine.set(t.id, t);
    zustand.naechsteId = gespeichert.naechsteId;
  }
  const speichern = () => {
    if (!speicherDatei) return;
    const tmp = `${speicherDatei}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ naechsteId: zustand.naechsteId, termine: [...termine.values()] }, null, 2));
    fs.renameSync(tmp, speicherDatei);
  };

  const server = http.createServer((req, res) => {
    let roh = '';
    req.on('data', (c) => { roh += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      aufrufe.push(`${req.method} ${url.pathname}`);
      if (req.headers.authorization !== `Bearer ${token}`) return sende(res, 401, { error: { code: 401 } });
      if (zustand.kaputt) return sende(res, 500, { error: { code: 500, message: 'backend error' } });
      let body = {};
      try { body = roh ? JSON.parse(roh) : {}; } catch (e) { return sende(res, 400, { error: { code: 400 } }); }
      const basis = `/calendar/v3/calendars/${encodeURIComponent(kalender)}/events`;

      if (req.method === 'POST' && url.pathname === '/calendar/v3/freeBusy') {
        const von = Date.parse(body.timeMin), bis = Date.parse(body.timeMax);
        const busy = [...zustand.fremdBelegt, ...[...termine.values()].map((t) => ({ start: t.start.dateTime, end: t.end.dateTime }))]
          .filter((b) => Date.parse(b.start) < bis && von < Date.parse(b.end));
        return sende(res, 200, { kind: 'calendar#freeBusy', calendars: { [body.items[0].id]: { busy } } });
      }
      if (req.method === 'GET' && url.pathname === basis) {
        const filter = url.searchParams.getAll('privateExtendedProperty').map((p) => p.split('='));
        const ab = Date.parse(url.searchParams.get('timeMin'));
        const bis = url.searchParams.get('timeMax') ? Date.parse(url.searchParams.get('timeMax')) : Infinity;
        const items = [...termine.values()]
          .filter((t) => Date.parse(t.end.dateTime) > ab && Date.parse(t.start.dateTime) < bis)
          .filter((t) => filter.every(([k, v]) => ((t.extendedProperties || {}).private || {})[k] === v))
          .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
        return sende(res, 200, { items });
      }
      if (req.method === 'POST' && url.pathname === basis) {
        const t = { ...body, id: `evt${String(zustand.naechsteId++).padStart(6, '0')}`, status: 'confirmed' };
        termine.set(t.id, t);
        speichern();
        return sende(res, 200, t);
      }
      const m = url.pathname.match(new RegExp(`^${basis}/([^/]+)$`));
      if (m && req.method === 'GET') return termine.has(m[1]) ? sende(res, 200, termine.get(m[1])) : sende(res, 404, { error: { code: 404 } });
      if (m && req.method === 'DELETE') {
        if (!termine.delete(m[1])) return sende(res, 410, { error: { code: 410 } });
        speichern();
        res.writeHead(204); return res.end();
      }
      sende(res, 404, { error: { code: 404, message: `unbekannt: ${req.method} ${url.pathname}` } });
    });
  });
  return { server, termine, zustand, aufrufe, speichern };
}

// Minimal SMTP server: accepts every e-mail and passes it to `beiMail`.
function erstelleSmtpAttrappe({ beiMail } = {}) {
  const mails = [];
  const server = net.createServer((sock) => {
    let puffer = '', imText = false, aktuell = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (d) => {
      puffer += d.toString('utf8');
      let i;
      while ((i = puffer.indexOf('\r\n')) >= 0) {
        const zeile = puffer.slice(0, i); puffer = puffer.slice(i + 2);
        if (imText) {
          if (zeile === '.') {
            imText = false; mails.push(aktuell);
            if (beiMail) beiMail(aktuell);
            aktuell = ''; sock.write('250 OK\r\n');
          } else aktuell += zeile + '\n';
          continue;
        }
        const cmd = zeile.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
        else if (cmd === 'DATA') { imText = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { server, mails };
}

module.exports = { erstelleGoogleAttrappe, erstelleSmtpAttrappe };
