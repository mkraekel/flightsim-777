// 777 overhead panel UI (Team D2), rendered inside #drawer-overhead.
// Boeing-style square push buttons with backlit legends (white ON/OFF, amber FAULT/PRESS),
// rotary selectors and bat-handle toggles. Clicks write sim.systems / sim.controls; the
// lights are refreshed from state in updateOverhead(sim) (cheap: class toggles on change only).
// The widget factory (pushButton/knob/toggle/lamp/lcd) is exported for the pedestal.

const SIDES = ['L', 'R'];

// ------------------------------------------------------------- DOM helpers
export function h(tag, cls, ...kids) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

/** Registry of widgets that need refreshing; each has update(sim). */
export function createRegistry(sim) {
  const list = [];
  return {
    sim, list,
    add(w) { list.push(w); return w.el; },
    update() { const pw = powered(sim); for (const w of list) w.update(sim, pw); },
  };
}

/** Panel lighting / annunciators need DC power (battery bus at least). */
export function powered(sim) {
  const e = sim.systems && sim.systems.elec;
  return !e || e.dcPowered !== false;
}

const toast = (sim, text) => sim.events.emit('toast', { text });

/**
 * Boeing push button with two legend lights.
 * cfg: { label, sub, top:{text, color:'white'|'amber'|'green', on:(sim)=>bool}, bot:{...}, click:(sim)=>void, guard }
 */
export function pushButton(reg, cfg) {
  const legend = (l) => h('span', `ow-pb-leg ow-pb-${l.color || 'white'}`, l.text);
  const top = cfg.top ? legend(cfg.top) : h('span', 'ow-pb-leg ow-pb-blank');
  const bot = cfg.bot ? legend(cfg.bot) : h('span', 'ow-pb-leg ow-pb-blank');
  const btn = h('button', 'ow-pb' + (cfg.wide ? ' ow-pb-wide' : ''), h('span', 'ow-pb-face', top, bot));
  btn.type = 'button';
  btn.title = cfg.title || cfg.label || '';
  btn.setAttribute('aria-label', (cfg.label || '') + ' ' + (cfg.sub || ''));
  btn.addEventListener('click', (e) => { e.stopPropagation(); cfg.click && cfg.click(reg.sim); reg.update(); });
  const el = h('div', 'ow-ctl ow-ctl-pb', cfg.over ? h('div', 'ow-ctl-over', cfg.over) : null, btn, h('div', 'ow-ctl-label', cfg.label || ''), cfg.sub ? h('div', 'ow-ctl-sub', cfg.sub) : null);
  let last = '';
  reg.add({ el, update(sim, pw) {
    const a = !!(pw && cfg.top && cfg.top.on(sim)), b = !!(pw && cfg.bot && cfg.bot.on(sim));
    const pressed = cfg.pressed ? !!cfg.pressed(sim) : false;
    const key = `${a}${b}${pressed}`;
    if (key === last) return; last = key;
    top.classList.toggle('lit', a); bot.classList.toggle('lit', b);
    btn.classList.toggle('ow-pb-in', pressed);
    btn.setAttribute('aria-pressed', String(pressed));
  } });
  return el;
}

/**
 * Rotary selector. cfg: { label, positions:[{v,label}], get(sim), set(sim,v), angles?, momentary?:{from,to} }
 * Click on the right half / wheel down = clockwise, left half / wheel up = counter-clockwise.
 */
