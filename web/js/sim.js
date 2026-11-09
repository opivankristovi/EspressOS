// JavaScript port of the firmware engine (Engine.cpp + Blocks.cpp), used for
// simulation in the browser and by the mock server. Same semantics:
// topological order, feedback loops see the previous cycle's value.
(function (root) {
  'use strict';

  const N_IN = { DI: 0, DO: 1, AI: 0, AO: 1, CONST: 0, VIN: 0, SENSOR: 0, AND: 4, OR: 4, XOR: 4, NAND: 4, NOR: 4,
    NOT: 1, SR: 2, EDGE: 1, TON: 1, TOF: 1, TP: 1, BLINK: 1, WEEK: 0, CTR: 3, CMP: 2, THRESH: 1, MATH: 2, SCALE: 1, SEL: 3 };
  const N_OUT = { DI: 1, DO: 0, AI: 1, AO: 0, CONST: 1, VIN: 1, SENSOR: 2, AND: 1, OR: 1, XOR: 1, NAND: 1, NOR: 1,
    NOT: 1, SR: 1, EDGE: 2, TON: 1, TOF: 1, TP: 1, BLINK: 1, WEEK: 1, CTR: 2, CMP: 1, THRESH: 1, MATH: 1, SCALE: 1, SEL: 1 };

  const ms = (s) => (s <= 0 ? 0 : Math.round(s * 1000));

  // Same pin rules as EspHal::pinProblem (lists live in catalog.js).
  const Cat = typeof module !== 'undefined' && module.exports ? require('./catalog.js') : root.Catalog;
  const PIN_USE = { DI: 'in', DO: 'out', AI: 'adc', AO: 'out' };
  function pinProblem(pin, use) {
    if (!Cat.IN_PINS.includes(pin)) return 'cannot be used (0, 1 and 3 are boot/serial pins, 6-11 belong to the flash chip)';
    if (use === 'out' && !Cat.OUT_PINS.includes(pin)) return 'is input-only';
    if (use === 'adc' && !Cat.ADC_PINS.includes(pin)) return 'has no usable ADC (use 32-36 or 39)';
    return null;
  }

  function makeEval(type, p) {
    const n = (k, d) => (p[k] === undefined || p[k] === '' ? d : Number(p[k]));
    const s = (k, d) => (p[k] === undefined ? d : String(p[k]));
    switch (type) {
      case 'DI': { const pin = n('pin', -1), pull = !!n('pull', 0), inv = !!n('inv', 0);
        return { begin(h) { h.setupInput(pin, pull); }, eval(c) { this.set(c, 0, (h(c).readDigital(pin) !== inv) ? 1 : 0); } }; }
      case 'DO': { const pin = n('pin', -1), inv = !!n('inv', 0);
        return { last: -1, begin(hh) { hh.setupOutput(pin, inv ? 1 : 0); this.last = inv ? 1 : 0; },
          eval(c) { const on = this.inb(c, 0), v = (on !== inv) ? 1 : 0; if (v !== this.last) { h(c).writeDigital(pin, v); this.last = v; } this.extra = on ? 1 : 0; } }; }
      case 'AI': { const pin = n('pin', -1), lo = n('min', 0), hi = n('max', 100);
        return { eval(c) { const raw = h(c).readAnalog(pin); this.set(c, 0, lo + raw / 4095 * (hi - lo)); this.extra = raw; } }; }
      case 'AO': { const pin = n('pin', -1), freq = n('freq', 1000);
        return { begin(hh) { hh.setupPwm(pin, freq); },
          eval(c) { const d = Math.min(100, Math.max(0, this.inp(c, 0))); h(c).writePwm(pin, d); this.extra = d; } }; }
      case 'CONST': { const v = n('value', 0); return { eval(c) { this.set(c, 0, v); } }; }
      case 'VIN': { const i = n('idx', 0); return { eval(c) { this.set(c, 0, h(c).readVirtual(i)); } }; }
      case 'SENSOR': { const dev = n('dev', 0), ch = n('ch', 0);
        return { eval(c) { const r = h(c).readSensor(dev, ch); if (r.ok) this.set(c, 0, r.v); this.set(c, 1, r.ok ? 1 : 0); } }; }
      case 'AND': case 'OR': case 'XOR': case 'NAND': case 'NOR':
        return { eval(c) {
          let cnt = 0, ones = 0;
          for (let i = 0; i < 4; i++) if (this.in[i] >= 0) { cnt++; if (this.inb(c, i)) ones++; }
          const r = { AND: cnt > 0 && ones === cnt, OR: ones > 0, XOR: (ones & 1) === 1, NAND: !(cnt > 0 && ones === cnt), NOR: ones === 0 }[type];
          this.set(c, 0, r ? 1 : 0);
        } };
      case 'NOT': return { eval(c) { this.set(c, 0, this.inb(c, 0) ? 0 : 1); } };
      case 'SR': { const setPrio = s('prio', 'R') === 'S';
        return { q: false, eval(c) { const S = this.inb(c, 0), R = this.inb(c, 1);
          if (S && R) this.q = setPrio; else if (S) this.q = true; else if (R) this.q = false; this.set(c, 0, this.q ? 1 : 0); } }; }
      case 'EDGE': return { prev: false, eval(c) { const v = this.inb(c, 0);
        this.set(c, 0, v && !this.prev ? 1 : 0); this.set(c, 1, !v && this.prev ? 1 : 0); this.prev = v; } };
      case 'TON': { const t = ms(n('t', 1));
        return { active: false, start: 0, eval(c) {
          if (!this.inb(c, 0)) { this.active = false; this.extra = 0; this.set(c, 0, 0); return; }
          if (!this.active) { this.active = true; this.start = c.now; }
          const el = c.now - this.start; this.extra = el / 1000; this.set(c, 0, el >= t ? 1 : 0); } }; }
      case 'TOF': { const t = ms(n('t', 1));
        return { q: false, timing: false, start: 0, eval(c) {
          if (this.inb(c, 0)) { this.q = true; this.timing = false; this.extra = 0; }
          else if (this.q) {
            if (!this.timing) { this.timing = true; this.start = c.now; }
            const el = c.now - this.start; this.extra = el / 1000;
            if (el >= t) { this.q = false; this.timing = false; this.extra = 0; }
          }
          this.set(c, 0, this.q ? 1 : 0); } }; }
      case 'TP': { const t = ms(n('t', 1));
        return { prev: false, q: false, start: 0, eval(c) {
          const v = this.inb(c, 0);
          if (v && !this.prev && !this.q) { this.q = true; this.start = c.now; }
          this.prev = v;
          if (this.q) { const el = c.now - this.start; this.extra = el / 1000; if (el >= t) { this.q = false; this.extra = 0; } }
          this.set(c, 0, this.q ? 1 : 0); } }; }
      case 'BLINK': { const tOn = ms(n('on', 0.5)), tOff = ms(n('off', 0.5));
        return { q: false, active: false, start: 0, eval(c) {
          if (!this.inb(c, 0, true)) { this.active = false; this.q = false; this.set(c, 0, 0); return; }
          if (!this.active) { this.active = true; this.q = true; this.start = c.now; }
          if (c.now - this.start >= (this.q ? tOn : tOff)) { this.q = !this.q; this.start = c.now; }
          this.set(c, 0, this.q ? 1 : 0); } }; }
      case 'WEEK': { const days = n('days', 127), on = n('on', 480), off = n('off', 1020);
        return { eval(c) {
          const t = h(c).timeOfDay(); if (!t) { this.set(c, 0, 0); return; }
          const { dow, m } = t; let q;
          if (on <= off) q = ((days >> dow) & 1) && m >= on && m < off;
          else { const prev = (dow + 6) % 7; q = (((days >> dow) & 1) && m >= on) || (((days >> prev) & 1) && m < off); }
          this.set(c, 0, q ? 1 : 0); } }; }
      case 'CTR': { const preset = n('preset', 10);
        return { cnt: 0, pu: false, pd: false, eval(c) {
          const u = this.inb(c, 0), d = this.inb(c, 1);
          if (this.inb(c, 2)) this.cnt = 0; else { if (u && !this.pu) this.cnt++; if (d && !this.pd) this.cnt--; }
          this.pu = u; this.pd = d;
          this.set(c, 0, this.cnt >= preset ? 1 : 0); this.set(c, 1, this.cnt); } }; }
      case 'CMP': { const op = s('op', '>'), b = n('b', 0);
        return { eval(c) { const x = this.inp(c, 0), y = this.inp(c, 1, b);
          const r = { '>': x > y, '>=': x >= y, '<': x < y, '<=': x <= y, '==': Math.abs(x - y) < 1e-6, '!=': Math.abs(x - y) >= 1e-6 }[op];
          this.set(c, 0, r ? 1 : 0); } }; }
      case 'THRESH': { const on = n('on', 25), off = n('off', 23);
        return { q: false, eval(c) { const x = this.inp(c, 0);
          if (on >= off) { if (x >= on) this.q = true; else if (x <= off) this.q = false; }
          else { if (x <= on) this.q = true; else if (x >= off) this.q = false; }
          this.set(c, 0, this.q ? 1 : 0); } }; }
      case 'MATH': { const op = s('op', '+'), b = n('b', 0);
        return { eval(c) { const x = this.inp(c, 0), y = this.inp(c, 1, b);
          const r = { '+': x + y, '-': x - y, '*': x * y, '/': y === 0 ? 0 : x / y, min: Math.min(x, y), max: Math.max(x, y) }[op];
          this.set(c, 0, r === undefined ? x + y : Math.fround(r)); } }; }
      case 'SCALE': { const i0 = n('inMin', 0), i1 = n('inMax', 4095), o0 = n('outMin', 0), o1 = n('outMax', 100), clamp = !!n('clamp', 1);
        return { eval(c) { const x = this.inp(c, 0); let r = i1 === i0 ? o0 : o0 + (x - i0) * (o1 - o0) / (i1 - i0);
          if (clamp) r = Math.min(Math.max(r, Math.min(o0, o1)), Math.max(o0, o1)); this.set(c, 0, r); } }; }
      case 'SEL': return { eval(c) { this.set(c, 0, this.inb(c, 2) ? this.inp(c, 1) : this.inp(c, 0)); } };
    }
    return null;
  }
  function h(c) { return c.hal; }

  const BlockProto = {
    inp(c, i, def = 0) { return this.in[i] < 0 ? def : c.sig[this.in[i]]; },
    inb(c, i, def = false) { return this.in[i] < 0 ? def : c.sig[this.in[i]] >= 0.5; },
    set(c, o, v) { if (this.out[o] >= 0) c.sig[this.out[o]] = v; },
  };

  class NullHal {
    setupInput() {} setupOutput(pin, level) {} readDigital() { return false; } writeDigital() {}
    readAnalog() { return 0; } setupPwm() {} writePwm() {}
    readSensor() { return { ok: false, v: 0 }; } timeOfDay() { return null; }
    readVirtual() { return 0; } safeOutputs() {}
  }

  class Engine {
    constructor(hal) { this.hal = hal || new NullHal(); this.clear(); }
    clear() { this.src = null; this.blocks = []; this.order = []; this.sig = new Float32Array(0); this.running = false; this.cycleMs = 10; this.cycles = 0; }

    // Returns null on success or an error string. Old program kept on error.
    load(prog) {
      if (typeof prog === 'string') { try { prog = JSON.parse(prog); } catch (e) { return 'JSON: ' + e.message; } }
      const blocks = [], byId = new Map(), pinOwner = new Map(); let nSig = 0;
      for (const o of prog.blocks || []) {
        if (!(o.type in N_IN)) return "Unknown block type '" + o.type + "'";
        if (!(o.id > 0) || byId.has(o.id)) return 'Invalid or duplicate block id ' + o.id;
        const use = PIN_USE[o.type];
        if (use) {
          const raw = o.p && o.p.pin, pin = raw === undefined || raw === '' || raw === null ? -1 : Number(raw);
          if (!(pin >= 0)) return 'Block ' + o.id + ' has no GPIO pin';
          const why = pinProblem(pin, use);
          if (why) return 'Block ' + o.id + ': GPIO ' + pin + ' ' + why;
          const prev = pinOwner.get(pin), drives = use === 'out';
          if (prev && (drives || prev.drives)) return 'GPIO ' + pin + ' is used by block ' + prev.id + ' and block ' + o.id;
          pinOwner.set(pin, { id: o.id, drives: drives || !!(prev && prev.drives) });
        }
        const b = makeEval(o.type, o.p || {});
        Object.setPrototypeOf(b, BlockProto);
        b.id = o.id; b.type = o.type; b.extra = 0; b.in = [-1, -1, -1, -1]; b.out = [-1, -1];
        for (let i = 0; i < N_OUT[o.type]; i++) b.out[i] = nSig++;
        byId.set(o.id, blocks.length); blocks.push(b);
      }
      const edges = blocks.map(() => []), indeg = blocks.map(() => 0);
      for (const w of prog.wires || []) {
        if (!Array.isArray(w) || w.length !== 4) return 'Wire must be [fromId,fromPort,toId,toPort]';
        const [fid, fp, tid, tp] = w;
        if (!byId.has(fid) || !byId.has(tid)) return 'Wire references missing block ' + fid + '/' + tid;
        const fi = byId.get(fid), ti = byId.get(tid);
        if (fp < 0 || fp >= N_OUT[blocks[fi].type]) return 'Block ' + fid + ' has no output ' + fp;
        if (tp < 0 || tp >= N_IN[blocks[ti].type]) return 'Block ' + tid + ' has no input ' + tp;
        if (blocks[ti].in[tp] >= 0) return 'Input ' + tp + ' of block ' + tid + ' has two wires';
        blocks[ti].in[tp] = blocks[fi].out[fp];
        edges[fi].push(ti); indeg[ti]++;
      }
      const order = [], done = blocks.map(() => false);
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = 0; i < blocks.length; i++) {
          if (done[i] || indeg[i] !== 0) continue;
          done[i] = true; progress = true; order.push(blocks[i]);
          for (const d of edges[i]) indeg[d]--;
        }
      }
      for (let i = 0; i < blocks.length; i++) if (!done[i]) order.push(blocks[i]);

      this.hal.safeOutputs();
      this.blocks = blocks; this.order = order; this.sig = new Float32Array(nSig);
      this.cycleMs = Math.min(1000, Math.max(1, prog.cycleMs || 10)); this.cycles = 0;
      for (const b of order) if (b.begin) b.begin(this.hal);
      this.src = JSON.stringify(prog);
      return null;
    }
    // Starting from stop rebuilds all blocks: outputs set up again, timers/counters/latches fresh.
    run() { if (this.running) return; if (this.src) this.load(this.src); this.running = true; }
    stop() { this.running = false; this.hal.safeOutputs(); }
    scan(now) {
      if (!this.running || !this.order.length) return;
      const c = { sig: this.sig, now, hal: this.hal };
      for (const b of this.order) b.eval(c);
      this.cycles++;
    }
    output(id, port) { const b = this.blocks.find((x) => x.id === id); return b && b.out[port] >= 0 ? this.sig[b.out[port]] : NaN; }
    snapshot() {
      const b = {};
      for (const x of this.blocks) {
        const v = [];
        for (let i = 0; i < 2 && x.out[i] >= 0; i++) v.push(this.sig[x.out[i]]);
        v.push(x.extra); b[x.id] = v;
      }
      return { run: this.running ? 1 : 0, cycle: this.cycles, b };
    }
  }

  const api = { Engine, NullHal, N_IN, N_OUT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(this);
