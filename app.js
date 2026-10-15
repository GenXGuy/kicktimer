'use strict';

// KickTimer: countdown -> random delay -> beep -> time until the bag is hit.
// Runs entirely on the phone; see README.md for setup.

const VERSION = '1.6.1';
const G = 9.80665;           // m/s^2 per g
const SETTLE_MS = 600;       // bag must stay below threshold this long before a rep
const CAPTURE_MS = 120;      // after the first crossing, keep reading to find the peak
const SERIES_GAP_MS = 1500;  // at series end, show the last rep before the fastest/average screen
const MAX_LIST = 50;
const VOLUME = 1;            // full; the phone's volume buttons set the loudness
const MAX_SAME_SIDE = 3;      // Random side: never more than this many in a row
const IMPULSE_MS = 80;       // logged for comparison only: the bag's push summed over this long
// Side check uses the FIRST jolt of the kick. On hard kicks the bag bounces back
// within ~50 ms, so longer sums get it backwards (class logs, 2026-10-14: 80 ms sum
// matched the arrow 50% of the time, first jolt 88%).
const JOLT_LEAD_MS = 34;     // look this far before the trigger for an earlier, lighter first jolt
const JOLT_MIN_G = 0.5;      // ...at least this strong
const CALIB_KICKS = 3;       // side calibration: kicks per side
const SIDE_MIN = 0.3;        // side check: a push weaker than this along the left/right line is unclear
const RAW_PRE_MS = 200;      // detailed log: sensor readings kept from before each kick...
const RAW_POST_MS = 400;     // ...and after it
const LOGS_KEY = 'kicktimer.logs';
const LOGS_MAX_CHARS = 3000000; // saved logs stay under ~3 MB; the oldest sessions are dropped

// Bump when a default changes and phones should pick up the new value.
const SETTINGS_VERSION = 3;

const DEFAULTS = {
  threshold: 0.6, countdown: 3, delayMin: 1, delayMax: 3, timeout: 3,
  reps: 5, rest: 3, flash: true, mode: 'single', cue: 'right', sideAxis: null,
  voice: false,
};

// ---------- settings ----------

const settings = loadSettings();

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('kicktimer.settings') || '{}');
    // v1 defaulted to 2.0 g, far too hard for young kids: replace it with the new default.
    if (!saved.v || saved.v < 2) delete saved.threshold;
    // v3 lowered the rest minimum to 1 s: a phone still on the old 5 s default gets the new 3 s.
    if ((!saved.v || saved.v < 3) && saved.rest === 5) delete saved.rest;
    return { ...DEFAULTS, ...saved, v: SETTINGS_VERSION };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try { localStorage.setItem('kicktimer.settings', JSON.stringify(settings)); } catch (e) { /* private mode */ }
}

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);
const el = {
  display: $('display'), status: $('status'), big: $('big'), detail: $('detail'),
  start: $('startBtn'), reset: $('resetBtn'), sim: $('simBtn'),
  modeSingle: $('modeSingle'), modeSeries: $('modeSeries'),
  gNow: $('gNow'), gPeak: $('gPeak'), peakReset: $('peakReset'),
  meterFill: $('meterFill'), meterThresh: $('meterThresh'),
  summary: $('summary'), results: $('results'), copyLog: $('copyLog'),
  badge: $('sensorBadge'), rotateWarn: $('rotateWarn'),
  cue: $('cue'), cueWord: $('cueWord'),
  cueLeft: $('cueLeft'), cueRight: $('cueRight'), cueRandom: $('cueRandom'),
  cueNote: $('cueNote'), sideStatus: $('sideStatus'),
};

function show(cls, status, big, detail) {
  el.display.className = 'display ' + (cls || '');
  el.status.textContent = status;
  el.big.textContent = big;
  el.detail.innerHTML = detail || '&nbsp;';
}

const fmt = (ms) => (ms / 1000).toFixed(3) + ' s';
const sideName = (side) => (side === 'left' ? 'Left' : side === 'right' ? 'Right' : '');

// ---------- kick-side cue ----------
// Left/right are as seen by the student looking at the screen.

function pickSide() {
  if (settings.cue !== 'random') return settings.cue;
  const recent = drill.recentSides;
  let side = Math.random() < 0.5 ? 'left' : 'right';
  if (recent.length >= MAX_SAME_SIDE && recent.slice(-MAX_SAME_SIDE).every((x) => x === side)) {
    side = side === 'left' ? 'right' : 'left';
  }
  recent.push(side);
  if (recent.length > MAX_SAME_SIDE) recent.shift();
  return side;
}

function showCue(side, flash, note) {
  el.cue.className = 'cue ' + side + (flash ? ' flash' : '');
  el.cueWord.textContent = side.toUpperCase();
  el.cueNote.textContent = note || '';
  el.cue.hidden = false; // un-hiding restarts the blink, so it always starts fully on
}

function hideCue() {
  el.cue.hidden = true;
}

// ---------- side check ----------
// The bag's push in the first IMPULSE_MS is turned into screen coordinates, so
// flipping the phone over in the holder keeps the calibration valid.

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