export function knob(reg, cfg) {
  const n = cfg.positions.length;
  const span = cfg.span || (n === 2 ? 70 : n === 3 ? 100 : 240);
  const angles = cfg.angles || cfg.positions.map((_, i) => (n === 1 ? 0 : -span / 2 + (span * i) / (n - 1)));
  const dial = h('div', 'ow-knob-dial');
  const cap = h('div', 'ow-knob-cap', h('div', 'ow-knob-ptr'));
  const wrap = h('div', 'ow-knob-wrap' + (cfg.small ? ' ow-knob-small' : ''), dial, cap);
  const r = cfg.radius || (cfg.small ? 28 : 34);
  if (cfg.size) { wrap.style.width = cfg.size[0] + 'px'; wrap.style.height = cfg.size[1] + 'px'; }
  cfg.positions.forEach((p, i) => {
    const a = angles[i] * Math.PI / 180;
    const lab = h('span', 'ow-knob-pos', p.label);
    lab.style.left = `calc(50% + ${Math.sin(a) * r}px)`;
    lab.style.top = `calc(50% - ${Math.cos(a) * r}px)`;
    dial.append(lab);
  });
  const step = (d) => {
    const cur = cfg.positions.findIndex((p) => p.v === cfg.get(reg.sim));
    const i = Math.max(0, Math.min(n - 1, (cur < 0 ? 0 : cur) + d));
    if (i !== cur) { cfg.set(reg.sim, cfg.positions[i].v); reg.update(); }
  };
  wrap.addEventListener('click', (e) => {
    const rc = cap.getBoundingClientRect();
    step(e.clientX >= rc.left + rc.width / 2 ? 1 : -1);
  });
  wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); step(-1); });
  wrap.addEventListener('wheel', (e) => { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'slider');
  wrap.setAttribute('aria-label', cfg.label);
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { step(1); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { step(-1); e.preventDefault(); e.stopPropagation(); }
  });
  const lights = (cfg.lights || []).map((l) => ({ ...l, el: h('span', `ow-pb-leg mini ow-pb-${l.color || 'amber'}`, l.text) }));
  const el = h('div', 'ow-ctl ow-ctl-knob', cfg.over ? h('div', 'ow-ctl-over', cfg.over) : null,
    lights.length ? h('div', 'ow-knob-lights', lights.map((l) => l.el)) : null,
    wrap, h('div', 'ow-ctl-label', cfg.label), cfg.sub ? h('div', 'ow-ctl-sub', cfg.sub) : null);
  let last = null;
  reg.add({ el, update(sim, pw) {
    const v = cfg.get(sim);
    const i = cfg.positions.findIndex((p) => p.v === v);
    const lk = lights.map((l) => (pw && l.on(sim) ? 1 : 0)).join('');
    const key = i + '|' + lk;
    if (key === last) return; last = key;
    cap.style.transform = `rotate(${angles[Math.max(0, i)]}deg)`;
    dial.querySelectorAll('.ow-knob-pos').forEach((p, j) => p.classList.toggle('sel', j === i));
    wrap.setAttribute('aria-valuetext', cfg.positions[Math.max(0, i)].label);
    lights.forEach((l, j) => l.el.classList.toggle('lit', lk[j] === '1'));
  } });
  return el;
}

/** Bat-handle toggle switch. cfg: { label, get(sim)->bool, set(sim,bool), up:'ON', down:'OFF' } */
export function toggle(reg, cfg) {
  const lever = h('div', 'ow-tg-lever');
  const sw = h('button', 'ow-tg', h('span', 'ow-tg-pos ow-tg-up', cfg.up || 'ON'), h('span', 'ow-tg-base', lever), h('span', 'ow-tg-pos ow-tg-dn', cfg.down || 'OFF'));
  sw.type = 'button';
  sw.setAttribute('aria-label', cfg.label);
  sw.addEventListener('click', (e) => { e.stopPropagation(); cfg.set(reg.sim, !cfg.get(reg.sim)); reg.update(); });
  const el = h('div', 'ow-ctl ow-ctl-tg', sw, h('div', 'ow-ctl-label', cfg.label));
  let last = null;
  reg.add({ el, update(sim) {
    const v = !!cfg.get(sim);
    if (v === last) return; last = v;
    sw.classList.toggle('on', v);
    sw.setAttribute('aria-pressed', String(v));
  } });
  return el;
}

/** Stand-alone annunciator light. cfg: { text, color, on(sim) } */
export function lamp(reg, cfg) {
  const el = h('span', `ow-lamp ow-pb-${cfg.color || 'amber'}`, cfg.text);
  let last = null;
  reg.add({ el, update(sim, pw) {
    const v = !!(pw && cfg.on(sim));
    if (v === last) return; last = v;
    el.classList.toggle('lit', v);
  } });
  return el;
}

