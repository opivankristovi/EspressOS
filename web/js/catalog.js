// Block and sensor-driver catalogue. Keep in sync with
// firmware/lib/engine/src/Blocks.cpp and firmware/src/Sensors.cpp.
(function (root) {
  'use strict';

  // ESP32-WROOM dev board pins (6-11 are flash and never offered).
  const OUT_PINS = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
  const IN_PINS = OUT_PINS.concat([34, 35, 36, 39]).sort((a, b) => a - b);
  const ADC_PINS = [32, 33, 34, 35, 36, 39]; // ADC1 only: ADC2 is unusable while Wi-Fi is on

  const d = (n) => ({ n, t: 'd' });
  const a = (n) => ({ n, t: 'a' });
  const pin = (list, def) => ({ key: 'pin', label: 'GPIO', type: 'select', options: list.map((p) => [p, 'GPIO ' + p]), def });
  const num = (key, label, def, unit, step) => ({ key, label, type: 'number', def, unit, step });
  const bool = (key, label, def) => ({ key, label, type: 'bool', def: def ? 1 : 0 });

  const BLOCKS = [
    // ---- inputs / outputs
    { type: 'DI', cat: 'io', label: 'Digital input', sym: 'I', ins: [], outs: [d('Q')],
      params: [pin(IN_PINS, 4), bool('pull', 'Internal pull-up', 1), bool('inv', 'Invert', 0)],
      sum: (p) => 'GPIO ' + p.pin + (p.inv ? ' inv' : ''),
      help: 'Reads a GPIO pin. With pull-up enabled, wire a button between the pin and GND and tick Invert.' },
    { type: 'DO', cat: 'io', label: 'Digital output', sym: 'Q', ins: [d('')], outs: [],
      params: [pin(OUT_PINS, 2), bool('inv', 'Invert (active-low relay)', 0)],
      sum: (p) => 'GPIO ' + p.pin + (p.inv ? ' inv' : ''),
      help: 'Drives a GPIO pin (LED, relay, MOSFET). When the program stops, the pin is released.' },
    { type: 'AI', cat: 'io', label: 'Analog input', sym: 'AI', ins: [], outs: [a('')],
      params: [pin(ADC_PINS, 34), num('min', 'Value at 0 V', 0), num('max', 'Value at 3.3 V', 100)],
      sum: (p) => 'GPIO ' + p.pin, help: 'ADC reading scaled linearly to min..max. Only ADC1 pins work while Wi-Fi is on.' },
    { type: 'AO', cat: 'io', label: 'PWM output', sym: 'AQ', ins: [a('%')], outs: [],
      params: [pin(OUT_PINS, 25), num('freq', 'Frequency', 1000, 'Hz')],
      sum: (p) => 'GPIO ' + p.pin, help: 'PWM duty cycle 0-100 % (dimming, fans, servo-less motors).' },
    { type: 'VIN', ui: 'VSWITCH', cat: 'io', label: 'Web switch', sym: 'V', ins: [], outs: [d('Q')],
      params: [num('idx', 'Slot (0-15)', 0, '', 1), { key: 'mode', label: 'Type', type: 'select', options: [['switch', 'Toggle switch'], ['button', 'Push button']], def: 'switch' }, { key: 'name', label: 'Label', type: 'text', def: 'Switch' }],
      sum: (p) => p.name || 'V' + p.idx, help: 'A switch or push button on the Live panel. No wiring needed.' },
    { type: 'VIN', ui: 'VSLIDER', cat: 'io', label: 'Web setpoint', sym: 'V#', ins: [], outs: [a('')],
      params: [num('idx', 'Slot (0-15)', 1, '', 1), num('min', 'Min', 0), num('max', 'Max', 100), num('step', 'Step', 0.5), { key: 'name', label: 'Label', type: 'text', def: 'Setpoint' }],
      sum: (p) => p.name || 'V' + p.idx, help: 'A number you set from the Live panel, e.g. a temperature setpoint.' },
    { type: 'CONST', cat: 'io', label: 'Constant', sym: 'K', ins: [], outs: [a('')], params: [num('value', 'Value', 0)],
      sum: (p) => String(p.value) },
    { type: 'SENSOR', cat: 'sensor', label: 'Sensor value', sym: '◉', ins: [], outs: [a('val'), d('ok')],
      params: [{ key: 'dev', label: 'Device', type: 'device', def: 0 }, { key: 'ch', label: 'Channel', type: 'channel', def: 0 }],
      help: 'Reads one channel of a sensor configured on the Devices tab. "ok" is low when the sensor does not answer.' },

    // ---- logic
    { type: 'AND', cat: 'logic', label: 'AND', sym: '&', ins: [d(''), d(''), d(''), d('')], outs: [d('')], params: [],
      help: 'High when all connected inputs are high.' },
    { type: 'OR', cat: 'logic', label: 'OR', sym: '≥1', ins: [d(''), d(''), d(''), d('')], outs: [d('')], params: [],
      help: 'High when at least one input is high.' },
    { type: 'NOT', cat: 'logic', label: 'NOT', sym: '1', invOut: true, ins: [d('')], outs: [d('')], params: [] },
    { type: 'NAND', cat: 'logic', label: 'NAND', sym: '&', invOut: true, ins: [d(''), d(''), d(''), d('')], outs: [d('')], params: [] },
    { type: 'NOR', cat: 'logic', label: 'NOR', sym: '≥1', invOut: true, ins: [d(''), d(''), d(''), d('')], outs: [d('')], params: [] },
    { type: 'XOR', cat: 'logic', label: 'XOR', sym: '=1', ins: [d(''), d(''), d(''), d('')], outs: [d('')], params: [],
      help: 'High when an odd number of inputs is high.' },
    { type: 'SR', cat: 'logic', label: 'Latch (SR)', sym: 'RS', ins: [d('S'), d('R')], outs: [d('Q')],
      params: [{ key: 'prio', label: 'When S and R are both high', type: 'select', options: [['R', 'Reset wins'], ['S', 'Set wins']], def: 'R' }],
      help: 'Set/reset memory: S switches on, R switches off.' },
    { type: 'EDGE', cat: 'logic', label: 'Edge detect', sym: '⇅', ins: [d('')], outs: [d('↑'), d('↓')], params: [],
      help: 'One-cycle pulse on the rising (↑) and falling (↓) edge.' },

    // ---- timers
    { type: 'TON', cat: 'timer', label: 'On-delay', sym: '⊓→', ins: [d('Trg')], outs: [d('Q')], params: [num('t', 'Delay', 1, 's', 0.1)],
      sum: (p) => p.t + ' s', timer: 't', help: 'Q switches on after the input has been high for the delay time.' },
    { type: 'TOF', cat: 'timer', label: 'Off-delay', sym: '→⊓', ins: [d('Trg')], outs: [d('Q')], params: [num('t', 'Delay', 1, 's', 0.1)],
      sum: (p) => p.t + ' s', timer: 't', help: 'Q stays on for the delay time after the input goes low (staircase light).' },
    { type: 'TP', cat: 'timer', label: 'Pulse', sym: '⊓', ins: [d('Trg')], outs: [d('Q')], params: [num('t', 'Pulse length', 1, 's', 0.1)],
      sum: (p) => p.t + ' s', timer: 't', help: 'A rising edge gives a pulse of fixed length.' },
    { type: 'BLINK', cat: 'timer', label: 'Blinker', sym: '⊓⊔', ins: [d('En')], outs: [d('Q')],
      params: [num('on', 'On time', 0.5, 's', 0.1), num('off', 'Off time', 0.5, 's', 0.1)],
      sum: (p) => p.on + '/' + p.off + ' s', help: 'Blinks while En is high (or unconnected).' },
    { type: 'WEEK', cat: 'timer', label: 'Weekly timer', sym: '⏲', ins: [], outs: [d('Q')],
      params: [{ key: 'days', label: 'Days', type: 'days', def: 62 }, { key: 'on', label: 'On at', type: 'time', def: 480 }, { key: 'off', label: 'Off at', type: 'time', def: 1020 }],
      sum: (p) => fmtTime(p.on) + '-' + fmtTime(p.off), help: 'On between two times on the selected days. Needs Wi-Fi for clock sync (NTP).' },
    { type: 'CTR', cat: 'timer', label: 'Counter', sym: '+/-', ins: [d('Up'), d('Dn'), d('R')], outs: [d('Q'), a('N')],
      params: [num('preset', 'Q on at count', 10, '', 1)], sum: (p) => '≥ ' + p.preset,
      help: 'Counts rising edges on Up/Dn. Q is high when count ≥ preset. R resets.' },

    // ---- analog
    { type: 'CMP', cat: 'analog', label: 'Compare', sym: 'A?B', ins: [a('A'), a('B')], outs: [d('')],
      params: [{ key: 'op', label: 'Condition', type: 'select', options: [['>', 'A > B'], ['>=', 'A ≥ B'], ['<', 'A < B'], ['<=', 'A ≤ B'], ['==', 'A = B'], ['!=', 'A ≠ B']], def: '>' }, num('b', 'B when unconnected', 0)],
      sum: (p) => 'A ' + p.op + ' ' + p.b },
    { type: 'THRESH', cat: 'analog', label: 'Threshold', sym: '⌇', ins: [a('')], outs: [d('')],
      params: [num('on', 'On at', 25), num('off', 'Off at', 23)], sum: (p) => p.on + ' / ' + p.off,
      help: 'Threshold switch with hysteresis. If On > Off it switches on above On (cooling); if On < Off it switches on below On (heating).' },
    { type: 'MATH', cat: 'analog', label: 'Math', sym: 'f(x)', ins: [a('A'), a('B')], outs: [a('')],
      params: [{ key: 'op', label: 'Operation', type: 'select', options: [['+', 'A + B'], ['-', 'A − B'], ['*', 'A × B'], ['/', 'A ÷ B'], ['min', 'min(A,B)'], ['max', 'max(A,B)']], def: '+' }, num('b', 'B when unconnected', 0)],
      sum: (p) => 'A ' + p.op + ' B' },
    { type: 'SCALE', cat: 'analog', label: 'Scale', sym: '↗', ins: [a('')], outs: [a('')],
      params: [num('inMin', 'In min', 0), num('inMax', 'In max', 4095), num('outMin', 'Out min', 0), num('outMax', 'Out max', 100), bool('clamp', 'Clamp', 1)],
      sum: (p) => p.outMin + '…' + p.outMax },
    { type: 'SEL', cat: 'analog', label: 'Select', sym: 'MUX', ins: [a('A'), a('B'), d('S')], outs: [a('')], params: [],
      help: 'Output is B when S is high, A otherwise.' },
  ];

  const CATS = [['io', 'Inputs & outputs'], ['sensor', 'Sensors'], ['logic', 'Logic'], ['timer', 'Timers & counters'], ['analog', 'Analog']];

  const DRIVERS = [
    { id: 'BME280', label: 'BME280 temp / humidity / pressure', bus: 'i2c', addrs: [0x76, 0x77],
      ch: [['Temperature', '°C'], ['Humidity', '%'], ['Pressure', 'hPa']] },
    { id: 'SHT31', label: 'SHT3x temp / humidity', bus: 'i2c', addrs: [0x44, 0x45], ch: [['Temperature', '°C'], ['Humidity', '%']] },
    { id: 'BH1750', label: 'BH1750 light', bus: 'i2c', addrs: [0x23, 0x5c], ch: [['Light', 'lx']] },
    { id: 'ADS1115', label: 'ADS1115 4-ch 16-bit ADC', bus: 'i2c', addrs: [0x48, 0x49, 0x4a, 0x4b],
      ch: [['A0', 'V'], ['A1', 'V'], ['A2', 'V'], ['A3', 'V']] },
    { id: 'DS18B20', label: 'DS18B20 1-Wire temperature', bus: 'onewire', ch: [['Temperature', '°C']] },
    { id: 'I2C_GENERIC', label: 'Generic I2C register', bus: 'i2c', addrs: [], ch: [['Value', '']], generic: true },
  ];

  function fmtTime(m) {
    m = Number(m) || 0;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  function blockDef(b) {
    if (b.ui) { const f = BLOCKS.find((x) => x.ui === b.ui); if (f) return f; }
    return BLOCKS.find((x) => x.type === b.type && !x.ui) || BLOCKS.find((x) => x.type === b.type);
  }

  function defaults(def) {
    const p = {};
    for (const q of def.params) p[q.key] = q.def;
    return p;
  }

  const api = { BLOCKS, CATS, DRIVERS, OUT_PINS, IN_PINS, ADC_PINS, blockDef, defaults, fmtTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Catalog = api;
})(this);