function toScreen(x, y) {
  const a = screenAngle() * Math.PI / 180;
  return [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
}

// side: 'left' | 'right' | '?' (too unclear to call) | '' (not calibrated)
function judgeSide(v) {
  const axis = settings.sideAxis;
  const n = Math.hypot(v[0], v[1]);
  if (!axis) return { side: '', score: 0 };
  if (n < 1e-6) return { side: '?', score: 0 };
  const score = (v[0] * axis[0] + v[1] * axis[1]) / n;
  return { side: Math.abs(score) < SIDE_MIN ? '?' : score > 0 ? 'right' : 'left', score };
}

function sideTag(r) {
  if (!r.side) return '';
  if (r.correct === true) return `${sideName(r.side)} ✓`;
  if (r.correct === false) return `${sideName(r.side)} ✗ hit ${sideName(r.hitSide)}`;
  return r.hitSide === '?' ? `${sideName(r.side)} ?` : sideName(r.side);
}
const sideClass = (r) => (r.correct === true ? 'ok' : r.correct === false ? 'bad' : '');

// ---------- audio ----------

let audio = null;

function startAudio() {
  // Called synchronously from the Start tap so iOS allows sound.
  const info = { before: audio ? audio.state : 'none' };
  try {
    if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; // play with silent switch on
    info.audioSession = 'audioSession' in navigator ? navigator.audioSession.type : 'not supported';
  } catch (e) { info.audioSession = 'error: ' + e.message; }
  // iOS can leave the context stuck "interrupted" (a call, Siri, another app's audio)
  // or closed. A tap is allowed to make a new one, so start fresh.
  if (audio && (audio.state === 'interrupted' || audio.state === 'closed')) {
    if (audio.state !== 'closed') audio.close().catch(() => {});
    audio = null;
    info.recreated = true;
  }
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { logEvent('audio', { ...info, error: 'no Web Audio' }); return Promise.resolve(); }
    audio = new AC();
    audio.onstatechange = onAudioState;
    // A silent buffer fully unlocks output on iOS.
    const buf = audio.createBuffer(1, 1, 22050);
    const src = audio.createBufferSource();
    src.buffer = buf;
    src.connect(audio.destination);
    src.start(0);
  }
  loadVoice();
  const done = () => {
    logEvent('audio', { ...info, after: audio.state, sampleRate: audio.sampleRate, baseLatency: audio.baseLatency, outputLatency: audio.outputLatency });
  };
  if (audio.state === 'running') { done(); return Promise.resolve(); }
  return audio.resume().then(done, (e) => { info.resumeError = String(e && e.message || e); done(); });
}

// iPhone can switch the sound off mid-drill, e.g. when a finger on Start turns into
// a scroll. Try to switch it straight back on; any tap on the screen also does it.
function onAudioState() {
  logEvent('audioState', { state: audio.state, drillRunning: running() });
  if (audio.state !== 'running' && audio.state !== 'closed' && running()) {
    audio.resume().then(
      () => logEvent('audioResume', { ok: audio.state === 'running', state: audio.state, by: 'auto' }),
      (e) => logEvent('audioResume', { ok: false, error: String(e && e.message || e), by: 'auto' }));
  }
}

function wakeAudioOnTap() {
  if (!audio || audio.state === 'running') return;
  const before = audio.state;
  startAudio(); // inside a tap, so iOS allows it (and it rebuilds a stuck context)
  logEvent('audioResume', { before, by: 'tap' });
}

function tone(freq, durSec, vol, type, at) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(vol, at + 0.003);
  gain.gain.setValueAtTime(vol, at + durSec - 0.02);
  gain.gain.linearRampToValueAtTime(0, at + durSec);
  osc.connect(gain).connect(audio.destination);
  osc.start(at);
  osc.stop(at + durSec + 0.01);
}

// Game feedback after each kick: a rising chirp for the right side, a low buzz for the wrong side.
function resultSound(good) {
  if (!audio) return;
  const v = 0.5 * VOLUME;
  const at = audio.currentTime + 0.02;
  if (good) {
    tone(880, 0.09, v, 'triangle', at);
    tone(1320, 0.14, v, 'triangle', at + 0.1);
  } else {
    tone(150, 0.4, v, 'sawtooth', at);
  }
}

// ---------- voice cue ----------
// Short "Right!" / "Left!" clips (voice/right.wav, voice/left.wav: Windows "David" at 1.25x), trimmed so the
// word starts at the first sample. They play through Web Audio like the beep, so
// they start at the scheduled moment and the timing stays the same for everyone.

const voiceBuffers = {}; // 'right' -> AudioBuffer, or 'loading'

function loadVoice() {
  if (!audio || !settings.voice) return;
  ['right', 'left'].forEach((key) => {
    if (voiceBuffers[key]) return;
    voiceBuffers[key] = 'loading';
    const t0 = performance.now();
    let step = 'fetch';
    fetch(`voice/${key}.wav`)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); step = 'decode'; return r.arrayBuffer(); })
      .then((data) => new Promise((ok, fail) => audio.decodeAudioData(data, ok, fail)))
      .then((buf) => {
        voiceBuffers[key] = buf;
        logEvent('voiceLoad', { file: key, ok: true, ms: Math.round(performance.now() - t0), online: navigator.onLine });
      })
      .catch((e) => {
        delete voiceBuffers[key]; // falls back to the beep
        logEvent('voiceLoad', { file: key, ok: false, step, error: String(e && e.message || e), online: navigator.onLine });
      });
  });
}

// Settings shows whether the clips are saved for offline use (the gym has no signal).
// If they're missing and we're online, fetch them: the service worker keeps a copy.
const VOICE_FILES = ['voice/right.wav', 'voice/left.wav'];

