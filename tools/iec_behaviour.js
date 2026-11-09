#!/usr/bin/env node
// Checks that a program behaves the same in OpenPLC as in EspressOS.
//
//   node tools/iec_behaviour.js prepare <program.json> <dir>
//       Writes <dir>/harness.c (drives the matiec-generated C code), <dir>/stim.txt
//       (random inputs, one line per scan cycle) and <dir>/expected.txt (the outputs
//       EspressOS's engine produces for those inputs).
//   node tools/iec_behaviour.js compare <dir>
//       Compares <dir>/actual.txt (the harness's output) with expected.txt.
//
// The C side is compiled with the iec2c output for the same program, see
// .github/workflows/iec.yml. Inputs: digital and analog inputs, web controls,
// sensor values and the clock. Outputs: digital output pin levels and PWM values.
const fs = require('fs');
const path = require('path');
const P = require('../web/js/plcopen.js');
const { Engine, NullHal } = require('../web/js/sim.js');

const CYCLES = 3000;
const AO_TOLERANCE = 2;  // counts of 0..65535: REAL rounding differs slightly between JS and C

// Deterministic pseudo-random numbers (mulberry32), so failures can be reproduced.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cName = (name) => name.toUpperCase();
const located = (address) => '__' + address.slice(1).replace('.', '_');  // %IX0.1 -> __IX0_1

function prepare(progFile, dir) {
  const prog = JSON.parse(fs.readFileSync(progFile, 'utf8'));
  const { vars } = P.exportPLCopen(prog, { name: 'check' });
  const ins = vars.filter((v) => v.role && v.role.kind !== 'do' && v.role.kind !== 'ao');
  const outs = vars.filter((v) => v.role && (v.role.kind === 'do' || v.role.kind === 'ao'));
  const cycleMs = Math.min(1000, Math.max(1, prog.cycleMs || 10));

  // ---- stimulus: sticky values that change now and then, so timers and latches get exercised
  const rand = rng(12345);
  const state = ins.map((v) => initial(v));
  function initial(v) {
    switch (v.role.kind) {
      case 'di': return 0;
      case 'ai': return 1003;          // raw ADC; odd steps of 10 keep away from exact thresholds
      case 'vin': return 0;
      case 'sensor': return 22.5;      // multiples of 0.5 are exact in float and double
      case 'clock': return { dow: 2, minute: 600, valid: 0 }[v.role.part];
      default: return 0;
    }
  }
  function step(v, cur, k) {
    const r = rand();
    switch (v.role.kind) {
      case 'di': return r < 0.08 ? 1 - cur : cur;
      case 'ai': return r < 0.1 ? 10 * Math.floor(rand() * 409) + 3 : cur;
      case 'vin': return v.type === 'BOOL' ? (r < 0.05 ? 1 - cur : cur) : (r < 0.05 ? Math.floor(rand() * 101) : cur);
      case 'sensor': return r < 0.15 ? Math.min(60, Math.max(-10, cur + (rand() < 0.5 ? -0.5 : 0.5) * (1 + Math.floor(rand() * 4)))) : cur;
      case 'clock':
        if (v.role.part === 'valid') return k < 100 ? 0 : 1;  // clock not set at first
        if (v.role.part === 'dow') return r < 0.02 ? Math.floor(rand() * 7) : cur;
        return r < 0.1 ? Math.floor(rand() * 1440) : cur;
      default: return cur;
    }
  }

  // ---- run EspressOS's engine on the same inputs
  const cur = {};
  class Hal extends NullHal {
    constructor() { super(); this.dout = {}; }
    readDigital(pin) { return !!cur['di' + pin]; }
    readAnalog(pin) { return cur['ai' + pin] || 0; }
    readVirtual(i) { return cur['vin' + i] || 0; }
    readSensor(d, c) { return { ok: true, v: cur['s' + d + '.' + c] || 0 }; }
    timeOfDay() { return cur.valid ? { dow: cur.dow, m: cur.minute } : null; }
    setupOutput(pin, level) { this.dout[pin] = level ? 1 : 0; }
    writeDigital(pin, v) { this.dout[pin] = v ? 1 : 0; }
  }
  const hal = new Hal();
  const eng = new Engine(hal);
  const err = eng.load(prog);
  if (err) throw new Error(progFile + ': ' + err);
  eng.run();

  const stim = [], expected = [];
  for (let k = 0; k < CYCLES; k++) {
    ins.forEach((v, i) => {
      state[i] = k === 0 ? state[i] : step(v, state[i], k);
      const r = v.role, x = state[i];
      if (r.kind === 'di') cur['di' + r.pin] = x;
      else if (r.kind === 'ai') cur['ai' + r.pin] = x;
      else if (r.kind === 'vin') cur['vin' + r.idx] = x;
      else if (r.kind === 'sensor') cur['s' + r.dev + '.' + r.ch] = x;
      else if (r.kind === 'clock') cur[r.part] = x;
    });
    eng.scan(k * cycleMs);
    // what the C side gets: OpenPLC delivers analog inputs as ADC x 16
    stim.push(ins.map((v, i) => (v.role.kind === 'ai' ? state[i] * 16 : state[i])).join(' '));
    expected.push(outs.map((v) => {
      if (v.role.kind === 'do') return hal.dout[v.role.pin] ? 1 : 0;
      const b = eng.blocks.find((x) => x.id === v.role.block);  // AO: duty % -> 0..65535 like EOS_AO
      return Math.round(Math.min(100, Math.max(0, b.extra)) * 655.35);
    }).join(' '));
  }

  // ---- C harness for the matiec output
  const setIn = ins.map((v, i) => {
    const val = v.type === 'BOOL' ? `v[${i}] != 0` : v.type === 'REAL' ? `(REAL)v[${i}]` : `(${v.type})v[${i}]`;
    return v.address ? `    *${located(v.address)} = ${val};` : `    RES0__INSTANCE0.${cName(v.name)}.value = ${val};`;
  }).join('\n');
  const fmt = outs.map(() => '%d').join(' ');
  const getOut = outs.map((v) => `(int)*${located(v.address)}`).join(', ');
  const harness = `/* Generated by tools/iec_behaviour.js: drives the matiec output scan by scan. */
#include <stdio.h>
#include "iec_std_lib.h"
#include "accessor.h"
#include "POUS.h"

/* Located variables: storage plus the pointers the generated code expects. */
#define __LOCATED_VAR(type, name, ...) type name##_store; type *name = &name##_store;
#include "LOCATED_VARIABLES.h"
#undef __LOCATED_VAR

TIME __CURRENT_TIME;
BOOL __DEBUG;
extern MAIN RES0__INSTANCE0;
void config_init__(void);
void config_run__(unsigned long tick);

int main(void) {
  double v[${Math.max(1, ins.length)}];
  unsigned long tick = 0;
  config_init__();
  for (;;) {
    for (int i = 0; i < ${ins.length}; i++)
      if (scanf("%lf", &v[i]) != 1) return 0;
${setIn}
    unsigned long long ms = (unsigned long long)tick * ${cycleMs}ULL;
    __CURRENT_TIME.tv_sec = (long)(ms / 1000);
    __CURRENT_TIME.tv_nsec = (long)((ms % 1000) * 1000000ULL);
    config_run__(tick++);
    printf("${fmt}\\n"${outs.length ? ', ' + getOut : ''});
  }
}
`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'harness.c'), harness);
  fs.writeFileSync(path.join(dir, 'stim.txt'), stim.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'expected.txt'), expected.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'columns.json'), JSON.stringify({ ins: ins.map((v) => v.name), outs: outs.map((v) => ({ name: v.name, kind: v.role.kind })) }));
  console.log(`${progFile}: ${ins.length} inputs, ${outs.length} outputs, ${CYCLES} cycles of ${cycleMs} ms`);
}