/** Small LCD-style readout. cfg: { label, value(sim)->string } */
export function lcd(reg, cfg) {
  const val = h('span', 'ow-lcd-val', '');
  const el = h('div', 'ow-lcd', h('span', 'ow-lcd-lab', cfg.label), val);
  let last = null;
  reg.add({ el, update(sim, pw) {
    const v = pw ? cfg.value(sim) : '';
    if (v === last) return; last = v;
    val.textContent = v;
  } });
  return el;
}

export const section = (title, ...kids) => h('section', 'ohp-sec', h('h3', 'ohp-title', h('span', '', title)), h('div', 'ohp-body', ...kids));
const row = (...kids) => h('div', 'ohp-row', ...kids);
const group = (title, ...kids) => h('div', 'ohp-group', title ? h('div', 'ohp-gtitle', title) : null, h('div', 'ohp-row', ...kids));

// ------------------------------------------------------------ panel content
const S = (sim) => sim.systems;
const engRun = (sim, i) => sim.engines[i] && sim.engines[i].startState === 'RUN' && sim.engines[i].n2 > 50;
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '--');

function adiruSection(reg) {
  return section('ADIRU · FLIGHT CONTROLS',
    row(
      pushButton(reg, { label: 'ADIRU', top: { text: 'ON BAT', color: 'amber', on: (s) => S(s).adiru.onBat },
        bot: { text: 'OFF', on: (s) => !S(s).adiru.on }, pressed: (s) => S(s).adiru.on,
        click: (s) => { S(s).adiru.on = !S(s).adiru.on; } }),
      h('div', 'ohp-stack', lamp(reg, { text: 'ALIGN', color: 'white', on: (s) => S(s).adiru.on && !S(s).adiru.aligned }),
        lcd(reg, { label: 'ALIGN', value: (s) => (S(s).adiru.aligned ? 'NAV' : S(s).adiru.on ? `${Math.ceil(S(s).adiru.alignRemaining / 60)} MIN` : 'OFF') })),
      pushButton(reg, { label: 'PRIMARY FLT', sub: 'COMPUTERS', top: { text: 'DISC', color: 'amber', on: (s) => S(s).flightCtl.pfcDisc },
        click: (s) => { S(s).flightCtl.pfcDisc = !S(s).flightCtl.pfcDisc; if (s.fbw) s.fbw.mode = S(s).flightCtl.pfcDisc ? 'DIRECT' : 'NORMAL'; } }),
      pushButton(reg, { label: 'THRUST ASYM', sub: 'COMP', top: { text: 'DISC', color: 'amber', on: (s) => !S(s).flightCtl.tac },
        bot: { text: 'OFF', on: (s) => !S(s).flightCtl.tac },
        click: (s) => { S(s).flightCtl.tac = !S(s).flightCtl.tac; if (s.fbw && s.fbw.prot) s.fbw.prot.tac = S(s).flightCtl.tac; } }),
    ));
}