function checkVoiceOffline(retry = true) {
  const out = $('voiceStatus');
  if (!('caches' in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) {
    out.textContent = '';
    return;
  }
  Promise.all(VOICE_FILES.map((f) => caches.match(f, { ignoreSearch: true }))).then((hits) => {
    logEvent('voiceCache', { right: !!hits[0], left: !!hits[1], online: navigator.onLine, retry });
    if (hits.every(Boolean)) {
      out.textContent = '✓ Voice saved for offline use';
      out.className = 'hint voice-status ok';
      return;
    }
    out.textContent = 'Voice not saved for offline use yet. Open the app once on Wi-Fi (the beep is used until then).';
    out.className = 'hint voice-status bad';
    if (retry && navigator.onLine) {
      Promise.all(VOICE_FILES.map((f) => fetch(f).catch(() => null)))
        .then(() => setTimeout(() => checkVoiceOffline(false), 500));
    }
  }).catch(() => { out.textContent = ''; });
}

function voiceBuffer(side) {
  const buf = settings.voice && side && voiceBuffers[side];
  return buf && buf !== 'loading' ? buf : null;
}

function playBuffer(buf, at) {
  const src = audio.createBufferSource();
  const gain = audio.createGain();
  src.buffer = buf;
  gain.gain.value = VOLUME;
  src.connect(gain).connect(audio.destination);
  src.start(at);
}

// Schedules the beep (or the voice for that side) and returns the performance.now()
// time at which it actually comes out of the speaker.
function scheduleBeep(side) {
  const now = performance.now();
  if (!audio) return now;
  const lead = 0.03;
  const at = audio.currentTime + lead;
  const voice = voiceBuffer(side);
  if (voice) playBuffer(voice, at);
  else tone(1200, 0.2, 0.6 * VOLUME, 'square', at);
  // for the logs: what played, and whether the sound system was actually on
  const vb = side && voiceBuffers[side];
  drill.sound = {
    played: voice ? 'voice' : 'beep', audioState: audio.state,
    voiceOn: settings.voice, voiceClip: !settings.voice ? 'off' : vb === 'loading' ? 'loading' : vb ? 'ready' : 'missing',
  };

  let perfAt = null;
  if (audio.getOutputTimestamp) {
    const ts = audio.getOutputTimestamp();
    if (ts && ts.performanceTime > 0) perfAt = ts.performanceTime + (at - ts.contextTime) * 1000;
  }
  if (perfAt === null || Math.abs(perfAt - now) > 1000) {
    perfAt = now + lead * 1000 + ((audio.outputLatency || audio.baseLatency || 0) * 1000);
  }
  return perfAt;
}

// ---------- motion sensor ----------

const motion = { listening: false, lastEventAt: -1e9, frameMax: 0, peak: 0, lastAbove: -1e9, hz: 0, _count: 0, gx: 0, gy: 0, gz: 0, ring: [], recording: null };

function startMotion() {
  // Must be called synchronously from a tap on iOS.
  let perm = Promise.resolve('granted');
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    perm = DeviceMotionEvent.requestPermission().catch(() => 'denied');
  }
  return perm.then((result) => {
    if (result !== 'granted') {
      alert('Motion access was denied. In Settings > Safari (or this app), allow Motion & Orientation Access, then reload.');
    }
    if (!motion.listening) {
      window.addEventListener('devicemotion', onMotion);
      motion.listening = true;
    }
  });
}

const sensorLive = () => performance.now() - motion.lastEventAt < 1000;

function eventTime(e) {
  const now = performance.now();
  // event.timeStamp is on the performance.now() clock in modern browsers; guard against old epoch-based values.
  return (e.timeStamp > 0 && Math.abs(now - e.timeStamp) < 1000) ? e.timeStamp : now;
}

function onMotion(e) {
  let x = 0, y = 0, z = 0, g = 0;
  const a = e.acceleration;
  if (a && a.x !== null) {
    x = a.x; y = a.y; z = a.z;
    g = Math.hypot(x, y, z) / G;
  } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
    const ag = e.accelerationIncludingGravity;
    x = ag.x; y = ag.y; z = ag.z;
    g = Math.abs(Math.hypot(x, y, z) / G - 1);
  } else {
    return; // desktop browsers fire empty events
  }
  const ag = e.accelerationIncludingGravity;
  if (ag && ag.x !== null) {
    // Smoothed gravity, so a kick or a swinging bag doesn't flip the rotation check
    motion.gx += (ag.x - motion.gx) * 0.05;
    motion.gy += (ag.y - motion.gy) * 0.05;
    motion.gz += (ag.z - motion.gz) * 0.05;
  }
  motion.lastEventAt = performance.now();
  motion._count++;
  const rr = e.rotationRate || {};
  const s = { t: eventTime(e), g, x, y, z, ra: rr.alpha || 0, rb: rr.beta || 0, rg: rr.gamma || 0, sim: false };
  recordRaw(s);
  handleSample(s);
}

// Detailed log: keep the last moment of readings, and while a kick is being
// recorded, keep adding to it until RAW_POST_MS after impact.
function recordRaw(s) {
  const ring = motion.ring;
  ring.push(s);
  while (ring.length && ring[0].t < s.t - RAW_PRE_MS - 50) ring.shift();
  const rec = motion.recording;
  if (rec) {
    if (s.t <= rec.until) { if (rec.arr[rec.arr.length - 1] !== s) rec.arr.push(s); }
    else motion.recording = null;
  }
}

function startRawRecording(s) {
  const arr = motion.ring.filter((p) => p.t >= s.t - RAW_PRE_MS);
  if (arr[arr.length - 1] !== s) arr.push(s); // simulated hits aren't in the ring
  motion.recording = { arr, until: s.t + RAW_POST_MS };
  return arr;
}

function handleSample(s) {
  motion.frameMax = Math.max(motion.frameMax, s.g);
  motion.peak = Math.max(motion.peak, s.g);
  const over = s.g >= settings.threshold;
  if (over) motion.lastAbove = s.t;

  switch (drill.state) {
    case 'countdown':
    case 'waiting':
      if (over) falseStart();
      break;
    case 'armed':
      if (over) {
        if (s.t < drill.beepT) falseStart();
        else beginCapture(s);
      }
      break;
    case 'calib':
      if (over) beginCapture(s);
      break;
    case 'capture':
      if (s.g > drill.peak.g) drill.peak = s;
      if (s.t - drill.hitT <= IMPULSE_MS) { drill.imp[0] += s.x; drill.imp[1] += s.y; }
      break;
  }
}

