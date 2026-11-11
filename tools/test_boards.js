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
  assert.deepEqual(mb2.terminals.map((t) => t.label + '=' + t.gpio).join(' '),
    'DI1=36 DI2=39 DI3=34 DI4=35 DI5=13 DI6=14 DI7=27 DI8=26 AI1=32 AI2=33 R1=16 R2=17 R3=18 R4=19 Q1=23 Q2=25');
  assert.deepEqual(mb2.terminals[0], { label: 'DI1', gpio: 36, uses: ['di'], active: 'low', pull: false, group: 'Inputs', note: '12-24 V opto' });
  assert.deepEqual(mb1.terminals.find((t) => t.label === 'R1'), { label: 'R1', gpio: 16, uses: ['do'], active: 'high', group: 'Relays', note: 'G3MB-202P SSR, AC loads 0.1-2 A' });
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
  assert.deepEqual(B.pinsFor(mb2, 'pwm'), [23, 25]);
  assert.equal(B.labelOf(B.BARE, 16), 'GPIO 16');
  assert.equal(B.labelOf(mb1, 16), 'R1');
  assert.equal(B.labelOf(mb1, 5), 'GPIO 5');
  assert.equal(B.fixedInv(mb1, 16), 0); assert.equal(B.fixedInv(mb2, 36), 1); assert.equal(B.fixedInv(mb1, 23), -1); assert.equal(B.fixedInv(B.BARE, 16), -1);
  assert.deepEqual(B.oneWirePins(B.BARE), C.OUT_PINS); assert.deepEqual(B.oneWirePins(mb1), [4]);
  assert.equal(B.i2cOf(B.BARE), null); assert.deepEqual(B.i2cOf(mb1), { sda: 21, scl: 22 });
  assert.equal(B.hasI2c(B.BARE), true); assert.equal(B.hasI2c(base([])), false);
  assert.equal(B.isBare({ id: 'bare' }), true); assert.equal(B.isBare(mb1), false);
});

// ------------------------------------------------------------ engine with a board
const boardEngine = (board) => { const hal = new NullHal(); hal.board = board; return new Engine(hal); };
const relayProg = (extra) => ({ board: 'eos-mb1', blocks: [{ id: 1, type: 'CONST', p: { value: 1 } }, { id: 2, type: 'DO', p: { pin: 16, inv: 0 } }], wires: [[1, 0, 2, 0]], ...extra });

test('engine accepts a correct program for the board', () => {
  assert.equal(boardEngine(mb1).load(relayProg()), null);
  assert.equal(boardEngine(mb2).load({ board: 'eos-mb2', blocks: [{ id: 1, type: 'DI', p: { pin: 36, inv: 1, pull: 0 } }, { id: 2, type: 'AI', p: { pin: 32 } }, { id: 3, type: 'AO', p: { pin: 23 } }], wires: [] }), null);
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
  assert.match(boardEngine(mb2).load({ board: 'eos-mb2', blocks: [{ id: 1, type: 'DI', p: { pin: 36 } }], wires: [] }), /active-low.*set Invert to on/);
  assert.equal(e.load(relayProg({ board: 'eos-mb2' })),
    'Program was made for board "eos-mb2" but this board is set to "eos-mb1". Open it in the editor and use Retarget, then Deploy.');
  assert.match(e.load(relayProg({ board: undefined })), /made for board "bare"/);
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
  e.stop(); hal.board = mb2;
  assert.match(e.run(), /made for board "eos-mb1"/);
  assert.equal(e.running, false);
});

// ------------------------------------------------------------ retarget
test('retarget maps by label, keeps GPIOs that fit, clears the rest', () => {
  const prog = { board: 'eos-mb1', blocks: [
    { id: 1, type: 'DO', p: { pin: 16, inv: 0 } },    // R1 -> R1 (same GPIO)
    { id: 2, type: 'DI', p: { pin: 23, pull: 1, inv: 0 } }, // IO1: no IO1 on MB-2, GPIO 23 is Q1 (do/pwm) -> cleared
    { id: 3, type: 'AI', p: { pin: 36 } },             // AI1 -> AI1 = GPIO 32 on MB-2
    { id: 4, type: 'AO', p: { pin: 25 } },             // IO2: GPIO 25 is Q2 on MB-2 (pwm) -> kept
    { id: 5, type: 'DI', p: { pin: 34, inv: 0, pull: 1 } },     // AI3: GPIO 34 is DI3 (active-low) -> kept, inv 1, pull 0
  ], wires: [], devices: [{ id: 1, driver: 'DS18B20', pin: 4 }] };
  const { prog: out, notes } = B.retarget(prog, mb1, mb2);
  const pin = (id) => out.blocks.find((b) => b.id === id).p;
  assert.equal(out.board, 'eos-mb2');
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
  assert.equal(boardEngine(mb2).load(out), null);
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
