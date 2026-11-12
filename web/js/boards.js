// Board profiles: which ESP32 pins a carrier board brings out to terminals, and how.
// A profile only NAMES and NARROWS the chip's pins; programs keep raw GPIO numbers.
// Keep validate() in step with firmware/lib/engine/src/Board.cpp: both must give the
// same accept/reject answer for every case in tools/board_vectors.json.
(function (root) {
  'use strict';
  const Cat = typeof module !== 'undefined' && module.exports ? require('./catalog.js') : root.Catalog;

  const USES = ['di', 'do', 'ai', 'pwm', 'touch'];
  const USE_NAME = { di: 'digital in', do: 'digital out', ai: 'analog in', pwm: 'PWM out', touch: 'touch' };
  // Relays must not sit here: these pins pulse or are sampled at reset (relays chatter or the board won't boot).
  const BOOT_PINS = [0, 2, 5, 12, 14, 15];
  const MAX_BYTES = 4096, MAX_TERMINALS = 40;
  const BARE = { id: 'bare', name: 'Bare ESP32 dev board' };

  const t = (label, gpio, uses, group, note, extra) => Object.assign({ label, gpio, uses }, extra, group ? { group } : {}, note ? { note } : {});
  const relay = (n, gpio, note) => t('R' + n, gpio, ['do'], 'Relays', note, { active: 'high' });
  const touch = (n, gpio, note) => t('T' + n, gpio, ['touch'], 'Touch', note);
  const io = (n, gpio) => t('IO' + n, gpio, ['di', 'do', 'pwm'], 'GPIO');

  const PRESETS = [
    BARE,
    // Hardware: hardware/MB-1/README.md. AI terminals have a 30k/10k divider, so the chip's pull-up must stay off.
    { schema: 1, id: 'eos-mb1', name: 'MB-1 Analog + 2 relay + 2 SSR', rev: 'A', i2c: { sda: 21, scl: 22 }, onewire: [4],
      terminals: [
        t('AI1', 36, ['ai', 'di'], 'Analog in', '0-10 V; AI block max = value at 13.2 V', { pull: false }),
        ...[39, 34, 35, 32, 33].map((g, i) => t('AI' + (i + 2), g, ['ai', 'di'], 'Analog in', '', { pull: false })),
        relay(1, 16, 'Relay COM/NO/NC, 5 A 250 V AC / 30 V DC'), relay(2, 17),
        relay(3, 18, 'G3MB-202P SSR, AC loads 0.1-2 A'), relay(4, 19),
        io(1, 23), io(2, 25), io(3, 26), io(4, 27), io(5, 13),
        t('IO6', 14, ['di'], 'GPIO', 'input only: pulses at boot'),
      ] },
    // Hardware: hardware/MB-2/README.md. A carrier for a 30-pin DevKit. Its four precise analog inputs
    // (AI1-AI4) are ADS1115 channels on I2C (address 0x48), read with the Sensor value block, so they are not terminals.
    { schema: 1, id: 'eos-mb2', name: 'MB-2 Sensor node + touch + 4 relay', rev: 'A', i2c: { sda: 21, scl: 22 }, onewire: [4],
      terminals: [
        t('IN1', 36, ['ai', 'di'], 'Inputs', '0-3.3 V (0-10 V, 4-20 mA: ADS1115 sensor)', { pull: false }),
        ...[39, 34, 35].map((g, i) => t('IN' + (i + 2), g, ['ai', 'di'], 'Inputs', '0-3.3 V', { pull: false })),
        touch(1, 13), touch(2, 14), touch(3, 15), touch(4, 27), touch(5, 32), touch(6, 33),
        relay(1, 16, 'Relay module header, 5 V'), relay(2, 17), relay(3, 18), relay(4, 19),
        io(1, 23), io(2, 25), io(3, 26),
      ] },
  ];

  // The size limit is in bytes (serialized JSON); text limits are in characters,
  // as the firmware counts them (utf8Len in Board.cpp counts code points).
  const bytes = (s) => new TextEncoder().encode(s).length;
  const chars = (s) => [...s].length;
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const str = (x, min, max) => typeof x === 'string' && chars(x) >= min && chars(x) <= max;
  const given = (x) => x !== undefined && x !== null;  // JSON null counts as absent (ArduinoJson isNull)

  // null when the profile is usable, else the reason. Never trims or repairs a profile.
  function validate(p) {
    if (!isObj(p)) return 'A board profile must be a JSON object';
    let size;
    try { size = bytes(JSON.stringify(p)); } catch { return 'Not valid JSON'; }
    if (size > MAX_BYTES) return 'Profile is too large (' + size + ' bytes, max ' + MAX_BYTES + ')';
    if (p.id === 'bare') {
      if (given(p.terminals) || given(p.i2c) || given(p.onewire)) return 'The id "bare" is reserved for "no profile" and cannot have terminals or buses';
      if (given(p.schema) && p.schema !== 1) return 'Unknown profile schema (expected 1)';
      return null;
    }
    if (p.schema !== 1) return 'Unknown profile schema (expected "schema": 1)';
    if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(p.id)) return 'Profile id must be 1-24 characters a-z, 0-9 or -';
    if (!str(p.name, 1, 40)) return 'Profile name must be 1-40 characters';
    if (given(p.rev) && !str(p.rev, 0, 8)) return 'Profile rev must be at most 8 characters';
    const owner = new Map();  // gpio -> what uses it, to catch double use
    const claim = (g, what) => {
      if (owner.has(g)) return 'GPIO ' + g + ' is used twice (' + owner.get(g) + ' and ' + what + ')';
      owner.set(g, what); return null;
    };
    const outPin = (g) => Number.isInteger(g) && Cat.OUT_PINS.includes(g);
    if (given(p.i2c)) {
      if (!isObj(p.i2c)) return 'i2c must be {"sda": n, "scl": n} or null';
      const { sda, scl } = p.i2c;
      if (!outPin(sda) || !outPin(scl)) return 'I2C SDA and SCL must be output-capable GPIOs';
      if (sda === scl) return 'I2C SDA and SCL must be different pins';
      const e = claim(sda, 'I2C SDA') || claim(scl, 'I2C SCL');
      if (e) return e;
    }
    if (given(p.onewire)) {
      if (!Array.isArray(p.onewire)) return 'onewire must be a list of GPIOs';
      for (const g of p.onewire) {
        if (!outPin(g)) return '1-Wire pins must be output-capable GPIOs (' + g + ' is not)';
        const e = claim(g, '1-Wire');
        if (e) return e;
      }
    }
    if (!Array.isArray(p.terminals)) return 'terminals must be a list';
    if (p.terminals.length > MAX_TERMINALS) return 'At most ' + MAX_TERMINALS + ' terminals';
    const labels = new Set();
    for (const x of p.terminals) {
      if (!isObj(x)) return 'Each terminal must be an object';
      const L = x.label;
      if (typeof L !== 'string' || !/^[A-Za-z0-9_.-]{1,8}$/.test(L)) return 'Terminal label ' + JSON.stringify(L) + ': 1-8 characters A-Z, a-z, 0-9, _ . -';
      if (labels.has(L)) return 'Terminal label ' + L + ' is used twice';
      labels.add(L);
      const g = x.gpio;
      if (!Number.isInteger(g) || !Cat.IN_PINS.includes(g)) return L + ': GPIO ' + g + ' cannot be used (flash, serial or boot pin, or not a GPIO)';
      if (!Array.isArray(x.uses) || !x.uses.length) return L + ': "uses" must list at least one of di, do, ai, pwm, touch';
      for (const u of x.uses) if (!USES.includes(u)) return L + ': unknown use ' + JSON.stringify(u);
      if (new Set(x.uses).size !== x.uses.length) return L + ': a use is listed twice';
      if ((x.uses.includes('do') || x.uses.includes('pwm')) && !Cat.OUT_PINS.includes(g)) return L + ': GPIO ' + g + ' is input-only';
      if (x.uses.includes('ai') && !Cat.ADC_PINS.includes(g)) return L + ': GPIO ' + g + ' has no usable ADC (ADC1: 32-36, 39)';
      if (x.uses.includes('touch') && !Cat.TOUCH_PINS.includes(g)) return L + ': GPIO ' + g + ' has no touch sensor (2, 4, 12-15, 27, 32, 33)';
      if (given(x.active)) {
        if (x.active !== 'high' && x.active !== 'low') return L + ': active must be "high" or "low"';
        if (x.uses.some((u) => u !== 'di' && u !== 'do')) return L + ': a fixed active level only fits di/do terminals';
        if (x.uses.includes('do') && BOOT_PINS.includes(g)) return L + ': GPIO ' + g + ' pulses or is sampled at reset, so a relay there would chatter or stop the board from booting';
      }
      if (given(x.pull) && typeof x.pull !== 'boolean') return L + ': pull must be true or false';
      if (given(x.group) && !str(x.group, 0, 24)) return L + ': group must be at most 24 characters';
      if (given(x.note) && !str(x.note, 0, 48)) return L + ': note must be at most 48 characters';
      const e = claim(g, 'terminal ' + L);
      if (e) return e;
    }
    return null;
  }

  const isBare = (p) => !p || p.id === 'bare';
  const idOf = (p) => (isBare(p) ? 'bare' : p.id);
  // The board a program was made for. Like the firmware: anything but a string (absent, null, a number) = bare.
  const stampOf = (prog) => (prog && typeof prog.board === 'string' ? prog.board : 'bare');
  const CHIP = { di: () => Cat.IN_PINS, do: () => Cat.OUT_PINS, ai: () => Cat.ADC_PINS, pwm: () => Cat.OUT_PINS, touch: () => Cat.TOUCH_PINS };

  function pinsFor(p, use) {
    if (isBare(p)) return CHIP[use]().slice();
    return p.terminals.filter((x) => x.uses.includes(use)).map((x) => x.gpio);
  }
  const terminalOf = (p, gpio) => (isBare(p) ? null : p.terminals.find((x) => x.gpio === Number(gpio)) || null);
  function labelOf(p, gpio) { const x = terminalOf(p, gpio); return x ? x.label : 'GPIO ' + gpio; }
  function fixedInv(p, gpio) { const x = terminalOf(p, gpio); return x && given(x.active) ? (x.active === 'low' ? 1 : 0) : -1; }
  const oneWirePins = (p) => (isBare(p) ? Cat.OUT_PINS.slice() : (p.onewire || []).slice());
  // null for bare too: there the pins come from Settings. Use hasI2c() to ask "is there a bus".
  const i2cOf = (p) => (isBare(p) || !given(p.i2c) ? null : { sda: p.i2c.sda, scl: p.i2c.scl });
  const hasI2c = (p) => isBare(p) || given(p.i2c);
  function busOf(p, gpio) {
    if (isBare(p)) return '';
    const i = i2cOf(p);
    if (i && (gpio === i.sda || gpio === i.scl)) return 'I2C';
    return (p.onewire || []).includes(gpio) ? '1-Wire' : '';
  }

  // Same message shapes as EspHal::pinProblem's profile part; null = fine (chip rules are checked first by the caller).
  function pinProblem(p, gpio, use) {
    if (isBare(p)) return null;
    const x = terminalOf(p, gpio);
    if (!x) { const bus = busOf(p, gpio); return bus ? 'is the ' + bus + ' bus on this board' : 'is not wired to a terminal on this board'; }
    if (!x.uses.includes(use)) return '(' + x.label + ') on this board is ' + x.uses.map((u) => USE_NAME[u]).join(' / ') + ' only';
    return null;
  }

  // Moves a program to another board: by terminal label, else same GPIO, else no pin (the user picks one).
  const IO_USE = { DI: 'di', DO: 'do', AI: 'ai', AO: 'pwm', TOUCH: 'touch' };
  function retarget(prog0, from, to) {
    const prog = JSON.parse(JSON.stringify(prog0));
    const notes = [];
    const fromP = isBare(from) ? null : from;
    for (const b of prog.blocks || []) {
      const use = IO_USE[b.type];
      if (!use) continue;
      b.p = b.p || {};
      const had = b.p.pin === undefined || b.p.pin === '' || b.p.pin === null ? null : Number(b.p.pin);
      const ft = had === null ? null : terminalOf(fromP, had);
      const byLabel = ft && !isBare(to) ? to.terminals.find((x) => x.label === ft.label && x.uses.includes(use)) : null;
      const allowed = pinsFor(to, use);
      let pin = null;
      if (byLabel) pin = byLabel.gpio;
      else if (had !== null && allowed.includes(had)) pin = had;
      const was = had === null ? 'no pin' : labelOf(fromP, had) + (ft ? ' (GPIO ' + had + ')' : '');
      if (pin === null) {
        delete b.p.pin;
        if (had !== null) notes.push(`B${b.id}: ${was} does not exist on ${to.name || idOf(to)}; pick a terminal.`);
        else notes.push(`B${b.id}: pick a terminal.`);
      } else {
        b.p.pin = pin;
        if (pin !== had) notes.push(`B${b.id}: ${was} → ${labelOf(to, pin)} (GPIO ${pin}).`);
      }
      if (pin !== null && (b.type === 'DI' || b.type === 'DO')) {
        const fi = fixedInv(to, pin), tt = terminalOf(to, pin), name = labelOf(to, pin);
        const inv = Number(b.p.inv) ? 1 : 0;
        if (fi >= 0) {
          if (inv !== fi) { b.p.inv = fi; notes.push(`B${b.id}: Invert ${fi ? 'on' : 'off'}, ${name} is active-${fi ? 'low' : 'high'}.`); }
        } else if (ft && given(ft.active) && inv) {
          // The old board forced Invert (an opto input or active-low relay); the new terminal does not.
          b.p.inv = 0;
          notes.push(`B${b.id}: Invert was set by ${ft.label} on ${from.name || idOf(from)}; it is now off on ${name}. Check it matches your wiring.`);
        }
        if (b.type === 'DI') {
          const pull = Number(b.p.pull) ? 1 : 0;
          if (tt && typeof tt.pull === 'boolean') {
            if (pull !== (tt.pull ? 1 : 0)) { b.p.pull = tt.pull ? 1 : 0; notes.push(`B${b.id}: internal pull-up ${tt.pull ? 'on' : 'off'} for ${tt.label}.`); }
          } else if (ft && typeof ft.pull === 'boolean' && !pull && Cat.OUT_PINS.includes(pin)) {
            // Back to the DI default (pull-up on); input-only pins 34-39 have no internal pull.
            b.p.pull = 1;
            notes.push(`B${b.id}: internal pull-up was turned off by ${ft.label} on ${from.name || idOf(from)}; it is on again for ${name}. Check it matches your wiring.`);
          }
        }
      }
    }
    const ow = oneWirePins(to);
    for (const d of prog.devices || []) {
      if (d.driver === 'DS18B20' && !ow.includes(Number(d.pin))) {
        if (ow.length) { notes.push(`Sensor ${d.name || d.driver}: 1-Wire data moved from GPIO ${d.pin} to GPIO ${ow[0]}.`); d.pin = ow[0]; }
        else notes.push(`Sensor ${d.name || d.driver}: ${to.name || idOf(to)} has no 1-Wire pin; remove the sensor.`);
      } else if (d.driver !== 'DS18B20' && !hasI2c(to)) notes.push(`Sensor ${d.name || d.driver}: ${to.name || idOf(to)} has no I2C bus; remove the sensor.`);
    }
    if (isBare(to)) delete prog.board; else prog.board = to.id;  // no stamp = bare, as before profiles existed
    return { prog, notes };
  }

  const api = { PRESETS, BARE, USES, USE_NAME, BOOT_PINS, validate, isBare, idOf, stampOf, pinsFor, terminalOf, labelOf, fixedInv,
    oneWirePins, i2cOf, hasI2c, busOf, pinProblem, retarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Boards = api;
})(this);