// On the PC: a push toward the cued side 75% of the time (always during calibration).
function simulateHit() {
  const target = drill.calib ? drill.calib.steps[drill.calib.i] : drill.side;
  let ang = Math.random() * Math.PI * 2;
  if (target) {
    const side = drill.calib || Math.random() < 0.75 ? target : (target === 'left' ? 'right' : 'left');
    ang = (side === 'right' ? 0 : Math.PI) + (Math.random() - 0.5) * 1.2;
  }
  const g = settings.threshold + 0.5 + Math.random() * 3;
  handleSample({ t: performance.now(), g, x: Math.cos(ang) * g * G, y: Math.sin(ang) * g * G, z: 0, sim: true });
}

// ---------- wake lock ----------

let wakeLock = null;

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* not supported or denied */ }
}

// ---------- drill state machine ----------
// idle -> settle -> countdown -> waiting -> armed -> capture -> (result) -> idle / next rep

const drill = {
  state: 'idle', run: 0, timers: [], beepT: 0, hitT: 0, peak: null,
  series: null, repNo: 0, side: null, cueShown: false, recentSides: [], imp: [0, 0], calib: null,
};
let results = [];   // newest first, for the on-screen list
let log = [];       // every rep, oldest first, for Copy log

function later(ms, fn) {
  const run = drill.run;
  const id = setTimeout(() => { if (run === drill.run) fn(); }, Math.max(0, ms));
  drill.timers.push(id);
}

function cancelTimers() {
  drill.timers.forEach(clearTimeout);
  drill.timers = [];
  drill.run++;
}

const running = () => drill.state !== 'idle';

function updateStartButton() {
  el.start.textContent = running() ? 'Stop' : 'Start';
  el.start.classList.toggle('stop', running());
  document.body.classList.toggle('running', running());
}

function onStartTap() {
  if (running()) { stopDrill('Stopped'); return; }
  // Kick off permission + audio inside the tap, then continue.
  const ready = Promise.all([startMotion(), startAudio()]);
  keepAwake();
  window.scrollTo(0, 0); // the timer display and Stop button in view
  ready.then(() => {
    cancelTimers();
    drill.series = settings.mode === 'series' ? { total: settings.reps, list: [] } : null;
    drill.repNo = 0;
    drill.recentSides = [];
    el.summary.hidden = true;
    beginRep();
  });
}

function stopDrill(msg) {
  cancelTimers();
  drill.state = 'idle';
  drill.series = null;
  drill.calib = null;
  hideCue();
  updateStartButton();
  if (msg) show('', msg, '—', '');
}

// Series: keep the last result on screen while the student gets back into stance.
function restCountdown(n) {
  el.status.textContent = `Rest · next kick in ${n}`;
  later(1000, () => (n > 1 ? restCountdown(n - 1) : beginRep()));
}

function beginRep() {
  drill.state = 'settle';
  drill.repNo++;
  drill.side = null;
  drill.cueShown = false;
  updateStartButton();
  const repLabel = drill.series ? `Rep ${drill.repNo} of ${drill.series.total}` : '';
  show('waiting', 'Hold the bag still', '…', repLabel);
  whenSettled(() => {
    if (settings.countdown > 0) countdown(settings.countdown, repLabel);
    else waitPhase(repLabel);
  });
}

function whenSettled(fn) {
  const start = performance.now();
  const check = () => {
    const now = performance.now();
    const settled = !sensorLive() || (now - motion.lastAbove >= SETTLE_MS && now - start >= 300);
    if (settled) fn();
    else later(50, check);
  };
  later(50, check);
}

// Silent "ready" time, then the random delay. The screen shows READY for both,
// so students get no visual hint of when the beep is coming.
function countdown(n, repLabel) {
  drill.state = 'countdown';
  show('waiting', 'Get ready', 'READY', repLabel);
  later(n * 1000, () => waitPhase(repLabel));
}

function waitPhase(repLabel) {
  drill.state = 'waiting';
  show('waiting', 'Get ready', 'READY', repLabel);
  const lo = Math.min(settings.delayMin, settings.delayMax);
  const hi = Math.max(settings.delayMin, settings.delayMax);
  later((lo + Math.random() * (hi - lo)) * 1000, fireBeep);
}

function fireBeep() {
  drill.side = pickSide();
  drill.beepT = scheduleBeep(drill.side);
  drill.state = 'armed';
  const now = performance.now();
  const soundAt = drill.beepT;
  later(soundAt - now, () => {
    if (drill.state !== 'armed') return;
    show(settings.flash ? 'armed flash' : 'armed', `Kick ${sideName(drill.side).toLowerCase()}!`, 'GO', '');
    showCue(drill.side, settings.flash);
    drill.cueShown = true;
    if (settings.flash) later(250, () => { if (drill.state === 'armed') { el.display.classList.remove('flash'); el.cue.classList.remove('flash'); } });
  });
  later(drill.beepT + settings.timeout * 1000 - now, () => {
    if (drill.state === 'armed') finishRep({ kind: 'none' });
  });
}

function beginCapture(s) {
  const calib = drill.state === 'calib';
  drill.state = 'capture';
  drill.hitT = s.t;
  drill.peak = s;
  drill.imp = [s.x, s.y];
  const samples = startRawRecording(s);
  const jolt = samples.find((p) => p.t >= s.t - JOLT_LEAD_MS && p.t <= s.t && p.g >= JOLT_MIN_G) || s;
  const push = toScreen(jolt.x, jolt.y);
  later(CAPTURE_MS, () => {
    const push80 = toScreen(drill.imp[0], drill.imp[1]);
    if (calib) { calibKick(push, samples, s.t); return; }
    const p = drill.peak;
    const angle = (Math.atan2(p.y, p.x) * 180 / Math.PI + 360) % 360;
    const judged = judgeSide(push);
    finishRep({
      kind: 'hit', ms: drill.hitT - drill.beepT,
      peakG: p.g, x: p.x, y: p.y, z: p.z, angle, sim: s.sim,
      hitSide: judged.side, sideScore: judged.score, push, push80, joltMs: Math.round(jolt.t - s.t), screenAngle: screenAngle(),
      samples, hitT: s.t,
    });
  });
}

