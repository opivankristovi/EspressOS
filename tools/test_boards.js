// node --test tools/test_boards.js — board profiles (web/js/boards.js) and the engine's board checks.
// tools/board_vectors.json is shared with the C++ test (firmware/test/test_engine): both must agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const B = require(path.join(__dirname, '../web/js/boards.js'));
const C = require(path.join(__dirname, '../web/js/catalog.js'));
const { Engine, NullHal } = require(path.join(__dirname, '../web/js/sim.js'));

const vectors = require('./board_vectors.json');
const mb1 = B.PRESETS.find((p) => p.id === 'eos-mb1'), mb2 = B.PRESETS.find((p) => p.id === 'eos-mb2');
// A cabinet-PLC style profile (opto inputs with a fixed active level), to test what MB-1 and MB-2 do not have.
const plc = { schema: 1, id: 't-plc', name: 'Test PLC', rev: 'A', i2c: { sda: 21, scl: 22 }, onewire: [4], terminals: [
  ...[36, 39, 34, 35, 13, 14, 27, 26].map((g, i) => ({ label: 'DI' + (i + 1), gpio: g, uses: ['di'], active: 'low', pull: false, group: 'Inputs', note: '12-24 V opto' })),
  { label: 'AI1', gpio: 32, uses: ['ai'] }, { label: 'AI2', gpio: 33, uses: ['ai'] },
  ...[16, 17, 18, 19].map((g, i) => ({ label: 'R' + (i + 1), gpio: g, uses: ['do'], active: 'high' })),
  { label: 'Q1', gpio: 23, uses: ['do', 'pwm'] }, { label: 'Q2', gpio: 25, uses: ['do', 'pwm'] },
] };
const base = (terminals, extra) => ({ schema: 1, id: 't-x', name: 'X', terminals, ...extra });

function generated(kind) {
  if (kind === 'terminals41') return base(Array.from({ length: 41 }, (_, i) => ({ label: 'T' + (i + 1), gpio: 23, uses: ['di'] })));
  if (kind === 'oversize') return base([{ label: 'IO1', gpio: 23, uses: ['do'] }], { pad: 'x'.repeat(4100) });
  throw new Error('unknown generator ' + kind);
}

test('shared validator vectors', () => {
  assert.ok(vectors.cases.length > 30);
  for (const c of vectors.cases) {
    const p = c.generate ? generated(c.generate) : c.profile;
    const err = B.validate(p);
    assert.equal(err === null, c.ok, c.name + (err ? ' -> ' + err : ''));
  }
});

test('every preset is valid and matches the contract tables', () => {
  for (const p of B.PRESETS) assert.equal(B.validate(p), null, p.id);
  assert.equal(B.PRESETS[0].id, 'bare');
  assert.deepEqual(mb1.terminals.map((t) => t.label + '=' + t.gpio).join(' '),
    'AI1=36 AI2=39 AI3=34 AI4=35 AI5=32 AI6=33 R1=16 R2=17 R3=18 R4=19 IO1=23 IO2=25 IO3=26 IO4=27 IO5=13 IO6=14');
  assert.equal(B.validate(plc), null);
  // MB-2 (hardware/MB-2/README.md): the pin map there and this list must agree.
  assert.deepEqual(mb2.terminals.map((t) => t.label + '=' + t.gpio).join(' '),
    'IN1=36 IN2=39 IN3=34 IN4=35 T1=13 T2=14 T3=15 T4=27 T5=32 T6=33 R1=16 R2=17 R3=18 R4=19 IO1=23 IO2=25 IO3=26');
  assert.deepEqual(mb2.terminals.find((t) => t.label === 'T1'), { label: 'T1', gpio: 13, uses: ['touch'], group: 'Touch' });
  assert.deepEqual(mb2.terminals.find((t) => t.label === 'R1'), { label: 'R1', gpio: 16, uses: ['do'], active: 'high', group: 'Relays', note: 'Relay module header, 5 V' });
  assert.ok(mb2.terminals.filter((t) => t.label.startsWith('IN')).every((t) => t.pull === false && t.uses.join() === 'ai,di'));
  assert.deepEqual(mb1.terminals.find((t) => t.label === 'R1'), { label: 'R1', gpio: 16, uses: ['do'], active: 'high', group: 'Relays', note: 'Relay COM/NO/NC, 5 A 250 V AC / 30 V DC' });
  assert.deepEqual(mb1.terminals.find((t) => t.label === 'R3').note, 'G3MB-202P SSR, AC loads 0.1-2 A');
  assert.ok(mb1.terminals.filter((t) => t.label.startsWith('AI')).every((t) => t.pull === false), 'AI dividers: no internal pull-up');
  for (const p of [mb1, mb2]) { assert.deepEqual(p.i2c, { sda: 21, scl: 22 }); assert.deepEqual(p.onewire, [4]); }
});

