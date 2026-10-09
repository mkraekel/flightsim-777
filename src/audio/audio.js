// Synthesized sound (Team D2): WebAudio only, no sample files.
//  * engines (fan blade-pass tone, core whine, broadband rumble, buzz-saw at high N1), per engine, panned L/R
//  * wind (TAS), gear rolling rumble + centre-line light thumps, touchdown thump, gear-down airframe rumble
//  * hydraulic motor whine while gear/flaps travel, APU whine
//  * alerting: siren (config / overspeed / cabin alt), fire bell, A/P disconnect wailer, stick shaker,
//    master-caution / A/T-disc beeper, gear horn
//  * EGPWS / radio-altitude callouts with window.speechSynthesis
// Master volume: sim.audioVolume (0..1, default 0.8). Audio starts only after resumeAudio()
// is called from a user gesture (browser autoplay policy).
//
// Continuous alert sounds follow sim.alerts.aural flags (set by alerts.js); one-shot sounds and
// voice callouts come from sim.events 'aural' {id}.

import { KT, FPM, clamp } from '../core/geo.js';

const PHRASES = {
  pull_up: 'Pull up', terrain: 'Terrain, terrain', too_low_terrain: 'Too low, terrain', too_low_gear: 'Too low, gear',
  too_low_flaps: 'Too low, flaps', sink_rate: 'Sink rate', dont_sink: "Don't sink", bank_angle: 'Bank angle, bank angle',
  glideslope: 'Glide slope', minimums: 'Minimums', approaching_minimums: 'Approaching minimums',
  ra2500: 'Twenty five hundred', ra1000: 'One thousand', ra500: 'Five hundred', ra100: 'One hundred', ra50: 'Fifty',
  ra40: 'Forty', ra30: 'Thirty', ra20: 'Twenty', ra10: 'Ten', v1: 'Vee one', rotate: 'Rotate', positive_rate: 'Positive rate',
};
// sounds rendered continuously from sim.alerts.aural flags: ignore their one-shot events
const FLAG_DRIVEN = new Set(['master_warning', 'config', 'overspeed', 'ap_disc', 'stall']);

const A = {
  sim: null, ctx: null, master: null, nodes: null, noise: null, ready: false,
  lastStep: 0, suspendedByWatchdog: false, prevOnGround: true, prevVs: 0, prevGear: 1, prevFlaps: 0,
  nextThump: 0, nextBell: 0, speech: { queue: [], current: null, voice: null, endAt: 0 },
};

// ------------------------------------------------------------------ public
export function initAudio(sim) {
  A.sim = sim;
  if (sim.audioVolume === undefined) sim.audioVolume = 0.8;
  sim.events.on('aural', (e) => onAural(e));
  sim.events.on('pause', (e) => { if (A.ctx) (e && e.paused ? A.ctx.suspend() : A.ctx.resume()).catch(() => {}); });
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    const pick = () => { A.speech.voice = pickVoice(); };
    pick();
    window.speechSynthesis.addEventListener?.('voiceschanged', pick);
  }
}

/** Create/resume the AudioContext. Call from a click/keydown handler. */
export function resumeAudio() {
  if (typeof window === 'undefined') return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!A.ctx) {
    A.ctx = new AC();
    buildGraph();
    setInterval(watchdog, 250);
  }
  A.ctx.resume().catch(() => {});
}

/** Per-frame update of all continuous sounds. */
export function stepAudio(sim, dt) {
  A.sim = sim;
  if (!A.ready) return;
  try {
    A.lastStep = performance.now();
    if (A.suspendedByWatchdog) { A.suspendedByWatchdog = false; A.ctx.resume().catch(() => {}); }
    const t = A.ctx.currentTime;
    const vol = clamp(Number.isFinite(sim.audioVolume) ? sim.audioVolume : 0.8, 0, 1);
    A.master.gain.setTargetAtTime(vol * vol, t, 0.05);
    const ext = sim.view && sim.view.mode !== 'cockpit';
    updateEngines(sim, t, ext);
    updateAirframe(sim, t, ext, dt);
    updateAlertSounds(sim, t, ext);
    pumpSpeech();
  } catch (err) {
    if (!stepAudio._warned) { console.warn('stepAudio:', err); stepAudio._warned = true; }
  }
}