function elecSection(reg) {
  const e = (s) => S(s).elec;
  return section('ELECTRICAL',
    row(
      pushButton(reg, { label: 'BATTERY', bot: { text: 'OFF', on: (s) => !e(s).battery }, pressed: (s) => e(s).battery,
        click: (s) => { e(s).battery = !e(s).battery; } }),
      pushButton(reg, { label: 'APU GEN', top: { text: 'FAULT', color: 'amber', on: () => false }, bot: { text: 'OFF', on: (s) => !e(s).apuGenSw },
        pressed: (s) => e(s).apuGenSw, click: (s) => { e(s).apuGenSw = !e(s).apuGenSw; } }),
      pushButton(reg, { label: 'EXT PWR', sub: 'PRIMARY', top: { text: 'AVAIL', on: (s) => e(s).extPwrAvail && !e(s).extPwrOn },
        bot: { text: 'ON', on: (s) => e(s).extOnline }, pressed: (s) => e(s).extPwrOn,
        click: (s) => { if (!e(s).extPwrAvail) { toast(s, 'External power not available'); return; } e(s).extPwrOn = !e(s).extPwrOn; } }),
    ),
    row(...[0, 1].map((i) => pushButton(reg, { label: `BUS TIE ${SIDES[i]}`, top: { text: 'AUTO', on: () => false },
      bot: { text: 'ISLN', color: 'amber', on: (s) => !e(s).acBus[i] && (e(s).idgOnline[1 - i] || e(s).apuGenOnline || e(s).extOnline) || !e(s).busTie[i] },
      pressed: (s) => e(s).busTie[i], click: (s) => { e(s).busTie[i] = !e(s).busTie[i]; } }))),
    row(...[0, 1].flatMap((i) => [
      pushButton(reg, { label: `GEN CTRL ${SIDES[i]}`, top: { text: 'FAULT', color: 'amber', on: () => false },
        bot: { text: 'OFF', on: (s) => !e(s).genCtrl[i] || !e(s).idgOnline[i] }, pressed: (s) => e(s).genCtrl[i],
        click: (s) => { e(s).genCtrl[i] = !e(s).genCtrl[i]; } }),
      pushButton(reg, { label: `DRIVE ${SIDES[i]}`, top: { text: 'DRIVE', color: 'amber', on: (s) => !engRun(s, i) || e(s).driveDisc[i] },
        click: (s) => { if (e(s).driveDisc[i]) { toast(s, 'IDG disconnected: reset on the ground only'); return; } toast(s, 'DRIVE DISC is guarded: not used in this sim'); } }),
    ])),
  );
}

function hydSection(reg) {
  const p = (s) => S(s).hyd.pumps, r = (s) => S(s).hyd.run;
  const prim = (key, label, sub) => pushButton(reg, { label, sub, top: { text: 'FAULT', color: 'amber', on: (s) => p(s)[key] && !r(s)[key] },
    bot: { text: 'OFF', on: (s) => !p(s)[key] }, pressed: (s) => p(s)[key], click: (s) => { p(s)[key] = !p(s)[key]; } });
  const dem = (key, label) => knob(reg, { label, small: true, positions: [{ v: 'OFF', label: 'OFF' }, { v: 'AUTO', label: 'AUTO' }, { v: 'ON', label: 'ON' }],
    get: (s) => p(s)[key], set: (s, v) => { p(s)[key] = v; },
    lights: [{ text: 'FAULT', color: 'amber', on: (s) => p(s)[key] === 'ON' && !r(s)[key] }] });
  return section('HYDRAULIC',
    group('PRIMARY', prim('engL', 'L ENG'), prim('elecC1', 'C1 ELEC'), prim('elecC2', 'C2 ELEC'), prim('engR', 'R ENG')),
    group('DEMAND', dem('demL', 'L'), dem('demC1', 'C1 AIR'), dem('demC2', 'C2 AIR'), dem('demR', 'R')),
  );
}

function apuStartSection(reg) {
  const apu = (s) => S(s).apu;
  const startKnob = (i) => knob(reg, { label: `START ${SIDES[i]}`, small: true,
    positions: [{ v: false, label: 'NORM' }, { v: true, label: 'START' }],
    get: (s) => !!s.controls.engStart[i],
    set: (s, v) => {
      s.controls.engStart[i] = v;
      if (v && S(s).air.ductPsi < 20) toast(s, `ENG ${SIDES[i]} START: no duct pressure — start the APU (APU BLEED on)`);
      else if (v) toast(s, `ENG ${SIDES[i]} start: fuel control switch to RUN`);
    },
    lights: [{ text: 'VALVE', color: 'white', on: (s) => s.engines[i].startState === 'STARTING' }] });
  return section('APU · ENGINE START',
    row(
      knob(reg, { label: 'APU', positions: [{ v: 'OFF', label: 'OFF' }, { v: 'ON', label: 'ON' }, { v: 'START', label: 'START' }],
        get: (s) => apu(s).selector, set: (s, v) => {
          apu(s).selector = v;
          if (v === 'START' && !S(s).elec.dcPowered) toast(s, 'APU: battery switch ON first');
        },
        lights: [{ text: 'FAULT', color: 'amber', on: (s) => apu(s).fault }, { text: 'RUN', color: 'white', on: (s) => apu(s).state === 'RUN' }] }),
      h('div', 'ohp-stack',
        lcd(reg, { label: 'APU N', value: (s) => `${fmt(apu(s).n)}%` }),
        lcd(reg, { label: 'APU EGT', value: (s) => fmt(apu(s).egt) })),
    ),
    h('div', 'ohp-row ohp-nowrap', startKnob(0),
      pushButton(reg, { label: 'AUTOSTART', bot: { text: 'OFF', on: (s) => !S(s).start.autostart }, pressed: (s) => S(s).start.autostart,
        click: (s) => { S(s).start.autostart = !S(s).start.autostart; } }),
      pushButton(reg, { label: 'CON', sub: 'IGNITION', top: { text: 'ON', on: (s) => S(s).start.conIgn }, pressed: (s) => S(s).start.conIgn,
        click: (s) => { S(s).start.conIgn = !S(s).start.conIgn; } }),
      startKnob(1)),
  );
}