test('invalid profiles from the contract list are rejected', () => {
  const T = (x) => base([{ label: 'IO1', gpio: 23, uses: ['do'], ...x }]);
  const bad = {
    'bad gpio': T({ gpio: 40 }), 'flash pin': T({ gpio: 9 }), 'output on 34-39': T({ gpio: 35 }),
    'ai on non-ADC1': T({ uses: ['ai'], gpio: 26 }), 'dup gpio terminal/i2c': T({ gpio: 22, }),
    'dup gpio onewire/i2c': base([], { i2c: { sda: 21, scl: 22 }, onewire: [21] }),
    'relay active on 12': T({ gpio: 12, active: 'high' }), 'active with ai': base([{ label: 'A', gpio: 36, uses: ['ai'], active: 'high' }]),
    'label dup': base([{ label: 'A', gpio: 23, uses: ['do'] }, { label: 'A', gpio: 25, uses: ['do'] }]),
    'schema 2': { ...T({}), schema: 2 }, 'bare with terminals': { id: 'bare', terminals: [] }, 'not an object': [],
  };
  bad['dup gpio terminal/i2c'].i2c = { sda: 21, scl: 22 };
  for (const [name, p] of Object.entries(bad)) assert.notEqual(B.validate(p), null, name);
  assert.equal(B.validate({ id: 'bare' }), null);
  assert.equal(B.validate({ schema: 1, id: 'bare', name: 'Bare ESP32 dev board' }), null);
});

test('lookups: bare is the chip, a profile narrows it', () => {
  assert.deepEqual(B.pinsFor(B.BARE, 'di'), C.IN_PINS);
  assert.deepEqual(B.pinsFor(undefined, 'ai'), C.ADC_PINS);
  assert.deepEqual(B.pinsFor(B.BARE, 'pwm'), C.OUT_PINS);
  assert.deepEqual(B.pinsFor(mb1, 'do'), [16, 17, 18, 19, 23, 25, 26, 27, 13]);
  assert.deepEqual(B.pinsFor(plc, 'pwm'), [23, 25]);
  assert.equal(B.labelOf(B.BARE, 16), 'GPIO 16');
  assert.equal(B.labelOf(mb1, 16), 'R1');
  assert.equal(B.labelOf(mb1, 5), 'GPIO 5');
  assert.equal(B.fixedInv(mb1, 16), 0); assert.equal(B.fixedInv(plc, 36), 1); assert.equal(B.fixedInv(mb1, 23), -1); assert.equal(B.fixedInv(B.BARE, 16), -1);
  assert.deepEqual(B.oneWirePins(B.BARE), C.OUT_PINS); assert.deepEqual(B.oneWirePins(mb1), [4]);
  assert.equal(B.i2cOf(B.BARE), null); assert.deepEqual(B.i2cOf(mb1), { sda: 21, scl: 22 });
  assert.equal(B.hasI2c(B.BARE), true); assert.equal(B.hasI2c(base([])), false);
  assert.equal(B.isBare({ id: 'bare' }), true); assert.equal(B.isBare(mb1), false);
});

test('touch: chip pins, profile terminals and the validator', () => {
  assert.deepEqual(B.pinsFor(B.BARE, 'touch'), C.TOUCH_PINS);
  assert.deepEqual(B.pinsFor(mb2, 'touch'), [13, 14, 15, 27, 32, 33]);
  assert.deepEqual(B.pinsFor(mb1, 'touch'), []);
  const T = (x) => base([{ label: 'T1', gpio: 13, uses: ['touch'], ...x }]);
  assert.equal(B.validate(T({})), null);
  assert.equal(B.validate(T({ uses: ['touch', 'di'] })), null);
  assert.match(B.validate(T({ gpio: 34 })), /no touch sensor/);      // input-only ADC pins cannot sense touch
  assert.match(B.validate(T({ gpio: 25 })), /no touch sensor/);
  assert.match(B.validate(T({ active: 'low' })), /only fits di\/do/);
});

