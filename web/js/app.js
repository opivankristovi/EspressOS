// EspressOS web app: wires the editor, side panels, sensors page and settings to a backend.
(function () {
  'use strict';
  const C = window.Catalog;
  const Boards = window.Boards;
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
  let i2cBus = { sda: 21, scl: 22 };  // replaced by the board's settings once known
  let mqttCfg = null;     // the board's MQTT settings (null in the simulator / unknown)
  let connReason = '';    // 'board' | 'forced' | 'unreachable'
  let board = Boards.BARE; // the board profile the backend runs with
  let customBoards = [];  // profiles imported from files (validated), kept in this browser
  const isPhone = () => window.matchMedia('(max-width: 900px)').matches;
  const openSide = (on) => $('.side').classList.toggle('open', on);

  // ------------------------------------------------------------ helpers
  let toastTimer;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 2500);
  }
  const progJson = (p) => JSON.stringify(p);
  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Modal with a choice of buttons: resolves to the key of the button pressed ('cancel' for Esc / outside click).
  function choose(title, text, buttons, extra) {
    return new Promise((resolve) => {
      const back = h('div', { class: 'modal-back' });
      const done = (k) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(k); };
      const onKey = (e) => { if (e.key === 'Escape') done('cancel'); };
      const btns = buttons.map(([k, label, cls]) => h('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', onclick: () => done(k) }, label));
      back.append(h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
        h('h2', {}, title), h('p', { class: 'muted' }, text), extra || null, h('div', { class: 'choices' }, btns)));
      back.addEventListener('click', (e) => { if (e.target === back) done('cancel'); });
      document.addEventListener('keydown', onKey);
      document.body.append(back);
      btns[0].focus();
    });
  }
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  function devLabel(d) { return d ? (d.name || d.driver) + ' #' + d.id : '(none)'; }
  function driverOf(devId) {
    const d = editor.prog.devices.find((x) => x.id === Number(devId));
    return d ? C.DRIVERS.find((x) => x.id === d.driver) : null;
  }

  // ------------------------------------------------------------ board profile helpers
  const IO_USE = { DI: 'di', DO: 'do', AI: 'ai', AO: 'pwm' };
  const bare = () => Boards.isBare(board);
  const hasPin = (p) => !!p && p.pin !== undefined && p.pin !== '' && p.pin !== null;
  // How a pin is shown: "GPIO 16" on a bare board (as always), the terminal label ("R1") on a profile.
  const pinName = (pin) => (bare() ? 'GPIO ' + pin : pin === undefined || pin === '' || pin === null ? 'no terminal' : Boards.labelOf(board, pin));
  // A terminal's fixed active level and pull-up default go into the block when the pin is picked.
  function terminalDefaults(type, p) {
    const fi = Boards.fixedInv(board, p.pin);
    if (fi >= 0 && (type === 'DI' || type === 'DO')) p.inv = fi;
    const t = Boards.terminalOf(board, p.pin);
    if (type === 'DI' && t && typeof t.pull === 'boolean') p.pull = t.pull ? 1 : 0;
  }
  // New I/O blocks on a profile get the first terminal no other block uses yet.
  function initBlock(b, def) {
    const use = IO_USE[def.type];
    if (!use || bare()) return;
    const taken = new Set(editor.prog.blocks.filter((x) => IO_USE[x.type] && hasPin(x.p)).map((x) => Number(x.p.pin)));
    const free = Boards.pinsFor(board, use).find((g) => !taken.has(g));
    if (free === undefined) { delete b.p.pin; return; }
    b.p.pin = free;
    terminalDefaults(def.type, b.p);
  }
  const sameProfile = (a, b) => (Boards.isBare(a) || Boards.isBare(b) ? Boards.isBare(a) && Boards.isBare(b) : JSON.stringify(a) === JSON.stringify(b));
  // The profile a program's stamp names, as far as this browser knows it (unknown id: no terminal names).
  function stampedBoard(prog) {
    const id = Boards.stampOf(prog);
    if (id === 'bare') return Boards.BARE;
    if (board && id === board.id) return board;
    return [...Boards.PRESETS, ...customBoards].find((x) => x.id === id) || { id, name: id, terminals: [] };
  }
  function retargetProgram() {
    const { prog, notes } = Boards.retarget(editor.prog, stampedBoard(editor.prog), board);
    editor.checkpoint();
    editor.setProgram(prog, true);
    editor.changed();
    showReport('Retargeted to ' + board.name, [notes.length ? 'These changes were made. Check them, then press Deploy:' : 'No pin changes were needed. Press Deploy.'], [], notes);
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
    if (IO_USE[d.type] && !bare())  // terminal label; "inv" only when it is the user's choice, not the board's
      return pinName(b.p.pin) + ((d.type === 'DI' || d.type === 'DO') && Number(b.p.inv) && Boards.fixedInv(board, b.p.pin) < 0 ? ' inv' : '');
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
        // The board's terminal decides Invert. The box shows what the block really holds; it is
        // locked once that matches the terminal, and left free to fix a block that does not.
        const fixed = q.key === 'inv' && (b.type === 'DI' || b.type === 'DO') ? Boards.fixedInv(board, p.pin) : -1;
        const val = Number(p[q.key]) ? 1 : 0, wrong = fixed >= 0 && val !== fixed;
        pane.append(h('label', { class: 'inline', title: fixed >= 0 ? 'Set by the board: this terminal is active-' + (fixed ? 'low' : 'high') : null },
          h('input', { type: 'checkbox', checked: !!val, disabled: fixed >= 0 && !wrong, onchange: (e) => { p[q.key] = e.target.checked ? 1 : 0; commit(); renderProps(editor.block(b.id)); } }),
          q.label + (fixed < 0 ? '' : wrong ? ` (must be ${fixed ? 'on' : 'off'}: this terminal is active-${fixed ? 'low' : 'high'})` : ' (set by the board)')));
      } else if (q.type === 'pin' && !bare()) {
        pane.append(h('label', {}, 'Terminal', terminalSelect(q.use, p, () => { terminalDefaults(b.type, p); commit(); renderProps(editor.block(b.id)); })));
        const clash = pinClash(b);
        if (clash) pane.append(h('p', { class: 'help', style: 'color:var(--warn)' }, clash));
      } else if (q.type === 'select' || q.type === 'pin') {
        const sel = h('select', { onchange: (e) => { const o = q.options.find((x) => String(x[0]) === e.target.value); p[q.key] = o ? o[0] : e.target.value; commit(); } },
          // A pin cleared by Retarget (or a board change) shows as unset, not as the first GPIO.
          q.type === 'pin' && !hasPin(p) ? h('option', { value: '', selected: true, disabled: true }, '– pick a pin –') : null,
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
    if (isPhone()) openSide(true);
  }

  // Terminals of the profile for one use, grouped like the board's silk screen: "R1 · Relays (GPIO 16)".
  function terminalSelect(use, p, onPick) {
    const cur = hasPin(p) ? Number(p.pin) : null;
    const terms = Boards.pinsFor(board, use).map((g) => Boards.terminalOf(board, g));
    const groups = [...new Set(terms.map((t) => t.group || ''))];
    const opt = (t) => h('option', { value: t.gpio, selected: t.gpio === cur, title: t.note || null }, t.label + (t.group ? ' · ' + t.group : '') + ' (GPIO ' + t.gpio + ')');
    const kids = [];
    if (cur === null || !terms.some((t) => t.gpio === cur)) kids.push(h('option', { value: '', selected: true }, cur === null ? '– pick a terminal –' : 'GPIO ' + cur + ' (not on this board)'));
    for (const g of groups) {
      const opts = terms.filter((t) => (t.group || '') === g).map(opt);
      kids.push(g ? h('optgroup', { label: g }, opts) : opts);
    }
    return h('select', { onchange: (e) => { if (e.target.value === '') delete p.pin; else p.pin = Number(e.target.value); onPick(); } }, kids);
  }

  function pinClash(b) {
    if (b.p.pin === undefined) return '';
    const others = editor.prog.blocks.filter((x) => x.id !== b.id && ['DI', 'DO', 'AI', 'AO'].includes(x.type) && Number(x.p.pin) === Number(b.p.pin));
    if (!bare()) {  // the board's own notes replace the dev-board hints
      const t = Boards.terminalOf(board, b.p.pin);
      let msg = others.length ? pinName(b.p.pin) + ' is also used by ' + others.map((x) => 'B' + x.id).join(', ') + '.' : '';
      if (t && t.note) msg += ' ' + t.label + ': ' + t.note + '.';
      return msg.trim();
    }
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
        if (bare()) {
          const allowed = b.type === 'AI' ? C.ADC_PINS : isOut ? C.OUT_PINS : C.IN_PINS;
          if (!allowed.includes(k)) out.push({ lvl: 'err', msg: `B${b.id} ${d.label}: GPIO ${b.p.pin} cannot be used for this (pick another pin)` });
        } else if (!hasPin(b.p)) {
          out.push({ lvl: 'err', msg: `B${b.id} ${d.label}: pick a terminal`, pin: true });
          continue;
        } else {
          if (!Boards.pinsFor(board, IO_USE[b.type]).includes(k)) {
            const t = Boards.terminalOf(board, k), bus = Boards.busOf(board, k);
            out.push({ lvl: 'err', msg: `B${b.id} ${d.label}: ` + (t ? `${t.label} is ${t.uses.map((u) => Boards.USE_NAME[u]).join(' / ')} only` : bus ? `GPIO ${k} is the ${bus} bus of this board` : `GPIO ${k} is not a terminal of this board`) + ' (pick another terminal)', pin: true });
          }
          const fi = b.type === 'DI' || b.type === 'DO' ? Boards.fixedInv(board, k) : -1;
          if (fi >= 0 && (Number(b.p.inv) ? 1 : 0) !== fi) out.push({ lvl: 'err', msg: `B${b.id}: ${pinName(k)} is active-${fi ? 'low' : 'high'} on this board: Invert must be ${fi ? 'on' : 'off'}`, pin: true });
        }
        if (pins[k] && (isOut || pins[k].out)) out.push({ lvl: 'err', msg: `${bare() ? 'GPIO ' + k : pinName(k)} used by B${pins[k].id} and B${b.id}` });
        if (i2cBus && prog.devices.some((x) => x.driver !== 'DS18B20') && (k === i2cBus.sda || k === i2cBus.scl))
          out.push({ lvl: 'err', msg: `B${b.id}: GPIO ${k} is the I²C bus used by your sensors` });
        pins[k] = { id: b.id, out: isOut || !!(pins[k] && pins[k].out) };
      }
      if ((b.type === 'DO' || b.type === 'AO' || b.type === 'MQTTOUT') && !wiredIn.has(b.id + '.0')) out.push({ lvl: 'warn', msg: `B${b.id} ${d.label} has no input wire` });
      if (b.type === 'SENSOR' && !prog.devices.find((x) => x.id === Number(b.p.dev))) out.push({ lvl: 'err', msg: `B${b.id} reads a sensor that does not exist` });
      if (['AND', 'OR', 'XOR', 'NAND', 'NOR', 'NOT', 'SR', 'TON', 'TOF', 'TP', 'EDGE', 'CMP', 'THRESH', 'SCALE'].includes(b.type) && d.ins.every((_, i) => !wiredIn.has(b.id + '.' + i)))
        out.push({ lvl: 'warn', msg: `B${b.id} ${d.label} has no inputs connected` });
    }
    const mq = prog.blocks.filter((b) => b.type === 'MQTTIN' || b.type === 'MQTTOUT');
    const outTopics = {}, topics = { MQTTIN: new Set(), MQTTOUT: new Set() };
    for (const b of mq) {
      const t = b.p.topic === undefined ? '' : String(b.p.topic);
      const why = Sim.topicProblem(t);
      if (why) out.push({ lvl: 'err', msg: `B${b.id} ${why}` });
      topics[b.type].add(t);
      if (b.type === 'MQTTOUT') {
        if (outTopics[t]) out.push({ lvl: 'warn', msg: `B${outTopics[t]} and B${b.id} both publish to ${t}` });
        outTopics[t] = b.id;
      }
    }
    for (const k of ['MQTTIN', 'MQTTOUT']) if (topics[k].size > 16) out.push({ lvl: 'err', msg: `More than 16 different ${k === 'MQTTIN' ? 'MQTT in' : 'MQTT out'} topics` });
    if (mq.length && mqttCfg && !mqttCfg.host) out.push({ lvl: 'warn', msg: 'MQTT blocks need a broker: enter it under Settings → MQTT' });
    const vins = {};
    for (const b of prog.blocks.filter((x) => x.type === 'VIN')) {
      const i = Number(b.p.idx);
      if (i < 0 || i > 15) out.push({ lvl: 'err', msg: `B${b.id}: web input slot must be 0-15` });
      if (vins[i]) out.push({ lvl: 'warn', msg: `B${vins[i]} and B${b.id} share web input slot ${i}` });
      vins[i] = b.id;
    }
    if (builtDrivers) for (const dv of prog.devices) if (!builtDrivers.includes(dv.driver)) out.push({ lvl: 'err', msg: `Driver ${dv.driver} is not in this firmware` });
    for (const dv of prog.devices) {
      const name = dv.name || dv.driver;
      if (dv.driver === 'DS18B20') {
        if (pins[Number(dv.pin)]) out.push({ lvl: 'err', msg: `Sensor ${name}: GPIO ${dv.pin} is also used by B${pins[Number(dv.pin)].id}` });
        if (!bare() && !Boards.oneWirePins(board).includes(Number(dv.pin))) out.push({ lvl: 'err', msg: `Sensor ${name}: GPIO ${dv.pin} is not a 1-Wire terminal on this board` });
      } else if (!Boards.hasI2c(board)) out.push({ lvl: 'err', msg: `Sensor ${name}: this board has no I²C bus` });
    }
    // Board stamp: a program made for another board must be retargeted (the board refuses it otherwise).
    const act = { label: 'Retarget to ' + board.name, fn: retargetProgram };
    const stamp = Boards.stampOf(prog);
    if (stamp !== 'bare' && stamp !== Boards.idOf(board))
      out.unshift({ lvl: 'err', msg: `This program was made for board "${stamp}", but the board is set to ${board.name}.`, act });
    else if (stamp === 'bare' && !bare() && out.some((i) => i.pin))
      out.unshift({ lvl: 'warn', msg: `This program was made for a bare ESP32. Retarget it to map its pins onto the terminals of ${board.name}.`, act });
    return out;
  }
  function renderIssuesBox() {
    const issues = validate(editor.prog);
    if (!issues.length) return h('p', { class: 'help' }, editor.prog.blocks.length ? '✓ No problems found.' : '');
    return h('div', {}, h('h3', {}, 'Check'), h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: i.lvl }, i.msg,
      i.act ? h('div', {}, h('button', { class: 'btn sm', type: 'button', onclick: i.act.fn }, i.act.label)) : null))));
  }

  // ------------------------------------------------------------ live panel
  function liveStructureKey() {
    return JSON.stringify([editor.prog.blocks.filter((b) => ['VIN', 'DI', 'AI', 'DO', 'AO', 'MQTTIN', 'MQTTOUT'].includes(b.type)).map((b) => [b.id, b.p, b.note]), editor.prog.devices, be.kind, Boards.idOf(board)]);
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
              oninput: (e) => { out.textContent = e.target.value; sendVin(idx, Number(e.target.value)); } }));
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
        for (const b of dis) pane.append(h('div', { class: 'kv' }, h('span', {}, `B${b.id} ${b.note || pinName(b.p.pin)}`),
          h('button', { class: 'switch', 'data-din': b.p.pin, onclick: (e) => be.setDin(b.p.pin, !e.currentTarget.classList.contains('on')) })));
        for (const b of ais) {
          pane.append(h('div', { class: 'kv' }, h('span', {}, `B${b.id} ${b.note || pinName(b.p.pin)}`), h('span', { class: 'v', 'data-ain-out': b.id })));
          pane.append(h('input', { type: 'range', class: 'slider', min: 0, max: 4095, value: be.hal.ain[b.p.pin] || 0, oninput: (e) => be.setAin(b.p.pin, Number(e.target.value)) }));
        }
      }
      const outs = prog.blocks.filter((b) => b.type === 'DO' || b.type === 'AO');
      if (outs.length) {
        pane.append(h('h3', {}, 'Outputs'));
        for (const b of outs) pane.append(h('div', { class: 'kv' }, h('span', {}, `B${b.id} ${b.note || pinName(b.p.pin)}`),
          b.type === 'DO' ? h('span', { class: 'lamp', 'data-out': b.id }) : h('span', { class: 'v', 'data-out': b.id })));
      }
      const mqs = prog.blocks.filter((b) => b.type === 'MQTTIN' || b.type === 'MQTTOUT');
      if (mqs.length) {
        pane.append(h('h3', {}, 'MQTT'));
        for (const b of mqs) {
          const topic = String(b.p.topic || '');
          const row = h('div', { class: 'kv', title: topic }, h('span', {}, (b.type === 'MQTTIN' ? '⇣ ' : '⇡ ') + (b.note || topic)), h('span', { class: 'v', 'data-mq': b.id }));
          if (be.kind === 'sim' && b.type === 'MQTTIN') {
            row.title = 'Click to simulate a message on ' + topic;
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
              const v = prompt(`Simulated message on ${topic} (ON, OFF or a number)`);
              if (v !== null && !be.setMqtt(topic, v)) toast('Not understood: use ON, OFF, true, false or a number', true);
            });
          }
          pane.append(row);
        }
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
      const b = snap.run && snap.b ? snap.b[e.dataset.out] : null, x = b ? b[b.length - 1] : 0;
      if (e.classList.contains('lamp')) e.classList.toggle('on', x >= 0.5);
      else e.textContent = window.fmtVal(x) + ' %';
    });
    $$('[data-mq]', pane).forEach((e) => {
      const b = snap.run && snap.b ? snap.b[e.dataset.mq] : null;
      if (!b) { e.textContent = '–'; return; }
      if (b.length === 3) e.textContent = b[2] ? window.fmtVal(b[0]) : 'no message yet';  // MQTT in: value, Q, received
      else e.textContent = window.fmtVal(b[0]);                                          // MQTT out: value sent
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
    // The board runs the deployed program; showing its values on edited blocks would mislead.
    editor.setLivePaused(dirty);
    $('#btnDeploy').classList.toggle('pulse', dirty);
    $('#btnRestore').disabled = !dirty;
  }

  // Empty sheet; the board keeps its program until the next deploy.
  function newSheet() {
    if (!editor.prog.blocks.length && !editor.prog.devices.length) return;
    editor.checkpoint();
    editor.setProgram(Object.assign(Api.EMPTY(), { cycleMs: editor.prog.cycleMs || 10 }), true);
    editor.changed();
    toast('Empty program. The board keeps running until you deploy. Ctrl+Z brings your drawing back.');
  }

  // Back to the program on the board, dropping every change since the last deploy (undoable).
  async function restoreDeployed() {
    let prog;
    try { prog = Object.assign(Api.EMPTY(), await be.getProgram()); } catch (e) { toast('Could not read the program from the board: ' + e.message, true); return; }
    deployedJson = progJson(prog);
    editor.checkpoint();
    editor.setProgram(JSON.parse(deployedJson), true);
    editor.changed();
    editor.fit();
    toast('Back to the program on the board. Ctrl+Z brings your changes back.');
  }

  // Before a deploy replaces a different program on the board, offer to save a copy of it.
  async function okToReplace() {
    if (store.get('eos.askSave') === 'no') return true;
    let cur, info;
    try { cur = Object.assign(Api.EMPTY(), await be.getProgram()); info = await be.info(); } catch { return true; }
    if (!cur.blocks.length || progJson(cur) === progJson(editor.prog)) return true;
    const dont = h('input', { type: 'checkbox' });
    const where = be.kind === 'sim' ? 'The simulator' : 'The board';
    const ans = await choose('Save the current program first?',
      `${where} ${info && info.running ? 'is running' : 'holds'} a program with ${cur.blocks.length} block${cur.blocks.length === 1 ? '' : 's'}. Deploying replaces it. Save a copy on this device first?`,
      [['save', 'Save copy, then deploy', 'primary'], ['go', 'Deploy without saving'], ['cancel', 'Cancel']],
      h('label', { class: 'inline' }, dont, 'Don\'t ask again (can be changed under Settings)'));
    if (ans === 'cancel') return false;
    if (dont.checked) { store.set('eos.askSave', 'no'); $('#chkAskSave').checked = false; }
    if (ans === 'save') download(new Blob([JSON.stringify(cur, null, 1)], { type: 'application/json' }), `espressos-program-${stamp()}.json`);
    return true;
  }

  async function deploy() {
    // commit a field that is still being edited (its change event fires on blur)
    if (document.activeElement && document.activeElement.matches('input, select')) document.activeElement.blur();
    const issues = validate(editor.prog).filter((i) => i.lvl === 'err');
    if (issues.length) { toast(issues[0].msg, true); showSide('props'); editor.select(null); return; }
    if ($('#btnDeploy').disabled) return;  // a deploy (or its question) is already open
    $('#btnDeploy').disabled = true;
    try {
      if (!(await okToReplace())) return;
      // Lint passed, so the pins fit this board: stamp it (no stamp = bare, as before profiles).
      if (bare()) delete editor.prog.board; else editor.prog.board = board.id;
      const r = await be.deploy(editor.prog);
      if (r && r.ok) {
        deployedJson = progJson(editor.prog);
        updateDirty();
        toast(be.kind === 'sim' ? (connReason === 'unreachable' ? 'Running in the simulator only: the board is not connected' : 'Running in simulator') : 'Deployed and running');
      } else toast('Rejected: ' + (r && r.err), true);
    } catch (e) { toast('Deploy failed: ' + e.message, true); } finally { $('#btnDeploy').disabled = false; }
    refreshInfo();
  }

  // ------------------------------------------------------------ status
  async function refreshInfo() {
    try {
      const i = await be.info();
      showBoardError(i.boardError);
      if (i.board && i.board.id !== '?' && i.board.id !== Boards.idOf(board)) { await loadBoard(); boardChanged(); }
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
      if (i.mqtt !== undefined) rows.push(['MQTT', i.mqtt]);
      $('#mqttStatus').textContent = i.mqtt !== undefined ? i.mqtt : 'not available in the simulator';
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
    if (drv.bus === 'i2c' && !Boards.hasI2c(board)) return toast(board.name + ' has no I²C bus', true);
    if (drv.bus === 'onewire' && !Boards.oneWirePins(board).length) return toast(board.name + ' has no 1-Wire terminal', true);
    editor.checkpoint();
    const id = editor.prog.devices.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    const dev = { id, driver: drv.id, name: drv.id.replace('_GENERIC', '') + (id > 1 ? ' ' + id : ''), poll: 2 };
    if (drv.bus === 'i2c') dev.addr = addr || drv.addrs[0] || 0x40;
    if (drv.bus === 'onewire') dev.pin = bare() ? 4 : Boards.oneWirePins(board)[0];
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
      if (drv.bus === 'onewire') {
        const ow = Boards.oneWirePins(board);
        if (!ow.includes(d.pin) && !bare()) ow.unshift(d.pin);  // keep showing a pin the board does not offer (lint flags it)
        fields.append(h('label', {}, 'Data pin', h('select', { onchange: upd('pin', Number) }, ow.map((p) => h('option', { value: p, selected: p === d.pin }, 'GPIO ' + p)))));
      }
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
      if (r.error) box.append(h('p', { class: 'err' }, r.error));
      if (!r.found.length && r.error) return;
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
  let i2cFixed = false;
  async function loadSettings() {
    const f = $('#formWifi');
    $('#cycleMs').value = String(editor.prog.cycleMs || 10);
    try {
      const c = await be.getConfig();
      f.ssid.value = c.ssid || ''; f.host.value = c.host || ''; f.tz.value = c.tz || ''; f.sda.value = c.sda; f.scl.value = c.scl;
      // A board profile fixes (or removes) the I2C bus: show it, but it is not a setting then.
      i2cFixed = !!c.i2cFixed;
      f.sda.readOnly = f.scl.readOnly = i2cFixed;
      $('#i2cRow').hidden = i2cFixed && !(c.sda >= 0);
      $('#i2cNote').textContent = !i2cFixed ? '' : c.sda >= 0 ? 'The I²C pins are fixed by the board profile.' : 'This board has no I²C bus.';
      if (Number.isInteger(c.sda)) i2cBus = { sda: c.sda, scl: c.scl };
      f.adminPass.placeholder = c.hasAdminPass ? 'unchanged' : 'none (open access)';
      $('#apKey').textContent = c.apKey || '';
      $('#apKeyInfo').hidden = !c.apKey;
      fillMqtt(c.mqtt);
    } catch { /* offline */ }
    renderBoardCard();
    refreshInfo();
  }
  function fillMqtt(m) {
    const f = $('#formMqtt');
    mqttCfg = m || null;
    for (const el of f.elements) el.disabled = !m;
    if (!m) { $('#mqttTopics').textContent = 'MQTT is only available on the board, not in the simulator.'; return; }
    f.host.value = m.host || ''; f.port.value = m.port || 1883; f.user.value = m.user || '';
    f.pass.value = ''; f.pass.placeholder = m.hasPass ? 'unchanged' : '';
    f.base.value = m.base || ''; f.base.placeholder = m.defaultBase || 'espressos/<hostname>';
    f.ha.checked = m.ha !== false; f.haPrefix.value = m.haPrefix || 'homeassistant';
    mqttTopicsHelp();
  }
  function mqttTopicsHelp() {
    const f = $('#formMqtt');
    const b = (f.base.value.trim() || f.base.placeholder).replace(/\/+$/, '');
    $('#mqttTopics').textContent = `Web control in slot N: state on ${b}/vN, commands to ${b}/vN/set (ON/OFF, PRESS or a number). Board status on ${b}/status.`;
  }
  function initSettings() {
    const fm = $('#formMqtt');
    fm.base.addEventListener('input', mqttTopicsHelp);
    fm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const m = { host: fm.host.value.trim(), port: Number(fm.port.value) || 1883, user: fm.user.value.trim(), base: fm.base.value.trim(), ha: fm.ha.checked, haPrefix: fm.haPrefix.value.trim() };
      if (fm.pass.value) m.pass = fm.pass.value;
      const r = await be.setConfig({ mqtt: m }).catch((x) => ({ ok: false, err: x.message }));
      if (!r.ok) return toast(r.err, true);
      fm.pass.value = '';
      toast(m.host ? 'Saved. Connecting to the broker…' : 'Saved. MQTT is off.');
      try { fillMqtt((await be.getConfig()).mqtt); } catch { /* keep form */ }
      setTimeout(refreshInfo, 2500);
    });
    const ask = $('#chkAskSave');
    ask.checked = store.get('eos.askSave') !== 'no';
    ask.addEventListener('change', () => store.set('eos.askSave', ask.checked ? 'yes' : 'no'));
    const f = $('#formWifi');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = { ssid: f.ssid.value, host: f.host.value || 'espressos', tz: f.tz.value };
      if (!i2cFixed) { c.sda = Number(f.sda.value); c.scl = Number(f.scl.value); }
      if (f.pass.value) c.pass = f.pass.value;
      if (f.adminPass.value) {
        if (f.adminPass.value.length < 8) return toast('Admin password needs at least 8 characters', true);
        c.adminPass = f.adminPass.value;
      }
      const r = await be.setConfig(c).catch((x) => ({ ok: false, err: x.message }));
      if (!r.ok) return toast(r.err, true);
      f.pass.value = '';
      if (c.adminPass) { f.adminPass.value = ''; toast('Password changed. Log in again as user "admin".'); setTimeout(() => location.reload(), 1500); }
      else toast('Saved. Network and I²C changes apply after a reboot.');
    });
    $('#btnReboot').addEventListener('click', async () => {
      if (!confirm('Reboot the board? Outputs switch off briefly.')) return;
      const r = await be.reboot().catch((x) => ({ ok: false, err: x.message }));
      r.ok ? toast('Rebooting…') : toast(r.err, true);
    });
    $('#cycleMs').addEventListener('change', (e) => { editor.checkpoint(); editor.prog.cycleMs = Number(e.target.value); editor.changed(); });
    $('#btnExport').addEventListener('click', () => download(new Blob([JSON.stringify(editor.prog, null, 1)], { type: 'application/json' }), 'espressos-program.json'));
    $('#btnExportXml').addEventListener('click', () => {
      const name = (editor.prog.name || 'EspressOS program');
      const r = PLCopen.exportPLCopen(editor.prog, { name, version: 'EspressOS' });
      download(new Blob([r.xml], { type: 'application/xml' }), 'espressos-program.xml');
      const io = r.ioMap.map((m) => `${m.address}  →  ${bare() ? '' : Boards.labelOf(board, m.pin) + ' = '}GPIO ${m.pin}  (B${m.block}, ${m.kind})`);
      showReport('Exported as PLCopen XML', [
        'Open the file in OpenPLC Editor or Beremiz (File → Open). The program is called "main"; helper blocks are named EOS_*.',
        ...(io.length ? ['In OpenPLC, set these pins for your ESP32 board so the addresses match your wiring:'] : []),
      ], io, r.warnings);
    });
    $('#fileImport').addEventListener('change', async (e) => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        let p, warnings = [];
        // Under a board profile, GPIO numbers from another tool mean nothing: the user picks terminals.
        if (/^\s*</.test(text)) ({ prog: p, warnings } = PLCopen.importPLCopen(text, { noPins: !bare() }));
        else p = JSON.parse(text);
        if (!Array.isArray(p.blocks) || !Array.isArray(p.wires)) throw new Error('not an EspressOS program');
        const chk = JSON.parse(JSON.stringify(p));  // check the structure; blocks still waiting for a terminal are left out
        if (!bare()) {
          const open = new Set(chk.blocks.filter((b) => IO_USE[b.type] && !hasPin(b.p)).map((b) => b.id));
          chk.blocks = chk.blocks.filter((b) => !open.has(b.id));
          chk.wires = chk.wires.filter((w) => !open.has(w[0]) && !open.has(w[2]));
        }
        const err = new Sim.Engine().load(chk);
        if (err) throw new Error(err);
        editor.checkpoint();
        editor.setProgram(Object.assign(Api.EMPTY(), p), true);
        editor.changed(); editor.fit();
        $('.tab[data-tab=editor]').click();
        if (warnings.length) showReport('Imported ' + file.name, ['The program was converted. Check these points, then press Deploy:'], [], warnings);
        else toast('Imported. Press Deploy to send it to the board.');
      } catch (x) { toast('Import failed: ' + x.message, true); }
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

  // ------------------------------------------------------------ board profile (Settings → Board)
  // Profiles may come from files: everything here is rendered as text nodes, never as HTML.
  let boardPick = null;  // profile shown in the card (not applied yet)
  let boardLocked = false;  // the board's stored profile is unreadable: nothing is active, every choice can be applied
  function loadCustomBoards() {
    try { customBoards = (JSON.parse(store.get('eos.boards.custom') || '[]') || []).filter((x) => !Boards.validate(x) && !Boards.isBare(x)); } catch { customBoards = []; }
  }
  function boardChoices() {
    const list = Boards.PRESETS.map((x) => ({ prof: x, custom: false }));
    for (const x of customBoards) if (!list.some((c) => sameProfile(c.prof, x))) list.push({ prof: x, custom: true });
    if (!boardLocked && !list.some((c) => sameProfile(c.prof, board))) list.push({ prof: board, custom: true });  // set on the board from elsewhere
    return list;
  }
  function renderBoardCard() {
    const sel = $('#boardSel');
    const list = boardChoices();
    if (!boardPick || !list.some((c) => sameProfile(c.prof, boardPick))) boardPick = board;
    sel.textContent = '';
    list.forEach((c, i) => sel.append(h('option', { value: i, selected: sameProfile(c.prof, boardPick) },
      c.prof.name + (c.prof.rev ? ' rev ' + c.prof.rev : '') + (c.custom ? ' (custom)' : '') + (isActive(c.prof) ? ' – active' : ''))));
    sel.onchange = () => { boardPick = list[Number(sel.value)].prof; renderBoardView(); };
    renderBoardView();
  }
  const isActive = (p) => !boardLocked && sameProfile(p, board);
  function renderBoardView() {
    const box = $('#boardView'), p = boardPick;
    box.textContent = '';
    $('#btnBoardApply').disabled = isActive(p);
    if (Boards.isBare(p)) {
      box.append(h('p', { class: 'muted small' }, 'Any usable GPIO, as on an ESP32 dev board. I²C pins come from the Network settings, DS18B20 sensors can use any output-capable pin.'));
      return;
    }
    const i2c = Boards.i2cOf(p), ow = p.onewire || [];
    box.append(h('p', { class: 'muted small' }, 'Id ' + p.id + ' · I²C: ' + (i2c ? 'SDA GPIO ' + i2c.sda + ', SCL GPIO ' + i2c.scl : 'none') + ' · 1-Wire: ' + (ow.length ? ow.map((g) => 'GPIO ' + g).join(', ') : 'none')));
    const active = (t) => (t.active ? 'active-' + t.active : '');
    box.append(h('div', { class: 'tablewrap' }, h('table', { class: 'terms' },
      h('thead', {}, h('tr', {}, ['Terminal', 'GPIO', 'Use', 'Level', 'Group', 'Note'].map((x) => h('th', {}, x)))),
      h('tbody', {}, p.terminals.map((t) => h('tr', {}, h('td', {}, h('b', {}, t.label)), h('td', {}, t.gpio),
        h('td', {}, t.uses.map((u) => Boards.USE_NAME[u]).join(', ')), h('td', {}, active(t)), h('td', {}, t.group || ''), h('td', {}, t.note || '')))))));
  }
  async function applyBoard() {
    const p = boardPick;
    if (isActive(p)) return;
    // Programs are tied to a board by id: a changed profile under the active id would let the old program run on it.
    if (!boardLocked && !Boards.isBare(p) && p.id === Boards.idOf(board))
      return toast(`The board already uses a profile with the id "${p.id}". Give the changed profile its own id (in its JSON file), then import it again.`, true);
    const ans = await choose('Use ' + p.name + '?', 'The board restarts with this profile. The program stays stopped until you deploy it again.',
      [['go', 'Apply', 'primary'], ['cancel', 'Cancel']]);
    if (ans !== 'go') return;
    const r = await be.setBoard(Boards.isBare(p) ? { id: 'bare' } : p).catch((x) => ({ ok: false, err: x.message }));
    if (!r || !r.ok) return toast('Not applied: ' + ((r && r.err) || 'no answer'), true);
    board = Boards.isBare(p) ? Boards.BARE : p;
    boardLocked = false;
    // Until the board answers again, show the I2C pins as the new profile sets them, so a
    // Network save in the meantime cannot send the old pins.
    i2cFixed = !Boards.isBare(p);
    const f = $('#formWifi'), bus = Boards.i2cOf(p);
    f.sda.readOnly = f.scl.readOnly = i2cFixed;
    if (bus) { f.sda.value = bus.sda; f.scl.value = bus.scl; }
    $('#i2cRow').hidden = i2cFixed && !bus;
    $('#i2cNote').textContent = !i2cFixed ? '' : bus ? 'The I²C pins are fixed by the board profile.' : 'This board has no I²C bus.';
    boardChanged();
    showBoardError('');
    if (be.kind === 'sim') { toast('Board profile set. Deploy the program to run it on this board.'); loadSettings(); return; }
    toast('Board profile saved. The board restarts…');
    // A restart plus Wi-Fi reconnect can take a while: wait until the board answers, then reload.
    for (let i = 0; i < 30; i++) {
      await new Promise((ok) => setTimeout(ok, i ? 3000 : 6000));
      try { await be.getConfig(); break; } catch { /* still restarting */ }
    }
    await loadBoard();
    boardChanged();
    loadSettings();
  }
  // Everything that shows pins depends on the board.
  function boardChanged() {
    liveKey = '';
    editor.render();
    renderProps(editor.sel && editor.sel.kind === 'block' ? editor.block(editor.sel.id) : null);
    renderLive();
    renderDevices();
    renderBoardCard();
  }
  async function loadBoard() {
    let r = null;
    try { r = await be.getBoard(); } catch { /* older firmware: no profiles */ }
    boardLocked = !!(r && r.id === '?');
    if (boardLocked) { board = Boards.BARE; return; }  // refreshInfo shows boardError
    const bad = r && typeof r.id === 'string' ? Boards.validate(r) : 'no profile';
    if (bad && r && r.id) console.warn('Board profile from the board not understood:', bad);
    board = !bad && !Boards.isBare(r) ? r : Boards.BARE;
  }
  function initBoardCard() {
    loadCustomBoards();
    $('#btnBoardApply').addEventListener('click', applyBoard);
    $('#btnBoardExport').addEventListener('click', () => {
      const p = Boards.isBare(boardPick) ? { schema: 1, ...Boards.BARE } : boardPick;
      download(new Blob([JSON.stringify(p, null, 1)], { type: 'application/json' }), 'board-' + p.id + '.json');
    });
    $('#fileBoard').addEventListener('change', async (e) => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      let p;
      try { p = JSON.parse(await file.text()); } catch (x) { return toast('Not a JSON file: ' + x.message, true); }
      const err = Boards.validate(p);
      if (err) return toast('Not a usable board profile: ' + err, true);
      if (!Boards.isBare(p)) {
        // An id names one wiring: a different profile under a built-in or the active id would be mistaken for it.
        const preset = Boards.PRESETS.find((x) => x.id === p.id);
        if (preset && !sameProfile(preset, p)) return toast(`This profile uses the id "${p.id}" of the built-in ${preset.name} but has different terminals. Give it its own id.`, true);
        if (!boardLocked && p.id === Boards.idOf(board) && !sameProfile(board, p))
          return toast(`The board already uses a profile with the id "${p.id}" and this one is different. Give it its own id.`, true);
        customBoards = customBoards.filter((x) => x.id !== p.id).concat([p]);
        store.set('eos.boards.custom', JSON.stringify(customBoards));
      }
      boardPick = Boards.isBare(p) ? Boards.BARE : p;
      renderBoardCard();
      toast('Profile loaded. Check the terminals, then press Apply.');
    });
  }
  function showBoardError(err) {
    const bn = $('#boardBanner');
    bn.hidden = !err;
    bn.textContent = '';
    if (err) bn.append(h('b', {}, 'Board profile problem. '), String(err), ' No program runs until the board is chosen again under Settings → Board.');
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    initTabs();
    initPalette();
    editor = new Editor($('#canvas'), {
      summary, onBlockClick, initBlock,
      onSelect: (b) => { renderProps(b); if (b) showSide('props'); },
      onChange,
      onWireRejected: (t) => toast(t === 'a' ? 'Analog values cannot drive a digital input directly. Use a Compare or Threshold block in between.' : 'Incompatible ports', true),
      isSimInput: (b) => b.type === 'DI' && be && be.kind === 'sim',
      onBackground: () => { if (isPhone()) openSide(false); },
    });
    initDevices();
    initSettings();
    initBoardCard();
    $('#btnNewSheet').onclick = newSheet;
    $('#btnRestore').onclick = restoreDeployed;
    $('#btnUndo').onclick = () => editor.undo();
    $('#btnRedo').onclick = () => editor.redo();
    $('#btnFit').onclick = () => editor.fit();
    $('#btnZoomIn').onclick = () => editor.zoom(1.2);
    $('#btnZoomOut').onclick = () => editor.zoom(1 / 1.2);
    $('#chkOnline').onchange = (e) => editor.setLive(snap, e.target.checked);
    $('#btnDeploy').onclick = deploy;
    const runStop = async (run) => {
      try {
        const r = await (run ? be.run() : be.stop());
        if (!r || !r.ok) throw new Error((r && r.err) || 'no answer');
        if (run && progJson(editor.prog) !== deployedJson) toast('Running the deployed program. Your edits are not deployed yet.');
        else toast(run ? 'Program running' : 'Program stopped, outputs off');
      } catch (e) { toast((run ? 'Run' : 'Stop') + ' failed: ' + e.message, true); }
      refreshInfo();
    };
    $('#btnRun').onclick = () => runStop(true);
    $('#btnStop').onclick = () => runStop(false);
    $('#btnPanel').onclick = () => openSide(!$('.side').classList.contains('open'));
    $('#btnSideClose').onclick = () => openSide(false);
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); deploy(); } });

    $('#conn').textContent = 'Looking for the board…';
    ({ be, reason: connReason } = await Api.connect());
    showConnBanner();
    try { builtDrivers = await be.drivers(); } catch { builtDrivers = null; }
    try {
      const c = await be.getConfig();
      if (c && Number.isInteger(c.sda)) i2cBus = { sda: c.sda, scl: c.scl };
      mqttCfg = (c && c.mqtt) || null;
    } catch { /* keep defaults */ }
    await loadBoard();

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
      // null (connection lost) or a stopped program clears the overlay: outputs are off then,
      // and the last scan's values would be stale.
      editor.setLive(s && s.run ? s : null);
      if (!s) return;
      renderLive();
      updateDeviceValues();
    });
    refreshInfo();
    setInterval(refreshInfo, 4000);
    try { const info = await be.info(); if (info.setup) showSetupDialog(info); } catch { /* offline */ }
  }

  // ------------------------------------------------------------ connection banner
  function showConnBanner() {
    const bn = $('#banner');
    bn.hidden = be.kind !== 'sim';
    bn.className = 'banner';
    bn.textContent = '';
    if (be.kind !== 'sim') return;
    if (connReason === 'forced') {
      bn.append(h('b', {}, 'Simulation mode. '), 'Programs run here in your browser. Click Digital-input blocks to toggle them.');
      return;
    }
    // The page was served by something, but the board API did not answer: say so loudly.
    bn.classList.add('err');
    bn.append(h('b', {}, 'The board is not answering. '), 'You are working in the simulator; Deploy will NOT reach the board. ',
      h('button', { class: 'btn sm', onclick: () => location.reload() }, 'Retry now'));
    const timer = setInterval(async () => {
      if (await Api.probe(3000)) {
        clearInterval(timer);
        bn.textContent = '';
        bn.className = 'banner';
        bn.append(h('b', {}, 'The board is back. '), 'Export your work first if you changed anything (Settings), then ',
          h('button', { class: 'btn sm', onclick: () => location.reload() }, 'Reconnect'));
      }
    }, 5000);
  }

  // ------------------------------------------------------------ import/export report
  function showReport(title, intro, list, warnings) {
    const close = h('button', { class: 'btn primary', type: 'button' }, 'OK');
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      h('h2', {}, title),
      intro.map((t) => h('p', { class: 'muted' }, t)),
      list.length ? h('pre', { class: 'report' }, list.join('\n')) : null,
      warnings.length ? h('div', {}, h('h3', {}, 'Please check'), h('ul', { class: 'issues' }, warnings.map((w) => h('li', { class: 'warn' }, w)))) : null,
      h('div', { class: 'row' }, close));
    const back = h('div', { class: 'modal-back' }, box);
    const done = () => back.remove();
    close.onclick = done;
    back.addEventListener('click', (e) => { if (e.target === back) done(); });
    document.body.append(back);
    close.focus();
  }

  // ------------------------------------------------------------ first-run setup
  function showSetupDialog(info) {
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const ssid = h('input', { autocomplete: 'off' });
    const wpass = h('input', { type: 'password', autocomplete: 'new-password' });
    const err = h('p', { class: 'small', style: 'color:var(--danger)' });
    const form = h('form', { class: 'modal' },
      h('h2', {}, 'Secure your board'),
      h('p', { class: 'muted' }, 'This board switches real outputs. Choose an admin password first: until then it accepts no programs. You log in with user name "admin".'),
      h('label', {}, 'Admin password (8+ characters)', pw),
      h('label', {}, 'Repeat password', pw2),
      info.ap ? h('div', {}, h('h3', {}, 'Wi-Fi (you can also do this later)'),
        h('label', {}, 'Network name (SSID)', ssid), h('label', {}, 'Wi-Fi password', wpass)) : null,
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    const back = h('div', { class: 'modal-back' }, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pw.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
      if (pw.value !== pw2.value) { err.textContent = 'The passwords do not match.'; return; }
      const c = { adminPass: pw.value };
      if (ssid.value) { c.ssid = ssid.value; c.pass = wpass.value; }
      const r = await be.setConfig(c).catch((x) => ({ ok: false, err: x.message }));
      if (!r.ok) { err.textContent = r.err; return; }
      if (c.ssid) {
        await be.reboot().catch(() => {});
        form.textContent = '';
        form.append(h('h2', {}, 'Joining ' + c.ssid + '…'),
          h('p', {}, 'The board is restarting. Reconnect this device to your normal Wi-Fi, open http://' + (info.host || 'espressos') + '.local and log in as "admin".'));
      } else location.reload();
    });
    document.body.append(back);
    pw.focus();
  }

  // Live-panel sliders: at most one request per 150 ms per slot, always ending on the final value.
  const vinTimers = {}, vinPending = {};
  function sendVin(idx, v) {
    vinPending[idx] = v;
    if (vinTimers[idx]) return;
    const flush = async () => {
      if (!(idx in vinPending)) { vinTimers[idx] = null; return; }
      const val = vinPending[idx];
      delete vinPending[idx];
      try {
        const r = await be.setVin(idx, val);
        if (r && r.ok === false) toast(r.err, true);
      } catch (e) { toast('The board did not take the value: ' + e.message, true); }
      vinTimers[idx] = setTimeout(flush, 150);
    };
    vinTimers[idx] = setTimeout(flush, 0);
  }

  boot();
})();