function falseStart() {
  finishRep({ kind: 'false' });
}

function finishRep(r) {
  cancelTimers();
  drill.state = 'result';
  hideCue();
  r.rep = drill.repNo;
  r.side = drill.cueShown ? drill.side : ''; // blank for false starts: no side was shown yet
  // true/false only when the side could be judged; null = not calibrated or unclear
  r.sound = drill.cueShown ? drill.sound : null;
  r.correct = r.kind === 'hit' && r.side && (r.hitSide === 'left' || r.hitSide === 'right') ? r.hitSide === r.side : null;
  r.mode = drill.series ? 'series' : 'single';
  r.when = new Date();
  addResult(r);
  logEvent('rep', r);

  if (r.kind === 'hit') {
    const extra = `peak ${r.peakG.toFixed(1)} g · dir ${Math.round(r.angle)}°${r.sim ? ' · simulated' : ''}`;
    if (r.correct === false) {
      show('bad', 'Wrong side!', fmt(r.ms), `Arrow said ${sideName(r.side)} · kicked ${sideName(r.hitSide)}`);
      resultSound(false);
    } else {
      const sideTxt = r.correct ? `✓ ${sideName(r.side)} side` : r.hitSide === '?' ? `${sideName(r.side)} · side unclear` : sideName(r.side);
      const noSound = r.sound && r.sound.audioState !== 'running' ? ' · <b class="nosound">⚠ no sound, tap the screen</b>' : '';
      show('good', 'Reaction time', fmt(r.ms), `${sideTxt} · ${extra}${noSound}`);
      if (r.correct) resultSound(true);
    }
  } else if (r.kind === 'false') {
    show('bad word', 'Too early', 'FALSE START', 'Kicked before the beep');
  } else {
    show('bad word', 'Timed out', 'NO KICK', `${sideName(r.side)} · nothing above ${settings.threshold.toFixed(1)} g in ${settings.timeout} s`);
  }

  const s = drill.series;
  if (s) {
    s.list.push(r);
    if (s.list.length < s.total) {
      restCountdown(Math.max(1, settings.rest));
      return;
    }
    const list = s.list;
    showSummary(list);
    later(SERIES_GAP_MS, () => showSeriesDisplay(list)); // let the last rep's time be seen first
    drill.series = null;
  }
  drill.state = 'idle';
  updateStartButton();
}

// ---------- results ----------

function addResult(r) {
  results.unshift(r);
  results = results.slice(0, MAX_LIST);
  log.push(r);
  renderResults();
}

function renderResults() {
  el.results.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    if (r.kind === 'hit') {
      li.innerHTML = `<span class="t ${r.correct === false ? 'bad' : ''}">${fmt(r.ms)}</span><span class="x"><span class="${sideClass(r)}">${sideTag(r)}</span> · ${r.peakG.toFixed(1)} g · ${Math.round(r.angle)}°${r.sim ? ' · sim' : ''}</span>`;
    } else {
      li.innerHTML = `<span class="bad">${r.kind === 'false' ? 'FALSE START' : 'NO KICK'}</span>${r.side ? `<span class="x">${sideTag(r)}</span>` : ''}`;
    }
    el.results.appendChild(li);
  });
  // list is newest first; number so the newest has the highest number
  el.results.setAttribute('reversed', '');
}

// Fastest and average over the hits only; false starts, no-kicks and wrong-side kicks are left out.
function seriesStats(list) {
  const hits = list.filter((r) => r.kind === 'hit' && r.correct !== false).map((r) => r.ms);
  return {
    hits: hits.length,
    checked: list.some((r) => r.correct !== null),
    correct: list.filter((r) => r.correct === true).length,
    wrong: list.filter((r) => r.correct === false).length,
    fastest: hits.length ? fmt(Math.min(...hits)) : '—',
    average: hits.length ? fmt(hits.reduce((a, b) => a + b, 0) / hits.length) : '—',
  };
}

function showSummary(list) {
  const st = seriesStats(list);
  const falses = list.filter((r) => r.kind === 'false').length;
  const none = list.filter((r) => r.kind === 'none').length;
  const reps = list.map((r, i) =>
    `<li><span class="n">${i + 1}</span>${r.kind === 'hit' ? fmt(r.ms) : `<span class="bad">${r.kind === 'false' ? 'FALSE START' : 'NO KICK'}</span>`}<span class="side ${sideClass(r)}">${sideTag(r)}</span></li>`
  ).join('');
  el.summary.innerHTML =
    `Series done: ${st.hits} of ${list.length} kicks counted` +
    (falses ? ` · ${falses} false start${falses > 1 ? 's' : ''}` : '') +
    (none ? ` · ${none} no kick` : '') +
    (st.wrong ? ` · ${st.wrong} wrong side` : '') +
    `<div class="nums"><div>Fastest<b>${st.fastest}</b></div><div>Average<b>${st.average}</b></div>` +
    (st.checked ? `<div>Correct side<b>${st.correct}/${list.length}</b></div>` : '') + `</div>` +
    `<ol class="reps">${reps}</ol>`;
  el.summary.hidden = false;
}

function showSeriesDisplay(list) {
  if (running()) return; // a new drill already started
  const st = seriesStats(list);
  show('good', `Series done · ${st.hits} of ${list.length} kicks`, '', st.checked ? `<b class="score">Correct side: ${st.correct} of ${list.length}</b>` : '');
  el.big.innerHTML =
    `<div class="pair"><div><span>Fastest</span>${st.fastest}</div><div><span>Average</span>${st.average}</div></div>`;
}