function compare(dir) {
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).filter(Boolean).map(Number));
  const exp = read('expected.txt'), act = read('actual.txt'), stim = read('stim.txt');
  const cols = JSON.parse(fs.readFileSync(path.join(dir, 'columns.json'), 'utf8'));
  if (act.length !== exp.length) { console.error(`${dir}: expected ${exp.length} cycles, harness printed ${act.length}`); return 1; }
  let bad = 0;
  for (let k = 0; k < exp.length; k++) {
    for (let j = 0; j < cols.outs.length; j++) {
      const tol = cols.outs[j].kind === 'ao' ? AO_TOLERANCE : 0;
      if (Math.abs(exp[k][j] - act[k][j]) > tol) {
        if (bad < 5) console.error(`${dir}: cycle ${k}: ${cols.outs[j].name} EspressOS=${exp[k][j]} OpenPLC=${act[k][j]}  inputs: ${cols.ins.map((n, i) => n + '=' + stim[k][i]).join(' ')}`);
        bad++;
      }
    }
  }
  if (bad) { console.error(`${dir}: ${bad} differences`); return 1; }
  console.log(`${dir}: ${exp.length} cycles, ${cols.outs.length} outputs: identical`);
  return 0;
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'prepare' && a && b) prepare(a, b);
else if (mode === 'compare' && a) process.exit(compare(a));
else { console.error('usage: iec_behaviour.js prepare <program.json> <dir> | compare <dir>'); process.exit(2); }
