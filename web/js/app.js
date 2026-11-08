// EspressOS web app: wires the editor, side panels, sensors page and settings to a backend.
(function () {
  'use strict';
  const C = window.Catalog;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
    return e;
  };
  const hex = (a) => '0x' + Number(a).toString(16).padStart(2, '0').toUpperCase();
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  let be;                 // backend
  let editor;
  let deployedJson = '';  // program as last deployed / loaded from board
  let snap = null;        // latest monitor snapshot
  let liveKey = '';       // structure key of live panel
  let builtDrivers = null;

  // ------------------------------------------------------------ helpers
  let toastTimer;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 2500);
  }
  const progJson = (p) => JSON.stringify(p);
  function devLabel(d) { return d ? (d.name || d.driver) + ' #' + d.id : '(none)'; }
  function driverOf(devId) {
    const d = editor.prog.devices.find((x) => x.id === Number(devId));
    return d ? C.DRIVERS.find((x) => x.id === d.driver) : null;
  }

  // ------------------------------------------------------------ tabs
  function initTabs() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
      if (b.dataset.tab === 'devices') renderDevices();
      if (b.dataset.tab === 'settings') loadSettings();
      if (b.dataset.tab === 'editor') editor.render();
    }));
    $$('.sidetab').forEach((b) => b.addEventListener('click', () => showSide(b.dataset.side)));
  }
  function showSide(name) {
    $$('.sidetab').forEach((x) => x.classList.toggle('active', x.dataset.side === name));
    $$('.sidepane').forEach((p) => p.classList.toggle('active', p.id === 'side-' + name));
  }

  // ------------------------------------------------------------ palette
  function initPalette() {
    const pal = $('#palette');
    for (const [cat, title] of C.CATS) {
      pal.append(h('h4', {}, title));
      for (const d of C.BLOCKS.filter((b) => b.cat === cat)) {
        const key = d.ui || d.type;
        const it = h('div', { class: 'pitem cat-' + cat, draggable: 'true', title: (d.help || d.label) + '\n(drag onto the sheet or click to add)' },
          h('span', { class: 'psym' }, d.sym), h('span', {}, d.label));
        it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-eos-block', key); e.dataTransfer.effectAllowed = 'copy'; });
        it.addEventListener('click', () => { const c = editor.centerWorld(); editor.addBlock(d, c.x + Math.random() * 40, c.y + Math.random() * 40); });
        pal.append(it);
      }
    }
  }

  // ------------------------------------------------------------ block summary text on the canvas
  function summary(b, d) {
    if (d.type === 'SENSOR') {
      const dev = editor.prog.devices.find((x) => x.id === Number(b.p.dev));
      if (!dev) return 'no device';
      const drv = C.DRIVERS.find((x) => x.id === dev.driver);
      const ch = drv && drv.ch[b.p.ch];
      return (dev.name || dev.driver) + (ch ? ' · ' + ch[0] : '');
    }
    return d.sum ? d.sum(b.p) : '';
  }

  // ------------------------------------------------------------ properties panel
  function renderProps(b) {
    const pane = $('#side-props');
    pane.textContent = '';
    if (!b) {
      pane.append(
        h('h3', {}, 'Nothing selected'),
        h('p', { class: 'help' }, 'Click a block to edit its settings. Drag from a block output (right side) to an input (left side) to wire them. Drag a wire off an input to remove it.'),
        h('h3', {}, 'Shortcuts'),
        h('p', { class: 'help' }, 'Del: delete · Ctrl+D: duplicate · Ctrl+Z / Ctrl+Y: undo/redo · Ctrl+S: deploy · wheel: zoom · drag background: pan'),
        renderIssuesBox());
      return;
    }
    const d = C.blockDef(b);
    pane.append(h('div', { class: 'ptitle cat-' + d.cat }, h('span', { class: 'badge' }, 'B' + b.id), d.label));
    if (d.help) pane.append(h('p', { class: 'help' }, d.help));

    const p = { ...b.p };
    const commit = () => editor.updateParams(b.id, { ...p });
    for (const q of d.params) {
      if (q.type === 'number') {
        pane.append(h('label', {}, q.label + (q.unit ? ' (' + q.unit + ')' : ''),
          h('input', { type: 'number', step: q.step || 'any', value: p[q.key], onchange: (e) => { p[q.key] = e.target.value === '' ? q.def : Number(e.target.value); commit(); } })));
      } else if (q.type === 'text') {
        pane.append(h('label', {}, q.label, h('input', { value: p[q.key] || '', onchange: (e) => { p[q.key] = e.target.value; commit(); } })));
      } else if (q.type === 'bool') {
        pane.append(h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!Number(p[q.key]), onchange: (e) => { p[q.key] = e.target.checked ? 1 : 0; commit(); } }), q.label));
      } else if (q.type === 'select') {
        const sel = h('select', { onchange: (e) => { const o = q.options.find((x) => String(x[0]) === e.target.value); p[q.key] = o ? o[0] : e.target.value; commit(); } },
          q.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(p[q.key]) }, l)));
        pane.append(h('label', {}, q.label, sel));
        if (q.key === 'pin') {
          const clash = pinClash(b);
          if (clash) pane.append(h('p', { class: 'help', style: 'color:var(--warn)' }, clash));
        }
      } else if (q.type === 'device') {
        const devs = editor.prog.devices;
        if (!devs.length) {
          pane.append(h('p', { class: 'help' }, 'No sensors configured yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); $('.tab[data-tab=devices]').click(); } }, 'Add one on the Sensors tab.')));
        } else {
          pane.append(h('label', {}, q.label, h('select', { onchange: (e) => { p.dev = Number(e.target.value); p.ch = 0; commit(); renderProps(editor.block(b.id)); } },
            devs.map((x) => h('option', { value: x.id, selected: x.id === Number(p.dev) }, devLabel(x))))));
        }
      } else if (q.type === 'channel') {
        const drv = driverOf(p.dev);
        if (drv) pane.append(h('label', {}, q.label, h('select', { onchange: (e) => { p.ch = Number(e.target.value); commit(); } },
          drv.ch.map(([n, u], i) => h('option', { value: i, selected: i === Number(p.ch) }, n + (u ? ' (' + u + ')' : ''))))));
      } else if (q.type === 'days') {
        const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
        const box = h('div', { class: 'days' });
        names.forEach((n, i) => box.append(h('button', { type: 'button', class: (p.days >> i) & 1 ? 'on' : '', onclick: (e) => { p.days ^= 1 << i; e.target.classList.toggle('on'); commit(); } }, n)));
        pane.append(h('label', {}, q.label, box));
      } else if (q.type === 'time') {
        pane.append(h('label', {}, q.label, h('input', { type: 'time', value: C.fmtTime(p[q.key]), onchange: (e) => { const [hh, mm] = e.target.value.split(':').map(Number); p[q.key] = hh * 60 + mm; commit(); } })));
      }
    }
    pane.append(h('label', {}, 'Comment / name', h('input', { value: b.note || '', placeholder: d.label, onchange: (e) => editor.updateParams(b.id, { ...p }, e.target.value.trim()) })));
    pane.append(h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => editor.duplicateSelection() }, 'Duplicate'),
      h('button', { class: 'btn danger', onclick: () => editor.deleteSelection() }, 'Delete')));
    if (window.matchMedia('(max-width: 900px)').matches) $('.side').classList.add('open');
  }

  function pinClash(b) {
    if (b.p.pin === undefined) return '';
    const others = editor.prog.blocks.filter((x) => x.id !== b.id && ['DI', 'DO', 'AI', 'AO'].includes(x.type) && Number(x.p.pin) === Number(b.p.pin));
    let msg = others.length ? 'GPIO ' + b.p.pin + ' is also used by ' + others.map((x) => 'B' + x.id).join(', ') + '.' : '';
    if ([21, 22].includes(Number(b.p.pin))) msg += ' GPIO 21/22 are the default I²C pins.';
    if (Number(b.p.pin) === 2) msg += ' GPIO 2 is the on-board LED on most dev boards.';
    if ([0, 12, 15].includes(Number(b.p.pin))) msg += ' GPIO ' + b.p.pin + ' is a boot strapping pin; do not pull it high/low at power-up.';
    return msg.trim();
  }

  // ------------------------------------------------------------ validation
  function validate(prog) {
    const out = [];
    const wiredIn = new Set(prog.wires.map((w) => w[2] + '.' + w[3]));
    const pins = {};
    for (const b of prog.blocks) {
      const d = C.blockDef(b);
      if (['DI', 'DO', 'AI', 'AO'].includes(b.type)) {
        const k = Number(b.p.pin);
        const isOut = b.type === 'DO' || b.type === 'AO';
        if (pins[k] && (isOut || pins[k].out)) out.push({ lvl: 'err', msg: `GPIO ${k} used by B${pins[k].id} and B${b.id}` });
        pins[k] = { id: b.id, out: isOut };
      }
      if ((b.type === 'DO' || b.type === 'AO') && !wiredIn.has(b.id + '.0')) out.push({ lvl: 'warn', msg: `B${b.id} ${d.label} has no input wire` });
      if (b.type === 'SENSOR' && !prog.devices.find((x) => x.id === Number(b.p.dev))) out.push({ lvl: 'err', msg: `B${b.id} reads a sensor that does not exist` });
      if (['AND', 'OR', 'XOR', 'NAND', 'NOR', 'NOT', 'SR', 'TON', 'TOF', 'TP', 'EDGE', 'CMP', 'THRESH', 'SCALE'].includes(b.type) && d.ins.every((_, i) => !wiredIn.has(b.id + '.' + i)))
        out.push({ lvl: 'warn', msg: `B${b.id} ${d.label} has no inputs connected` });
    }
    const vins = {};
    for (const b of prog.blocks.filter((x) => x.type === 'VIN')) {
      const i = Number(b.p.idx);
      if (i < 0 || i > 15) out.push({ lvl: 'err', msg: `B${b.id}: web input slot must be 0-15` });
      if (vins[i]) out.push({ lvl: 'warn', msg: `B${vins[i]} and B${b.id} share web input slot ${i}` });
      vins[i] = b.id;
    }
    if (builtDrivers) for (const dv of prog.devices) if (!builtDrivers.includes(dv.driver)) out.push({ lvl: 'err', msg: `Driver ${dv.driver} is not in this firmware` });
    return out;
  }
  function renderIssuesBox() {
    const issues = validate(editor.prog);
    if (!issues.length) return h('p', { class: 'help' }, editor.prog.blocks.length ? '✓ No problems found.' : '');
    return h('div', {}, h('h3', {}, 'Check'), h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: i.lvl }, i.msg))));
  }

  // ------------------------------------------------------------ live panel
  function liveStructureKey() {
    return JSON.stringify([editor.prog.blocks.filter((b) => ['VIN', 'DI', 'AI', 'DO', 'AO'].includes(b.type)).map((b) => [b.id, b.p]), editor.prog.devices, be.kind]);
  }
  function renderLive() {
    const key = liveStructureKey();
    const pane = $('#side-live');
    if (key !== liveKey) {
      liveKey = key;
      pane.textContent = '';
      const prog = editor.prog;
      const vins = prog.blocks.filter((b) => b.type === 'VIN');
      if (vins.length) {
        pane.append(h('h3', {}, 'Controls'));
        for (const b of vins) {
          const idx = Number(b.p.idx), name = b.p.name || 'V' + idx;
          if (b.ui === 'VSLIDER') {
            const out = h('span', { class: 'v', 'data-vin-out': idx });
            pane.append(h('div', { class: 'kv' }, h('span', {}, name), out));
            pane.append(h('input', { type: 'range', class: 'slider', min: b.p.min, max: b.p.max, step: b.p.step || 'any', 'data-vin': idx,
              oninput: (e) => { out.textContent = e.target.value; be.setVin(idx, Number(e.target.value)); } }));
          } else if (b.p.mode === 'button') {
            const btn = h('button', { class: 'pushbtn', 'data-vin': idx }, 'Press');
            const set = (v) => (e) => { e.preventDefault(); btn.classList.toggle('on', !!v); be.setVin(idx, v); };
            btn.addEventListener('pointerdown', set(1)); btn.addEventListener('pointerup', set(0)); btn.addEventListener('pointerleave', (e) => btn.classList.contains('on') && set(0)(e));
            pane.append(h('div', { class: 'kv' }, h('span', {}, name), btn));
          } else {
            pane.append(h('div', { class: 'kv' }, h('span', {}, name),
              h('button', { class: 'switch', 'data-vin': idx, 'aria-label': name, onclick: (e) => be.setVin(idx, e.currentTarget.classList.contains('on') ? 0 : 1) })));
          }
        }
      }
      if (be.kind === 'sim') {
        const dis = prog.blocks.filter((b) => b.type === 'DI'), ais = prog.blocks.filter((b) => b.type === 'AI');
        if (dis.length || ais.length) pane.append(h('h3', {}, 'Simulated inputs'));
        for (const b of dis) pane.append(h('div', { class: 'kv' }, h('span', {}, `B${b.id} ${b.note || 'GPIO ' + b.p.pin}`),
          h('button', { class: 'switch', 'data-din': b.p.pin, onclick: (e) => be.setDin(b.p.pin, !e.currentTarget.classList.contains('on')) })));
        for (const b of ais) {
          pane.append(h('div', { class: 'kv' }, h('span', {}, `B${b.id} ${b.note || 'GPIO ' + b.p.pin}`), h('span', { class: 'v', 'data-ain-out': b.id })));
          pane.append(h('input', { type: 'range', class: 'slider', min: 0, max: 4095, value: be.hal.ain[b.p.pin] || 0, oninput: (e) => be.setAin(b.p.pin, Number(e.target.value)) }));
        }
      }
      const outs = prog.blocks.filter((b) => b.type === 'DO' || b.type === 'AO');
      if (outs.length) {
        pane.append(h('h3', {}, 'Outputs'));
        for (const b of outs) pane.append(h('div', { class: 'kv' }, h('span', {}, `B${b.id} ${b.note || 'GPIO ' + b.p.pin}`),
          b.type === 'DO' ? h('span', { class: 'lamp', 'data-out': b.id }) : h('span', { class: 'v', 'data-out': b.id })));
      }
      if (prog.devices.length) {
        pane.append(h('h3', {}, 'Sensors'));
        for (const d of prog.devices) {
          const drv = C.DRIVERS.find((x) => x.id === d.driver);
          (drv ? drv.ch : []).forEach(([n, u], i) => {
            const row = h('div', { class: 'kv' }, h('span', {}, `${d.name || d.driver} · ${n}`), h('span', { class: 'v', 'data-dev': d.id + '.' + i, 'data-unit': u }));
            if (be.kind === 'sim') {
              row.title = 'Click to type a value (simulation)';
              row.style.cursor = 'pointer';
              row.addEventListener('click', () => { const v = prompt(`Simulated ${n} (${u})`); if (v !== null && v !== '' && !isNaN(v)) be.setSensor(d.id, i, Number(v)); });
            }
            pane.append(row);
          });
        }
      }
      if (!pane.children.length) pane.append(h('p', { class: 'help' }, 'Add web switches, inputs, outputs or sensors to the program to see them here.'));
    }
    if (!snap) return;
    $$('[data-vin]', pane).forEach((e) => {
      const v = snap.v ? snap.v[Number(e.dataset.vin)] : 0;
      if (e.classList.contains('switch')) e.classList.toggle('on', v >= 0.5);
      else if (e.type === 'range' && document.activeElement !== e) e.value = v;
    });
    $$('[data-vin-out]', pane).forEach((e) => (e.textContent = window.fmtVal(snap.v ? snap.v[Number(e.dataset.vinOut)] : 0)));
    if (snap.sim) $$('[data-din]', pane).forEach((e) => e.classList.toggle('on', !!snap.sim.din[e.dataset.din]));
    $$('[data-ain-out]', pane).forEach((e) => { const b = snap.b[e.dataset.ainOut]; e.textContent = b ? window.fmtVal(b[0]) : '–'; });
    $$('[data-out]', pane).forEach((e) => {
      const b = snap.b ? snap.b[e.dataset.out] : null, x = b ? b[b.length - 1] : 0;
      if (e.classList.contains('lamp')) e.classList.toggle('on', x >= 0.5);
      else e.textContent = window.fmtVal(x) + ' %';
    });
    $$('[data-dev]', pane).forEach((e) => {
      const [id, ch] = e.dataset.dev.split('.').map(Number);
      const s = (snap.dev || []).find((x) => x.id === id);
      e.textContent = s && s.ok && s.v[ch] !== undefined ? window.fmtVal(s.v[ch]) + ' ' + e.dataset.unit : (s ? 'no data' : '–');
    });
  }

  // canvas clicks on VIN / simulated DI blocks while live
  function onBlockClick(b, down, moved) {
    if (b.type === 'VIN' && b.ui !== 'VSLIDER') {
      const idx = Number(b.p.idx);
      if (b.p.mode === 'button') be.setVin(idx, down && !moved ? 1 : 0);
      else if (!down && !moved) be.setVin(idx, snap && snap.v && snap.v[idx] >= 0.5 ? 0 : 1);
    } else if (b.type === 'DI' && be.kind === 'sim' && !down && !moved) {
      be.setDin(b.p.pin, !be.hal.din[b.p.pin]);
    }
  }

  // ------------------------------------------------------------ program state
  function onChange(prog) {
    store.set('eos.draft.' + be.kind, progJson(prog));
    updateDirty();
    renderLive();
    if (!editor.sel) renderProps(null);
  }
  function updateDirty() {
    const dirty = progJson(editor.prog) !== deployedJson;
    $('#dirty').hidden = !dirty;
    $('#btnDeploy').classList.toggle('pulse', dirty);
  }

  async function deploy() {
    // commit a field that is still being edited (its change event fires on blur)
    if (document.activeElement && document.activeElement.matches('input, select')) document.activeElement.blur();
    const issues = validate(editor.prog).filter((i) => i.lvl === 'err');
    if (issues.length) { toast(issues[0].msg, true); showSide('props'); editor.select(null); return; }
    $('#btnDeploy').disabled = true;
    try {
      const r = await be.deploy(editor.prog);
      if (r && r.ok) {
        deployedJson = progJson(editor.prog);
        updateDirty();
        toast(be.kind === 'sim' ? 'Running in simulator' : 'Deployed and running');
      } else toast('Rejected: ' + (r && r.err), true);
    } catch (e) { toast('Deploy failed: ' + e.message, true); }
    $('#btnDeploy').disabled = false;
    refreshInfo();
  }

  // ------------------------------------------------------------ status
  async function refreshInfo() {
    try {
      const i = await be.info();
      const conn = $('#conn');
      if (be.kind === 'sim') { conn.textContent = 'Simulator'; conn.className = 'pill sim'; }
      else { conn.textContent = (i.ap ? 'Setup AP · ' : '') + i.host + ' · ' + i.ip; conn.className = 'pill ok'; }
      const rs = $('#runstate');
      rs.textContent = i.running ? 'RUN' : 'STOP';
      rs.className = 'pill ' + (i.running ? 'ok' : 'warn');
      if (i.error) { rs.textContent += ' · error'; rs.className = 'pill bad'; rs.title = i.error; } else rs.title = '';
      const dl = $('#info');
      dl.textContent = '';
      const rows = [['Firmware', i.version], ['Address', i.ip + (i.host ? ' (' + i.host + '.local)' : '')], ['Uptime', fmtUptime(i.uptime)],
        ['Free memory', i.heap ? Math.round(i.heap / 1024) + ' KB' : '–'], ['Program', i.blocks + ' blocks, ' + i.cycleMs + ' ms cycle'],
        ['Clock', i.timeSynced ? 'synced' : 'not synced (weekly timers inactive)'], ['Wi-Fi signal', i.rssi ? i.rssi + ' dBm' : '–']];
      if (i.error) rows.push(['Last error', i.error]);
      for (const [k, v] of rows) dl.append(h('dt', {}, k), h('dd', {}, v));
    } catch {
      $('#conn').textContent = 'Board offline'; $('#conn').className = 'pill bad';
    }
  }
  const fmtUptime = (s) => { s = Number(s) || 0; const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + 'd ' : '') + hh + 'h ' + m + 'm'; };

  // ------------------------------------------------------------ sensors page
  function initDevices() {
    const sel = $('#drvSelect');
    for (const d of C.DRIVERS) sel.append(h('option', { value: d.id }, d.label));
    $('#btnAddDev').addEventListener('click', () => addDevice(sel.value));
    $('#btnScan').addEventListener('click', scanBus);
  }
  function addDevice(driverId, addr) {
    const drv = C.DRIVERS.find((d) => d.id === driverId);
    editor.checkpoint();
    const id = editor.prog.devices.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    const dev = { id, driver: drv.id, name: drv.id.replace('_GENERIC', '') + (id > 1 ? ' ' + id : ''), poll: 2 };
    if (drv.bus === 'i2c') dev.addr = addr || drv.addrs[0] || 0x40;
    if (drv.bus === 'onewire') dev.pin = 4;
    if (drv.generic) Object.assign(dev, { reg: 0, len: 2, signed: false, be: true, scale: 1, offset: 0 });
    editor.prog.devices.push(dev);
    editor.changed();
    renderDevices();
    toast('Sensor added. Use a "Sensor value" block to read it.');
  }
  function renderDevices() {
    const list = $('#devList');
    list.textContent = '';
    const devs = editor.prog.devices;
    if (!devs.length) list.append(h('p', { class: 'muted' }, 'No sensors yet.'));
    for (const d of devs) {
      const drv = C.DRIVERS.find((x) => x.id === d.driver) || { ch: [], label: d.driver, bus: '?' };
      const upd = (k, conv) => (e) => { editor.checkpoint(); d[k] = conv ? conv(e.target.value, e.target) : e.target.value; editor.changed(); };
      const fields = h('div', { class: 'fields' },
        h('label', {}, 'Name', h('input', { value: d.name || '', onchange: upd('name') })),
        h('label', {}, 'Read every (s)', h('input', { type: 'number', min: 0.1, step: 0.1, value: d.poll || 2, onchange: upd('poll', Number) })));
      if (drv.bus === 'i2c') {
        const opts = [...new Set([...(drv.addrs || []), d.addr])];
        fields.append(h('label', {}, 'I²C address', drv.generic
          ? h('input', { value: hex(d.addr), onchange: upd('addr', (v) => parseInt(v, 16) || 0) })
          : h('select', { onchange: upd('addr', Number) }, opts.map((a) => h('option', { value: a, selected: a === d.addr }, hex(a))))));
      }
      if (drv.bus === 'onewire') fields.append(h('label', {}, 'Data pin', h('select', { onchange: upd('pin', Number) }, C.OUT_PINS.map((p) => h('option', { value: p, selected: p === d.pin }, 'GPIO ' + p)))));
      if (drv.generic) {
        fields.append(
          h('label', {}, 'Register', h('input', { value: hex(d.reg), onchange: upd('reg', (v) => parseInt(v, 16) || 0) })),
          h('label', {}, 'Bytes', h('select', { onchange: upd('len', Number) }, [1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === d.len }, n)))),
          h('label', {}, 'Byte order', h('select', { onchange: upd('be', (v) => v === '1') }, h('option', { value: 1, selected: d.be }, 'MSB first'), h('option', { value: 0, selected: !d.be }, 'LSB first'))),
          h('label', {}, 'Signed', h('select', { onchange: upd('signed', (v) => v === '1') }, h('option', { value: 0, selected: !d.signed }, 'unsigned'), h('option', { value: 1, selected: d.signed }, 'signed'))),
          h('label', {}, 'Scale ×', h('input', { type: 'number', step: 'any', value: d.scale, onchange: upd('scale', Number) })),
          h('label', {}, 'Offset +', h('input', { type: 'number', step: 'any', value: d.offset, onchange: upd('offset', Number) })));
      }
      const vals = h('div', { class: 'vals' }, drv.ch.map(([n, u], i) => h('span', {}, n + ': ', h('b', { 'data-devval': d.id + '.' + i, 'data-unit': u }, '–'))));
      const used = editor.prog.blocks.filter((b) => b.type === 'SENSOR' && Number(b.p.dev) === d.id).map((b) => 'B' + b.id);
      list.append(h('div', { class: 'card dev' },
        h('div', { class: 'devhead' }, h('span', { class: 'name' }, d.name || d.driver), h('span', { class: 'muted' }, '#' + d.id + ' · ' + drv.label),
          h('span', { class: 'grow' }), used.length ? h('span', { class: 'muted small' }, 'used by ' + used.join(', ')) : null,
          h('button', { class: 'btn danger sm', onclick: () => {
            if (used.length && !confirm('Blocks ' + used.join(', ') + ' read this sensor. Remove anyway?')) return;
            editor.checkpoint(); editor.prog.devices = editor.prog.devices.filter((x) => x !== d); editor.changed(); renderDevices();
          } }, 'Remove')),
        fields, vals));
    }
    updateDeviceValues();
  }
  function updateDeviceValues() {
    if (!snap) return;
    $$('[data-devval]').forEach((e) => {
      const [id, ch] = e.dataset.devval.split('.').map(Number);
      const s = (snap.dev || []).find((x) => x.id === id);
      e.textContent = s && s.ok && s.v[ch] !== undefined ? window.fmtVal(s.v[ch]) + ' ' + e.dataset.unit : (s ? 'no data' : 'deploy to start reading');
    });
  }
  async function scanBus() {
    const box = $('#scanResult');
    box.textContent = 'Scanning…';
    try {
      const r = await be.scanI2C();
      box.textContent = '';
      if (!r.found.length) { box.append(h('span', { class: 'muted' }, `Nothing found on SDA ${r.sda} / SCL ${r.scl}. Check wiring and pull-ups.`)); return; }
      for (const a of r.found) {
        const matches = C.DRIVERS.filter((d) => (d.addrs || []).includes(a));
        const used = editor.prog.devices.some((d) => d.addr === a);
        box.append(h('div', { class: 'chip' }, h('b', {}, hex(a)),
          matches.length ? matches.map((m) => h('button', { class: 'btn sm', disabled: used, onclick: () => addDevice(m.id, a) }, (used ? '✓ ' : '+ ') + m.id))
            : h('button', { class: 'btn sm', onclick: () => addDevice('I2C_GENERIC', a) }, '+ Generic')));
      }
    } catch (e) { box.textContent = 'Scan failed: ' + e.message; }
  }

  // ------------------------------------------------------------ settings page
  async function loadSettings() {
    const f = $('#formWifi');
    $('#cycleMs').value = String(editor.prog.cycleMs || 10);
    try {
      const c = await be.getConfig();
      f.ssid.value = c.ssid || ''; f.host.value = c.host || ''; f.tz.value = c.tz || ''; f.sda.value = c.sda; f.scl.value = c.scl;
      f.adminPass.placeholder = c.hasAdminPass ? 'unchanged' : 'none (open access)';
    } catch { /* offline */ }
    refreshInfo();
  }
  function initSettings() {
    const f = $('#formWifi');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = { ssid: f.ssid.value, host: f.host.value || 'espressos', tz: f.tz.value, sda: Number(f.sda.value), scl: Number(f.scl.value) };
      if (f.pass.value) c.pass = f.pass.value;
      if (f.adminPass.value) c.adminPass = f.adminPass.value;
      const r = await be.setConfig(c).catch((x) => ({ ok: false, err: x.message }));
      if (r.ok) { toast('Saved. Reboot the board to apply.'); f.pass.value = ''; f.adminPass.value = ''; } else toast(r.err, true);
    });
    $('#btnReboot').addEventListener('click', async () => {
      if (!confirm('Reboot the board? Outputs switch off briefly.')) return;
      const r = await be.reboot().catch((x) => ({ ok: false, err: x.message }));
      r.ok ? toast('Rebooting…') : toast(r.err, true);
    });
    $('#cycleMs').addEventListener('change', (e) => { editor.checkpoint(); editor.prog.cycleMs = Number(e.target.value); editor.changed(); });
    $('#btnExport').addEventListener('click', () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(editor.prog, null, 1)], { type: 'application/json' })), download: 'espressos-program.json' });
      document.body.append(a); a.click(); a.remove();
    });
    $('#fileImport').addEventListener('change', async (e) => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      try {
        const p = JSON.parse(await file.text());
        if (!Array.isArray(p.blocks) || !Array.isArray(p.wires)) throw new Error('not an EspressOS program');
        editor.checkpoint();
        editor.setProgram(Object.assign(Api.EMPTY(), p), true);
        editor.changed(); editor.fit();
        $('.tab[data-tab=editor]').click();
        toast('Imported. Press Deploy to send it to the board.');
      } catch (x) { toast('Import failed: ' + x.message, true); }
    });
    $('#btnNew').addEventListener('click', () => {
      if (!confirm('Clear the editor? The board keeps running its current program until you deploy.')) return;
      editor.checkpoint();
      editor.setProgram(Api.EMPTY(), true);
      editor.changed();
      $('.tab[data-tab=editor]').click();
    });
    $('#btnOta').addEventListener('click', async () => {
      const file = $('#fileOta').files[0];
      if (!file) return toast('Choose a .bin file first', true);
      if (!confirm(`Flash ${file.name} (${Math.round(file.size / 1024)} KB)? The board reboots afterwards.`)) return;
      const pr = $('#otaProg'); pr.hidden = false; pr.value = 0;
      try {
        const r = await be.ota(file, (p) => (pr.value = p));
        r.ok ? toast('Update done, rebooting…') : toast('Update failed: ' + r.err, true);
      } catch (x) { toast('Update failed: ' + x.message, true); }
    });
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    initTabs();
    initPalette();
    editor = new Editor($('#canvas'), {
      summary, onBlockClick,
      onSelect: (b) => { renderProps(b); if (b) showSide('props'); },
      onChange,
      onWireRejected: (t) => toast(t === 'a' ? 'Analog values cannot drive a digital input directly. Use a Compare or Threshold block in between.' : 'Incompatible ports', true),
      isSimInput: (b) => b.type === 'DI' && be && be.kind === 'sim',
    });
    initDevices();
    initSettings();
    $('#btnUndo').onclick = () => editor.undo();
    $('#btnRedo').onclick = () => editor.redo();
    $('#btnFit').onclick = () => editor.fit();
    $('#btnZoomIn').onclick = () => editor.zoom(1.2);
    $('#btnZoomOut').onclick = () => editor.zoom(1 / 1.2);
    $('#chkOnline').onchange = (e) => editor.setLive(snap, e.target.checked);
    $('#btnDeploy').onclick = deploy;
    $('#btnRun').onclick = async () => { await be.run(); refreshInfo(); };
    $('#btnStop').onclick = async () => { await be.stop(); refreshInfo(); };
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); deploy(); } });

    be = await Api.connect();
    if (be.kind === 'sim') {
      const bn = $('#banner');
      bn.hidden = false;
      bn.innerHTML = '<b>Simulation mode.</b> No EspressOS board answered, so programs run here in your browser. Click Digital-input blocks to toggle them.';
    }
    try { builtDrivers = await be.drivers(); } catch { builtDrivers = null; }

    let prog;
    try { prog = await be.getProgram(); } catch { prog = Api.EMPTY(); }
    deployedJson = progJson(Object.assign(Api.EMPTY(), prog));
    const draft = store.get('eos.draft.' + be.kind);
    let useDraft = false;
    if (draft && draft !== deployedJson) {
      try { const d = JSON.parse(draft); useDraft = d.blocks.length > 0 && confirm('You have undeployed changes from your last session. Restore them?'); if (useDraft) prog = d; } catch { /* ignore */ }
    }
    editor.setProgram(Object.assign(Api.EMPTY(), prog));
    editor.fit();
    updateDirty();
    renderProps(null);
    renderLive();

    be.subscribe((s) => {
      snap = s;
      if (!s) return;
      editor.setLive(s);
      renderLive();
      updateDeviceValues();
    });
    refreshInfo();
    setInterval(refreshInfo, 4000);
  }

  boot();
})();
