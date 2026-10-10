'use strict';

// KickTimer: countdown -> random delay -> beep -> time until the bag is hit.
// Runs entirely on the phone; see README.md for setup.

const VERSION = '1.3.0';
const G = 9.80665;           // m/s^2 per g
const SETTLE_MS = 600;       // bag must stay below threshold this long before a rep
const CAPTURE_MS = 120;      // after the first crossing, keep reading to find the peak
const SERIES_GAP_MS = 1500;  // at series end, show the last rep before the fastest/average screen
const MAX_LIST = 50;
const MAX_SAME_SIDE = 3;      // Random side: never more than this many in a row
const IMPULSE_MS = 80;       // side check: add up the bag's push over this long after impact
const CALIB_KICKS = 3;       // side calibration: kicks per side
const SIDE_MIN = 0.3;        // side check: a push weaker than this along the left/right line is unclear

// Bump when a default changes and phones should pick up the new value.
const SETTINGS_VERSION = 2;

const DEFAULTS = {
  threshold: 0.6, countdown: 3, delayMin: 1, delayMax: 3, timeout: 3,
  reps: 5, rest: 5, volume: 80, latency: 0, flash: true, mode: 'single', cue: 'right', sideAxis: null,
};

// ---------- settings ----------

const settings = loadSettings();

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('kicktimer.settings') || '{}');
    // v1 defaulted to 2.0 g, far too hard for young kids: replace it with the new default.
    if (!saved.v || saved.v < 2) delete saved.threshold;
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
  try {
    if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; // play with silent switch on
  } catch (e) { /* older iOS */ }
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.resolve();
    audio = new AC();
    // A silent buffer fully unlocks output on iOS.
    const buf = audio.createBuffer(1, 1, 22050);
    const src = audio.createBufferSource();
    src.buffer = buf;
    src.connect(audio.destination);
    src.start(0);
  }
  return audio.state === 'running' ? Promise.resolve() : audio.resume().catch(() => {});
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
  const v = 0.5 * settings.volume / 100;
  const at = audio.currentTime + 0.02;
  if (good) {
    tone(880, 0.09, v, 'triangle', at);
    tone(1320, 0.14, v, 'triangle', at + 0.1);
  } else {
    tone(150, 0.4, v, 'sawtooth', at);
  }
}

// Schedules the beep and returns the performance.now() time at which it
// actually comes out of the speaker (plus the user's latency offset).
function scheduleBeep() {
  const now = performance.now();
  if (!audio) return now + settings.latency;
  const lead = 0.03;
  const at = audio.currentTime + lead;
  tone(1200, 0.2, 0.6 * settings.volume / 100, 'square', at);

  let perfAt = null;
  if (audio.getOutputTimestamp) {
    const ts = audio.getOutputTimestamp();
    if (ts && ts.performanceTime > 0) perfAt = ts.performanceTime + (at - ts.contextTime) * 1000;
  }
  if (perfAt === null || Math.abs(perfAt - now) > 1000) {
    perfAt = now + lead * 1000 + ((audio.outputLatency || audio.baseLatency || 0) * 1000);
  }
  return perfAt + settings.latency;
}

// ---------- motion sensor ----------

const motion = { listening: false, lastEventAt: -1e9, frameMax: 0, peak: 0, lastAbove: -1e9, hz: 0, _count: 0, gx: 0, gy: 0, gz: 0 };

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
  handleSample({ t: eventTime(e), g, x, y, z, sim: false });
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
}