function fuelSection(reg) {
  const p = (s) => S(s).fuel.pumps;
  const tank = (s, k) => s.ac.fuelKg && s.ac.fuelKg[k] > 1;
  const pump = (key, label, tk) => pushButton(reg, { label, top: { text: 'PRESS', color: 'amber', on: (s) => !p(s)[key] || !tank(s, tk) || !S(s).elec.acPowered },
    bot: { text: 'OFF', on: (s) => !p(s)[key] }, pressed: (s) => p(s)[key], click: (s) => { p(s)[key] = !p(s)[key]; } });
  const xf = (key, label) => pushButton(reg, { label, top: { text: 'VALVE', color: 'amber', on: (s) => (S(s).fuel._xt && S(s).fuel._xt[key] > s.time) },
    pressed: (s) => S(s).fuel[key], click: (s) => {
      const f = S(s).fuel; f[key] = !f[key]; f._xt = f._xt || {}; f._xt[key] = s.time + 2;
    } });
  const qty = (k) => lcd(reg, { label: k === 'C' ? 'CTR' : k, value: (s) => fmt((s.ac.fuelKg[k] || 0) / 1000, 1) });
  return section('FUEL',
    row(pump('lFwd', 'L FWD', 'L'), xf('xfeedFwd', 'X FEED FWD'), pump('rFwd', 'R FWD', 'R')),
    row(pump('lAft', 'L AFT', 'L'), xf('xfeedAft', 'X FEED AFT'), pump('rAft', 'R AFT', 'R')),
    row(pump('cL', 'CTR L', 'C'), pump('cR', 'CTR R', 'C')),
    h('div', 'ohp-qty', h('div', 'ohp-gtitle', 'FUEL QTY ×1000 KG'), h('div', 'ohp-row tight', qty('L'), qty('C'), qty('R'))),
  );
}

function antiIceSection(reg) {
  const ai = (s) => S(s).antiIce;
  const pos = [{ v: 'OFF', label: 'OFF' }, { v: 'AUTO', label: 'AUTO' }, { v: 'ON', label: 'ON' }];
  return section('ANTI-ICE',
    row(
      knob(reg, { label: 'ENGINE L', small: true, positions: pos, get: (s) => ai(s).eng[0], set: (s, v) => { ai(s).eng[0] = v; },
        lights: [{ text: 'VALVE', color: 'white', on: (s) => ai(s).engOn[0] }] }),
      knob(reg, { label: 'WING', small: true, positions: pos, get: (s) => ai(s).wing, set: (s, v) => { ai(s).wing = v; },
        lights: [{ text: 'VALVE', color: 'white', on: (s) => ai(s).wingOn }] }),
      knob(reg, { label: 'ENGINE R', small: true, positions: pos, get: (s) => ai(s).eng[1], set: (s, v) => { ai(s).eng[1] = v; },
        lights: [{ text: 'VALVE', color: 'white', on: (s) => ai(s).engOn[1] }] }),
    ),
    row(
      pushButton(reg, { label: 'WINDOW HEAT', top: { text: 'INOP', color: 'amber', on: () => false }, bot: { text: 'OFF', on: (s) => !S(s).windowHeat },
        pressed: (s) => S(s).windowHeat, click: (s) => { S(s).windowHeat = !S(s).windowHeat; } }),
      pushButton(reg, { label: 'PROBE HEAT', bot: { text: 'OFF', on: (s) => !S(s).probeHeat }, pressed: (s) => S(s).probeHeat,
        click: (s) => { S(s).probeHeat = !S(s).probeHeat; } }),
    ));
}

