// Creates the phone intro: a self-synthesised trap beat (no third-party material, so no licence
// questions) followed by the greeting spoken by the Windows voice "Hedda".
// Output: lokal/daten/begruessung.wav (24 kHz, 16 bit, mono). Call: node vapi/intro/erzeugen.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('../../src/config');

const RATE = 24000;
const ZIEL = path.join(__dirname, '..', '..', 'lokal', 'daten', 'begruessung.wav');
const BPM = 140;
const SCHLAG = 60 / BPM; // Sekunden pro Viertel

// ---------- Klangbausteine ----------
let zufall = 7;
const rauschen = () => { zufall = (zufall * 1103515245 + 12345) % 2147483648; return zufall / 1073741824 - 1; };

function leer(sekunden) { return new Float32Array(Math.ceil(sekunden * RATE)); }
function addiere(ziel, quelle, startSek, lautstaerke = 1) {
  const o = Math.round(startSek * RATE);
  for (let i = 0; i < quelle.length && o + i < ziel.length; i++) ziel[o + i] += quelle[i] * lautstaerke;
}

// 808: Sinus mit Tonhöhen-Glide nach unten, langes Ausklingen, leicht angezerrt.
function acht0acht(dauer, startHz = 98, endHz = 49) {
  const b = leer(dauer);
  let phase = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / RATE;
    const hz = endHz + (startHz - endHz) * Math.exp(-t * 18);
    phase += (2 * Math.PI * hz) / RATE;
    const huelle = Math.min(1, t * 400) * Math.exp(-t * 2.2);
    b[i] = Math.tanh(Math.sin(phase) * 2.2) * huelle;
  }
  return b;
}

function kick() {
  const b = leer(0.18);
  let phase = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / RATE;
    phase += (2 * Math.PI * (45 + 140 * Math.exp(-t * 40))) / RATE;
    b[i] = Math.sin(phase) * Math.exp(-t * 22);
  }
  return b;
}

// Snare/Clap: gefiltertes Rauschen mit drei kurzen Anschlägen (Clap-Charakter) plus Grundton.
function clap() {
  const b = leer(0.3);
  let hp = 0, letzt = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / RATE;
    const n = rauschen();
    hp = 0.85 * (hp + n - letzt); letzt = n; // einfacher Hochpass
    const anschlaege = [0, 0.012, 0.024].reduce((s, a) => s + (t >= a ? Math.exp(-(t - a) * 60) : 0), 0) / 2;
    b[i] = hp * (anschlaege + Math.exp(-t * 14) * 0.6) + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.4;
  }
  return b;
}

function hihat(dauer = 0.045) {
  const b = leer(dauer);
  let hp = 0, letzt = 0;
  for (let i = 0; i < b.length; i++) {
    const n = rauschen();
    hp = 0.6 * (hp + n - letzt); letzt = n;
    b[i] = hp * Math.exp(-(i / RATE) * 90);
  }
  return b;
}

// Dunkle Glocke/Pluck für die Melodie (Sinus + Oberton, schnelles Abklingen).
function glocke(hz, dauer) {
  const b = leer(dauer);
  for (let i = 0; i < b.length; i++) {
    const t = i / RATE;
    b[i] = (Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(2 * Math.PI * hz * 2.01 * t) + 0.15 * Math.sin(2 * Math.PI * hz * 3 * t))
      * Math.min(1, t * 300) * Math.exp(-t * 4.5);
  }
  return b;
}

