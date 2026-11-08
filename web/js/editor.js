// SVG block-diagram editor: drag blocks, wire ports, pan/zoom, undo, live view.
(function (root) {
  'use strict';
  const C = root.Catalog;
  const NS = 'http://www.w3.org/2000/svg';
  const BW = 100, HEAD = 18, ROW = 20, STUB = 10;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const snap = (v) => Math.round(v / 10) * 10;
  const fmtVal = (v) => {
    if (v === undefined || v === null || isNaN(v)) return '–';
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  };

  class Editor {
    constructor(svg, opts) {
      this.svg = svg;
      this.opts = opts;  // {onSelect, onChange, onBlockClick, summary}
      this.world = svg.querySelector('#world');
      this.gWires = svg.querySelector('#wires');
      this.gBlocks = svg.querySelector('#blocks');
      this.dragWire = svg.querySelector('#dragwire');
      this.prog = root.Api.EMPTY();
      this.view = { x: 40, y: 40, s: 1 };
      this.sel = null;          // {kind:'block'|'wire', id|index}
      this.live = null;         // monitor snapshot
      this.liveOn = true;
      this.hist = []; this.fut = [];
      this.refs = { wires: [], outVals: {}, extras: {}, blocks: {} };
      this._bind();
    }

    // ------------------------------------------------------------- model
    setProgram(p, keepHistory) {
      this.prog = p;
      if (!this.prog.devices) this.prog.devices = [];
      if (!keepHistory) { this.hist = []; this.fut = []; }
      this.sel = null;
      this.render();
      this.opts.onSelect(null);
    }
    nextId() { return this.prog.blocks.reduce((m, b) => Math.max(m, b.id), 0) + 1; }
    block(id) { return this.prog.blocks.find((b) => b.id === id); }
    checkpoint() { this.hist.push(JSON.stringify(this.prog)); if (this.hist.length > 100) this.hist.shift(); this.fut = []; }
    changed() { this.render(); this.opts.onChange(this.prog); }
    undo() { if (!this.hist.length) return; this.fut.push(JSON.stringify(this.prog)); this.prog = JSON.parse(this.hist.pop()); this._afterHist(); }
    redo() { if (!this.fut.length) return; this.hist.push(JSON.stringify(this.prog)); this.prog = JSON.parse(this.fut.pop()); this._afterHist(); }
    _afterHist() {
      if (this.sel && this.sel.kind === 'block' && !this.block(this.sel.id)) this.sel = null;
      if (this.sel && this.sel.kind === 'wire') this.sel = null;
      this.changed();
      this.opts.onSelect(this.sel && this.sel.kind === 'block' ? this.block(this.sel.id) : null);
    }

    addBlock(def, x, y) {
      this.checkpoint();
      const b = { id: this.nextId(), type: def.type, x: snap(x), y: snap(y), p: C.defaults(def) };
      if (def.ui) b.ui = def.ui;
      if (def.type === 'VIN') {  // pick a free virtual slot
        const used = new Set(this.prog.blocks.filter((q) => q.type === 'VIN').map((q) => Number(q.p.idx)));
        let i = 0; while (used.has(i) && i < 15) i++;
        b.p.idx = i;
      }
      if (def.type === 'SENSOR' && this.prog.devices.length) b.p.dev = this.prog.devices[0].id;
      this.prog.blocks.push(b);
      this.select({ kind: 'block', id: b.id });
      this.changed();
      return b;
    }
    deleteSelection() {
      if (!this.sel) return;
      this.checkpoint();
      if (this.sel.kind === 'block') {
        const id = this.sel.id;
        this.prog.blocks = this.prog.blocks.filter((b) => b.id !== id);
        this.prog.wires = this.prog.wires.filter((w) => w[0] !== id && w[2] !== id);
      } else {
        this.prog.wires.splice(this.sel.index, 1);
      }
      this.select(null);
      this.changed();
    }
    duplicateSelection() {
      if (!this.sel || this.sel.kind !== 'block') return;
      const src = this.block(this.sel.id);
      const def = C.blockDef(src);
      const b = this.addBlock(def, src.x + 30, src.y + 30);
      b.p = JSON.parse(JSON.stringify(src.p));
      if (def.type === 'VIN') b.p.idx = Math.min(15, this.prog.blocks.filter((q) => q.type === 'VIN').length - 1);
      this.changed();
    }
    updateParams(id, p, note) {
      const b = this.block(id);
      if (!b) return;
      this.checkpoint();
      b.p = p;
      if (note !== undefined) { if (note) b.note = note; else delete b.note; }
      this.changed();
    }
    select(s) {
      this.sel = s;
      this.opts.onSelect(s && s.kind === 'block' ? this.block(s.id) : null);
      this._applySel();
    }

    // ------------------------------------------------------------- geometry
    size(b) {
      const d = C.blockDef(b);
      const rows = Math.max(d.ins.length, d.outs.length, 2);
      return { w: BW, h: HEAD + rows * ROW + 16 };
    }
    inPos(b, i) { return { x: b.x - STUB, y: b.y + HEAD + 4 + ROW * i + ROW / 2 }; }
    outPos(b, i) {
      const d = C.blockDef(b), { w } = this.size(b);
      // center a single output vertically
      const n = d.outs.length, rows = Math.max(d.ins.length, n, 2);
      const off = n === 1 ? (rows - 1) / 2 : 0;
      return { x: b.x + w + STUB, y: b.y + HEAD + 4 + ROW * (i + off) + ROW / 2 };
    }
    wirePath(a, b) {
      const dx = Math.max(30, Math.abs(b.x - a.x) / 2);
      return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
    }
    toWorld(cx, cy) {
      const r = this.svg.getBoundingClientRect();
      return { x: (cx - r.left - this.view.x) / this.view.s, y: (cy - r.top - this.view.y) / this.view.s };
    }
    applyView() { this.world.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.s})`); }
    zoom(f, cx, cy) {
      const r = this.svg.getBoundingClientRect();
      if (cx === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
      const s = Math.min(2.5, Math.max(0.3, this.view.s * f));
      const px = cx - r.left, py = cy - r.top;
      this.view.x = px - ((px - this.view.x) * s) / this.view.s;
      this.view.y = py - ((py - this.view.y) * s) / this.view.s;
      this.view.s = s;
      this.applyView();
    }
    fit() {
      const r = this.svg.getBoundingClientRect();
      if (!this.prog.blocks.length) { this.view = { x: 40, y: 40, s: 1 }; return this.applyView(); }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const b of this.prog.blocks) {
        const { w, h } = this.size(b);
        x0 = Math.min(x0, b.x - 30); y0 = Math.min(y0, b.y - 20); x1 = Math.max(x1, b.x + w + 50); y1 = Math.max(y1, b.y + h + 20);
      }
      const s = Math.min(1.4, Math.max(0.3, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
      this.view = { s, x: (r.width - (x1 - x0) * s) / 2 - x0 * s, y: (r.height - (y1 - y0) * s) / 2 - y0 * s };
      this.applyView();
    }
    centerWorld() {
      const r = this.svg.getBoundingClientRect();
      return this.toWorld(r.left + r.width / 2 - 50, r.top + r.height / 2 - 40);
    }

    // ------------------------------------------------------------- render
    render() {
      this.applyView();
      this.gWires.textContent = '';
      this.gBlocks.textContent = '';
      this.refs = { wires: [], outVals: {}, extras: {}, blocks: {}, sums: {} };

      if (!this.prog.blocks.length) {
        const r = this.svg.getBoundingClientRect();
        const c = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
        const t = el('text', { x: c.x, y: c.y - 10, 'text-anchor': 'middle', class: 'empty-hint' }, this.gBlocks);
        t.textContent = 'Drag blocks from the left onto this sheet.';
        const t2 = el('text', { x: c.x, y: c.y + 14, 'text-anchor': 'middle', class: 'empty-hint' }, this.gBlocks);
        t2.textContent = 'Then drag from an output (right side) to an input (left side) to wire them.';
      }

      this.prog.wires.forEach((w, i) => {
        const a = this.block(w[0]), b = this.block(w[2]);
        if (!a || !b) return;
        const t = (C.blockDef(a).outs[w[1]] || {}).t || 'd';
        const d = this.wirePath(this.outPos(a, w[1]), this.inPos(b, w[3]));
        const path = el('path', { d, class: 'wire t-' + t }, this.gWires);
        const hit = el('path', { d, class: 'wirehit', 'data-wire': i }, this.gWires);
        this.refs.wires.push({ path, hit, w, t });
      });

      for (const b of this.prog.blocks) this._renderBlock(b);
      this._applySel();
      this.applyLive();
    }

    _renderBlock(b) {
      const d = C.blockDef(b);
      const { w, h } = this.size(b);
      const g = el('g', { class: 'blk cat-' + d.cat, 'data-id': b.id, transform: `translate(${b.x},${b.y})` }, this.gBlocks);
      this.refs.blocks[b.id] = g;
      el('rect', { class: 'body', width: w, height: h, rx: 4 }, g);
      el('path', { class: 'head', d: `M1,${HEAD} V5 Q1,1 5,1 H${w - 5} Q${w - 1},1 ${w - 1},5 V${HEAD} Z` }, g);
      el('rect', { class: 'stripe', x: 1, y: 1, width: 4, height: h - 2, rx: 2 }, g);
      const title = el('text', { class: 'title', x: 9, y: 13 }, g);
      title.textContent = 'B' + b.id + ' ' + (b.note || d.label);
      if ((b.note || d.label).length > 13) title.textContent = title.textContent.slice(0, 15) + '…';

      const bodyMid = HEAD + (h - HEAD) / 2 - 6;
      const sym = el('text', { class: 'sym', x: w / 2, y: bodyMid }, g);
      sym.textContent = d.sym;
      const sumText = this.opts.summary(b, d);
      if (sumText) { const s = el('text', { class: 'sum', x: w / 2, y: h - 8 }, g); s.textContent = sumText.length > 18 ? sumText.slice(0, 17) + '…' : sumText; this.refs.sums[b.id] = s; }
      const ex = el('text', { class: 'extra', x: w / 2, y: h - 8 }, g);
      this.refs.extras[b.id] = ex;

      d.ins.forEach((p, i) => {
        const pos = this.inPos(b, i), y = pos.y - b.y;
        const pg = el('g', { class: 'port in t-' + p.t, 'data-port': 'in', 'data-id': b.id, 'data-i': i }, g);
        el('line', { x1: -STUB, y1: y, x2: 0, y2: y }, pg);
        el('circle', { cx: -STUB, cy: y, r: 4.5 }, pg);
        el('circle', { class: 'hitc', cx: -STUB, cy: y, r: 10 }, pg);
        if (p.n) { const t = el('text', { class: 'plabel', x: 9, y }, g); t.textContent = p.n; }
      });
      d.outs.forEach((p, i) => {
        const pos = this.outPos(b, i), y = pos.y - b.y;
        const pg = el('g', { class: 'port out t-' + p.t, 'data-port': 'out', 'data-id': b.id, 'data-i': i }, g);
        el('line', { x1: w, y1: y, x2: w + STUB, y2: y }, pg);
        if (d.invOut) el('circle', { class: 'bubble', cx: w + 3.5, cy: y, r: 3.5 }, pg);
        el('circle', { cx: w + STUB, cy: y, r: 4.5 }, pg);
        el('circle', { class: 'hitc', cx: w + STUB, cy: y, r: 10 }, pg);
        if (p.n) { const t = el('text', { class: 'plabel', x: w - 6, y, 'text-anchor': 'end' }, g); t.textContent = p.n; }
        const v = el('text', { class: 'val', x: w + STUB + 6, y: y - 9 }, g);
        this.refs.outVals[b.id + '.' + i] = { el: v, t: p.t };
      });
      if (d.type === 'VIN' || (this.opts.isSimInput && this.opts.isSimInput(b))) g.classList.add('clickable-candidate');
    }

    _applySel() {
      for (const g of this.gBlocks.querySelectorAll('.blk')) g.classList.toggle('sel', !!this.sel && this.sel.kind === 'block' && Number(g.dataset.id) === this.sel.id);
      this.refs.wires.forEach((r, i) => r.path.classList.toggle('sel', !!this.sel && this.sel.kind === 'wire' && this.sel.index === i));
    }

    setLive(snap, on) {
      this.live = snap;
      if (on !== undefined) this.liveOn = on;
      this.applyLive();
    }
    applyLive() {
      const L = this.liveOn && this.live && this.live.b ? this.live.b : null;
      for (const r of this.refs.wires) {
        const v = L && L[r.w[0]] ? L[r.w[0]][r.w[1]] : undefined;
        r.path.classList.toggle('on', !!L && r.t === 'd' && v >= 0.5);
      }
      for (const key in this.refs.outVals) {
        const { el: e, t } = this.refs.outVals[key];
        const [id, i] = key.split('.');
        const v = L && L[id] ? L[id][i] : undefined;
        e.textContent = L && t === 'a' && v !== undefined ? fmtVal(v) : '';
      }
      for (const b of this.prog.blocks) {
        const g = this.refs.blocks[b.id], ex = this.refs.extras[b.id];
        if (!g) continue;
        const d = C.blockDef(b);
        const vals = L ? L[b.id] : null;
        let lit = false, extra = '';
        if (vals) {
          const x = vals[vals.length - 1];
          if (d.type === 'DO') lit = x >= 0.5;
          else if (d.outs.length && d.outs[0].t === 'd' && d.type !== 'SENSOR') lit = vals[0] >= 0.5;
          if (d.timer && x > 0) extra = x.toFixed(1) + ' / ' + b.p[d.timer] + ' s';
          if (d.type === 'AO') extra = fmtVal(x) + ' %';
          if (d.type === 'CTR') extra = 'n = ' + vals[1];
          if (d.type === 'SENSOR' && vals[1] < 0.5) extra = 'no data';
        }
        g.classList.toggle('lit', lit);
        g.classList.toggle('clickable', !!L && g.classList.contains('clickable-candidate'));
        if (ex) ex.textContent = extra;
        const sm = this.refs.sums[b.id];
        if (sm) sm.style.visibility = extra ? 'hidden' : '';
      }
    }

    // ------------------------------------------------------------- input
    _bind() {
      const svg = this.svg;
      let drag = null;

      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        svg.focus();
        const port = e.target.closest('[data-port]');
        const blk = e.target.closest('.blk');
        const wire = e.target.closest('[data-wire]');
        const pw = this.toWorld(e.clientX, e.clientY);

        if (port && port.dataset.port === 'out') {
          const b = this.block(Number(port.dataset.id)), i = Number(port.dataset.i);
          drag = { kind: 'wire', from: b, fi: i, start: this.outPos(b, i), t: C.blockDef(b).outs[i].t };
        } else if (port && port.dataset.port === 'in') {
          // drag an existing wire off an input to re-route or delete it
          const id = Number(port.dataset.id), i = Number(port.dataset.i);
          const wi = this.prog.wires.findIndex((w) => w[2] === id && w[3] === i);
          if (wi >= 0) {
            const w = this.prog.wires[wi], b = this.block(w[0]);
            this.checkpoint();
            this.prog.wires.splice(wi, 1);
            this.render();
            drag = { kind: 'wire', from: b, fi: w[1], start: this.outPos(b, w[1]), t: C.blockDef(b).outs[w[1]].t, rewire: true };
          }
        } else if (blk) {
          const b = this.block(Number(blk.dataset.id));
          if (this.liveOn && this.live && blk.classList.contains('clickable') && this.opts.onBlockClick) {
            drag = { kind: 'press', b, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, pw, moved: false };
            this.opts.onBlockClick(b, true);
          } else {
            drag = { kind: 'move', b, ox: b.x, oy: b.y, pw, moved: false };
          }
          this.select({ kind: 'block', id: b.id });
        } else if (wire) {
          this.select({ kind: 'wire', index: Number(wire.dataset.wire) });
        } else {
          this.select(null);
          drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
        }
        if (drag) svg.setPointerCapture(e.pointerId);
      });

      svg.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const pw = this.toWorld(e.clientX, e.clientY);
        if (drag.kind === 'pan') {
          this.view.x = drag.vx + e.clientX - drag.sx; this.view.y = drag.vy + e.clientY - drag.sy;
          this.applyView();
        } else if (drag.kind === 'move' || drag.kind === 'press') {
          const dx = pw.x - drag.pw.x, dy = pw.y - drag.pw.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          if (!drag.moved) { this.checkpoint(); drag.moved = true; if (drag.kind === 'press') this.opts.onBlockClick(drag.b, false, true); }
          drag.b.x = snap(drag.ox + dx); drag.b.y = snap(drag.oy + dy);
          this.render();
        } else if (drag.kind === 'wire') {
          this.dragWire.setAttribute('d', this.wirePath(drag.start, pw));
          for (const p of this.gBlocks.querySelectorAll('.port.hot,.port.bad')) p.classList.remove('hot', 'bad');
          const tgt = document.elementFromPoint(e.clientX, e.clientY);
          const port = tgt && tgt.closest && tgt.closest('[data-port="in"]');
          if (port) port.classList.add(this._compatible(drag, port) ? 'hot' : 'bad');
        }
      });

      const end = (e) => {
        if (!drag) return;
        const d = drag; drag = null;
        if (d.kind === 'wire') {
          this.dragWire.setAttribute('d', '');
          const tgt = document.elementFromPoint(e.clientX, e.clientY);
          const port = tgt && tgt.closest && tgt.closest('[data-port="in"]');
          if (port && this._compatible(d, port)) {
            if (!d.rewire) this.checkpoint();
            const tid = Number(port.dataset.id), ti = Number(port.dataset.i);
            this.prog.wires = this.prog.wires.filter((w) => !(w[2] === tid && w[3] === ti));
            this.prog.wires.push([d.from.id, d.fi, tid, ti]);
            this.changed();
          } else {
            if (port && this.opts.onWireRejected) this.opts.onWireRejected(d.t);
            if (d.rewire) this.changed();  // wire was removed
            else this.render();
          }
        } else if (d.kind === 'press') {
          this.opts.onBlockClick(d.b, false, d.moved);
          if (d.moved) this.changed();
        } else if (d.kind === 'move' && d.moved) {
          this.changed();
        }
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);

      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        // wheel = zoom around the cursor, shift+wheel = pan
        if (e.shiftKey) { this.view.x -= e.deltaY || e.deltaX; this.applyView(); }
        else this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
      }, { passive: false });

      svg.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); }
        else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
        else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
        else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelection(); }
        else if (e.key === 'Escape') this.select(null);
      });

      // palette drop (HTML5 drag and drop)
      svg.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      svg.addEventListener('drop', (e) => {
        e.preventDefault();
        const key = e.dataTransfer.getData('text/x-eos-block');
        const def = C.BLOCKS.find((b) => (b.ui || b.type) === key);
        if (!def) return;
        const p = this.toWorld(e.clientX, e.clientY);
        this.addBlock(def, p.x - BW / 2, p.y - 20);
        svg.focus();
      });

      new ResizeObserver(() => { if (!this.prog.blocks.length) this.render(); }).observe(svg);
    }

    _compatible(d, port) {
      const tb = this.block(Number(port.dataset.id));
      if (!tb) return false;
      const t = C.blockDef(tb).ins[Number(port.dataset.i)].t;
      // digital may feed analog (0/1); analog into digital needs a Compare/Threshold block
      return d.t === t || (d.t === 'd' && t === 'a');
    }
  }

  root.Editor = Editor;
  root.fmtVal = fmtVal;
})(this);
