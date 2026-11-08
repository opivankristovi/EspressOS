// node --test tools/   — mirrors firmware/test/test_engine/test_main.cpp
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Engine, NullHal } = require(path.join(__dirname, '../web/js/sim.js'));
const Catalog = require(path.join(__dirname, '../web/js/catalog.js'));

class FakeHal extends NullHal {
  constructor() { super(); this.din = {}; this.dout = {}; this.vin = {}; this.safeCalls = 0; }
  readDigital(p) { return !!this.din[p]; }
  writeDigital(p, v) { this.dout[p] = !!v; }
  readVirtual(i) { return this.vin[i] || 0; }
  safeOutputs() { this.safeCalls++; this.dout = {}; }
}

function setup(prog) {
  const hal = new FakeHal(), eng = new Engine(hal);
  const err = eng.load(prog);
  assert.equal(err, null);
  eng.run();
  return { hal, eng };
}

test('gate truth tables', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'VIN', p: { idx: 0 } }, { id: 2, type: 'VIN', p: { idx: 1 } },
    { id: 3, type: 'AND' }, { id: 4, type: 'OR' }, { id: 5, type: 'XOR' }, { id: 6, type: 'NAND' }, { id: 7, type: 'NOR' }, { id: 8, type: 'NOT' }],
  wires: [[1, 0, 3, 0], [2, 0, 3, 1], [1, 0, 4, 0], [2, 0, 4, 1], [1, 0, 5, 0], [2, 0, 5, 1], [1, 0, 6, 0], [2, 0, 6, 1], [1, 0, 7, 0], [2, 0, 7, 1], [1, 0, 8, 0]] });
  for (const a of [0, 1]) for (const b of [0, 1]) {
    hal.vin = { 0: a, 1: b }; eng.scan(0);
    assert.equal(eng.output(3, 0), +(a && b)); assert.equal(eng.output(4, 0), +(a || b));
    assert.equal(eng.output(5, 0), a ^ b); assert.equal(eng.output(6, 0), +!(a && b));
    assert.equal(eng.output(7, 0), +!(a || b)); assert.equal(eng.output(8, 0), +!a);
  }
});

test('evaluation order follows wires, not JSON order', () => {
  const { hal, eng } = setup({ blocks: [{ id: 3, type: 'DO', p: { pin: 2 } }, { id: 2, type: 'NOT' }, { id: 1, type: 'VIN', p: { idx: 0 } }],
    wires: [[2, 0, 3, 0], [1, 0, 2, 0]] });
  eng.scan(0); assert.equal(hal.dout[2], true);
  hal.vin[0] = 1; eng.scan(10); assert.equal(hal.dout[2], false);
});

test('TON', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'VIN', p: { idx: 0 } }, { id: 2, type: 'TON', p: { t: 2 } }], wires: [[1, 0, 2, 0]] });
  hal.vin[0] = 1;
  eng.scan(1000); assert.equal(eng.output(2, 0), 0);
  eng.scan(2999); assert.equal(eng.output(2, 0), 0);
  eng.scan(3000); assert.equal(eng.output(2, 0), 1);
  hal.vin[0] = 0; eng.scan(3010); assert.equal(eng.output(2, 0), 0);
});

test('TOF and TP', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'VIN', p: { idx: 0 } }, { id: 2, type: 'TOF', p: { t: 1 } }, { id: 3, type: 'TP', p: { t: 0.5 } }],
    wires: [[1, 0, 2, 0], [1, 0, 3, 0]] });
  hal.vin[0] = 1; eng.scan(0); assert.equal(eng.output(2, 0), 1); assert.equal(eng.output(3, 0), 1);
  hal.vin[0] = 0; eng.scan(100); assert.equal(eng.output(2, 0), 1); assert.equal(eng.output(3, 0), 1);
  eng.scan(500); assert.equal(eng.output(3, 0), 0);
  eng.scan(1099); assert.equal(eng.output(2, 0), 1);
  eng.scan(1100); assert.equal(eng.output(2, 0), 0);
});

test('SR latch, reset priority', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'VIN', p: { idx: 0 } }, { id: 2, type: 'VIN', p: { idx: 1 } }, { id: 3, type: 'SR' }],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1]] });
  hal.vin[0] = 1; eng.scan(0); assert.equal(eng.output(3, 0), 1);
  hal.vin[0] = 0; eng.scan(1); assert.equal(eng.output(3, 0), 1);
  hal.vin = { 0: 1, 1: 1 }; eng.scan(2); assert.equal(eng.output(3, 0), 0);
});

test('feedback loop has one-cycle delay', () => {
  const { eng } = setup({ blocks: [{ id: 1, type: 'NOT' }], wires: [[1, 0, 1, 0]] });
  eng.scan(0); assert.equal(eng.output(1, 0), 1);
  eng.scan(1); assert.equal(eng.output(1, 0), 0);
  eng.scan(2); assert.equal(eng.output(1, 0), 1);
});

