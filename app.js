'use strict';

// KickTimer: countdown -> random delay -> beep -> time until the bag is hit.
// Runs entirely on the phone; see README.md for setup.

const VERSION = '1.0.0';
const G = 9.80665;           // m/s^2 per g
const SETTLE_MS = 600;       // bag must stay below threshold this long before a rep
const CAPTURE_MS = 120;      // after the first crossing, keep reading to find the peak
const SERIES_GAP_MS = 1500;  // at series end, show the last rep before the fastest/average screen
const MAX_LIST = 50;

const DEFAULTS = {
  threshold: 2.0, countdown: 3, delayMin: 1, delayMax: 3, timeout: 3,
  reps: 5, rest: 5, volume: 80, latency: 0, flash: true, mode: 'single',
};

// ---------- settings ----------

const settings = loadSettings();

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('kicktimer.settings') || '{}');
    return { ...DEFAULTS, ...saved };
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
  badge: $('sensorBadge'),
};

function show(cls, status, big, detail) {
  el.display.className = 'display ' + (cls || '');
  el.status.textContent = status;
  el.big.textContent = big;
  el.detail.innerHTML = detail || '&nbsp;';
}

const fmt = (ms) => (ms / 1000).toFixed(3) + ' s';

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

const motion = { listening: false, lastEventAt: -1e9, frameMax: 0, peak: 0, lastAbove: -1e9, hz: 0, _count: 0 };

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
    case 'capture':
      if (s.g > drill.peak.g) drill.peak = s;
      break;
  }
}

function simulateHit() {
  const ang = Math.random() * Math.PI * 2;
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
  series: null, repNo: 0,
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
    el.summary.hidden = true;
    beginRep();
  });
}

function stopDrill(msg) {
  cancelTimers();
  drill.state = 'idle';
  drill.series = null;
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
  updateStartButton();
  const repLabel = drill.series ? `Rep ${drill.repNo} of ${drill.series.total}` : '';
  show('waiting', 'Hold the bag still', '…', repLabel);
  const start = performance.now();
  const check = () => {
    const now = performance.now();
    const settled = !sensorLive() || (now - motion.lastAbove >= SETTLE_MS && now - start >= 300);
    if (!settled) { later(50, check); return; }
    if (settings.countdown > 0) countdown(settings.countdown, repLabel);
    else waitPhase(repLabel);
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
  drill.beepT = scheduleBeep();
  drill.state = 'armed';
  const now = performance.now();
  const soundAt = drill.beepT - settings.latency;
  later(soundAt - now, () => {
    if (drill.state !== 'armed') return;
    show(settings.flash ? 'armed flash' : 'armed', 'Kick!', 'GO', '');
    if (settings.flash) later(250, () => { if (drill.state === 'armed') el.display.classList.remove('flash'); });
  });
  later(drill.beepT + settings.timeout * 1000 - now, () => {
    if (drill.state === 'armed') finishRep({ kind: 'none' });
  });
}

function beginCapture(s) {
  drill.state = 'capture';
  drill.hitT = s.t;
  drill.peak = s;
  later(CAPTURE_MS, () => {
    const p = drill.peak;
    const angle = (Math.atan2(p.y, p.x) * 180 / Math.PI + 360) % 360;
    finishRep({
      kind: 'hit', ms: drill.hitT - drill.beepT,
      peakG: p.g, x: p.x, y: p.y, z: p.z, angle, sim: s.sim,
    });
  });
}

function falseStart() {
  finishRep({ kind: 'false' });
}

function finishRep(r) {
  cancelTimers();
  drill.state = 'result';
  r.rep = drill.repNo;
  r.mode = drill.series ? 'series' : 'single';
  r.when = new Date();
  addResult(r);

  if (r.kind === 'hit') {
    show('good', 'Reaction time', fmt(r.ms), `peak ${r.peakG.toFixed(1)} g · dir ${Math.round(r.angle)}°${r.sim ? ' · simulated' : ''}`);
  } else if (r.kind === 'false') {
    show('bad', 'Too early', 'FALSE START', 'Kicked before the beep');
  } else {
    show('bad', 'Timed out', 'NO KICK', `Nothing above ${settings.threshold.toFixed(1)} g in ${settings.timeout} s`);
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
      li.innerHTML = `<span class="t">${fmt(r.ms)}</span><span class="x">${r.peakG.toFixed(1)} g · ${Math.round(r.angle)}°${r.sim ? ' · sim' : ''}</span>`;
    } else {
      li.innerHTML = `<span class="bad">${r.kind === 'false' ? 'FALSE START' : 'NO KICK'}</span>`;
    }
    el.results.appendChild(li);
  });
  // list is newest first; number so the newest has the highest number
  el.results.setAttribute('reversed', '');
}