// ------------------------------------------------------------ engine with a board
const boardEngine = (board) => { const hal = new NullHal(); hal.board = board; return new Engine(hal); };
const relayProg = (extra) => ({ board: 'eos-mb1', blocks: [{ id: 1, type: 'CONST', p: { value: 1 } }, { id: 2, type: 'DO', p: { pin: 16, inv: 0 } }], wires: [[1, 0, 2, 0]], ...extra });

test('engine accepts a correct program for the board', () => {
  assert.equal(boardEngine(mb1).load(relayProg()), null);
  assert.equal(boardEngine(plc).load({ board: 't-plc', blocks: [{ id: 1, type: 'DI', p: { pin: 36, inv: 1, pull: 0 } }, { id: 2, type: 'AI', p: { pin: 32 } }, { id: 3, type: 'AO', p: { pin: 23 } }], wires: [] }), null);
  assert.equal(boardEngine(mb2).load({ board: 'eos-mb2', blocks: [{ id: 1, type: 'TOUCH', p: { pin: 13, thr: 30 } }, { id: 2, type: 'DO', p: { pin: 16, inv: 0 } },
    { id: 3, type: 'AI', p: { pin: 36 } }, { id: 4, type: 'AO', p: { pin: 23 } }], wires: [[1, 0, 2, 0]], devices: [{ id: 1, driver: 'ADS1115', addr: 0x48 }] }), null);
  // a bare board takes unstamped programs exactly as before
  assert.equal(boardEngine(B.BARE).load({ blocks: [{ id: 1, type: 'DO', p: { pin: 2 } }], wires: [] }), null);
});

test('engine refuses unwired pins, wrong use, fixed-level mismatch and a foreign stamp', () => {
  const e = boardEngine(mb1);
  assert.match(e.load(relayProg({ blocks: [{ id: 2, type: 'DO', p: { pin: 5 } }] })), /Block 2: GPIO 5 is not wired to a terminal on this board/);
  assert.match(e.load(relayProg({ blocks: [{ id: 2, type: 'DO', p: { pin: 21 } }] })), /GPIO 21 is the I2C bus on this board/);
  assert.match(e.load(relayProg({ blocks: [{ id: 2, type: 'AO', p: { pin: 16 } }], wires: [] })), /GPIO 16 \(R1\) on this board is digital out only/);
  assert.match(e.load(relayProg({ blocks: [{ id: 2, type: 'AI', p: { pin: 23 } }], wires: [] })), /has no usable ADC/);  // chip rule first
  assert.match(e.load(relayProg({ blocks: [{ id: 2, type: 'DO', p: { pin: 16, inv: 1 } }], wires: [] })), /terminal R1 \(GPIO 16\) is active-high on this board: set Invert to off/);
  assert.match(boardEngine(plc).load({ board: 't-plc', blocks: [{ id: 1, type: 'DI', p: { pin: 36 } }], wires: [] }), /active-low.*set Invert to on/);
  assert.equal(e.load(relayProg({ board: 't-plc' })),
    'Program was made for board "t-plc" but this board is set to "eos-mb1". Open it in the editor and use Retarget, then Deploy.');
  assert.match(e.load(relayProg({ board: undefined })), /made for board "bare"/);
  // touch: only on touch terminals, and never on a pin without a touch sensor
  const m2 = (blocks) => boardEngine(mb2).load({ board: 'eos-mb2', blocks, wires: [] });
  assert.match(m2([{ id: 1, type: 'TOUCH', p: { pin: 23 } }]), /Block 1: GPIO 23 has no touch sensor/);       // chip rule first
  assert.match(m2([{ id: 1, type: 'DI', p: { pin: 13 } }]), /GPIO 13 \(T1\) on this board is touch only/);
  assert.match(m2([{ id: 1, type: 'TOUCH', p: { pin: 4 } }]), /GPIO 4 is the 1-Wire bus on this board/);
  assert.match(m2([{ id: 1, type: 'TOUCH', p: { pin: 2 } }]), /GPIO 2 is not wired to a terminal/);
  assert.match(boardEngine(mb1).load(relayProg({ blocks: [{ id: 2, type: 'TOUCH', p: { pin: 13 } }], wires: [] })), /GPIO 13 \(IO5\) on this board is digital in \/ digital out \/ PWM out only/);
  assert.match(boardEngine(B.BARE).load(relayProg()), /made for board "eos-mb1" but this board is set to "bare"/);
});