test('counter', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'VIN', p: { idx: 0 } }, { id: 2, type: 'VIN', p: { idx: 1 } }, { id: 3, type: 'CTR', p: { preset: 3 } }],
    wires: [[1, 0, 3, 0], [2, 0, 3, 2]] });
  for (let i = 0; i < 3; i++) { hal.vin[0] = 1; eng.scan(i * 2); hal.vin[0] = 0; eng.scan(i * 2 + 1); }
  assert.equal(eng.output(3, 1), 3); assert.equal(eng.output(3, 0), 1);
  hal.vin[1] = 1; eng.scan(10); assert.equal(eng.output(3, 1), 0);
});

test('threshold hysteresis + math', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'VIN', p: { idx: 0 } }, { id: 2, type: 'MATH', p: { op: '*', b: 10 } },
    { id: 3, type: 'THRESH', p: { on: 25, off: 20 } }], wires: [[1, 0, 2, 0], [2, 0, 3, 0]] });
  const at = (v, t) => { hal.vin[0] = v; eng.scan(t); return eng.output(3, 0); };
  assert.equal(at(2.4, 0), 0); assert.equal(at(2.5, 1), 1); assert.equal(at(2.1, 2), 1); assert.equal(at(2.0, 3), 0);
});

test('invalid programs are rejected and the old one keeps running', () => {
  const { eng } = setup({ blocks: [{ id: 1, type: 'CONST', p: { value: 7 } }], wires: [] });
  assert.match(eng.load({ blocks: [{ id: 1, type: 'BOGUS' }], wires: [] }), /Unknown/);
  assert.match(eng.load({ blocks: [{ id: 1, type: 'NOT' }, { id: 1, type: 'NOT' }], wires: [] }), /duplicate/);
  assert.match(eng.load({ blocks: [{ id: 1, type: 'NOT' }], wires: [[1, 0, 1, 3]] }), /no input/);
  assert.match(eng.load({ blocks: [{ id: 1, type: 'NOT' }, { id: 2, type: 'NOT' }, { id: 3, type: 'NOT' }], wires: [[1, 0, 3, 0], [2, 0, 3, 0]] }), /two wires/);
  assert.match(eng.load('{not json'), /JSON/);
  eng.scan(0); assert.equal(eng.output(1, 0), 7);
});

test('stop puts outputs in safe state', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'CONST', p: { value: 1 } }, { id: 2, type: 'DO', p: { pin: 4 } }], wires: [[1, 0, 2, 0]] });
  eng.scan(0); assert.equal(hal.dout[4], true);
  const before = hal.safeCalls; eng.stop();
  assert.equal(hal.safeCalls, before + 1); assert.equal(hal.dout[4], undefined);
});

test('inverted output: pin level vs logical state', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'VIN', p: { idx: 0 } }, { id: 2, type: 'DO', p: { pin: 5, inv: 1 } }], wires: [[1, 0, 2, 0]] });
  hal.vin[0] = 1; eng.scan(0);
  assert.equal(hal.dout[5], false);
  assert.deepEqual(eng.snapshot().b[2], [1]);
  hal.vin[0] = 0; eng.scan(1);
  assert.equal(hal.dout[5], true);
});

test('weekly timer incl. overnight window', () => {
  let now = { dow: 1, m: 0 };
  const hal = new FakeHal(); hal.timeOfDay = () => now;
  const eng = new Engine(hal);
  assert.equal(eng.load({ blocks: [{ id: 1, type: 'WEEK', p: { days: 2, on: 22 * 60, off: 6 * 60 } }], wires: [] }), null);
  eng.run();
  const q = (dow, m) => { now = { dow, m }; eng.scan(0); return eng.output(1, 0); };
  assert.equal(q(1, 21 * 60), 0); assert.equal(q(1, 23 * 60), 1); assert.equal(q(2, 5 * 60), 1);
  assert.equal(q(2, 7 * 60), 0); assert.equal(q(2, 23 * 60), 0); // Tuesday not selected
});

test('catalogue port counts match the engine', () => {
  const { N_IN, N_OUT } = require(path.join(__dirname, '../web/js/sim.js'));
  for (const b of Catalog.BLOCKS) {
    assert.equal(b.ins.length, N_IN[b.type], b.type + ' inputs');
    assert.equal(b.outs.length, N_OUT[b.type], b.type + ' outputs');
  }
});

test('catalogue matches firmware block table', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../firmware/lib/engine/src/Blocks.cpp'), 'utf8');
  const fw = [...src.matchAll(/\{"(\w+)", (\d), (\d), make</g)].map((m) => [m[1], +m[2], +m[3]]);
  const { N_IN, N_OUT } = require(path.join(__dirname, '../web/js/sim.js'));
  assert.equal(fw.length, Object.keys(N_IN).length);
  for (const [t, i, o] of fw) { assert.equal(N_IN[t], i, t); assert.equal(N_OUT[t], o, t); }
});