function resetAll() {
  stopDrill('Tap Start');
  newSession(); // Reset starts a new session in the saved logs
  el.big.textContent = '0.000';
  results = [];
  log = [];
  motion.peak = 0;
  renderResults();
  el.summary.hidden = true;
}

function copyLog() {
  const head = 'time,mode,rep,result,reaction_ms,peak_g,x,y,z,angle_deg,simulated,side,hit_side,side_score,push_x,push_y,screen_angle';
  const rows = log.map((r) => [
    r.when.toISOString(), r.mode, r.rep, r.kind,
    r.kind === 'hit' ? r.ms.toFixed(1) : '',
    r.kind === 'hit' ? r.peakG.toFixed(2) : '',
    r.kind === 'hit' ? r.x.toFixed(2) : '',
    r.kind === 'hit' ? r.y.toFixed(2) : '',
    r.kind === 'hit' ? r.z.toFixed(2) : '',
    r.kind === 'hit' ? r.angle.toFixed(0) : '',
    r.kind === 'hit' ? (r.sim ? 1 : 0) : '',
    r.side || '',
    r.kind === 'hit' ? r.hitSide : '',
    r.kind === 'hit' ? r.sideScore.toFixed(2) : '',
    r.kind === 'hit' ? r.push[0].toFixed(2) : '',
    r.kind === 'hit' ? r.push[1].toFixed(2) : '',
    r.kind === 'hit' ? r.screenAngle : '',
  ].join(','));
  const text = [head, ...rows].join('\n');
  const done = () => alert(`Copied ${rows.length} row${rows.length === 1 ? '' : 's'}. Paste into Notes or an email.`);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { alert(text); }
  ta.remove();
}

// ---------- settings UI ----------

const RANGE_KEYS = ['threshold', 'countdown', 'delayMin', 'delayMax', 'timeout', 'reps', 'rest'];

function bindSettings() {
  RANGE_KEYS.forEach((key) => {
    const input = $(key);
    const out = $(key + 'Out');
    const paint = () => {
      const v = settings[key];
      out.textContent = key === 'threshold' || !Number.isInteger(v) ? v.toFixed(1) : v;
    };
    input.value = settings[key];
    paint();
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      // keep min <= max
      if (key === 'delayMin' && settings.delayMin > settings.delayMax) { settings.delayMax = settings.delayMin; $('delayMax').value = settings.delayMax; $('delayMaxOut').textContent = settings.delayMax; }
      if (key === 'delayMax' && settings.delayMax < settings.delayMin) { settings.delayMin = settings.delayMax; $('delayMin').value = settings.delayMin; $('delayMinOut').textContent = settings.delayMin; }
      paint();
      saveSettings();
    });
  });
  ['flash', 'voice'].forEach((key) => {
    const input = $(key);
    input.checked = !!settings[key];
    input.addEventListener('change', () => { settings[key] = input.checked; saveSettings(); loadVoice(); });
  });
  const paintMode = () => {
    el.modeSingle.classList.toggle('on', settings.mode === 'single');
    el.modeSeries.classList.toggle('on', settings.mode === 'series');
    el.modeSingle.setAttribute('aria-checked', settings.mode === 'single');
    el.modeSeries.setAttribute('aria-checked', settings.mode === 'series');
  };
  el.modeSingle.addEventListener('click', () => { settings.mode = 'single'; saveSettings(); paintMode(); });
  el.modeSeries.addEventListener('click', () => { settings.mode = 'series'; saveSettings(); paintMode(); });
  paintMode();

  const cues = { left: el.cueLeft, right: el.cueRight, random: el.cueRandom };
  const paintCue = () => Object.entries(cues).forEach(([key, btn]) => {
    btn.classList.toggle('on', settings.cue === key);
    btn.setAttribute('aria-checked', settings.cue === key);
  });
  Object.entries(cues).forEach(([key, btn]) => btn.addEventListener('click', () => { settings.cue = key; saveSettings(); paintCue(); }));
  paintCue();
  paintSideStatus();
}

function paintSideStatus() {
  el.sideStatus.innerHTML = settings.sideAxis
    ? 'Side check: <span class="on">on</span>'
    : 'Side check: off · calibrate to turn on';
}

// ---------- side calibration ----------
// Kick the right side CALIB_KICKS times, then the left side, with the phone in
// its holder. The app learns which way the bag moves for each side.

function onCalibTap() {
  if (running()) stopDrill('');
  const ready = Promise.all([startMotion(), startAudio()]);
  keepAwake();
  ready.then(() => {
    cancelTimers();
    const steps = [...Array(CALIB_KICKS).fill('right'), ...Array(CALIB_KICKS).fill('left')];
    drill.calib = { steps, i: 0, kicks: [] };
    calibStep();
  });
}

function calibStep() {
  const c = drill.calib;
  const side = c.steps[c.i];
  const n = c.steps.slice(0, c.i + 1).filter((x) => x === side).length;
  drill.state = 'calibSettle';
  updateStartButton();
  hideCue();
  show('waiting word', 'Calibrating sides', 'Hold still', `Kick ${c.i + 1} of ${c.steps.length}`);
  whenSettled(() => {
    drill.state = 'calib';
    showCue(side, false, `Calibrating · ${sideName(side)} kick ${n} of ${CALIB_KICKS} · tap screen to cancel`);
  });
}

function calibKick(push, samples, hitT) {
  const c = drill.calib;
  const n = Math.hypot(push[0], push[1]) || 1;
  c.kicks.push({ side: c.steps[c.i], v: [push[0] / n, push[1] / n] });
  logEvent('calibKick', { side: c.steps[c.i], kick: c.i + 1, push, screenAngle: screenAngle(), samples, hitT });
  resultSound(true);
  c.i++;
  if (c.i < c.steps.length) calibStep();
  else finishCalibration(c.kicks);
}