function airSection(reg) {
  const a = (s) => S(s).air;
  return section('AIR CONDITIONING · BLEED',
    row(
      ...[0, 1].map((i) => pushButton(reg, { label: `PACK ${SIDES[i]}`, top: { text: 'FAULT', color: 'amber', on: (s) => a(s).packs[i] !== 'OFF' && !a(s).packOn[i] && (s.engines.some((e) => e.startState === 'RUN') || S(s).apu.state === 'RUN') && !s.engines.some((e) => e.startState === 'STARTING') },
        bot: { text: 'OFF', on: (s) => a(s).packs[i] === 'OFF' }, pressed: (s) => a(s).packs[i] !== 'OFF',
        click: (s) => { a(s).packs[i] = a(s).packs[i] === 'OFF' ? 'AUTO' : 'OFF'; } })),
      pushButton(reg, { label: 'TRIM AIR', bot: { text: 'OFF', on: (s) => !a(s).trimAir }, pressed: (s) => a(s).trimAir, click: (s) => { a(s).trimAir = !a(s).trimAir; } }),
      pushButton(reg, { label: 'RECIRC FANS', bot: { text: 'OFF', on: (s) => !a(s).recirc }, pressed: (s) => a(s).recirc, click: (s) => { a(s).recirc = !a(s).recirc; } }),
    ),
    row(
      pushButton(reg, { label: 'ENG BLEED L', top: { text: 'FAULT', color: 'amber', on: () => false }, bot: { text: 'OFF', on: (s) => !a(s).engBleed[0] },
        pressed: (s) => a(s).engBleed[0], click: (s) => { a(s).engBleed[0] = !a(s).engBleed[0]; } }),
      pushButton(reg, { label: 'APU BLEED', top: { text: 'VALVE', color: 'white', on: (s) => a(s).ductSrc === 'APU' }, bot: { text: 'OFF', on: (s) => !a(s).apuBleed },
        pressed: (s) => a(s).apuBleed, click: (s) => { a(s).apuBleed = !a(s).apuBleed; } }),
      pushButton(reg, { label: 'ENG BLEED R', top: { text: 'FAULT', color: 'amber', on: () => false }, bot: { text: 'OFF', on: (s) => !a(s).engBleed[1] },
        pressed: (s) => a(s).engBleed[1], click: (s) => { a(s).engBleed[1] = !a(s).engBleed[1]; } }),
      lcd(reg, { label: 'DUCT PSI', value: (s) => fmt(a(s).ductPsi) }),
    ));
}

function pressSection(reg) {
  const pr = (s) => S(s).press;
  return section('PRESSURIZATION',
    row(
      h('div', 'ohp-stack',
        lcd(reg, { label: 'CABIN ALT', value: (s) => fmt(Math.round(pr(s).cabinAltFt / 10) * 10) }),
        lcd(reg, { label: 'RATE', value: (s) => fmt(Math.round(pr(s).cabinRateFpm / 50) * 50) }),
        lcd(reg, { label: 'Δ P', value: (s) => fmt(pr(s).diffPsi, 1) }),
        lcd(reg, { label: 'LDG ALT', value: (s) => fmt(pr(s).landingAltFt) })),
      pushButton(reg, { label: 'OUTFLOW', sub: 'VALVE FWD', top: { text: 'MAN', color: 'white', on: () => false }, pressed: () => true,
        click: (s) => toast(s, 'Outflow valves: AUTO (manual control not simulated)') }),
      pushButton(reg, { label: 'OUTFLOW', sub: 'VALVE AFT', top: { text: 'MAN', color: 'white', on: () => false }, pressed: () => true,
        click: (s) => toast(s, 'Outflow valves: AUTO (manual control not simulated)') }),
    ));
}