test('engine checks sensor buses like deploy()', () => {
  const ds = (pin) => ({ id: 1, driver: 'DS18B20', name: 'T', pin });
  assert.match(new Engine().load({ blocks: [{ id: 1, type: 'DI', p: { pin: 4 } }], wires: [], devices: [ds(4)] }), /GPIO 4 is also used by block 1/);
  assert.match(boardEngine(mb1).load(relayProg({ devices: [ds(5)] })), /not a 1-Wire terminal/);
  assert.equal(boardEngine(mb1).load(relayProg({ devices: [ds(4), { id: 2, driver: 'BME280', addr: 0x76 }] })), null);
  const noBus = { schema: 1, id: 't-nobus', name: 'No bus', terminals: [{ label: 'Q1', gpio: 25, uses: ['do'] }] };
  assert.match(boardEngine(noBus).load({ board: 't-nobus', blocks: [], wires: [], devices: [{ id: 1, driver: 'SHT31', addr: 0x44 }] }), /no I2C bus/);
});

test('run() refuses a stored program once the board changed', () => {
  const hal = new NullHal(); hal.board = mb1;
  const e = new Engine(hal);
  assert.equal(e.load(relayProg()), null);
  e.stop(); hal.board = plc;
  assert.match(e.run(), /made for board "eos-mb1"/);
  assert.equal(e.running, false);
});

// ------------------------------------------------------------ retarget
test('retarget maps by label, keeps GPIOs that fit, clears the rest', () => {
  const prog = { board: 'eos-mb1', blocks: [
    { id: 1, type: 'DO', p: { pin: 16, inv: 0 } },    // R1 -> R1 (same GPIO)
    { id: 2, type: 'DI', p: { pin: 23, pull: 1, inv: 0 } }, // IO1: no IO1 on the PLC board, GPIO 23 is Q1 (do/pwm) -> cleared
    { id: 3, type: 'AI', p: { pin: 36 } },             // AI1 -> AI1 = GPIO 32 on the PLC board
    { id: 4, type: 'AO', p: { pin: 25 } },             // IO2: GPIO 25 is Q2 on the PLC board (pwm) -> kept
    { id: 5, type: 'DI', p: { pin: 34, inv: 0, pull: 1 } },     // AI3: GPIO 34 is DI3 (active-low) -> kept, inv 1, pull 0
  ], wires: [], devices: [{ id: 1, driver: 'DS18B20', pin: 4 }] };
  const { prog: out, notes } = B.retarget(prog, mb1, plc);
  const pin = (id) => out.blocks.find((b) => b.id === id).p;
  assert.equal(out.board, 't-plc');
  assert.equal(pin(1).pin, 16);
  assert.equal(pin(2).pin, undefined);
  assert.equal(pin(3).pin, 32);
  assert.equal(pin(4).pin, 25);
  assert.deepEqual([pin(5).pin, pin(5).inv, pin(5).pull], [34, 1, 0]);
  assert.ok(notes.some((n) => /B2: IO1 \(GPIO 23\) does not exist/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /B3: AI1 \(GPIO 36\) → AI1 \(GPIO 32\)/.test(n)), notes.join('\n'));
  assert.equal(prog.board, 'eos-mb1', 'input untouched');
  // the result loads on the target once the user picked the missing terminal
  out.blocks.find((b) => b.id === 2).p.pin = 13; out.blocks.find((b) => b.id === 2).p.inv = 1;
  assert.equal(boardEngine(plc).load(out), null);
});

test('retarget carries touch blocks by label or GPIO', () => {
  // bare -> MB-2: GPIO 13 is T1 (kept); GPIO 4 is the 1-Wire pin there (cleared)
  const { prog, notes } = B.retarget({ blocks: [{ id: 1, type: 'TOUCH', p: { pin: 13, thr: 25 } }, { id: 2, type: 'TOUCH', p: { pin: 4 } }], wires: [] }, B.BARE, mb2);
  assert.deepEqual(prog.blocks[0].p, { pin: 13, thr: 25 });
  assert.equal(prog.blocks[1].p.pin, undefined);
  assert.ok(notes.some((n) => /B2: GPIO 4 does not exist/.test(n)), notes.join('\n'));
  // MB-2 -> MB-1 has no touch terminals: every touch block needs a new terminal
  const back = B.retarget({ board: 'eos-mb2', blocks: [{ id: 1, type: 'TOUCH', p: { pin: 13 } }], wires: [] }, mb2, mb1);
  assert.equal(back.prog.blocks[0].p.pin, undefined);
});