function onStartTap() {
  if (running()) { stopDrill('Stopped'); return; }
  // Kick off permission + audio inside the tap, then continue.
  const ready = Promise.all([startMotion(), startAudio()]);
  keepAwake();
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
  drill.beepT = scheduleBeep();
  drill.state = 'armed';
  const now = performance.now();
  const soundAt = drill.beepT - settings.latency;
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
  later(CAPTURE_MS, () => {
    const push = toScreen(drill.imp[0], drill.imp[1]);
    if (calib) { calibKick(push); return; }
    const p = drill.peak;
    const angle = (Math.atan2(p.y, p.x) * 180 / Math.PI + 360) % 360;
    const judged = judgeSide(push);
    finishRep({
      kind: 'hit', ms: drill.hitT - drill.beepT,
      peakG: p.g, x: p.x, y: p.y, z: p.z, angle, sim: s.sim,
      hitSide: judged.side, sideScore: judged.score, push, screenAngle: screenAngle(),
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
  r.correct = r.kind === 'hit' && r.side && (r.hitSide === 'left' || r.hitSide === 'right') ? r.hitSide === r.side : null;
  r.mode = drill.series ? 'series' : 'single';
  r.when = new Date();
  addResult(r);

  if (r.kind === 'hit') {
    const extra = `peak ${r.peakG.toFixed(1)} g · dir ${Math.round(r.angle)}°${r.sim ? ' · simulated' : ''}`;
    if (r.correct === false) {
      show('bad', 'Wrong side!', fmt(r.ms), `Arrow said ${sideName(r.side)} · kicked ${sideName(r.hitSide)}`);
      resultSound(false);
    } else {
      const sideTxt = r.correct ? `✓ ${sideName(r.side)} side` : r.hitSide === '?' ? `${sideName(r.side)} · side unclear` : sideName(r.side);
      show('good', 'Reaction time', fmt(r.ms), `${sideTxt} · ${extra}`);
      if (r.correct) resultSound(true);
    }
  } else if (r.kind === 'false') {
    show('bad', 'Too early', 'FALSE START', 'Kicked before the beep');
  } else {
    show('bad', 'Timed out', 'NO KICK', `${sideName(r.side)} · nothing above ${settings.threshold.toFixed(1)} g in ${settings.timeout} s`);
  }

  const s = drill.series;
  if (s) {
    s.list.push(r);
    if (s.list.length < s.total) {
      restCountdown(Math.max(5, settings.rest));
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

const RANGE_KEYS = ['threshold', 'countdown', 'delayMin', 'delayMax', 'timeout', 'reps', 'rest', 'volume', 'latency'];

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
  ['flash'].forEach((key) => {
    const input = $(key);
    input.checked = !!settings[key];
    input.addEventListener('change', () => { settings[key] = input.checked; saveSettings(); });
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
  show('waiting', 'Calibrating sides', 'Hold still', `Kick ${c.i + 1} of ${c.steps.length}`);
  whenSettled(() => {
    drill.state = 'calib';
    showCue(side, false, `Calibrating · ${sideName(side)} kick ${n} of ${CALIB_KICKS} · tap screen to cancel`);
  });
}

function calibKick(push) {
  const c = drill.calib;
  const n = Math.hypot(push[0], push[1]) || 1;
  c.kicks.push({ side: c.steps[c.i], v: [push[0] / n, push[1] / n] });
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
    show('bad', 'Calibration failed', 'TRY AGAIN', 'Right and left kicks moved the bag the same way. Kick firmly on each side.');
    return;
  }
  settings.sideAxis = [d[0] / n, d[1] / n];
  saveSettings();
  paintSideStatus();
  const ok = kicks.filter((k) => judgeSide(k.v).side === k.side).length;
  show(ok === kicks.length ? 'good' : 'bad', 'Side check on', `${ok} of ${kicks.length}`,
    ok === kicks.length ? 'Every calibration kick was sorted to the right side' : 'Some kicks were unclear. Calibrate again for better results.');
}

// ---------- live meter + sensor badge ----------

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
    el.rotateWarn.hidden = !(live && screenNotRotated());
  }
  requestAnimationFrame(frame);
}

// ---------- wiring ----------

el.start.addEventListener('click', onStartTap);
el.reset.addEventListener('click', resetAll);
el.sim.addEventListener('click', simulateHit);
el.peakReset.addEventListener('click', () => { motion.peak = 0; });
$('fromPeak').addEventListener('click', () => {
  if (motion.peak < 0.15) { alert('Kick the bag first so there is a peak reading.'); return; }
  const input = $('threshold');
  input.value = Math.max(0.1, Math.round(motion.peak * 0.7 * 10) / 10);
  input.dispatchEvent(new Event('input')); // same path as moving the slider: saves + repaints
});
el.copyLog.addEventListener('click', copyLog);
$('calibBtn').addEventListener('click', onCalibTap);
$('clearCalib').addEventListener('click', () => { settings.sideAxis = null; saveSettings(); paintSideStatus(); });
// Tap the full-screen arrow to stop (it covers the Stop button)
el.cue.addEventListener('click', () => { if (running()) stopDrill(drill.calib ? 'Calibration cancelled' : 'Stopped'); });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); simulateHit(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running()) stopDrill('Stopped (app was hidden)');
  } else {
    keepAwake();
    checkForUpdate(); // iOS often resumes the app instead of restarting it
  }
});

$('version').textContent = VERSION;
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
  });
  navigator.serviceWorker.register('sw.js').then((reg) => { swReg = reg; reg.update().catch(() => {}); }).catch(() => {});
}
$('checkUpdate').addEventListener('click', () => checkForUpdate(true));