// ------------------------------------------------------------------- graph
function noiseBuffer(ctx, seconds = 2, brown = false) {
  const len = ctx.sampleRate * seconds, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}

function noiseSource(buf) {
  const s = A.ctx.createBufferSource();
  s.buffer = buf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random());
  return s;
}

function osc(type, freq) {
  const o = A.ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.start(); return o;
}
function gain(v = 0) { const g = A.ctx.createGain(); g.gain.value = v; return g; }
function filter(type, freq, Q = 0.7) { const f = A.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q; return f; }
const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };

function buildGraph() {
  const ctx = A.ctx;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  A.master = gain(0.6);
  chain(A.master, comp, ctx.destination);
  A.white = noiseBuffer(ctx, 2, false);
  A.brown = noiseBuffer(ctx, 3, true);
  // environment bus: engines/wind pass through a "cabin" low-pass in cockpit view
  const envFilter = filter('lowpass', 20000);
  const envBus = gain(1);
  chain(envBus, envFilter, A.master);
  const alertBus = gain(1);
  alertBus.connect(A.master);
  A.nodes = { envBus, envFilter, alertBus, engines: [0, 1].map((i) => buildEngine(envBus, i ? 0.55 : -0.55)) };
  buildAirframe(envBus);
  buildAlerts(alertBus);
  A.ready = true;
}

function buildEngine(bus, pan) {
  const p = A.ctx.createStereoPanner ? A.ctx.createStereoPanner() : gain(1);
  if (p.pan) p.pan.value = pan;
  p.connect(bus);
  const fan = osc('sawtooth', 300), fanBp = filter('bandpass', 300, 6), fanG = gain(0);
  chain(fan, fanBp, fanG, p);
  const fan2 = osc('sine', 600), fan2G = gain(0);
  chain(fan2, fan2G, p);
  const core = osc('sine', 2500), coreG = gain(0);
  chain(core, coreG, p);
  const rumble = noiseSource(A.brown), rumbleLp = filter('lowpass', 200, 0.5), rumbleG = gain(0);
  chain(rumble, rumbleLp, rumbleG, p);
  const roar = noiseSource(A.white), roarBp = filter('bandpass', 900, 0.6), roarG = gain(0);
  chain(roar, roarBp, roarG, p);
  const saw = osc('square', 40), sawLp = filter('lowpass', 1400, 1), sawG = gain(0);
  chain(saw, sawLp, sawG, p);
  return { fan, fanBp, fanG, fan2, fan2G, core, coreG, rumbleLp, rumbleG, roarBp, roarG, saw, sawG };
}

function buildAirframe(bus) {
  const n = A.nodes;
  n.wind = { src: noiseSource(A.white), bp: filter('bandpass', 500, 0.5), g: gain(0) };
  chain(n.wind.src, n.wind.bp, n.wind.g, bus);
  n.windLow = { src: noiseSource(A.brown), lp: filter('lowpass', 180), g: gain(0) };
  chain(n.windLow.src, n.windLow.lp, n.windLow.g, bus);
  n.roll = { src: noiseSource(A.brown), lp: filter('lowpass', 90, 1.5), g: gain(0) };
  chain(n.roll.src, n.roll.lp, n.roll.g, bus);
  n.hyd = { o: osc('sawtooth', 118), o2: osc('sawtooth', 237), bp: filter('bandpass', 420, 2), g: gain(0) };
  n.hyd.o.connect(n.hyd.bp); n.hyd.o2.connect(n.hyd.bp); chain(n.hyd.bp, n.hyd.g, bus);
  n.apu = { o: osc('sine', 1200), g: gain(0), r: noiseSource(A.white), bp: filter('bandpass', 2400, 3), rg: gain(0) };
  chain(n.apu.o, n.apu.g, bus); chain(n.apu.r, n.apu.bp, n.apu.rg, bus);
}