test('retarget to and from bare', () => {
  const fromBare = B.retarget({ blocks: [{ id: 1, type: 'DO', p: { pin: 2 } }, { id: 2, type: 'DO', p: { pin: 17, inv: 1 } }], wires: [] }, B.BARE, mb1);
  assert.equal(fromBare.prog.blocks[0].p.pin, undefined);              // GPIO 2 is not wired on MB-1
  assert.deepEqual(fromBare.prog.blocks[1].p, { pin: 17, inv: 0 });    // R2 is active-high
  const toBare = B.retarget(fromBare.prog, mb1, B.BARE);
  assert.equal(toBare.prog.board, undefined);
  assert.equal(toBare.prog.blocks[1].p.pin, 17);
  assert.equal(boardEngine(B.BARE).load({ ...toBare.prog, blocks: [toBare.prog.blocks[1]] }), null);
});

test('retarget drops an Invert or pull-up that only the old board forced', () => {
  // the PLC board DI5 (GPIO 13) is an active-low opto: inv 1, pull 0. On MB-1, GPIO 13 is the plain IO5.
  const { prog, notes } = B.retarget({ board: 't-plc', blocks: [{ id: 1, type: 'DI', p: { pin: 13, inv: 1, pull: 0 } }], wires: [] }, plc, mb1);
  assert.deepEqual(prog.blocks[0].p, { pin: 13, inv: 0, pull: 1 });
  assert.ok(notes.some((n) => /B1: Invert was set by DI5/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /B1: internal pull-up was turned off by DI5/.test(n)), notes.join('\n'));
  // Input-only pins have no internal pull-up, so it stays off there (the PLC board DI1 = GPIO 36 -> bare).
  const toBare = B.retarget({ board: 't-plc', blocks: [{ id: 1, type: 'DI', p: { pin: 36, inv: 1, pull: 0 } }], wires: [] }, plc, B.BARE);
  assert.deepEqual(toBare.prog.blocks[0].p, { pin: 36, inv: 0, pull: 0 });
  // An Invert the user chose on a plain terminal is left alone.
  const own = B.retarget({ board: 'eos-mb1', blocks: [{ id: 1, type: 'DO', p: { pin: 23, inv: 1 } }], wires: [] }, mb1, B.BARE);
  assert.equal(own.prog.blocks[0].p.inv, 1);
});

test('a stamp that is not a string means bare, as in the firmware', () => {
  for (const board of [undefined, null, 0, 7, true]) assert.equal(B.stampOf({ board }), 'bare');
  assert.equal(B.stampOf({ board: 'eos-mb1' }), 'eos-mb1');
  assert.equal(boardEngine(B.BARE).load({ board: null, blocks: [{ id: 1, type: 'DO', p: { pin: 2 } }], wires: [] }), null);
  assert.match(boardEngine(mb1).load(relayProg({ board: null })), /made for board "bare"/);
});

test('text limits count characters, not bytes', () => {
  const note = 'ä'.repeat(48);
  const p = { schema: 1, id: 't-x', name: 'Ü'.repeat(40), terminals: [{ label: 'IO1', gpio: 23, uses: ['do'], note }] };
  assert.equal(B.validate(p), null);
  assert.match(B.validate({ ...p, name: 'Ü'.repeat(41) }), /name/);
});

test('bare board: sensors keep their pins to themselves, as deploy() checks', () => {
  const bme = { id: 1, driver: 'BME280', addr: 0x76 };
  assert.match(boardEngine(B.BARE).load({ blocks: [{ id: 1, type: 'DI', p: { pin: 21 } }], wires: [], devices: [bme] }), /GPIO 21 is the I2C bus/);
  assert.equal(boardEngine(B.BARE).load({ blocks: [{ id: 1, type: 'DI', p: { pin: 21 } }], wires: [] }), null);  // no I2C sensor: free pin
  assert.match(boardEngine(B.BARE).load({ blocks: [], wires: [], devices: [{ id: 1, driver: 'DS18B20', pin: 34 }] }), /output-capable/);
});
