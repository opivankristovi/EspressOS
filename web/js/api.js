// Backends: DeviceBackend talks to the ESP32 REST/WebSocket API;
// SimBackend runs the same program in the browser (no hardware needed).
(function (root) {
  'use strict';

  const EMPTY = () => ({ version: 1, cycleMs: 10, blocks: [], wires: [], devices: [] });

  async function http(method, url, body, timeout = 6000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, {
        method, signal: ctl.signal,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch { data = txt; }
      if (!r.ok && !(data && data.err)) throw new Error('HTTP ' + r.status);
      return data;
    } finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------ device
  class DeviceBackend {
    constructor() { this.kind = 'device'; this.listeners = []; this.ws = null; this.pollTimer = null; }
    info() { return http('GET', '/api/info'); }
    async getProgram() { const p = await http('GET', '/api/program'); return typeof p === 'object' ? p : EMPTY(); }
    deploy(prog) { return http('POST', '/api/program', prog, 15000); }
    run() { return http('POST', '/api/run'); }
    stop() { return http('POST', '/api/stop'); }
    setVin(idx, value) { return http('POST', '/api/vin', { idx, value }); }
    scanI2C() { return http('GET', '/api/i2c/scan', undefined, 15000); }
    drivers() { return http('GET', '/api/drivers'); }
    getConfig() { return http('GET', '/api/config'); }
    setConfig(c) { return http('POST', '/api/config', c); }
    reboot() { return http('POST', '/api/reboot'); }
    ota(file, onProgress) {
      return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('update', file, file.name);
        const x = new XMLHttpRequest();
        x.open('POST', '/api/ota');
        x.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
        x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch { reject(new Error('HTTP ' + x.status)); } };
        x.onerror = () => reject(new Error('Upload failed'));
        x.send(fd);
      });
    }
    subscribe(cb) {
      this.listeners.push(cb);
      if (!this.ws && !this.pollTimer) this._connect();
    }
    _emit(d) { for (const l of this.listeners) l(d); }
    _connect() {
      let opened = false;
      try {
        const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        this.ws = new WebSocket(proto + location.host + '/ws');
      } catch { return this._poll(); }
      this.ws.onopen = () => { opened = true; };
      this.ws.onmessage = (e) => { try { this._emit(JSON.parse(e.data)); } catch { /* ignore partial */ } };
      this.ws.onclose = () => {
        this.ws = null;
        if (!opened) this._poll();                 // no WebSocket support: fall back to polling
        else setTimeout(() => this._connect(), 2000);
        this._emit(null);
      };
    }
    _poll() {
      if (this.pollTimer) return;
      this.pollTimer = setInterval(async () => {
        try { this._emit(await http('GET', '/api/monitor', undefined, 2000)); } catch { this._emit(null); }
      }, 500);
    }
  }

  // ------------------------------------------------------------ simulation
  class SimHal extends root.Sim.NullHal {
    constructor(be) { super(); this.be = be; this.din = {}; this.ain = {}; this.dout = {}; this.pwm = {}; }
    readDigital(p) { return !!this.din[p]; }
    writeDigital(p, v) { this.dout[p] = v ? 1 : 0; }
    readAnalog(p) { return this.ain[p] || 0; }
    writePwm(p, d) { this.pwm[p] = d; }
    readVirtual(i) { return this.be.vin[i] || 0; }
    readSensor(dev, ch) { const s = this.be.sensors[dev]; return s ? { ok: true, v: s.v[ch] || 0 } : { ok: false, v: 0 }; }
    timeOfDay() { const d = new Date(); return { dow: d.getDay(), m: d.getHours() * 60 + d.getMinutes() }; }
    safeOutputs() { this.dout = {}; this.pwm = {}; }
  }

  // Plausible starting values per driver channel for simulated sensors.
  const SIM_BASE = { BME280: [21.5, 48, 1013], SHT31: [21.5, 48], BH1750: [320], ADS1115: [1.2, 0.5, 2.4, 3.1], DS18B20: [19.8], I2C_GENERIC: [100] };

  class SimBackend {
    constructor() {
      this.kind = 'sim';
      this.hal = new SimHal(this);
      this.engine = new root.Sim.Engine(this.hal);
      this.vin = new Array(16).fill(0);
      this.sensors = {};  // devId -> {driver, v:[...], manual:bool}
      this.listeners = [];
      this.t0 = performance.now();
      this.prog = EMPTY();
      try { const s = localStorage.getItem('eos.sim.program'); if (s) this.prog = JSON.parse(s); } catch { /* storage unavailable */ }
      this._apply(this.prog);
      this.engine.run();
      this._tick = this._tick.bind(this);
      this.timer = setInterval(this._tick, 10);
      setInterval(() => this._emit(), 200);
    }
    _now() { return Math.round(performance.now() - this.t0); }
    _tick() {
      const now = this._now();
      // let simulated sensors drift slowly unless the user set them by hand
      for (const [id, s] of Object.entries(this.sensors)) {
        if (s.manual) continue;
        const base = SIM_BASE[s.driver] || [0];
        s.v = base.map((b, i) => +(b + Math.sin(now / 9000 + i + Number(id)) * Math.max(0.5, Math.abs(b) * 0.08)).toFixed(2));
      }
      this.engine.scan(now);
    }
    _apply(prog) {
      const err = this.engine.load(prog);
      if (err) return err;
      const keep = this.sensors; this.sensors = {};
      for (const d of prog.devices || []) this.sensors[d.id] = keep[d.id] && keep[d.id].driver === d.driver ? keep[d.id] : { driver: d.driver, v: [], manual: false };
      return null;
    }
    snapshot() {
      const s = this.engine.snapshot();
      s.v = this.vin.slice();
      s.dev = (this.prog.devices || []).map((d) => ({ id: d.id, driver: d.driver, ok: true, v: (this.sensors[d.id] || { v: [] }).v }));
      s.sim = { din: { ...this.hal.din }, ain: { ...this.hal.ain }, dout: { ...this.hal.dout }, pwm: { ...this.hal.pwm } };
      return s;
    }
    _emit() { const s = this.snapshot(); for (const l of this.listeners) l(s); }
    subscribe(cb) { this.listeners.push(cb); cb(this.snapshot()); }

    async info() {
      return { version: 'simulator', uptime: Math.round(this._now() / 1000), ap: false, ip: '-', host: 'simulator', heap: 0,
        running: this.engine.running, blocks: this.engine.blocks.length, cycleMs: this.engine.cycleMs, cycles: this.engine.cycles, error: '', timeSynced: true };
    }
    async getProgram() { return JSON.parse(JSON.stringify(this.prog)); }
    async deploy(prog) {
      const err = this._apply(prog);
      if (err) return { ok: false, err };
      this.prog = JSON.parse(JSON.stringify(prog));
      try { localStorage.setItem('eos.sim.program', JSON.stringify(prog)); } catch { /* ignore */ }
      this.engine.run();
      this._emit();
      return { ok: true };
    }
    async run() { this.engine.run(); this._emit(); return { ok: true }; }
    async stop() { this.engine.stop(); this._emit(); return { ok: true }; }
    async setVin(idx, value) { this.vin[idx] = value; this._tick(); this._emit(); return { ok: true }; }
    async scanI2C() {
      const found = (this.prog.devices || []).filter((d) => d.addr).map((d) => d.addr);
      return { sda: 21, scl: 22, found: found.length ? found : [0x76, 0x23] };
    }
    async drivers() { return root.Catalog.DRIVERS.map((d) => d.id); }
    async getConfig() { return { ssid: '', host: 'espressos', tz: 'CET-1CEST,M3.5.0,M10.5.0/3', sda: 21, scl: 22, hasAdminPass: false }; }
    async setConfig() { return { ok: false, err: 'Not available in simulation mode' }; }
    async reboot() { return { ok: false, err: 'Not available in simulation mode' }; }
    async ota() { return { ok: false, err: 'Not available in simulation mode' }; }
    // simulation-only inputs
    setDin(pin, v) { this.hal.din[pin] = v ? 1 : 0; this._tick(); this._emit(); }
    setAin(pin, raw) { this.hal.ain[pin] = raw; }
    setSensor(dev, ch, v) { const s = this.sensors[dev]; if (s) { s.manual = true; s.v[ch] = v; } }
  }

  async function connect() {
    const forceSim = /[?&]sim\b/.test(location.search) || location.protocol === 'file:';
    if (!forceSim) {
      try {
        const be = new DeviceBackend();
        const info = await http('GET', '/api/info', undefined, 2500);
        if (info && typeof info === 'object' && 'version' in info) return be;
      } catch { /* no board */ }
    }
    return new SimBackend();
  }

  root.Api = { connect, EMPTY };
})(this);