function buildAlerts(bus) {
  const n = A.nodes;
  // siren: warbling triangle (config, overspeed, cabin altitude)
  const siren = osc('triangle', 800), sLfo = osc('sine', 4.2), sDepth = gain(220), sG = gain(0);
  chain(sLfo, sDepth); sDepth.connect(siren.frequency); chain(siren, filter('lowpass', 3000), sG, bus);
  n.siren = sG;
  // A/P disconnect wailer: fast, wide warble with a slower swell
  const wail = osc('square', 1050), wLfo = osc('triangle', 7.5), wDepth = gain(420), wSw = osc('sine', 1.6), wSwD = gain(150);
  chain(wLfo, wDepth); wDepth.connect(wail.frequency); chain(wSw, wSwD); wSwD.connect(wail.frequency);
  const wG = gain(0); chain(wail, filter('lowpass', 2600, 0.8), wG, bus);
  n.wailer = wG;
  // stick shaker: low rattle with a hard 16 Hz amplitude modulation
  const sh = osc('square', 31), shN = noiseSource(A.brown), shLp = filter('lowpass', 160, 2), shAm = gain(0);
  const shLfo = osc('square', 16), shLfoG = gain(0.5);
  chain(shLfo, shLfoG); shLfoG.connect(shAm.gain);
  sh.connect(shLp); shN.connect(shLp); chain(shLp, shAm);
  const shG = gain(0); chain(shAm, shG, bus);
  n.shaker = shG;
  n.bus = bus;
}

// ------------------------------------------------------------ continuous
const set = (param, v, t, tc = 0.08) => param.setTargetAtTime(Number.isFinite(v) ? v : 0, t, tc);

function updateEngines(sim, t, ext) {
  A.nodes.envFilter.frequency.setTargetAtTime(ext ? 18000 : 2200, t, 0.2);
  sim.engines.forEach((e, i) => {
    const n = A.nodes.engines[i];
    const n1 = clamp(e.n1 || 0, 0, 115) / 100, n2 = clamp(e.n2 || 0, 0, 115) / 100;
    const k = ext ? 1.0 : 0.45;
    // GE90-115B fan: 22 blades, ~2355 rpm at 100 % N1 -> blade-pass ≈ 864 Hz
    const bpf = 864 * n1 + 1;
    set(n.fan.frequency, bpf, t, 0.05); set(n.fanBp.frequency, bpf, t, 0.05);
    set(n.fan2.frequency, bpf * 2, t, 0.05);
    set(n.fanG.gain, k * 0.09 * Math.pow(n1, 1.3), t);
    set(n.fan2G.gain, k * 0.015 * n1, t);
    // core (HP spool) whine, prominent during start and at idle
    set(n.core.frequency, 1800 + 2600 * n2, t, 0.1);
    set(n.coreG.gain, (ext ? 0.02 : 0.012) * clamp(n2 * 1.6, 0, 1) * (1 - 0.5 * n1), t);
    set(n.rumbleLp.frequency, 120 + 500 * n1, t);
    set(n.rumbleG.gain, (ext ? 0.6 : 0.25) * n1 * n1, t);
    set(n.roarBp.frequency, 500 + 1500 * n1, t);
    set(n.roarG.gain, (ext ? 0.22 : 0.06) * Math.pow(n1, 2.2), t);
    // buzz-saw (supersonic fan tips) above ~85 % N1, mostly audible outside
    set(n.saw.frequency, 39 * n1 * 1.0 + 1, t);
    set(n.sawG.gain, (ext ? 0.05 : 0.012) * clamp((n1 - 0.85) / 0.12, 0, 1), t);
  });
}

