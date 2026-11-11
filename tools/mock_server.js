// Fake EspressOS board for UI development: node tools/mock_server.js [port] [--configured]
// Serves web/ and implements the REST API with the JS engine. No WebSocket,
// so the UI falls back to polling /api/monitor (also exercises that path).
// Mirrors the firmware's request rules: writes need the X-EOS header (and a same-host
// Origin when a browser sends one), and in setup mode (no admin password yet) only
// POST /api/config is accepted. It does NOT implement HTTP Basic auth: --configured
// just skips setup mode. A board profile (POST /api/board) applies at once, no reboot.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine, NullHal } = require('../web/js/sim.js');
const Boards = require('../web/js/boards.js');
const Catalog = require('../web/js/catalog.js');

const PORT = Number(process.argv[2]) || 8080;
const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const vin = new Array(16).fill(0);
let devices = [];
class MockHal extends NullHal {
  readVirtual(i) { return vin[i] || 0; }
  readDigital(pin) { return Math.floor(Date.now() / 3000) % 2 === 1 && pin === 4; } // GPIO4 toggles every 3 s
  readAnalog() { return 2048 + Math.sin(Date.now() / 4000) * 1500; }
  readSensor(dev, ch) {
    const d = devices.find((x) => x.id === dev);
    if (!d) return { ok: false, v: 0 };
    const base = { BME280: [25.5, 38, 1013], SHT31: [21, 50], BH1750: [300], ADS1115: [1, 2, 3, 0.5], DS18B20: [18], I2C_GENERIC: [42] }[d.driver] || [0];
    return { ok: true, v: base[ch] + Math.sin(Date.now() / 7000 + ch) * 3 };
  }
  timeOfDay() { const d = new Date(); return { dow: d.getDay(), m: d.getHours() * 60 + d.getMinutes() }; }
  get i2c() { return i2cCfg; }  // bare-board I2C pins from Settings, for Engine.load's bus check
}
const engine = new Engine(new MockHal());
engine.hal.board = Boards.BARE;  // checked by engine.load like the firmware's deploy()
let program = { version: 1, cycleMs: 10, blocks: [], wires: [], devices: [] };
let lastError = '';
let hasAdminPass = process.argv.includes('--configured');
let mqtt = { host: '', port: 1883, user: '', pass: '', base: '', ha: true, haPrefix: 'homeassistant' };
const mqttPublic = () => ({ host: mqtt.host, port: mqtt.port, user: mqtt.user, hasPass: !!mqtt.pass, base: mqtt.base, defaultBase: 'espressos/mock', ha: mqtt.ha, haPrefix: mqtt.haPrefix });
const validI2c = (a, b) => a !== b && [a, b].every((p) => Number.isInteger(p) && Catalog.OUT_PINS.includes(p));
let i2cCfg = { sda: 21, scl: 22 };  // Settings; a board profile overrides it
const bare = () => Boards.isBare(engine.hal.board);
const i2cNow = () => (bare() ? i2cCfg : Boards.i2cOf(engine.hal.board) || { sda: -1, scl: -1 });
const t0 = Date.now();
setInterval(() => engine.scan(Date.now() - t0), 10);