// ---------- Arrangement: 2 Takte Trap in c-Moll ----------
function beat() {
  const takte = 2;
  const laenge = takte * 4 * SCHLAG;
  const mix = leer(laenge + 0.6);
  const s = (viertel) => viertel * SCHLAG;

  // 808 + Kick
  for (const [pos, hz] of [[0, 65.4], [1.5, 65.4], [4, 77.8], [5.75, 58.3], [6.5, 65.4]]) {
    addiere(mix, acht0acht(1.2, hz * 1.5, hz), s(pos), 0.75);
    addiere(mix, kick(), s(pos), 0.6);
  }
  // Clap auf 3 (Half-Time)
  for (const pos of [2, 6]) addiere(mix, clap(), s(pos), 0.55);
  // Hi-Hats: Achtel, am Ende von Takt 2 eine Triolen-Rolle
  for (let p = 0; p < 7; p += 0.5) addiere(mix, hihat(), s(p), p % 1 === 0 ? 0.28 : 0.2);
  for (let k = 0; k < 6; k++) addiere(mix, hihat(0.03), s(7) + k * (SCHLAG / 6), 0.18 + k * 0.02);
  // Melodie: c-Moll-Arpeggio (C5 Es5 G5 B4 …)
  const noten = [[0, 523.3], [0.75, 622.3], [1.5, 784.0], [2.5, 466.2], [4, 523.3], [4.75, 622.3], [5.5, 698.5], [6.5, 622.3]];
  for (const [pos, hz] of noten) addiere(mix, glocke(hz, 0.9), s(pos), 0.18);

  // Ausblenden am Ende
  const blende = Math.round(0.5 * RATE);
  for (let i = 0; i < blende; i++) mix[mix.length - blende + i] *= 1 - i / blende;
  return mix;
}

// ---------- Sprache über Windows (System.Speech, Stimme Hedda) ----------
function sprache(text) {
  if (process.platform !== 'win32') throw new Error('Die Sprachausgabe nutzt die Windows-Stimme "Hedda" und läuft nur unter Windows.');
  const tmp = path.join(os.tmpdir(), `begruessung-${process.pid}.wav`);
  const skript = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$s.SelectVoice('Microsoft Hedda Desktop')",
    '$s.Rate = 0',
    `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `$s.SetOutputToWaveFile('${tmp.replace(/'/g, "''")}', $f)`,
    `$s.Speak('${text.replace(/'/g, "''")}')`,
    '$s.Dispose()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skript], { stdio: 'inherit' });
  const wav = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  // PCM-Daten aus dem WAV holen (Chunk "data" suchen)
  let o = 12;
  while (o < wav.length && wav.toString('ascii', o, o + 4) !== 'data') o += 8 + wav.readUInt32LE(o + 4);
  const laenge = wav.readUInt32LE(o + 4);
  const pcm = new Float32Array(laenge / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(o + 8 + i * 2) / 32768;
  return pcm;
}

function alsWav(samples) {
  const daten = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) daten.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const kopf = Buffer.alloc(44);
  kopf.write('RIFF', 0); kopf.writeUInt32LE(36 + daten.length, 4); kopf.write('WAVE', 8);
  kopf.write('fmt ', 12); kopf.writeUInt32LE(16, 16); kopf.writeUInt16LE(1, 20); kopf.writeUInt16LE(1, 22);
  kopf.writeUInt32LE(RATE, 24); kopf.writeUInt32LE(RATE * 2, 28); kopf.writeUInt16LE(2, 32); kopf.writeUInt16LE(16, 34);
  kopf.write('data', 36); kopf.writeUInt32LE(daten.length, 40);
  return Buffer.concat([kopf, daten]);
}

function normalisieren(samples, ziel) {
  let spitze = 0;
  for (const s of samples) spitze = Math.max(spitze, Math.abs(s));
  if (spitze > 0) for (let i = 0; i < samples.length; i++) samples[i] *= ziel / spitze;
  return samples;
}

// Derselbe Text wie im Vapi-Assistenten (build.js): Begrüßung + Pflicht-Hinweise.
const text = `${config.begruessung} Ich bin übrigens eine künstliche Intelligenz. Bei einem Notfall bitte auflegen und die 112 wählen. Was kann ich für Sie tun?`;
const b = normalisieren(beat(), 0.45); // leiser als die Stimme, damit die Begrüßung gut verständlich bleibt
const stimme = normalisieren(sprache(text), 0.9);
const ueberlappung = Math.round(0.35 * RATE); // Stimme setzt ein, während der Beat ausblendet
const gesamt = new Float32Array(b.length + stimme.length - ueberlappung + Math.round(0.2 * RATE));
gesamt.set(b, 0);
for (let i = 0; i < stimme.length; i++) gesamt[b.length - ueberlappung + i] += stimme[i];
fs.mkdirSync(path.dirname(ZIEL), { recursive: true });
fs.writeFileSync(ZIEL, alsWav(normalisieren(gesamt, 0.9)));
console.log(`Intro geschrieben: ${ZIEL} (${(gesamt.length / RATE).toFixed(1)} s, davon Beat ${(b.length / RATE).toFixed(1)} s)`);