// Fastest and average over the hits only; false starts and no-kicks are left out.
function seriesStats(list) {
  const hits = list.filter((r) => r.kind === 'hit').map((r) => r.ms);
  return {
    hits: hits.length,
    fastest: hits.length ? fmt(Math.min(...hits)) : '—',
    average: hits.length ? fmt(hits.reduce((a, b) => a + b, 0) / hits.length) : '—',
  };
}

function showSummary(list) {
  const st = seriesStats(list);
  const falses = list.filter((r) => r.kind === 'false').length;
  const none = list.filter((r) => r.kind === 'none').length;
  const reps = list.map((r, i) =>
    `<li><span class="n">${i + 1}</span>${r.kind === 'hit' ? fmt(r.ms) : `<span class="bad">${r.kind === 'false' ? 'FALSE START' : 'NO KICK'}</span>`}</li>`
  ).join('');
  el.summary.innerHTML =
    `Series done: ${st.hits} of ${list.length} kicks counted` +
    (falses ? ` · ${falses} false start${falses > 1 ? 's' : ''}` : '') +
    (none ? ` · ${none} no kick` : '') +
    `<div class="nums"><div>Fastest<b>${st.fastest}</b></div><div>Average<b>${st.average}</b></div></div>` +
    `<ol class="reps">${reps}</ol>`;
  el.summary.hidden = false;
}

function showSeriesDisplay(list) {
  if (running()) return; // a new drill already started
  const st = seriesStats(list);
  show('good', `Series done · ${st.hits} of ${list.length} kicks`, '', '');
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
  const head = 'time,mode,rep,result,reaction_ms,peak_g,x,y,z,angle_deg,simulated';
  const rows = log.map((r) => [
    r.when.toISOString(), r.mode, r.rep, r.kind,
    r.kind === 'hit' ? r.ms.toFixed(1) : '',
    r.kind === 'hit' ? r.peakG.toFixed(2) : '',
    r.kind === 'hit' ? r.x.toFixed(2) : '',
    r.kind === 'hit' ? r.y.toFixed(2) : '',
    r.kind === 'hit' ? r.z.toFixed(2) : '',
    r.kind === 'hit' ? r.angle.toFixed(0) : '',
    r.kind === 'hit' ? (r.sim ? 1 : 0) : '',
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
}

// ---------- live meter + sensor badge ----------

let lastBadge = 0;

function frame(now) {
  const meterMax = Math.max(8, settings.threshold * 2);
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
  }
  requestAnimationFrame(frame);
}

// ---------- wiring ----------

el.start.addEventListener('click', onStartTap);
el.reset.addEventListener('click', resetAll);
el.sim.addEventListener('click', simulateHit);
el.peakReset.addEventListener('click', () => { motion.peak = 0; });
el.copyLog.addEventListener('click', copyLog);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); simulateHit(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running()) stopDrill('Stopped (app was hidden)');
  } else {
    keepAwake();
  }
});

$('version').textContent = VERSION;
bindSettings();
renderResults();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
