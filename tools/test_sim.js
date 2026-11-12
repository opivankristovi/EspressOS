// node --test tools/   — mirrors firmware/test/test_engine/test_main.cpp
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Engine, NullHal } = require(path.join(__dirname, '../web/js/sim.js'));
const Catalog = require(path.join(__dirname, '../web/js/catalog.js'));

class FakeHal extends NullHal {
  constructor() { super(); this.din = {}; this.dout = {}; this.vin = {}; this.safeCalls = 0; this.setupLevel = {}; }
  setupOutput(p, level) { this.setupLevel[p] = !!level; this.dout[p] = !!level; }
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

test('stop then run re-arms outputs and restarts timers', () => {
  const { hal, eng } = setup({ blocks: [{ id: 1, type: 'CONST', p: { value: 1 } }, { id: 2, type: 'DO', p: { pin: 4 } },
    { id: 3, type: 'TON', p: { t: 2 } }], wires: [[1, 0, 2, 0], [1, 0, 3, 0]] });
  eng.scan(0); eng.scan(1500);
  assert.equal(hal.dout[4], true);
  eng.stop(); assert.equal(hal.dout[4], undefined);
  eng.run(); eng.scan(10000);
  assert.equal(hal.dout[4], true);
  assert.equal(eng.output(3, 0), 0);
  eng.scan(12000); assert.equal(eng.output(3, 0), 1);
});

test('inverted output starts at its off level', () => {
  const { hal } = setup({ blocks: [{ id: 1, type: 'DO', p: { pin: 5, inv: 1 } }], wires: [] });
  assert.equal(hal.setupLevel[5], true);
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

test('MQTT in/out: value, Q, formatting and rate limit', () => {
  class MqHal extends NullHal { constructor() { super(); this.mqttIn = {}; this.sent = []; } mqttPublish(t, p) { this.sent.push([t, p]); } }
  const hal = new MqHal(), e = new Engine(hal);
  assert.equal(e.load({ blocks: [{ id: 1, type: 'MQTTIN', p: { topic: 't/in', def: 0.75 } },
    { id: 2, type: 'MQTTOUT', p: { topic: 't/num', fmt: 'num', dec: 2, every: 1 } }, { id: 3, type: 'MQTTOUT', p: { topic: 't/sw', fmt: 'onoff', every: 0 } }],
  wires: [[1, 0, 2, 0], [1, 1, 3, 0]] }), null);
  e.run();
  e.scan(0);
  assert.equal(e.output(1, 0), 0.75); assert.equal(e.output(1, 1), 1);
  assert.deepEqual(hal.sent, [['t/num', '0.75'], ['t/sw', 'ON']]);
  hal.mqttIn['t/in'] = 21.5; e.scan(100);
  assert.equal(hal.sent.length, 2);
  e.scan(1000); assert.deepEqual(hal.sent[2], ['t/num', '21.5']);
  hal.mqttIn['t/in'] = 0; e.scan(1100); assert.deepEqual(hal.sent[3], ['t/sw', 'OFF']);
  e.scan(2000); assert.deepEqual(hal.sent[4], ['t/num', '0']);
  e.scan(3000); assert.equal(hal.sent.length, 5);
  assert.match(e.load({ blocks: [{ id: 1, type: 'MQTTIN', p: { topic: '' } }], wires: [] }), /no MQTT topic/);
  assert.match(e.load({ blocks: [{ id: 1, type: 'MQTTOUT', p: { topic: 'a/+/b' } }], wires: [] }), /wildcards/);
});

test('MQTT payload text matches the firmware', () => {
  const { mqttPayload, parsePayload } = require(path.join(__dirname, '../web/js/sim.js'));
  assert.equal(mqttPayload(Math.fround(21.456), 'num', 2), '21.46');
  assert.equal(mqttPayload(3, 'num', 2), '3');
  assert.equal(mqttPayload(-0.001, 'num', 2), '0');
  assert.equal(mqttPayload(0.5, 'bool', 2), 'true');
  assert.equal(mqttPayload(0.4, '01', 2), '0');
  for (const [t, v] of [['ON', 1], [' off ', 0], ['true', 1], ['PRESS', 1], ['23.5', 23.5], ['-1e2', -100], ['.5', 0.5]]) assert.equal(parsePayload(t), v, t);
  for (const t of ['', 'abc', '1.2.3', '0x10', 'inf', '1e']) assert.equal(parsePayload(t), null, t);
  // the firmware's parser accepts exactly the same forms
  const src = require('fs').readFileSync(path.join(__dirname, '../firmware/src/Mqtt.cpp'), 'utf8');
  assert.ok(src.includes('{"on", "true", "open", "yes", "press"}') && src.includes('{"off", "false", "closed", "no"}'));
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

test('engine rejects unusable, input-only and shared pins', () => {
  const load = (blocks) => new Engine(new NullHal()).load({ blocks, wires: [] });
  assert.match(load([{ id: 1, type: 'DO', p: { pin: 7 } }]), /Block 1: GPIO 7 cannot be used/);
  assert.match(load([{ id: 1, type: 'DO', p: { pin: 34 } }]), /input-only/);
  assert.match(load([{ id: 1, type: 'AI', p: { pin: 4 } }]), /no usable ADC/);
  assert.match(load([{ id: 1, type: 'DI', p: {} }]), /no GPIO pin/);
  assert.match(load([{ id: 1, type: 'DI', p: { pin: 4 } }, { id: 2, type: 'DO', p: { pin: 4 } }]), /GPIO 4 is used by block 1 and block 2/);
  assert.equal(load([{ id: 1, type: 'DI', p: { pin: 4 } }, { id: 2, type: 'DI', p: { pin: 4 } }]), null);
});

test('pin rules live on the HAL; no board means the chip rules only', () => {
  const hal = new NullHal();
  assert.equal(hal.pinProblem(34, 'di'), null);
  assert.equal(hal.pinProblem(34, 'do'), 'is input-only');
  assert.equal(hal.pinProblem(34, 'pwm'), 'is input-only');
  assert.match(hal.pinProblem(25, 'ai'), /no usable ADC/);
  assert.equal(hal.pinProblem(13, 'touch'), null);
  assert.match(hal.pinProblem(34, 'touch'), /no touch sensor/);
  assert.match(hal.pinProblem(6, 'di'), /flash chip/);
  // a HAL can narrow it further, and Engine.load asks the HAL
  class Narrow extends NullHal { pinProblem(pin, use) { return pin === 4 ? 'is reserved here' : super.pinProblem(pin, use); } }
  assert.match(new Engine(new Narrow()).load({ blocks: [{ id: 1, type: 'DI', p: { pin: 4 } }], wires: [] }), /Block 1: GPIO 4 is reserved here/);
});

test('pin lists match the firmware (EspHal.cpp)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../firmware/src/EspHal.cpp'), 'utf8');
  const list = (name) => src.match(new RegExp(name + String.raw`\[\] = \{([^}]*)\}`))[1].split(',').map(Number);
  const C = require('../web/js/catalog.js');
  assert.deepEqual(list('kOutPins'), C.OUT_PINS);
  assert.deepEqual([...list('kOutPins'), ...list('kInOnlyPins')].sort((a, b) => a - b), C.IN_PINS);
  assert.deepEqual(list('kAdcPins'), C.ADC_PINS);
  assert.deepEqual(list('kTouchPins'), C.TOUCH_PINS);
});

test('touch input: on below the threshold, off a little above it, off without a reading', () => {
  class TouchHal extends NullHal { constructor() { super(); this.raw = 60; } readTouch() { return this.raw; } }
  const hal = new TouchHal(), e = new Engine(hal);
  assert.equal(e.load({ blocks: [{ id: 1, type: 'TOUCH', p: { pin: 13, thr: 30 } }, { id: 2, type: 'DO', p: { pin: 16 } }], wires: [[1, 0, 2, 0]] }), null);
  e.run();
  let now = 0;
  const q = (raw) => { hal.raw = raw; e.scan(now += 10); return [e.output(1, 0), e.output(1, 1)]; };
  assert.deepEqual(q(60), [0, 60]);
  assert.deepEqual(q(29), [1, 29]);   // touched
  assert.deepEqual(q(31), [1, 31]);   // inside the 10 % gap: stays on
  assert.deepEqual(q(33), [0, 33]);   // released
  assert.deepEqual(q(31), [0, 31]);   // and stays off until below the threshold again
  assert.deepEqual(q(10), [1, 10]);
  assert.deepEqual(q(0), [0, 0]);     // no reading = not touched
});