function lightsSection(reg) {
  const L = (s) => S(s).lights;
  const t = (key, label) => toggle(reg, { label, get: (s) => L(s)[key], set: (s, v) => { L(s)[key] = v; } });
  const sg = (s) => S(s).signs;
  const sign = [{ v: 'OFF', label: 'OFF' }, { v: 'AUTO', label: 'AUTO' }, { v: 'ON', label: 'ON' }];
  return section('LIGHTS · PASSENGER SIGNS',
    row(
      group('LANDING', t('landingL', 'L'), t('landingN', 'NOSE'), t('landingR', 'R')),
      group('RWY TURNOFF', t('turnoffL', 'L'), t('turnoffR', 'R')),
      group('', t('taxi', 'TAXI'), t('strobe', 'STROBE'), t('beacon', 'BEACON'), t('nav', 'NAV'), t('logo', 'LOGO'), t('wing', 'WING'), t('storm', 'STORM'), t('dome', 'DOME')),
      group('PASS SIGNS',
        knob(reg, { label: 'NO SMOKING', small: true, positions: sign, get: (s) => sg(s).noSmoking, set: (s, v) => { sg(s).noSmoking = v; } }),
        knob(reg, { label: 'SEATBELTS', small: true, positions: sign, get: (s) => sg(s).seatbelts, set: (s, v) => { sg(s).seatbelts = v; } })),
      group('EMER LIGHTS', pushButton(reg, { label: 'EMER', sub: 'LIGHTS', top: { text: 'UNARMED', color: 'amber', on: (s) => sg(s).emerLights !== 'ARMED' },
        pressed: (s) => sg(s).emerLights === 'ARMED', click: (s) => { sg(s).emerLights = sg(s).emerLights === 'ARMED' ? 'OFF' : 'ARMED'; } })),
    ));
}

/** Non-panel status strip (helps cold & dark starts; not part of the real overhead). */
function statusStrip(reg) {
  const val = h('span', 'ohp-status-val', '');
  const el = h('div', 'ohp-status', h('span', 'ohp-status-lab', 'SYS'), val);
  let last = '';
  reg.add({ el, update(sim) {
    const s = S(sim);
    const txt = `ELEC ${s.elec.sources.join('+') || 'NONE'} · APU ${s.apu.state} ${fmt(s.apu.n)}% · DUCT ${fmt(s.air.ductPsi)} PSI · HYD ${['L', 'C', 'R'].map((k) => fmt(s.hyd.press[k])).join('/')} · ENG ${sim.engines.map((e) => `${e.startState} ${fmt(e.n2)}%`).join(' | ')}`;
    if (txt !== last) { val.textContent = txt; last = txt; }
  } });
  return el;
}

// --------------------------------------------------------------- public API
let REG = null, HOST = null;

/** Build the overhead panel inside `el` (#drawer-overhead). */
export function initOverhead(sim, el) {
  if (!el) return;
  if (!sim.systems || !sim.systems.elec) return console.warn('initOverhead: call initSystems first');
  REG = createRegistry(sim);
  HOST = el;
  el.classList.add('ohp-host');
  el.replaceChildren();
  const root = h('div', 'ohp',
    h('div', 'ohp-head', h('span', 'ohp-head-title', 'OVERHEAD PANEL'), statusStrip(REG)),
    h('div', 'ohp-grid',
      h('div', 'ohp-col', adiruSection(REG), elecSection(REG)),
      h('div', 'ohp-col', hydSection(REG), apuStartSection(REG)),
      h('div', 'ohp-col', fuelSection(REG), antiIceSection(REG)),
      h('div', 'ohp-col', airSection(REG), pressSection(REG)),
      h('div', 'ohp-col ohp-wide', lightsSection(REG)),
    ));
  el.append(root);
  REG.update();
}

/** Refresh lights/positions from state (call once per frame; cheap when nothing changed). */
export function updateOverhead(sim) {
  if (!REG) return;
  // drawers are toggled with the 'open' class (input.js); skip work while hidden
  if (HOST && HOST.id === 'drawer-overhead' && !HOST.classList.contains('open')) return;
  REG.sim = sim;
  REG.update();
}