function finishCalibration(kicks) {
  const mean = (side) => {
    const k = kicks.filter((x) => x.side === side);
    return [k.reduce((a, x) => a + x.v[0], 0) / k.length, k.reduce((a, x) => a + x.v[1], 0) / k.length];
  };
  const r = mean('right'), l = mean('left');
  const d = [r[0] - l[0], r[1] - l[1]];
  const n = Math.hypot(d[0], d[1]);
  stopDrill('');
  if (n < 0.5) {
    logEvent('calibDone', { ok: false, kicks: kicks.length });
    show('bad word', 'Calibration failed', 'TRY AGAIN', 'Right and left kicks moved the bag the same way. Kick firmly on each side.');
    return;
  }
  settings.sideAxis = [d[0] / n, d[1] / n];
  saveSettings();
  paintSideStatus();
  const ok = kicks.filter((k) => judgeSide(k.v).side === k.side).length;
  logEvent('calibDone', { ok: true, sorted: ok, kicks: kicks.length, sideAxis: settings.sideAxis });
  show(ok === kicks.length ? 'good' : 'bad', 'Side check on', `${ok} of ${kicks.length}`,
    ok === kicks.length ? 'Every calibration kick was sorted to the right side' : 'Some kicks were unclear. Calibrate again for better results.');
}

// ---------- hold to reset ----------
// Reset needs a press and hold, so a stray tap from a student can't wipe the results.

const HOLD_MS = 1000;

function bindHoldToReset() {
  const btn = el.reset;
  const hint = $('resetHint');
  let timer = null;
  let hintTimer = null;
  btn.style.setProperty('--hold-ms', HOLD_MS + 'ms');
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('holding');
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cancel();
    btn.classList.add('holding');
    timer = setTimeout(() => { cancel(); resetAll(); }, HOLD_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, () => {
    if (!timer) return;
    cancel();
    // let go too soon: say how it works
    hint.textContent = 'hold 1 sec';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.textContent = 'hold'; }, 1500);
  }));
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // long press menu on some phones
}

// ---------- saved session logs ----------
// Every rep and calibration kick, with the raw sensor readings around it, is kept
// on the phone per session. "Download logs" saves them all as one JSON file.

let session = null;
let saveTimer = null;

function newSession() {
  saveLogs();
  session = {
    id: Date.now(), started: new Date().toISOString(), version: VERSION,
    device: navigator.userAgent, screen: `${screen.width}x${screen.height}`, events: [],
  };
}

function logEvent(type, data) {
  if (!session) return;
  try {
    session.events.push({ type, when: new Date().toISOString(), threshold: settings.threshold, cueMode: settings.cue, sideAxis: settings.sideAxis, data });
    // wait for the readings after the kick to finish coming in, then save
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLogs, RAW_POST_MS + 200);
    paintLogsLink();
  } catch (e) { /* logging must never break the drill (or loop through the error handler) */ }
}

const r2 = (v) => Math.round(v * 100) / 100;

// Samples: [ms from impact, accel x, y, z (m/s²), rotation alpha, beta, gamma (°/s)]
function packEvent(e) {
  const { samples, hitT, when, ...rest } = e.data;
  const out = { type: e.type, when: e.when, threshold: e.threshold, cueMode: e.cueMode, sideAxis: e.sideAxis, ...rest };
  if (when instanceof Date) out.repTime = when.toISOString();
  if (out.push) out.push = out.push.map(r2);
  if (out.push80) out.push80 = out.push80.map(r2);
  ['ms', 'peakG', 'x', 'y', 'z', 'angle', 'sideScore'].forEach((k) => { if (typeof out[k] === 'number') out[k] = r2(out[k]); });
  if (samples) out.samples = samples.map((p) => [Math.round(p.t - hitT), r2(p.x), r2(p.y), r2(p.z), r2(p.ra || 0), r2(p.rb || 0), r2(p.rg || 0)]);
  return out;
}

function loadLogs() {
  try { return JSON.parse(localStorage.getItem(LOGS_KEY) || '[]'); } catch (e) { return []; }
}

function allSessions() {
  const saved = loadLogs().filter((x) => !session || x.id !== session.id);
  if (session && session.events.length) saved.push({ ...session, events: session.events.map(packEvent) });
  return saved;
}

function saveLogs() {
  if (!session || !session.events.length) return;
  const sessions = allSessions();
  let text = JSON.stringify(sessions);
  while (sessions.length > 1 && text.length > LOGS_MAX_CHARS) { sessions.shift(); text = JSON.stringify(sessions); }
  for (;;) {
    try { localStorage.setItem(LOGS_KEY, text); return; } catch (e) {
      if (sessions.length <= 1) return; // storage full or blocked: keep it in memory only
      sessions.shift();
      text = JSON.stringify(sessions);
    }
  }
}

function paintLogsLink() {
  const sessions = allSessions();
  const kicks = sessions.reduce((a, x) => a + x.events.filter((e) => e.type === 'rep').length, 0);
  $('downloadLogs').textContent = sessions.length
    ? `Download logs (${sessions.length} session${sessions.length === 1 ? '' : 's'}, ${kicks} kick${kicks === 1 ? '' : 's'})`
    : 'Download logs';
}