function body(req) {
  return new Promise((res) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => res(s)); });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const routes = {
  'GET /api/info': () => ({ version: '0.1.0-mock', uptime: Math.round((Date.now() - t0) / 1000), heap: 182000, ap: false, ip: '127.0.0.1', rssi: -55,
    host: 'mock', setup: !hasAdminPass, mqtt: mqtt.host ? 'cannot reach the broker (retrying)' : 'off', running: engine.running, blocks: engine.blocks.length, cycleMs: engine.cycleMs, cycles: engine.cycles, error: lastError, timeSynced: true,
    board: { id: Boards.idOf(engine.hal.board), name: engine.hal.board.name || '' }, boardError: '' }),
  'GET /api/board': () => (bare() ? { schema: 1, ...Boards.BARE } : engine.hal.board),
  'POST /api/board': (b) => {
    if (Buffer.byteLength(b) > 4096) return { status: 400, body: { ok: false, err: 'Profile is too large (max 4096 bytes)' } };
    let p; try { p = JSON.parse(b); } catch (e) { return { status: 400, body: { ok: false, err: 'JSON: ' + e.message } }; }
    const err = Boards.validate(p);
    if (err) return { status: 400, body: { ok: false, err } };
    if (!Boards.isBare(p) && p.id === Boards.idOf(engine.hal.board))
      return { status: 400, body: { ok: false, err: `This board already uses a profile with the id "${p.id}". A changed profile needs a new id, so programs made for the old wiring do not run on it.` } };
    engine.stop();  // the real board reboots; the stored program then waits for a deploy stamped for this board
    engine.hal.board = Boards.isBare(p) ? Boards.BARE : p;
    return { ok: true };
  },
  'GET /api/program': () => program,
  'POST /api/program': (b) => {
    let p; try { p = JSON.parse(b); } catch (e) { return { status: 400, body: { ok: false, err: 'JSON: ' + e.message } }; }
    const known = ['BME280', 'SHT31', 'BH1750', 'DS18B20', 'ADS1115', 'I2C_GENERIC'];
    const bad = (p.devices || []).find((d) => !known.includes(d.driver));
    if (bad) return { status: 400, body: { ok: false, err: `Driver '${bad.driver}' is not built into this firmware` } };
    const err = engine.load(p);
    if (err) { lastError = err; return { status: 400, body: { ok: false, err } }; }
    program = p; devices = p.devices || []; lastError = ''; engine.run();
    return { ok: true };
  },
  'POST /api/run': () => { const err = engine.run(); if (err) { lastError = err; return { status: 400, body: { ok: false, err } }; } return { ok: true }; },
  'POST /api/stop': () => { engine.stop(); return { ok: true }; },
  'POST /api/vin': (b) => { const d = JSON.parse(b); vin[d.idx] = Number(d.value); return { ok: true }; },
  'GET /api/monitor': () => {
    const s = engine.snapshot();
    s.v = vin;
    s.dev = devices.map((d) => { const n = { BME280: 3, SHT31: 2, ADS1115: 4 }[d.driver] || 1; return { id: d.id, driver: d.driver, ok: true, v: [...Array(n)].map((_, c) => engine.hal.readSensor(d.id, c).v) }; });
    return s;
  },
  'GET /api/drivers': () => ['BME280', 'SHT31', 'BH1750', 'DS18B20', 'ADS1115', 'I2C_GENERIC'],
  'GET /api/i2c/scan': () => (i2cNow().sda < 0 ? { sda: -1, scl: -1, found: [], error: 'This board has no I2C bus' } : { ...i2cNow(), found: [0x23, 0x3c, 0x76] }),
  'GET /api/config': () => ({ ssid: 'HomeWifi', host: 'mock', tz: 'CET-1CEST,M3.5.0,M10.5.0/3', ...i2cNow(), ...(bare() ? {} : { i2cFixed: true }), hasAdminPass, apKey: hasAdminPass ? 'k7mq2xw9hpta' : '', mqtt: mqttPublic() }),
  'POST /api/config': (b) => {
    let d; try { d = JSON.parse(b); } catch { return { status: 400, body: { ok: false, err: 'Bad JSON' } }; }
    if (!hasAdminPass && !d.adminPass) return { status: 400, body: { ok: false, err: 'Choose an admin password first' } };
    if (d.adminPass !== undefined && String(d.adminPass).length < 8) return { status: 400, body: { ok: false, err: 'Admin password needs at least 8 characters' } };
    if (!bare() && (d.sda !== undefined || d.scl !== undefined)) {
      const now = i2cNow();
      if ((d.sda !== undefined && d.sda !== now.sda) || (d.scl !== undefined && d.scl !== now.scl)) return { status: 400, body: { ok: false, err: 'The I2C pins are fixed by the board profile' } };
    } else if (!validI2c(d.sda ?? i2cCfg.sda, d.scl ?? i2cCfg.scl)) return { status: 400, body: { ok: false, err: 'I2C pins must be two different output-capable GPIOs (not 6-11 or 34-39)' } };
    if (d.mqtt) {
      const m = { ...mqtt, ...d.mqtt };
      if (!/^[A-Za-z0-9._-]{0,64}$/.test(m.host)) return { status: 400, body: { ok: false, err: "MQTT broker: use a host name or IP address (letters, digits, '.', '-')" } };
      if (!(m.port >= 1 && m.port <= 65535)) return { status: 400, body: { ok: false, err: 'MQTT port must be 1-65535' } };
      if (/[+#]/.test(m.base) || /[+#]/.test(m.haPrefix)) return { status: 400, body: { ok: false, err: 'MQTT base topic: at most 64 characters, no + or #' } };
      if (!m.user) m.pass = '';
      m.haPrefix = m.haPrefix || 'homeassistant';
      mqtt = m;
    }
    if (d.adminPass) hasAdminPass = true;
    if (bare() && d.sda !== undefined) i2cCfg = { sda: d.sda ?? i2cCfg.sda, scl: d.scl ?? i2cCfg.scl };
    return { ok: true };
  },
  'POST /api/reboot': () => ({ ok: true }),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
    const origin = req.headers.origin;  // browsers send it; it must name this server (cross-site guard)
    if (origin && origin.replace(/^[a-z]+:\/\//i, '').toLowerCase() !== String(req.headers.host).toLowerCase()) return json(res, 403, { ok: false, err: 'Cross-site request blocked' });
    if (!req.headers['x-eos']) return json(res, 403, { ok: false, err: 'Missing X-EOS header' });
    if (!hasAdminPass && url.pathname !== '/api/config') return json(res, 403, { ok: false, err: 'Set an admin password first (Settings)' });
  }
  if (routes[key]) {
    const r = routes[key](await body(req));
    return r && r.status ? json(res, r.status, r.body) : json(res, 200, r);
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return json(res, 404, { ok: false, err: 'not found' });
  const file = path.join(WEB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`EspressOS mock board on http://localhost:${PORT}`));