function updateAirframe(sim, t, ext, dt) {
  const n = A.nodes, ac = sim.ac, s = sim.surfaces;
  const tas = Math.max(0, ac.tas || 0) / KT;
  const w = clamp(tas / 280, 0, 1.4);
  set(n.wind.bp.frequency, 350 + tas * 3, t, 0.3);
  set(n.wind.g.gain, (ext ? 0.05 : 0.12) * w * w + (s.speedbrake || 0) * 0.03 * w, t, 0.3);
  set(n.windLow.g.gain, 0.25 * w * w + 0.15 * (s.gear || 0) * w * w, t, 0.3);
  // runway rolling
  const gs = Math.max(0, ac.gs || 0);
  set(n.roll.g.gain, ac.onGround ? clamp(gs / 40, 0, 1) * (ext ? 0.25 : 0.5) : 0, t, 0.15);
  set(n.roll.lp.frequency, 60 + gs * 2.5, t);
  if (ac.onGround && gs > 3 && A.ctx.currentTime > A.nextThump) {
    thump(0.08 + clamp(gs / 80, 0, 0.12), 70);                // centre-line lights / joints every ~15 m
    A.nextThump = A.ctx.currentTime + 15 / gs * (0.8 + Math.random() * 0.4);
  }
  // touchdown
  if (ac.onGround && !A.prevOnGround) {
    const vsFpm = Math.abs(A.prevVs) / FPM;
    thump(clamp(0.25 + vsFpm / 600, 0.25, 1.4), 55, 0.45);
  }
  A.prevOnGround = !!ac.onGround; A.prevVs = ac.vs || 0;
  // hydraulic motors while gear or flaps travel
  const gearMoving = Math.abs((s.gear || 0) - A.prevGear) > 1e-4;
  const flapMoving = Math.abs((s.flapsDeg || 0) - A.prevFlaps) > 1e-4;
  A.prevGear = s.gear || 0; A.prevFlaps = s.flapsDeg || 0;
  set(n.hyd.g.gain, (gearMoving ? 0.05 : 0) + (flapMoving ? 0.03 : 0), t, 0.25);
  // APU
  const apu = sim.systems && sim.systems.apu;
  const apuN = apu ? clamp(apu.n / 100, 0, 1) : 0;
  set(n.apu.o.frequency, 300 + 1100 * apuN, t, 0.3);
  set(n.apu.g.gain, apuN * (ext ? 0.025 : 0.006), t, 0.3);
  set(n.apu.rg.gain, apuN * (ext ? 0.05 : 0.01), t, 0.3);
}

function updateAlertSounds(sim, t, ext) {
  const n = A.nodes, a = (sim.alerts && sim.alerts.aural) || {};
  const k = ext ? 0.45 : 1;
  set(n.siren.gain, a.siren ? 0.12 * k : 0, t, 0.02);
  set(n.wailer.gain, a.wailer ? 0.1 * k : 0, t, 0.02);
  set(n.shaker.gain, a.shaker ? 0.55 : 0, t, 0.03);
  if (a.fireBell && A.ctx.currentTime > A.nextBell - 0.1) {
    // electric fire bell: ~11 strikes per second, scheduled slightly ahead
    let tt = Math.max(A.nextBell, A.ctx.currentTime);
    while (tt < A.ctx.currentTime + 0.25) { bellStrike(tt, 0.09 * k); tt += 0.09; }
    A.nextBell = tt;
  }
}

// --------------------------------------------------------------- one-shots
function envTone(type, freq, start, dur, peak, bus = A.nodes.bus, attack = 0.005) {
  const o = A.ctx.createOscillator(), g = A.ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(peak, start + attack);
  g.gain.setValueAtTime(peak, start + Math.max(attack, dur - 0.02));
  g.gain.linearRampToValueAtTime(0, start + dur);
  o.connect(g); g.connect(bus);
  o.start(start); o.stop(start + dur + 0.05);
}

function bellStrike(t0, v) {
  [[950, 1], [2620, 0.5], [5140, 0.25]].forEach(([f, a]) => {
    const o = A.ctx.createOscillator(), g = A.ctx.createGain();
    o.frequency.value = f; g.gain.setValueAtTime(v * a, t0); g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.12);
    o.connect(g); g.connect(A.nodes.bus); o.start(t0); o.stop(t0 + 0.14);
  });
}

function beeper(count = 4) {
  const t0 = A.ctx.currentTime + 0.01;
  for (let i = 0; i < count; i++) envTone('square', 1180, t0 + i * 0.16, 0.09, 0.05);
}

function chime() {
  const t0 = A.ctx.currentTime + 0.01;
  envTone('sine', 1320, t0, 0.5, 0.08, A.nodes.bus, 0.003);
  envTone('sine', 1047, t0 + 0.35, 0.7, 0.08, A.nodes.bus, 0.003);
}