async function downloadLogs(ev) {
  ev.preventDefault();
  saveLogs();
  const sessions = allSessions();
  if (!sessions.length) { alert('Nothing logged yet. Run a drill first.'); return; }
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`; // phone's local time
  const name = `kicktimer-logs-${stamp}.json`;
  const text = JSON.stringify({ app: 'KickTimer', version: VERSION, exported: new Date().toISOString(), sessions });
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'KickTimer logs' }); return; } catch (e) {
      if (e.name === 'AbortError') return; // closed the share sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function deleteLogs() {
  if (!confirm('Delete all saved logs on this phone? Download them first if you want to keep them.')) return;
  try { localStorage.removeItem(LOGS_KEY); } catch (e) { /* blocked */ }
  session.events = [];
  paintLogsLink();
}

// ---------- live meter + sensor badge ----------

function paintSoundBadge() {
  const b = $('soundBadge');
  if (!audio) { b.textContent = 'sound: tap Start'; b.className = 'badge'; return; }
  if (audio.state === 'running') { b.textContent = 'sound: on'; b.className = 'badge ok'; return; }
  b.textContent = 'sound: off · tap Start';
  b.className = 'badge bad';
}

// True when gravity says the phone is on its side (landscape) but the page is
// still laid out portrait, e.g. Rotation Lock is on. Uses only which axis gravity
// is along, not its sign, so it works the same on every iOS version.
function screenNotRotated() {
  const ax = Math.abs(motion.gx), ay = Math.abs(motion.gy), az = Math.abs(motion.gz);
  const sideways = ax > 0.5 * G && ax > 2 * ay && ax > az;
  return sideways && window.innerHeight > window.innerWidth;
}

let lastBadge = 0;

function frame(now) {
  const meterMax = Math.max(2, settings.threshold * 4);
  const g = motion.frameMax;
  motion.frameMax = 0;
  el.gNow.textContent = g.toFixed(2);
  el.gPeak.textContent = motion.peak.toFixed(2);
  el.meterFill.style.width = Math.min(100, (g / meterMax) * 100) + '%';
  el.meterFill.classList.toggle('over', g >= settings.threshold);
  el.meterThresh.style.left = Math.min(100, (settings.threshold / meterMax) * 100) + '%';

  if (now - lastBadge > 1000) {
    motion.hz = Math.round(motion._count * 1000 / (now - lastBadge || 1000));
    motion._count = 0;
    lastBadge = now;
    const live = sensorLive();
    if (live) {
      el.badge.textContent = `sensor: live ${motion.hz} Hz`;
      el.badge.className = 'badge ok';
    } else if (motion.listening) {
      el.badge.textContent = 'sensor: none (simulate)';
      el.badge.className = 'badge warn';
    } else {
      el.badge.textContent = 'sensor: tap Start';
      el.badge.className = 'badge';
    }
    el.sim.hidden = live || !motion.listening;
    paintSoundBadge();
    el.rotateWarn.hidden = !(live && screenNotRotated());
  }
  requestAnimationFrame(frame);
}

// ---------- wiring ----------

el.start.addEventListener('click', onStartTap);
bindHoldToReset();
el.sim.addEventListener('click', simulateHit);
el.peakReset.addEventListener('click', () => { motion.peak = 0; });
$('fromPeak').addEventListener('click', () => {
  if (motion.peak < 0.15) { alert('Kick the bag first so there is a peak reading.'); return; }
  const input = $('threshold');
  input.value = Math.max(0.1, Math.round(motion.peak * 0.7 * 10) / 10);
  input.dispatchEvent(new Event('input')); // same path as moving the slider: saves + repaints
});
el.copyLog.addEventListener('click', copyLog);
// Page locked while a drill runs (a scroll can switch the sound off), and any tap wakes the sound up
document.addEventListener('touchmove', (e) => { if (running()) e.preventDefault(); }, { passive: false });
document.addEventListener('touchend', wakeAudioOnTap, true);
document.addEventListener('click', wakeAudioOnTap, true);
$('calibBtn').addEventListener('click', onCalibTap);
checkVoiceOffline();
$('clearCalib').addEventListener('click', () => { settings.sideAxis = null; saveSettings(); paintSideStatus(); });
// Tap the full-screen arrow to stop (it covers the Stop button)
el.cue.addEventListener('click', () => { if (running()) stopDrill(drill.calib ? 'Calibration cancelled' : 'Stopped'); });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); simulateHit(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running()) stopDrill('Stopped (app was hidden)');
    saveLogs();
  } else {
    keepAwake();
    checkForUpdate(); // iOS often resumes the app instead of restarting it
    checkVoiceOffline();
  }
});

$('version').textContent = VERSION;
newSession();
logEvent('app', {
  online: navigator.onLine,
  homeScreen: !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)),
  offlineReady: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  audioSession: 'audioSession' in navigator,
});
// App errors go into the logs too, so problems at the gym can be traced later
window.addEventListener('error', (e) => logEvent('error', { message: e.message, where: `${(e.filename || '').split('/').pop()}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => logEvent('error', { message: String(e.reason && e.reason.message || e.reason) }));
paintLogsLink();
$('downloadLogs').addEventListener('click', downloadLogs);
$('deleteLogs').addEventListener('click', deleteLogs);
window.addEventListener('pagehide', saveLogs);
bindSettings();
renderResults();
requestAnimationFrame(frame);

// ---------- updates ----------
// A new sw.js installs in the background and takes over (skipWaiting + claim).
// Reload straight away if nothing is on screen; otherwise offer a tap-to-reload
// so a drill or a series summary is never wiped.

let swReg = null;

function applyUpdate() {
  if (!running() && log.length === 0) { location.reload(); return; }
  const footer = document.querySelector('.footer');
  footer.innerHTML = '<button id="updateBtn" class="btn small update">New version ready · tap to update</button>';
  $('updateBtn').addEventListener('click', () => location.reload());
}

function checkForUpdate(manual) {
  if (!swReg) {
    if (manual) alert('Updates are not available here.');
    return;
  }
  swReg.update().then(() => {
    if (manual && !swReg.installing && !swReg.waiting) alert(`You have the latest version (v${VERSION}).`);
  }, () => {
    if (manual) alert('No internet connection. Try again on Wi-Fi.');
  });
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let hadController = !!navigator.serviceWorker.controller; // false on the very first install
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) applyUpdate();
    hadController = true; // any later change in this session is a real update
    checkVoiceOffline();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => { swReg = reg; reg.update().catch(() => {}); }).catch(() => {});
}
$('checkUpdate').addEventListener('click', () => checkForUpdate(true));
