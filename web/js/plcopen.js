// PLCopen TC6 XML (v2.01) import/export for EspressOS programs, so they can
// be opened in OpenPLC Editor / Beremiz and other IEC 61131-3 tools.
//
// Export: one PROGRAM "main" with an FBD body. EspressOS blocks map to IEC
// standard functions/function blocks where one exists; the rest become small
// EOS_* POUs written in Structured Text and shipped in the same file.
// EspressOS details (GPIO pins, block ids, sensor devices) travel in
// <addData> so a file exported here imports back without loss.
//
// Import: FBD programs. Standard blocks map back to EspressOS blocks; located
// variables become I/O (%IX -> digital input, %QX -> output, %IW/%QW ->
// analog); internal variables become wires; literals become parameters.
(function (root) {
  'use strict';

  const NS = 'http://www.plcopen.org/xml/tc6_0201';
  const EOS_DATA = 'https://github.com/opivankristovi/EspressOS';
  const EOS_XMLNS = 'urn:espressos:plcopen:1';
  const C = typeof module !== 'undefined' && module.exports ? require('./catalog.js') : root.Catalog;

  // =========================================================== tiny XML
  const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] !== undefined ? ENT[e] : m;
  });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Returns the root element: {name (local, no prefix), attrs, kids, text}
  function parseXml(src) {
    const top = { name: '#doc', attrs: {}, kids: [], text: '' };
    const stack = [top];
    const tagRe = /<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
    const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let i = 0;
    const cur = () => stack[stack.length - 1];
    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt < 0) { cur().text += decode(src.slice(i)); break; }
      if (lt > i) cur().text += decode(src.slice(i, lt));
      i = lt;
      if (src.startsWith('<?', i)) { i = src.indexOf('?>', i) + 2; continue; }
      if (src.startsWith('<!--', i)) { i = src.indexOf('-->', i) + 3; continue; }
      if (src.startsWith('<![CDATA[', i)) { const e = src.indexOf(']]>', i); cur().text += src.slice(i + 9, e); i = e + 3; continue; }
      if (src.startsWith('<!', i)) { i = src.indexOf('>', i) + 1; continue; }
      if (src[i + 1] === '/') {
        const e = src.indexOf('>', i);
        const name = src.slice(i + 2, e).trim().replace(/^.*:/, '');
        if (stack.length < 2 || cur().name !== name) throw new Error('XML: unexpected </' + name + '>');
        stack.pop();
        i = e + 1;
        continue;
      }
      tagRe.lastIndex = i;
      const m = tagRe.exec(src);
      if (!m) throw new Error('XML: bad tag near "' + src.slice(i, i + 40) + '"');
      const el = { name: m[1].replace(/^.*:/, ''), qname: m[1], attrs: {}, kids: [], text: '' };
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[2]))) el.attrs[a[1].replace(/^.*:/, '')] = decode(a[3] !== undefined ? a[3] : a[4]);
      cur().kids.push(el);
      if (!m[3]) stack.push(el);
      i = tagRe.lastIndex;
    }
    if (stack.length !== 1) throw new Error('XML: unclosed <' + cur().name + '>');
    const rootEl = top.kids[0];
    if (!rootEl) throw new Error('XML: empty document');
    return rootEl;
  }
  const kid = (el, name) => (el ? el.kids.find((k) => k.name === name) : undefined);
  const kidsNamed = (el, name) => (el ? el.kids.filter((k) => k.name === name) : []);
  const findAll = (el, name, out = []) => { for (const k of el.kids) { if (k.name === name) out.push(k); findAll(k, name, out); } return out; };

  // XML writer: X('tag', {attrs}, ...children) ; children are nodes, strings or {raw}
  const X = (name, attrs, ...kids) => ({ name, attrs: attrs || {}, kids: kids.flat().filter((k) => k !== null && k !== undefined && k !== false) });
  function ser(n, ind = '') {
    if (typeof n === 'string') return ind + esc(n) + '\n';
    if (n.raw !== undefined) return ind + n.raw + '\n';
    const attrs = Object.entries(n.attrs).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    if (!n.kids.length) return `${ind}<${n.name}${attrs}/>\n`;
    if (n.kids.length === 1 && typeof n.kids[0] === 'string') return `${ind}<${n.name}${attrs}>${esc(n.kids[0])}</${n.name}>\n`;
    return `${ind}<${n.name}${attrs}>\n${n.kids.map((k) => ser(k, ind + '  ')).join('')}${ind}</${n.name}>\n`;
  }

  // =========================================================== literals
  function fmtReal(v) {
    v = Number(v);
    if (!isFinite(v)) v = 0;
    let s = String(v);
    if (!/[.eE]/.test(s)) s += '.0';
    return s;
  }
  const fmtTime = (sec) => 'T#' + Math.max(0, Math.round(Number(sec) * 1000)) + 'ms';

  // Parses an IEC literal; returns {type, value} or null if not a literal.
  function parseLiteral(s) {
    s = String(s).trim();
    let m;
    if (/^(BOOL#)?(TRUE|FALSE)$/i.test(s)) return { type: 'BOOL', value: /TRUE/i.test(s) ? 1 : 0 };
    if (/^BOOL#[01]$/i.test(s)) return { type: 'BOOL', value: Number(s.slice(-1)) };
    if ((m = /^(?:T|TIME)#(-?)(.+)$/i.exec(s))) {
      let ms = 0;
      const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi;
      let p, any = false;
      const body = m[2].replace(/_/g, '');
      while ((p = re.exec(body))) {
        any = true;
        const n = parseFloat(p[1]);
        ms += n * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[p[2].toLowerCase()];
      }
      if (!any) return null;
      return { type: 'TIME', value: (m[1] ? -ms : ms) / 1000 };
    }
    if ((m = /^(?:[A-Z]+#)?(?:(2|8|16)#([0-9A-F_]+))$/i.exec(s))) return { type: 'INT', value: parseInt(m[2].replace(/_/g, ''), Number(m[1])) };
    if ((m = /^(?:(REAL|LREAL|INT|SINT|DINT|LINT|UINT|USINT|UDINT|WORD|DWORD|BYTE)#)?([+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)$/i.exec(s))) {
      const num = parseFloat(m[2].replace(/_/g, ''));
      const isReal = m[1] ? /REAL/i.test(m[1]) : /[.eE]/.test(m[2]);
      return { type: isReal ? 'REAL' : 'INT', value: num };
    }
    return null;
  }

  // IEC identifiers: letters, digits, single underscores, no leading digit.
  function ident(s) {
    let r = String(s || '').normalize('NFKD').replace(/[^\w]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!r) r = 'X';
    if (/^\d/.test(r)) r = 'V_' + r;
    return r;
  }

  // =========================================================== EOS_* library (Structured Text)
  const LIB = {
    EOS_SCALE: {
      kind: 'function', ret: 'REAL',
      ins: [['IN', 'REAL'], ['IN_MIN', 'REAL'], ['IN_MAX', 'REAL'], ['OUT_MIN', 'REAL'], ['OUT_MAX', 'REAL'], ['CLAMP', 'BOOL']],
      st: `IF IN_MAX = IN_MIN THEN
  EOS_SCALE := OUT_MIN;
ELSE
  EOS_SCALE := OUT_MIN + (IN - IN_MIN) * (OUT_MAX - OUT_MIN) / (IN_MAX - IN_MIN);
  IF CLAMP THEN
    EOS_SCALE := LIMIT(MIN(OUT_MIN, OUT_MAX), EOS_SCALE, MAX(OUT_MIN, OUT_MAX));
  END_IF;
END_IF;`,
    },
    EOS_AI: {
      kind: 'function', ret: 'REAL',
      ins: [['RAW', 'UINT'], ['LO', 'REAL'], ['HI', 'REAL']],
      doc: 'Analog input: OpenPLC delivers 0..65535 for 0..3.3 V.',
      st: 'EOS_AI := LO + UINT_TO_REAL(RAW) / 65535.0 * (HI - LO);',
    },
    EOS_AO: {
      kind: 'function', ret: 'UINT',
      ins: [['PCT', 'REAL']],
      doc: 'PWM output: 0..100 % to the 0..65535 range OpenPLC writes to %QW.',
      st: 'EOS_AO := REAL_TO_UINT(LIMIT(0.0, PCT, 100.0) * 655.35);',
    },
    EOS_THRESH: {
      kind: 'functionBlock',
      ins: [['IN', 'REAL'], ['ON_LEVEL', 'REAL'], ['OFF_LEVEL', 'REAL']], outs: [['Q', 'BOOL']],
      doc: 'Threshold with hysteresis. ON_LEVEL > OFF_LEVEL: on above ON_LEVEL. ON_LEVEL < OFF_LEVEL: on below ON_LEVEL.',
      st: `IF ON_LEVEL >= OFF_LEVEL THEN
  IF IN >= ON_LEVEL THEN Q := TRUE; ELSIF IN <= OFF_LEVEL THEN Q := FALSE; END_IF;
ELSE
  IF IN <= ON_LEVEL THEN Q := TRUE; ELSIF IN >= OFF_LEVEL THEN Q := FALSE; END_IF;
END_IF;`,
    },
    EOS_BLINK: {
      kind: 'functionBlock',
      ins: [['EN_IN', 'BOOL'], ['T_ON', 'TIME'], ['T_OFF', 'TIME']], outs: [['Q', 'BOOL']], locals: [['t_on_phase', 'TON'], ['t_off_phase', 'TON']],
      doc: 'Blinker: while EN_IN is TRUE, Q is TRUE for T_ON then FALSE for T_OFF.',
      st: `t_on_phase(IN := EN_IN AND NOT t_off_phase.Q, PT := T_ON);
t_off_phase(IN := t_on_phase.Q, PT := T_OFF);
Q := EN_IN AND NOT t_on_phase.Q;`,
    },
    EOS_WEEK: {
      kind: 'functionBlock',
      ins: [['DAYS', 'INT'], ['ON_MIN', 'INT'], ['OFF_MIN', 'INT'], ['DOW', 'INT'], ['MINUTE', 'INT']], outs: [['Q', 'BOOL']],
      locals: [['today', 'BOOL'], ['yesterday', 'BOOL']],
      doc: 'Weekly timer. DAYS bit 0 = Sunday. DOW (0 = Sunday) and MINUTE (minute of the day) must come from a clock.',
      st: `today := (SHR(INT_TO_WORD(DAYS), DOW) AND 16#0001) <> 0;
yesterday := (SHR(INT_TO_WORD(DAYS), (DOW + 6) MOD 7) AND 16#0001) <> 0;
IF ON_MIN <= OFF_MIN THEN
  Q := today AND MINUTE >= ON_MIN AND MINUTE < OFF_MIN;
ELSE
  Q := (today AND MINUTE >= ON_MIN) OR (yesterday AND MINUTE < OFF_MIN);
END_IF;`,
    },
  };
  const typeNode = (t) => (/^(BOOL|REAL|INT|UINT|TIME|WORD|DINT)$/.test(t) ? X('type', {}, X(t, {})) : X('type', {}, X('derived', { name: t })));
  const vdecl = (name, type, extra = {}) => X('variable', { name, address: extra.address },
    typeNode(type),
    extra.init !== undefined ? X('initialValue', {}, X('simpleValue', { value: extra.init })) : null,
    extra.doc ? X('documentation', {}, X('xhtml:p', {}, extra.doc)) : null);
  function libPou(name) {
    const L = LIB[name];
    const iface = X('interface', {},
      L.ret ? X('returnType', {}, X(L.ret, {})) : null,
      X('inputVars', {}, L.ins.map(([n, t]) => vdecl(n, t))),
      L.outs ? X('outputVars', {}, L.outs.map(([n, t]) => vdecl(n, t))) : null,
      L.locals ? X('localVars', {}, L.locals.map(([n, t]) => vdecl(n, t))) : null);
    return X('pou', { name, pouType: L.kind }, iface,
      X('body', {}, X('ST', {}, X('xhtml:p', {}, { raw: '<![CDATA[' + L.st + ']]>' }))),
      L.doc ? X('documentation', {}, X('xhtml:p', {}, L.doc)) : null);
  }

  const eosData = (obj) => X('addData', {}, X('data', { name: EOS_DATA, handleUnknown: 'discard' },
    X('eos:info', { 'xmlns:eos': EOS_XMLNS, json: JSON.stringify(obj) })));
  function readEos(el) {
    const ad = kid(el, 'addData');
    if (!ad) return null;
    for (const d of kidsNamed(ad, 'data')) {
      if (d.attrs.name !== EOS_DATA) continue;
      const info = kid(d, 'info');
      if (info && info.attrs.json) { try { return JSON.parse(info.attrs.json); } catch { return null; } }
    }
    return null;
  }

  // =========================================================== EXPORT
  const T_OF = { d: 'BOOL', a: 'REAL' };
  const CONVERT = { 'BOOL>REAL': 'BOOL_TO_REAL', 'INT>REAL': 'INT_TO_REAL', 'BOOL>INT': 'BOOL_TO_INT', 'REAL>INT': 'REAL_TO_INT' };
  const BW = 100;  // block width in the exported drawing

  /**
   * @param prog EspressOS program
   * @param opts {name, date (ISO string), version}
   * @returns {xml, warnings[], ioMap[{address, pin, block, kind}]}
   */
  function exportPLCopen(prog, opts = {}) {
    const warnings = [];
    const ioMap = [];
    const els = [];          // FBD element descriptors
    const vars = [];         // program variables
    const instances = [];    // FB instances
    const libNeeded = new Set();
    const names = new Set();
    let nextLocal = 1;
    const counters = { IX: 0, QX: 0, IW: 0, QW: 0 };
    const blocks = prog.blocks || [];
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const wireTo = new Map();
    for (const w of prog.wires || []) wireTo.set(w[2] + '.' + w[3], w);
    const devices = prog.devices || [];

    // evaluation order like the engine (Kahn); wires against it are feedback
    const order = new Map();
    {
      const indeg = new Map(blocks.map((b) => [b.id, 0]));
      const outs = new Map(blocks.map((b) => [b.id, []]));
      for (const w of prog.wires || []) { if (byId.has(w[0]) && byId.has(w[2])) { outs.get(w[0]).push(w[2]); indeg.set(w[2], indeg.get(w[2]) + 1); } }
      let progress = true, k = 0;
      const done = new Set();
      while (progress) {
        progress = false;
        for (const b of blocks) {
          if (done.has(b.id) || indeg.get(b.id) !== 0) continue;
          done.add(b.id); order.set(b.id, k++); progress = true;
          for (const t of outs.get(b.id)) indeg.set(t, indeg.get(t) - 1);
        }
      }
      for (const b of blocks) if (!done.has(b.id)) order.set(b.id, k++);
    }

    const uname = (base) => { let n = ident(base), i = 2; const b0 = n; while (names.has(n.toUpperCase())) n = b0 + '_' + i++; names.add(n.toUpperCase()); return n; };
    const addr = (kind) => {
      const n = counters[kind]++;
      return kind === 'IX' || kind === 'QX' ? `%${kind}${Math.floor(n / 8)}.${n % 8}` : `%${kind}${n}`;
    };
    const declare = (base, type, extra) => { const name = uname(base); vars.push({ name, type, ...extra }); return name; };
    const label = (b) => (b.note ? '_' + b.note : '');

    // --- element factories
    const inVar = (expr, x, y, extra = {}) => { const e = { kind: 'in', id: nextLocal++, expr, x, y, ...extra }; els.push(e); return e; };
    const outVar = (expr, x, y, extra = {}) => { const e = { kind: 'out', id: nextLocal++, expr, x, y, src: null, ...extra }; els.push(e); return e; };
    const block = (typeName, x, y, ins, outs, extra = {}) => {
      const e = { kind: 'block', id: nextLocal++, typeName, x, y, ins: ins.map((f) => ({ formal: f, src: null })), outs: outs.map((f) => ({ formal: f, neg: false })), ...extra };
      els.push(e);
      return e;
    };
    const fbInstance = (typeName, b, suffix = '') => { const n = uname(typeName + '_B' + b.id + suffix); instances.push({ name: n, type: typeName }); return n; };
    const literal = (text, x, y) => inVar(text, x, y, { literal: true });

    // outputs of EspressOS blocks: "id.port" -> {ref: element, param, type}
    const outRef = new Map();
    const setOut = (b, port, el, param, type) => outRef.set(b.id + '.' + port, { el, param, type });
    const pending = []; // {el, slot (index or 'src'), b, port, type, fallback (literal text|null)}
    const need = (el, slot, b, port, type, fallback) => pending.push({ el, slot, b, port, type, fallback });

    for (const b of blocks) {
      const p = b.p || {};
      const x = b.x || 0, y = b.y || 0;
      const eos = { id: b.id, type: b.type, ui: b.ui, p, note: b.note };
      const def = C.blockDef(b);
      switch (b.type) {
        case 'CONST': {
          const e = literal(fmtReal(p.value), x, y);
          e.eos = eos;
          setOut(b, 0, e, null, 'REAL');
          break;
        }
        case 'VIN': {
          const slider = b.ui === 'VSLIDER';
          const v = declare('V' + p.idx + '_' + (p.name || ''), slider ? 'REAL' : 'BOOL', { doc: `EspressOS web ${slider ? 'setpoint' : (p.mode === 'button' ? 'push button' : 'switch')} slot ${p.idx}` });
          setOut(b, 0, inVar(v, x, y, { eos }), null, slider ? 'REAL' : 'BOOL');
          break;
        }
        case 'DI': {
          const a = addr('IX');
          const v = declare('DI_B' + b.id + label(b), 'BOOL', { address: a, doc: 'GPIO ' + p.pin });
          ioMap.push({ address: a, pin: Number(p.pin), block: b.id, kind: 'digital input' });
          setOut(b, 0, inVar(v, x, y, { eos, negated: !!Number(p.inv) }), null, 'BOOL');
          break;
        }
        case 'DO': {
          const a = addr('QX');
          const v = declare('DO_B' + b.id + label(b), 'BOOL', { address: a, doc: 'GPIO ' + p.pin });
          ioMap.push({ address: a, pin: Number(p.pin), block: b.id, kind: 'digital output' });
          const e = outVar(v, x, y, { eos, negated: !!Number(p.inv) });
          need(e, 'src', b, 0, 'BOOL', 'FALSE');
          break;
        }
        case 'AI': {
          const a = addr('IW');
          const v = declare('AI_B' + b.id + label(b), 'UINT', { address: a, doc: 'GPIO ' + p.pin });
          ioMap.push({ address: a, pin: Number(p.pin), block: b.id, kind: 'analog input' });
          const raw = inVar(v, x - 130, y);
          libNeeded.add('EOS_AI');
          const e = block('EOS_AI', x, y, ['RAW', 'LO', 'HI'], ['OUT'], { eos });
          e.ins[0].src = { el: raw };
          e.ins[1].src = { el: literal(fmtReal(p.min), x - 130, y + 30) };
          e.ins[2].src = { el: literal(fmtReal(p.max), x - 130, y + 60) };
          setOut(b, 0, e, 'OUT', 'REAL');
          break;
        }
        case 'AO': {
          const a = addr('QW');
          const v = declare('AO_B' + b.id + label(b), 'UINT', { address: a, doc: 'GPIO ' + p.pin + ' (PWM)' });
          ioMap.push({ address: a, pin: Number(p.pin), block: b.id, kind: 'analog (PWM) output' });
          libNeeded.add('EOS_AO');
          const e = block('EOS_AO', x, y, ['PCT'], ['OUT'], { eos });
          need(e, 0, b, 0, 'REAL', '0.0');
          outVar(v, x + 160, y).src = { el: e, param: 'OUT' };
          break;
        }
        case 'SENSOR': {
          const dev = devices.find((d) => d.id === Number(p.dev));
          const drv = dev && C.DRIVERS.find((d) => d.id === dev.driver);
          const chName = drv && drv.ch[p.ch] ? drv.ch[p.ch][0] : 'ch' + p.ch;
          const base = 'S_' + (dev ? dev.name || dev.driver : 'dev' + p.dev) + '_' + chName;
          const v = declare(base, 'REAL', { doc: `EspressOS sensor ${dev ? dev.driver : '?'} channel ${chName}` });
          setOut(b, 0, inVar(v, x, y, { eos }), null, 'REAL');
          const okName = declare(base + '_OK', 'BOOL', { init: 'TRUE', doc: 'TRUE while the sensor answers' });
          setOut(b, 1, inVar(okName, x, y + 40), null, 'BOOL');
          warnings.push(`B${b.id}: sensor "${base}" has no IEC equivalent. It is exported as REAL variable ${v}; feed it from your PLC's own I/O or Modbus.`);
          break;
        }
        case 'AND': case 'OR': case 'XOR': case 'NAND': case 'NOR': {
          const base = { NAND: 'AND', NOR: 'OR' }[b.type] || b.type;
          const connected = [0, 1, 2, 3].filter((i) => wireTo.has(b.id + '.' + i));
          const pad = base === 'AND' ? 'TRUE' : 'FALSE';
          const slots = connected.length >= 2 ? connected : connected.concat([null, null]).slice(0, 2);
          const e = block(base, x, y, slots.map((_, i) => 'IN' + (i + 1)), ['OUT'], { eos });
          slots.forEach((port, i) => {
            if (port === null) e.ins[i].src = { el: literal(connected.length ? pad : 'FALSE', x - 70, y + 20 * i) };
            else need(e, i, b, port, 'BOOL', null);
          });
          if (b.type === 'NAND' || b.type === 'NOR') e.outs[0].neg = true;
          setOut(b, 0, e, 'OUT', 'BOOL');
          break;
        }
        case 'NOT': {
          const e = block('NOT', x, y, ['IN'], ['OUT'], { eos });
          need(e, 0, b, 0, 'BOOL', 'FALSE');
          setOut(b, 0, e, 'OUT', 'BOOL');
          break;
        }
        case 'SR': {
          const setWins = p.prio === 'S';
          const t = setWins ? 'SR' : 'RS';
          const e = block(t, x, y, setWins ? ['S1', 'R'] : ['S', 'R1'], ['Q1'], { eos, instance: fbInstance(t, b) });
          need(e, 0, b, 0, 'BOOL', 'FALSE');
          need(e, 1, b, 1, 'BOOL', 'FALSE');
          setOut(b, 0, e, 'Q1', 'BOOL');
          break;
        }
        case 'EDGE': {
          const r = block('R_TRIG', x, y, ['CLK'], ['Q'], { eos, instance: fbInstance('R_TRIG', b) });
          const f = block('F_TRIG', x, y + 70, ['CLK'], ['Q'], { eos: { ...eos, part: 'falling' }, instance: fbInstance('F_TRIG', b) });
          need(r, 0, b, 0, 'BOOL', 'FALSE');
          need(f, 0, b, 0, 'BOOL', 'FALSE');
          setOut(b, 0, r, 'Q', 'BOOL');
          setOut(b, 1, f, 'Q', 'BOOL');
          break;
        }
        case 'TON': case 'TOF': case 'TP': {
          const e = block(b.type, x, y, ['IN', 'PT'], ['Q'], { eos, instance: fbInstance(b.type, b) });
          need(e, 0, b, 0, 'BOOL', 'FALSE');
          e.ins[1].src = { el: literal(fmtTime(p.t), x - 90, y + 20) };
          setOut(b, 0, e, 'Q', 'BOOL');
          break;
        }
        case 'BLINK': {
          libNeeded.add('EOS_BLINK');
          const e = block('EOS_BLINK', x, y, ['EN_IN', 'T_ON', 'T_OFF'], ['Q'], { eos, instance: fbInstance('EOS_BLINK', b) });
          need(e, 0, b, 0, 'BOOL', 'TRUE');
          e.ins[1].src = { el: literal(fmtTime(p.on), x - 90, y + 20) };
          e.ins[2].src = { el: literal(fmtTime(p.off), x - 90, y + 40) };
          setOut(b, 0, e, 'Q', 'BOOL');
          break;
        }
        case 'WEEK': {
          libNeeded.add('EOS_WEEK');
          if (!names.has('CLOCK_DOW')) {
            declare('CLOCK_DOW', 'INT', { doc: 'Day of week, 0 = Sunday. Set it from a real-time clock.' });
            declare('CLOCK_MINUTE', 'INT', { doc: 'Minute of the day, 0..1439. Set it from a real-time clock.' });
            warnings.push('Weekly timers need the time of day: set variables CLOCK_DOW and CLOCK_MINUTE from a real-time clock in your PLC.');
          }
          const e = block('EOS_WEEK', x, y, ['DAYS', 'ON_MIN', 'OFF_MIN', 'DOW', 'MINUTE'], ['Q'], { eos, instance: fbInstance('EOS_WEEK', b) });
          e.ins[0].src = { el: literal(String(Math.round(p.days)), x - 90, y) };
          e.ins[1].src = { el: literal(String(Math.round(p.on)), x - 90, y + 20) };
          e.ins[2].src = { el: literal(String(Math.round(p.off)), x - 90, y + 40) };
          e.ins[3].src = { el: inVar('CLOCK_DOW', x - 90, y + 60) };
          e.ins[4].src = { el: inVar('CLOCK_MINUTE', x - 90, y + 80) };
          setOut(b, 0, e, 'Q', 'BOOL');
          break;
        }
        case 'CTR': {
          const e = block('CTUD', x, y, ['CU', 'CD', 'R', 'LD', 'PV'], ['QU', 'QD', 'CV'], { eos, instance: fbInstance('CTUD', b) });
          need(e, 0, b, 0, 'BOOL', 'FALSE');
          need(e, 1, b, 1, 'BOOL', 'FALSE');
          need(e, 2, b, 2, 'BOOL', 'FALSE');
          e.ins[3].src = { el: literal('FALSE', x - 90, y + 60) };
          e.ins[4].src = { el: literal(String(Math.round(p.preset)), x - 90, y + 80) };
          setOut(b, 0, e, 'QU', 'BOOL');
          setOut(b, 1, e, 'CV', 'INT');
          break;
        }
        case 'CMP': {
          const t = { '>': 'GT', '>=': 'GE', '<': 'LT', '<=': 'LE', '==': 'EQ', '!=': 'NE' }[p.op] || 'GT';
          const e = block(t, x, y, ['IN1', 'IN2'], ['OUT'], { eos });
          need(e, 0, b, 0, 'REAL', '0.0');
          need(e, 1, b, 1, 'REAL', fmtReal(p.b));
          setOut(b, 0, e, 'OUT', 'BOOL');
          if (p.op === '==' || p.op === '!=') warnings.push(`B${b.id}: IEC EQ/NE compare REAL values exactly; EspressOS allows a 0.000001 tolerance.`);
          break;
        }
        case 'THRESH': {
          libNeeded.add('EOS_THRESH');
          const e = block('EOS_THRESH', x, y, ['IN', 'ON_LEVEL', 'OFF_LEVEL'], ['Q'], { eos, instance: fbInstance('EOS_THRESH', b) });
          need(e, 0, b, 0, 'REAL', '0.0');
          e.ins[1].src = { el: literal(fmtReal(p.on), x - 90, y + 20) };
          e.ins[2].src = { el: literal(fmtReal(p.off), x - 90, y + 40) };
          setOut(b, 0, e, 'Q', 'BOOL');
          break;
        }
        case 'MATH': {
          const t = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', min: 'MIN', max: 'MAX' }[p.op] || 'ADD';
          const e = block(t, x, y, ['IN1', 'IN2'], ['OUT'], { eos });
          need(e, 0, b, 0, 'REAL', '0.0');
          need(e, 1, b, 1, 'REAL', fmtReal(p.b));
          setOut(b, 0, e, 'OUT', 'REAL');
          if (t === 'DIV') warnings.push(`B${b.id}: EspressOS returns 0 for division by zero; IEC DIV does not.`);
          break;
        }
        case 'SCALE': {
          libNeeded.add('EOS_SCALE');
          const e = block('EOS_SCALE', x, y, ['IN', 'IN_MIN', 'IN_MAX', 'OUT_MIN', 'OUT_MAX', 'CLAMP'], ['OUT'], { eos });
          need(e, 0, b, 0, 'REAL', '0.0');
          ['inMin', 'inMax', 'outMin', 'outMax'].forEach((k, i) => (e.ins[i + 1].src = { el: literal(fmtReal(p[k]), x - 90, y + 20 * (i + 1)) }));
          e.ins[5].src = { el: literal(Number(p.clamp) ? 'TRUE' : 'FALSE', x - 90, y + 100) };
          setOut(b, 0, e, 'OUT', 'REAL');
          break;
        }
        case 'SEL': {
          const e = block('SEL', x, y, ['G', 'IN0', 'IN1'], ['OUT'], { eos });
          need(e, 0, b, 2, 'BOOL', 'FALSE');
          need(e, 1, b, 0, 'REAL', '0.0');
          need(e, 2, b, 1, 'REAL', '0.0');
          setOut(b, 0, e, 'OUT', 'REAL');
          break;
        }
        default:
          warnings.push(`B${b.id}: block type ${b.type} cannot be exported and was left out.`);
      }
      void def;
    }

    // --- connect inputs (second pass: every output is known now)
    const feedbackVar = new Map();
    for (const q of pending) {
      const w = wireTo.get(q.b.id + '.' + q.port);
      const tx = q.el.x - 60, ty = q.el.y + (typeof q.slot === 'number' ? q.slot * 20 : 0);
      let src;
      if (!w) {
        src = q.fallback === null ? null : { el: literal(q.fallback, tx, ty) };
      } else {
        const r = outRef.get(w[0] + '.' + w[1]);
        if (!r) { warnings.push(`B${q.b.id}: input ${q.port} comes from a block that was not exported.`); src = q.fallback ? { el: literal(q.fallback, tx, ty) } : null; }
        else {
          let s = { el: r.el, param: r.param }, type = r.type;
          // Feedback wire: route through a variable, which gives the same one-cycle delay as EspressOS.
          if (order.get(w[0]) >= order.get(q.b.id)) {
            const key = w[0] + '.' + w[1];
            if (!feedbackVar.has(key)) {
              const v = declare('FB_B' + w[0] + '_' + w[1], type);
              const src0 = byId.get(w[0]);
              const o = outVar(v, (src0.x || 0) + BW + 40, (src0.y || 0) + 40);
              o.src = s;
              feedbackVar.set(key, v);
            }
            s = { el: inVar(feedbackVar.get(key), tx - 40, ty) };
          }
          const conv = type !== q.type ? CONVERT[type + '>' + q.type] : null;
          if (type !== q.type && !conv) warnings.push(`B${q.b.id}: cannot convert ${type} to ${q.type}.`);
          if (conv) { const c = block(conv, tx - 20, ty, ['IN'], ['OUT']); c.ins[0].src = s; s = { el: c, param: 'OUT' }; }
          src = s;
        }
      }
      if (q.slot === 'src') q.el.src = src;
      else q.el.ins[q.slot].src = src;
    }

    // --- serialize FBD
    const rel = (x, y) => X('relPosition', { x: Math.round(x), y: Math.round(y) });
    const conn = (src) => (src ? X('connection', { refLocalId: src.el.id, formalParameter: src.param || undefined }) : null);
    const fbd = els.map((e) => {
      const pos = X('position', { x: Math.round(e.x), y: Math.round(e.y) });
      const ad = e.eos ? eosData(e.eos) : null;
      if (e.kind === 'in') {
        const w = Math.max(40, e.expr.length * 8 + 10);
        return X('inVariable', { localId: e.id, height: 30, width: w, negated: e.negated ? 'true' : undefined }, pos,
          X('connectionPointOut', {}, rel(w, 15)), X('expression', {}, e.expr), ad);
      }
      if (e.kind === 'out') {
        return X('outVariable', { localId: e.id, height: 30, width: Math.max(40, e.expr.length * 8 + 10), negated: e.negated ? 'true' : undefined }, pos,
          X('connectionPointIn', {}, rel(0, 15), conn(e.src)), X('expression', {}, e.expr), ad);
      }
      const h = 40 + 20 * Math.max(e.ins.length, e.outs.length);
      return X('block', { localId: e.id, typeName: e.typeName, instanceName: e.instance, width: BW, height: h }, pos,
        X('inputVariables', {}, e.ins.map((i, k) => X('variable', { formalParameter: i.formal },
          X('connectionPointIn', {}, rel(0, 40 + 20 * k), conn(i.src))))),
        X('inOutVariables', {}),
        X('outputVariables', {}, e.outs.map((o, k) => X('variable', { formalParameter: o.formal, negated: o.neg ? 'true' : undefined },
          X('connectionPointOut', {}, rel(BW, 40 + 20 * k))))),
        ad);
    });

    const progName = 'main';
    const now = opts.date || new Date().toISOString().replace(/\.\d+Z$/, '');
    const pinDoc = ioMap.length ? 'I/O map (set the same pins in OpenPLC board settings): ' + ioMap.map((m) => `${m.address} = GPIO ${m.pin} (B${m.block}, ${m.kind})`).join('; ') : 'No hardware I/O.';
    const mainPou = X('pou', { name: progName, pouType: 'program' },
      X('interface', {}, X('localVars', {},
        vars.map((v) => vdecl(v.name, v.type, v)),
        instances.map((v) => vdecl(v.name, v.type)))),
      X('body', {}, X('FBD', {}, fbd)),
      X('documentation', {}, X('xhtml:p', {}, 'Exported from EspressOS. ' + pinDoc)));

    const cycle = Math.max(1, Math.round(prog.cycleMs || 10));
    const project = X('project', { xmlns: NS, 'xmlns:xhtml': 'http://www.w3.org/1999/xhtml', 'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema' },
      X('fileHeader', { companyName: 'EspressOS', productName: 'EspressOS', productVersion: opts.version || '0.1.0', creationDateTime: now }),
      X('contentHeader', { name: opts.name || 'EspressOS program', modificationDateTime: now },
        X('coordinateInfo', {},
          X('fbd', {}, X('scaling', { x: 1, y: 1 })),
          X('ld', {}, X('scaling', { x: 1, y: 1 })),
          X('sfc', {}, X('scaling', { x: 1, y: 1 })))),
      X('types', {}, X('dataTypes', {}), X('pous', {}, [...libNeeded].sort().map(libPou), mainPou)),
      X('instances', {}, X('configurations', {}, X('configuration', { name: 'Config0' },
        X('resource', { name: 'Res0' },
          X('task', { name: 'task0', priority: 0, interval: `T#${cycle}ms` }, X('pouInstance', { name: 'instance0', typeName: progName })))))),
      eosData({ version: 1, cycleMs: prog.cycleMs, devices, lastId: prog.lastId }));

    const kindOrder = (a) => ['%IX', '%IW', '%QX', '%QW'].indexOf(a.slice(0, 3));
    ioMap.sort((a, b) => kindOrder(a.address) - kindOrder(b.address) || a.address.localeCompare(b.address, 'en', { numeric: true }));
    return { xml: '<?xml version="1.0" encoding="utf-8"?>\n' + ser(project), warnings, ioMap };
  }

  // =========================================================== IMPORT
  const LOGIC = { AND: 1, OR: 1, XOR: 1 };
  const CMPS = { GT: '>', GE: '>=', LT: '<', LE: '<=', EQ: '==', NE: '!=' };
  const MATHS = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MIN: 'min', MAX: 'max' };
  const isConversion = (t) => /^[A-Z]+_TO_[A-Z]+$/.test(t) || /^TRUNC$/.test(t);

  /**
   * @returns {prog, warnings[]}
   */
  function importPLCopen(xmlText) {
    const warnings = [];
    const doc = parseXml(xmlText);
    if (doc.name !== 'project') throw new Error('Not a PLCopen XML project');
    const pous = findAll(doc, 'pou');
    const programs = pous.filter((p) => p.attrs.pouType === 'program');
    const fbdPou = programs.find((p) => kid(kid(p, 'body'), 'FBD')) || pous.find((p) => kid(kid(p, 'body'), 'FBD'));
    if (!fbdPou) {
      const langs = [...new Set(pous.flatMap((p) => (kid(p, 'body') ? kid(p, 'body').kids.map((k) => k.name) : [])))];
      throw new Error('No FBD program found' + (langs.length ? ' (the file uses ' + langs.join(', ') + '). EspressOS can only import Function Block Diagrams.' : '.'));
    }
    if (programs.length > 1) warnings.push(`The file has ${programs.length} programs; only "${fbdPou.attrs.name}" was imported.`);
    const projEos = readEos(doc) || {};

    // variables of the program (and global ones)
    const varInfo = new Map();
    const collectVars = (container) => {
      for (const list of container.kids) for (const v of kidsNamed(list, 'variable')) {
        const t = kid(v, 'type');
        const tn = t && t.kids[0] ? (t.kids[0].name === 'derived' ? t.kids[0].attrs.name : t.kids[0].name) : 'BOOL';
        const iv = kid(kid(v, 'initialValue'), 'simpleValue');
        varInfo.set(v.attrs.name.toUpperCase(), { name: v.attrs.name, type: tn.toUpperCase(), address: v.attrs.address, init: iv ? iv.attrs.value : undefined });
      }
    };
    if (kid(fbdPou, 'interface')) collectVars(kid(fbdPou, 'interface'));
    for (const g of findAll(doc, 'globalVars')) collectVars({ kids: [g] });

    // FBD elements
    const fbd = kid(kid(fbdPou, 'body'), 'FBD');
    const el = new Map();
    const connOf = (cpi) => {
      const c = kid(cpi, 'connection');
      return c ? { ref: c.attrs.refLocalId, param: c.attrs.formalParameter } : null;
    };
    for (const e of fbd.kids) {
      const pos = kid(e, 'position');
      const base = { id: e.attrs.localId, tag: e.name, x: pos ? Number(pos.attrs.x) : 0, y: pos ? Number(pos.attrs.y) : 0, eos: readEos(e), neg: e.attrs.negated === 'true' };
      if (e.name === 'inVariable' || e.name === 'outVariable' || e.name === 'inOutVariable') {
        const expr = (kid(e, 'expression') || { text: '' }).text.trim();
        el.set(base.id, { ...base, expr, in: connOf(kid(e, 'connectionPointIn')) });
      } else if (e.name === 'block') {
        const ins = kidsNamed(kid(e, 'inputVariables'), 'variable').map((v) => ({ formal: v.attrs.formalParameter, neg: v.attrs.negated === 'true', edge: v.attrs.edge, conn: connOf(kid(v, 'connectionPointIn')) }));
        const outs = kidsNamed(kid(e, 'outputVariables'), 'variable').map((v) => ({ formal: v.attrs.formalParameter, neg: v.attrs.negated === 'true' }));
        if (kidsNamed(kid(e, 'inOutVariables'), 'variable').length) warnings.push(`Block ${e.attrs.typeName} (${base.id}) has in/out parameters, which are ignored.`);
        el.set(base.id, { ...base, typeName: e.attrs.typeName.toUpperCase(), ins, outs });
      } else if (e.name === 'connector') {
        el.set(base.id, { ...base, name: e.attrs.name, in: connOf(kid(e, 'connectionPointIn')) });
      } else if (e.name === 'continuation') {
        el.set(base.id, { ...base, name: e.attrs.name });
      } else if (e.name === 'comment') {
        /* ignore */
      } else {
        warnings.push(`FBD element <${e.name}> is not supported and was skipped.`);
      }
    }
    const connectors = new Map([...el.values()].filter((e) => e.tag === 'connector').map((e) => [e.name.toUpperCase(), e]));

    // variable writers: which outVariable feeds each variable
    const writers = new Map();
    for (const e of el.values()) if (e.tag === 'outVariable' || e.tag === 'inOutVariable') {
      const k = e.expr.toUpperCase();
      if (writers.has(k)) warnings.push(`Variable ${e.expr} is written more than once; the first write is used.`);
      else writers.set(k, e);
    }

    // ---- build EspressOS blocks
    const blocks = [];
    const wires = [];
    // Block ids: keep the ids recorded in addData; new blocks get ids nobody reserved.
    const usedIds = new Set();
    const reserved = new Set([...el.values()].filter((e) => e.eos && e.eos.id).map((e) => e.eos.id));
    let autoId = 0;
    const takeId = (want) => {
      if (want && !usedIds.has(want)) { usedIds.add(want); return want; }
      do autoId++; while (usedIds.has(autoId) || reserved.has(autoId));
      usedIds.add(autoId);
      return autoId;
    };
    const devices = Array.isArray(projEos.devices) ? projEos.devices : [];
    const usedPins = new Set();
    const usedVin = new Set();
    const addBlock = (type, x, y, p, extra = {}) => {
      const def = C.BLOCKS.find((d) => (extra.ui ? d.ui === extra.ui : d.type === type && !d.ui)) || C.BLOCKS.find((d) => d.type === type);
      const b = { id: extra.wantId !== undefined ? extra.wantId : takeId(), type, x: Math.round(x), y: Math.round(y), p: { ...C.defaults(def), ...p } };
      if (extra.ui) b.ui = extra.ui;
      if (extra.note) b.note = extra.note;
      blocks.push(b);
      return b;
    };
    // Preferred order for pins EspressOS picks itself: plain GPIOs first, then the
    // boot-strapping / on-board-LED pins; never the default I2C pins 21/22.
    const PREFER = [4, 5, 13, 14, 16, 17, 18, 19, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39, 2, 12, 15];
    const pickPin = (list0, want, what, name) => {
      const list = PREFER.filter((p) => list0.includes(p));
      if (want !== undefined && want !== null && !usedPins.has(Number(want))) { usedPins.add(Number(want)); return Number(want); }
      const free = list.find((p) => !usedPins.has(p) && !wantedPins.has(p));
      if (free === undefined) { warnings.push(`No free GPIO left for ${what} ${name}.`); return list[0]; }
      usedPins.add(free);
      warnings.push(`${what} ${name} was given GPIO ${free}; check that this matches your wiring.`);
      return free;
    };
    const pickVin = (want) => {
      if (want !== undefined && !usedVin.has(Number(want))) { usedVin.add(Number(want)); return Number(want); }
      let i = 0; while ((usedVin.has(i) || wantedVin.has(i)) && i < 15) i++;
      usedVin.add(i);
      return i;
    };
    const noteOf = (eos, fallback) => (eos && eos.note) || fallback;
    // Pins and web slots recorded in addData are reserved before any are auto-assigned.
    const wantedPins = new Set(), wantedVin = new Set();
    for (const e of el.values()) if (e.eos && e.eos.p) {
      if (e.eos.p.pin !== undefined && ['DI', 'DO', 'AI', 'AO'].includes(e.eos.type)) wantedPins.add(Number(e.eos.p.pin));
      if (e.eos.type === 'VIN') wantedVin.add(Number(e.eos.p.idx));
    }

    // node -> EspressOS output, filled as blocks are created: key "localId.param" -> [blockId, port]
    const produced = new Map();
    const mapOut = (e, param, id, port) => produced.set(e.id + '.' + (param || ''), [id, port]);
    const toConnect = []; // {bid, port, conn (from an FBD input), neg}
    const literalParam = (conn) => {
      if (!conn) return null;
      const s = el.get(conn.ref);
      if (s && s.tag === 'inVariable' && !(s.eos && s.eos.type === 'CONST')) { const l = parseLiteral(s.expr); if (l) return l; }
      return null;
    };
    const outputUsed = (e, formal) => [...el.values()].some((o) =>
      (o.in && o.in.ref === e.id && o.in.param === formal) || (o.ins && o.ins.some((i) => i.conn && i.conn.ref === e.id && i.conn.param === formal)));
    const inputOf = (e, formal) => e.ins.find((i) => i.formal && i.formal.toUpperCase() === formal);

    // Inputs that EspressOS handles inside the block itself (clock, raw ADC value):
    // the variables feeding them do not become blocks.
    const INTERNAL_INPUTS = { EOS_WEEK: ['DOW', 'MINUTE'], EOS_AI: ['RAW'] };
    const consumed = new Set();
    for (const e of el.values()) {
      if (e.tag === 'block') {
        for (const i of e.ins) if (i.conn && !(INTERNAL_INPUTS[e.typeName] || []).includes((i.formal || '').toUpperCase())) consumed.add(i.conn.ref);
      } else if (e.in) consumed.add(e.in.ref);
    }

    // Effective blocks for each FBD element type (elements carrying EspressOS data first,
    // so e.g. a sensor claims its _OK flag before that variable is treated generically)
    for (const e of [...el.values()].sort((a, b) => (b.eos ? 1 : 0) - (a.eos ? 1 : 0))) {
      if (e.tag === 'inVariable') {
        if (e.eos && e.eos.type === 'CONST') {            // an EspressOS constant block: keep it as a block
          const l = parseLiteral(e.expr);
          const b = addBlock('CONST', e.x, e.y, { value: l ? l.value : Number(e.eos.p && e.eos.p.value) || 0 }, { note: e.eos.note, wantId: takeId(e.eos.id) });
          mapOut(e, '', b.id, 0);
          continue;
        }
        if (parseLiteral(e.expr)) continue;               // literals are resolved where they are used
        if (produced.has(e.id + '.')) continue;           // already mapped (e.g. a sensor's _OK flag)
        if (!consumed.has(e.id) && !(e.eos && e.eos.type)) continue; // read by nothing EspressOS keeps
        const info = varInfo.get(e.expr.toUpperCase()) || { name: e.expr, type: 'BOOL' };
        if (writers.has(e.expr.toUpperCase())) continue;  // internal variable: becomes a wire
        const a = (info.address || '').toUpperCase();
        const eos = e.eos;
        if (eos && eos.type === 'VIN') {
          const b = addBlock('VIN', e.x, e.y, { ...eos.p, idx: pickVin(eos.p.idx) }, { ui: eos.ui, note: eos.note, wantId: takeId(eos.id) });
          mapOut(e, '', b.id, 0);
        } else if (eos && eos.type === 'SENSOR') {
          const b = addBlock('SENSOR', e.x, e.y, eos.p, { note: eos.note, wantId: takeId(eos.id) });
          mapOut(e, '', b.id, 0);
          const okVar = [...el.values()].find((o) => o.tag === 'inVariable' && o.expr.toUpperCase() === (e.expr + '_OK').toUpperCase());
          if (okVar) mapOut(okVar, '', b.id, 1);
        } else if (/^%I[X]/.test(a) || (eos && eos.type === 'DI')) {
          const p = eos ? eos.p : {};
          const b = addBlock('DI', e.x, e.y, { pull: p.pull !== undefined ? p.pull : 0, inv: e.neg ? 1 : 0, pin: pickPin(C.IN_PINS, p.pin, 'Digital input', e.expr) }, { note: noteOf(eos, info.name), wantId: takeId(eos && eos.id) });
          mapOut(e, '', b.id, 0);
          continue;
        } else if (/^%I[WD]/.test(a)) {
          const b = addBlock('AI', e.x, e.y, { pin: pickPin(C.ADC_PINS, undefined, 'Analog input', e.expr), min: 0, max: 65535 }, { note: info.name });
          mapOut(e, '', b.id, 0);
        } else if (/^%[IQM]/.test(a) || /^%Q/.test(a)) {
          warnings.push(`Variable ${e.expr} (${a}) is read but EspressOS cannot read that address; a web control was used instead.`);
          const b = addBlock('VIN', e.x, e.y, { idx: pickVin(), name: info.name, mode: 'switch' }, { ui: info.type === 'BOOL' ? 'VSWITCH' : 'VSLIDER', note: info.name });
          mapOut(e, '', b.id, 0);
        } else if (!(eos && eos.type)) {
          // Plain input variable nobody writes: a web control lets you set it.
          const isBool = info.type === 'BOOL';
          const init = info.init !== undefined ? parseLiteral(info.init) : null;
          if (/_OK$/i.test(e.expr) && init && init.type === 'BOOL') {
            const b = addBlock('CONST', e.x, e.y, { value: init.value });
            mapOut(e, '', b.id, 0);
            continue;
          }
          const b = addBlock('VIN', e.x, e.y, { idx: pickVin(), name: info.name, mode: 'switch', ...(isBool ? {} : { min: 0, max: 100, step: 1 }) }, { ui: isBool ? 'VSWITCH' : 'VSLIDER', note: info.name });
          mapOut(e, '', b.id, 0);
          warnings.push(`Variable ${e.expr} is only read, so it became a web ${isBool ? 'switch' : 'setpoint'} (slot ${b.p.idx}).`);
        }
        if (e.neg) warnings.push(`Negated read of ${e.expr} is applied with a NOT block.`);
      } else if (e.tag === 'outVariable') {
        const info = varInfo.get(e.expr.toUpperCase()) || { name: e.expr, type: 'BOOL' };
        const a = (info.address || '').toUpperCase();
        const eos = e.eos;
        const readers = [...el.values()].some((o) => o.tag === 'inVariable' && o.expr.toUpperCase() === e.expr.toUpperCase());
        if (/^%QX/.test(a) || (eos && eos.type === 'DO')) {
          const p = eos ? eos.p : {};
          const b = addBlock('DO', e.x, e.y, { inv: e.neg ? 1 : 0, pin: pickPin(C.OUT_PINS, p.pin, 'Digital output', e.expr) }, { note: noteOf(eos, info.name), wantId: takeId(eos && eos.id) });
          if (e.in) toConnect.push({ bid: b.id, port: 0, conn: e.in, neg: false });
        } else if (/^%Q[WD]/.test(a)) {
          const src = e.in && el.get(e.in.ref);
          if (src && src.tag === 'block' && src.typeName === 'EOS_AO') continue; // handled by the EOS_AO block
          const b = addBlock('AO', e.x, e.y, { pin: pickPin(C.OUT_PINS, undefined, 'Analog output', e.expr), freq: 1000 }, { note: info.name });
          const m = addBlock('MATH', e.x - 120, e.y, { op: '/', b: 655.35 }, { note: 'to %' });
          wires.push([m.id, 0, b.id, 0]);
          if (e.in) toConnect.push({ bid: m.id, port: 0, conn: e.in, neg: false });
        } else if (!readers && !/^FB_B\d+/i.test(e.expr)) {
          warnings.push(`Variable ${e.expr} is written but never used; it was left out.`);
        }
      } else if (e.tag === 'block') {
        const t = e.typeName;
        const eos = e.eos || {};
        const p = eos.p || {};
        const note = eos.note;
        const wantId = eos.type ? takeId(eos.id) : undefined;
        const lit = (formal) => literalParam(inputOf(e, formal) && inputOf(e, formal).conn);
        const wireIn = (formal, bid, port, extraNeg = false) => {
          const i = inputOf(e, formal);
          if (i && i.conn) toConnect.push({ bid, port, conn: i.conn, neg: i.neg !== extraNeg ? true : false, from: t });
          if (i && i.edge && i.edge !== 'none') warnings.push(`Edge-triggered input ${t}.${formal} is not supported; it was treated as a level.`);
        };
        if (isConversion(t)) continue; // conversions are transparent wires
        if (LOGIC[t]) {
          const neg = e.outs[0] && e.outs[0].neg;
          const type = neg ? (t === 'AND' ? 'NAND' : t === 'OR' ? 'NOR' : 'XOR') : t;
          if (neg && t === 'XOR') warnings.push(`Negated XOR (${e.id}) is imported as XOR followed by NOT.`);
          // drop neutral padding literals (AND TRUE, OR/XOR FALSE)
          const real = e.ins.filter((i) => {
            const l = literalParam(i.conn);
            return !(l && l.type === 'BOOL' && ((t === 'AND' && l.value === 1) || (t !== 'AND' && l.value === 0)));
          });
          const chunks = [];
          for (let k = 0; k < real.length; k += 4) chunks.push(real.slice(k, k + 4));
          if (!chunks.length) chunks.push([]);
          if (chunks.length > 1) warnings.push(`${t} with ${real.length} inputs was split into ${chunks.length} blocks.`);
          const parts = chunks.map((ch, k) => {
            const b = addBlock(chunks.length > 1 ? t : type === 'XOR' && neg ? 'XOR' : type, e.x, e.y + 130 * k, {}, { note, wantId: k === 0 ? wantId : undefined });
            ch.forEach((i, n) => toConnect.push({ bid: b.id, port: n, conn: i.conn, neg: i.neg }));
            return b;
          });
          let outB = parts[0];
          if (parts.length > 1) {
            const join = addBlock(neg ? (t === 'AND' ? 'NAND' : 'NOR') : t, e.x + 140, e.y, {});
            parts.slice(0, 4).forEach((b, n) => wires.push([b.id, 0, join.id, n]));
            outB = join;
          }
          if (neg && t === 'XOR') { const n = addBlock('NOT', e.x + 140, e.y, {}); wires.push([outB.id, 0, n.id, 0]); outB = n; }
          mapOut(e, e.outs[0] ? e.outs[0].formal : 'OUT', outB.id, 0);
          continue;
        }
        let b = null;
        const outNeg = e.outs.some((o) => o.neg);
        switch (t) {
          case 'NOT': b = addBlock('NOT', e.x, e.y, {}, { note, wantId }); wireIn('IN', b.id, 0); mapOut(e, 'OUT', b.id, 0); break;
          case 'RS': b = addBlock('SR', e.x, e.y, { prio: 'R' }, { note, wantId }); wireIn('S', b.id, 0); wireIn('R1', b.id, 1); mapOut(e, 'Q1', b.id, 0); break;
          case 'SR': b = addBlock('SR', e.x, e.y, { prio: 'S' }, { note, wantId }); wireIn('S1', b.id, 0); wireIn('R', b.id, 1); mapOut(e, 'Q1', b.id, 0); break;
          case 'R_TRIG': case 'F_TRIG': {
            // EspressOS EDGE = R_TRIG + F_TRIG on the same input; merge the pair if marked as one
            const port = t === 'R_TRIG' ? 0 : 1;
            const existing = eos.type === 'EDGE' ? blocks.find((x) => x.id === eos.id && x.type === 'EDGE') : null;
            b = existing || addBlock('EDGE', e.x, e.y, {}, { note, wantId });
            if (!existing) wireIn('CLK', b.id, 0);
            mapOut(e, 'Q', b.id, port);
            break;
          }
          case 'TON': case 'TOF': case 'TP': {
            const pt = lit('PT');
            b = addBlock(t, e.x, e.y, { t: pt && pt.type === 'TIME' ? pt.value : (p.t !== undefined ? p.t : 1) }, { note, wantId });
            if (!pt) warnings.push(`${t} (${e.id}): PT is not a constant; ${b.p.t} s was used.`);
            wireIn('IN', b.id, 0);
            mapOut(e, 'Q', b.id, 0);
            mapOut(e, 'ET', null, null); // elapsed time is not available as an output in EspressOS
            break;
          }
          case 'CTU': case 'CTD': case 'CTUD': {
            const pv = lit('PV');
            b = addBlock('CTR', e.x, e.y, { preset: pv ? pv.value : (p.preset !== undefined ? p.preset : 10) }, { note, wantId });
            if (t === 'CTD') warnings.push(`CTD (${e.id}) counts down from PV in IEC; EspressOS counts from 0, so its Q differs.`);
            wireIn('CU', b.id, 0); wireIn('CD', b.id, 1); wireIn('R', b.id, 2);
            const ld = lit('LD');
            if (inputOf(e, 'LD') && inputOf(e, 'LD').conn && !(ld && ld.value === 0)) warnings.push(`Counter (${e.id}): LD (load) is not supported.`);
            mapOut(e, t === 'CTD' ? 'Q' : t === 'CTU' ? 'Q' : 'QU', b.id, 0);
            mapOut(e, 'CV', b.id, 1);
            if (outputUsed(e, 'QD')) warnings.push(`Counter (${e.id}): output QD is not supported; its connections were dropped.`);
            mapOut(e, 'QD', null, null);
            break;
          }
          case 'EOS_BLINK': {
            const on = lit('T_ON'), off = lit('T_OFF');
            b = addBlock('BLINK', e.x, e.y, { on: on ? on.value : 0.5, off: off ? off.value : 0.5 }, { note, wantId });
            const en = inputOf(e, 'EN_IN');
            const enLit = en && literalParam(en.conn);
            if (en && en.conn && !(enLit && enLit.value === 1)) wireIn('EN_IN', b.id, 0);
            mapOut(e, 'Q', b.id, 0);
            break;
          }
          case 'EOS_THRESH': {
            const on = lit('ON_LEVEL'), off = lit('OFF_LEVEL');
            b = addBlock('THRESH', e.x, e.y, { on: on ? on.value : 25, off: off ? off.value : 23 }, { note, wantId });
            wireIn('IN', b.id, 0);
            mapOut(e, 'Q', b.id, 0);
            break;
          }
          case 'EOS_SCALE': {
            const v = (f, d) => { const l = lit(f); return l ? l.value : d; };
            b = addBlock('SCALE', e.x, e.y, { inMin: v('IN_MIN', 0), inMax: v('IN_MAX', 4095), outMin: v('OUT_MIN', 0), outMax: v('OUT_MAX', 100), clamp: v('CLAMP', 1) ? 1 : 0 }, { note, wantId });
            wireIn('IN', b.id, 0);
            mapOut(e, 'OUT', b.id, 0);
            break;
          }
          case 'EOS_WEEK': {
            const v = (f, d) => { const l = lit(f); return l ? l.value : d; };
            b = addBlock('WEEK', e.x, e.y, { days: v('DAYS', 127), on: v('ON_MIN', 480), off: v('OFF_MIN', 1020) }, { note, wantId });
            mapOut(e, 'Q', b.id, 0);
            break;
          }
          case 'EOS_AI': {
            const lo = lit('LO'), hi = lit('HI');
            b = addBlock('AI', e.x, e.y, { pin: pickPin(C.ADC_PINS, p.pin, 'Analog input', 'B' + (eos.id || e.id)), min: lo ? lo.value : 0, max: hi ? hi.value : 100 }, { note, wantId });
            mapOut(e, 'OUT', b.id, 0);
            break;
          }
          case 'EOS_AO': {
            b = addBlock('AO', e.x, e.y, { pin: pickPin(C.OUT_PINS, p.pin, 'Analog output', 'B' + (eos.id || e.id)), freq: p.freq || 1000 }, { note, wantId });
            wireIn('PCT', b.id, 0);
            break;
          }
          case 'SEL': b = addBlock('SEL', e.x, e.y, {}, { note, wantId }); wireIn('G', b.id, 2); wireIn('IN0', b.id, 0); wireIn('IN1', b.id, 1); mapOut(e, 'OUT', b.id, 0); break;
          default:
            if (CMPS[t]) {
              const b2 = lit('IN2');
              b = addBlock('CMP', e.x, e.y, { op: CMPS[t], b: b2 ? b2.value : 0 }, { note, wantId });
              wireIn('IN1', b.id, 0);
              if (!b2) wireIn('IN2', b.id, 1);
              if (e.ins.length > 2) warnings.push(`${t} (${e.id}) with more than two inputs: only the first two were used.`);
              mapOut(e, 'OUT', b.id, 0);
            } else if (MATHS[t]) {
              const b2 = lit('IN2');
              b = addBlock('MATH', e.x, e.y, { op: MATHS[t], b: b2 ? b2.value : 0 }, { note, wantId });
              wireIn('IN1', b.id, 0);
              if (!b2) wireIn('IN2', b.id, 1);
              if (e.ins.length > 2) warnings.push(`${t} (${e.id}) with more than two inputs: only the first two were used.`);
              mapOut(e, 'OUT', b.id, 0);
            } else {
              warnings.push(`Block type ${t} is not supported by EspressOS and was skipped (its connections were dropped).`);
            }
        }
        if (b && outNeg && t !== 'R_TRIG' && t !== 'F_TRIG') {
          // negated output on a non-logic block: append a NOT
          const n = addBlock('NOT', e.x + 130, e.y, {});
          wires.push([b.id, 0, n.id, 0]);
          mapOut(e, e.outs.find((o) => o.neg).formal, n.id, 0);
        }
      }
    }

    // ---- resolve connections into wires
    const resolve = (conn, seen = new Set()) => {
      if (!conn) return null;
      const s = el.get(conn.ref);
      if (!s || seen.has(conn.ref)) return null;
      seen.add(conn.ref);
      if (s.tag === 'continuation') {
        const c = connectors.get(s.name.toUpperCase());
        return c ? resolve(c.in, seen) : null;
      }
      if (s.tag === 'inVariable') {
        if (produced.has(s.id + '.')) return { out: produced.get(s.id + '.'), neg: s.neg && !blocks.find((b) => b.id === produced.get(s.id + '.')[0] && b.type === 'DI') };
        const l = parseLiteral(s.expr);
        if (l) return { lit: l };
        const w = writers.get(s.expr.toUpperCase());
        if (w && !produced.has(s.id + '.')) {
          const r = resolve(w.in, seen);
          return r && s.neg ? { ...r, neg: !r.neg } : r;
        }
        const out = produced.get(s.id + '.');
        return out ? { out, neg: s.neg && !blocks.find((b) => b.id === out[0] && b.type === 'DI') } : null;
      }
      if (s.tag === 'block' && isConversion(s.typeName)) return resolve(s.ins[0] && s.ins[0].conn, seen);
      if (s.tag === 'block') {
        const key = s.id + '.' + (conn.param || (s.outs[0] && s.outs[0].formal) || '');
        const out = produced.get(key) || produced.get(s.id + '.' + (s.outs[0] && s.outs[0].formal));
        if (out && out[0] === null) { warnings.push(`Output ${s.typeName}.${conn.param} is not available in EspressOS; that connection was dropped.`); return null; }
        return out ? { out } : null;
      }
      return null;
    };
    const constFor = new Map();
    for (const t of toConnect) {
      const r = resolve(t.conn);
      if (!r) continue;
      let src;
      if (r.lit) {
        const key = r.lit.type + ':' + r.lit.value;
        if (!constFor.has(key)) {
          const tb = blocks.find((b) => b.id === t.bid);
          constFor.set(key, addBlock('CONST', tb.x - 130, tb.y - 40, { value: r.lit.value }));
        }
        src = [constFor.get(key).id, 0];
      } else src = r.out;
      if ((r.neg ? 1 : 0) ^ (t.neg ? 1 : 0)) {
        const tb = blocks.find((b) => b.id === t.bid);
        const n = addBlock('NOT', tb.x - 120, tb.y + 20 * t.port, {});
        wires.push([src[0], src[1], n.id, 0]);
        src = [n.id, 0];
      }
      if (!wires.some((w) => w[2] === t.bid && w[3] === t.port)) wires.push([src[0], src[1], t.bid, t.port]);
    }

    // ---- tidy positions: keep everything on a non-negative grid
    const minX = Math.min(0, ...blocks.map((b) => b.x)), minY = Math.min(0, ...blocks.map((b) => b.y));
    for (const b of blocks) { b.x = Math.round((b.x - minX) / 10) * 10 + 20; b.y = Math.round((b.y - minY) / 10) * 10 + 20; }

    const task = findAll(doc, 'task')[0];
    const iv = task && task.attrs.interval ? parseLiteral(task.attrs.interval) : null;
    const prog = {
      version: 1,
      cycleMs: projEos.cycleMs || (iv && iv.type === 'TIME' ? Math.min(1000, Math.max(1, Math.round(iv.value * 1000))) : 10),
      blocks, wires, devices,
      lastId: Math.max(projEos.lastId || 0, ...blocks.map((b) => b.id), 0),
    };
    const sensorDevs = new Set(devices.map((d) => d.id));
    for (const b of blocks) if (b.type === 'SENSOR' && !sensorDevs.has(Number(b.p.dev))) warnings.push(`B${b.id}: sensor device ${b.p.dev} is missing; add it on the Sensors tab.`);
    return { prog, warnings };
  }

  const api = { exportPLCopen, importPLCopen, parseXml, parseLiteral, LIB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PLCopen = api;
})(this);