function horn(dur = 1.5) {
  const t0 = A.ctx.currentTime + 0.01;
  envTone('sawtooth', 415, t0, dur, 0.04); envTone('sawtooth', 554, t0, dur, 0.03);
}

function thump(v, freq = 60, dur = 0.25) {
  const ctx = A.ctx, t0 = ctx.currentTime + 0.005;
  const src = ctx.createBufferSource(); src.buffer = A.brown;
  const lp = filter('lowpass', freq * 3, 0.8), g = gain(0);
  g.gain.setValueAtTime(v, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  chain(src, lp, g, A.master);
  src.start(t0, Math.random()); src.stop(t0 + dur + 0.05);
  const o = ctx.createOscillator(), og = gain(0);
  o.frequency.setValueAtTime(freq * 1.3, t0); o.frequency.exponentialRampToValueAtTime(freq * 0.5, t0 + dur);
  og.gain.setValueAtTime(v * 0.5, t0); og.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  chain(o, og, A.master); o.start(t0); o.stop(t0 + dur + 0.05);
}

function onAural(e) {
  if (!e || !e.id) return;
  if (PHRASES[e.id]) { say(e.id, e.priority || 0); return; }
  if (!A.ready || FLAG_DRIVEN.has(e.id)) return;
  if (e.id === 'master_caution' || e.id === 'at_disc') {
    // A/T disc and the master caution it latches arrive together: one beeper only
    if (A.ctx.currentTime - (A.lastBeep || -9) > 1.2) { A.lastBeep = A.ctx.currentTime; beeper(e.id === 'at_disc' ? 3 : 4); }
  }
  else if (e.id === 'gear_horn') horn();
  else if (e.id === 'chime') chime();
}

// ------------------------------------------------------------------ speech
function pickVoice() {
  const vs = (window.speechSynthesis.getVoices() || []).filter((v) => /^en[-_]US/i.test(v.lang));
  const male = /(David|Mark|Guy|Alex|Fred|Daniel|Male|Google US English|Aaron|Evan|Tom)/i;
  return vs.find((v) => male.test(v.name) && !/Female|Zira|Samantha/i.test(v.name)) || vs[0] || null;
}

function say(id, priority) {
  if (typeof window === 'undefined' || !window.speechSynthesis || !A.ctx) return;
  const sp = A.speech, now = performance.now();
  if (sp.current && now < sp.endAt && priority > sp.current.priority) {
    window.speechSynthesis.cancel(); sp.current = null; sp.queue = [];
  }
  sp.queue.push({ id, priority, at: now });
  sp.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
  if (sp.queue.length > 3) sp.queue.length = 3;
  pumpSpeech();
}

function pumpSpeech() {
  const sp = A.speech;
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const now = performance.now();
  if (sp.current && now < sp.endAt && window.speechSynthesis.speaking) return;
  sp.current = null;
  sp.queue = sp.queue.filter((q) => now - q.at < 1800);      // drop stale callouts
  const next = sp.queue.shift();
  if (!next) return;
  const u = new SpeechSynthesisUtterance(PHRASES[next.id]);
  if (sp.voice) u.voice = sp.voice;
  u.lang = 'en-US'; u.rate = 1.05; u.pitch = 0.85;
  const vol = A.sim && Number.isFinite(A.sim.audioVolume) ? A.sim.audioVolume : 0.8;
  u.volume = clamp(vol * 1.1, 0, 1);
  u.onend = () => { sp.endAt = 0; };
  sp.current = next; sp.endAt = now + 600 + PHRASES[next.id].length * 75;
  window.speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- watchdog
function watchdog() {
  if (!A.ctx || A.ctx.state !== 'running') return;
  // main loop stopped calling stepAudio (pause / menu / hidden tab): silence
  if (A.lastStep && performance.now() - A.lastStep > 400) { A.suspendedByWatchdog = true; A.ctx.suspend().catch(() => {}); }
}

/** Debug/test helper. */
export function audioState() { return { ready: A.ready, state: A.ctx ? A.ctx.state : 'none' }; }
