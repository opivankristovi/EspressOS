// node --test tools/test_plcopen.js
// Set PLCOPEN_XSD=<path to tc6_xml_v201.xsd> (and have python + lxml) to also
// validate exports against the official schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const P = require('../web/js/plcopen.js');
const { Engine, NullHal } = require('../web/js/sim.js');

const greenhouse = require('../examples/greenhouse.json');

// Every block type, inverted I/O, a feedback loop, analog and digital paths.
const allBlocks = require('../examples/all-blocks.json');


class FakeHal extends NullHal {
  constructor() { super(); this.din = {}; this.ain = {}; this.vin = {}; this.sens = {}; this.dout = {}; this.pwm = {}; this.now = { dow: 2, m: 600 }; }
  readDigital(p) { return !!this.din[p]; }
  readAnalog(p) { return this.ain[p] || 0; }
  readVirtual(i) { return this.vin[i] || 0; }
  readSensor(d, c) { const v = this.sens[d + '.' + c]; return v === undefined ? { ok: false, v: 0 } : { ok: true, v }; }
  writeDigital(p, v) { this.dout[p] = v ? 1 : 0; }
  setupOutput(p, l) { this.dout[p] = l ? 1 : 0; }
  writePwm(p, d) { this.pwm[p] = Math.round(d * 1000) / 1000; }
  timeOfDay() { return this.now; }
}

// Runs both programs with the same pseudo-random inputs and compares every pin each scan.
function assertSameBehaviour(a, b, steps = 400) {
  const ha = new FakeHal(), hb = new FakeHal();
  const ea = new Engine(ha), eb = new Engine(hb);
  assert.equal(ea.load(a), null);
  assert.equal(eb.load(b), null);
  ea.run(); eb.run();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let s = 0; s < steps; s++) {
    const t = s * 20;
    if (s % 7 === 0) for (const h of [ha, hb]) { h.din[4] = rnd() > 0.5; }
    if (s % 11 === 0) { const v = rnd() > 0.5; ha.din[5] = hb.din[5] = v; }
    if (s % 13 === 0) { const v = rnd() > 0.4 ? 1 : 0; ha.vin[0] = hb.vin[0] = v; }
    if (s % 5 === 0) { const v = Math.round(rnd() * 100); ha.vin[1] = hb.vin[1] = v; }
    if (s % 9 === 0) { const v = Math.round(rnd() * 4095); ha.ain[34] = hb.ain[34] = v; }
    if (s % 17 === 0) { const v = 10 + rnd() * 30; ha.sens['1.0'] = hb.sens['1.0'] = v; }
    ha.din[4] = hb.din[4] = ha.din[4];
    ea.scan(t); eb.scan(t);
    assert.deepEqual(hb.dout, ha.dout, `digital outputs differ at scan ${s}`);
    assert.deepEqual(hb.pwm, ha.pwm, `PWM outputs differ at scan ${s}`);
  }
}

const exp = (prog) => P.exportPLCopen(prog, { name: 'test', date: '2026-11-09T12:00:00' });

test('literals', () => {
  assert.deepEqual(P.parseLiteral('T#1m30s'), { type: 'TIME', value: 90 });
  assert.deepEqual(P.parseLiteral('T#500ms'), { type: 'TIME', value: 0.5 });
  assert.deepEqual(P.parseLiteral('TIME#1h_2m'), { type: 'TIME', value: 3720 });
  assert.deepEqual(P.parseLiteral('TRUE'), { type: 'BOOL', value: 1 });
  assert.deepEqual(P.parseLiteral('REAL#2.5'), { type: 'REAL', value: 2.5 });
  assert.deepEqual(P.parseLiteral('-3'), { type: 'INT', value: -3 });
  assert.deepEqual(P.parseLiteral('16#FF'), { type: 'INT', value: 255 });
  assert.deepEqual(P.parseLiteral('1.5E2'), { type: 'REAL', value: 150 });
  assert.equal(P.parseLiteral('Motor_On'), null);
});

test('export: standard IEC blocks, located I/O and EOS library', () => {
  const r = exp(allBlocks);
  for (const t of ['"AND"', '"OR"', '"XOR"', '"NOT"', '"RS"', '"SR"', '"R_TRIG"', '"F_TRIG"', '"TON"', '"TOF"', '"TP"', '"CTUD"', '"GE"', '"MUL"', '"SEL"', '"MAX"', '"EOS_BLINK"', '"EOS_THRESH"', '"EOS_SCALE"', '"EOS_AI"', '"EOS_AO"', '"INT_TO_REAL"', '"BOOL_TO_REAL"'])
    assert.ok(r.xml.includes('typeName=' + t), 'missing block ' + t);
  assert.ok(r.xml.includes('address="%IX0.0"') && r.xml.includes('address="%IX0.1"'));
  assert.ok(r.xml.includes('address="%QX0.0"') && r.xml.includes('address="%QW0"') && r.xml.includes('address="%IW0"'));
  assert.ok(r.xml.includes('<pou name="EOS_BLINK" pouType="functionBlock">'));
  assert.ok(/<variable formalParameter="OUT" negated="true">/.test(r.xml), 'NAND/NOR negated output');
  assert.ok(r.xml.includes('FB_B30_0'), 'feedback loop routed through a variable');
  // OpenPLC/Beremiz ignore `negated` on in/out variables, so inverted I/O must use NOT blocks
  assert.ok(!/<(in|out)Variable [^>]*negated/.test(r.xml), 'no negated in/out variables');
  assert.ok(r.xml.includes('&quot;invert&quot;:&quot;in&quot;') && r.xml.includes('&quot;invert&quot;:&quot;out&quot;'), 'inverted DI and DO become tagged NOT blocks');
  // every wire carries its route, which OpenPLC/Beremiz use to find the source pin
  assert.ok(!/<connection [^>]*\/>/.test(r.xml), 'connections have <position> points');
  assert.ok(r.xml.includes('interval="T#20ms"'));
  assert.deepEqual(r.ioMap.map((m) => m.address + '=' + m.pin).sort(),
    ['%IW0=34', '%IX0.0=4', '%IX0.1=5', '%QW0=25', '%QX0.0=16', '%QX0.1=17', '%QX0.2=18', '%QX0.3=19'].sort());
  assert.ok(r.warnings.some((w) => /sensor/.test(w)));
});

test('round trip keeps every block, wire, pin and parameter', () => {
  for (const prog of [allBlocks, greenhouse]) {
    const { prog: back, warnings } = P.importPLCopen(exp(prog).xml);
    assert.deepEqual(warnings, [], 'no warnings expected on a round trip: ' + warnings.join(' | '));
    assert.equal(back.blocks.length, prog.blocks.length);
    for (const b of prog.blocks) {
      const c = back.blocks.find((x) => x.id === b.id);
      assert.ok(c, 'block ' + b.id + ' missing');
      assert.equal(c.type, b.type, 'type of ' + b.id);
      for (const [k, v] of Object.entries(b.p)) assert.equal(Number(c.p[k]) || c.p[k], Number(v) || v, `B${b.id}.${k}`);
      if (b.ui) assert.equal(c.ui, b.ui);
    }
    const norm = (ws) => ws.map((w) => w.join(',')).sort();
    assert.deepEqual(norm(back.wires), norm(prog.wires));
    assert.deepEqual(back.devices, prog.devices);
    assert.equal(back.cycleMs, prog.cycleMs);
  }
});

test('round trip behaves identically in the engine', () => {
  for (const prog of [allBlocks, greenhouse]) assertSameBehaviour(prog, P.importPLCopen(exp(prog).xml).prog);
});

// A file as an IEC tool would write it: no EspressOS addData at all.
const foreign = `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <fileHeader companyName="Beremiz" productName="Pump" productVersion="1" creationDateTime="2026-01-01T00:00:00"/>
  <contentHeader name="Pump"><coordinateInfo><fbd><scaling x="0" y="0"/></fbd><ld><scaling x="0" y="0"/></ld><sfc><scaling x="0" y="0"/></sfc></coordinateInfo></contentHeader>
  <types><dataTypes/><pous>
    <pou name="helper" pouType="function"><interface><returnType><BOOL/></returnType></interface><body><ST><xhtml:p><![CDATA[helper := TRUE;]]></xhtml:p></ST></body></pou>
    <pou name="pump" pouType="program">
      <interface><localVars>
        <variable name="start" address="%IX0.0"><type><BOOL/></type></variable>
        <variable name="stop" address="%IX0.1"><type><BOOL/></type></variable>
        <variable name="motor" address="%QX0.0"><type><BOOL/></type></variable>
        <variable name="alarm" address="%QX0.1"><type><BOOL/></type></variable>
        <variable name="running"><type><BOOL/></type></variable>
        <variable name="latch"><type><derived name="RS"/></type></variable>
        <variable name="delay"><type><derived name="TON"/></type></variable>
        <variable name="cnt"><type><derived name="CTU"/></type></variable>
      </localVars></interface>
      <body><FBD>
        <inVariable localId="1"><position x="10" y="10"/><connectionPointOut/><expression>start</expression></inVariable>
        <inVariable localId="2"><position x="10" y="60"/><connectionPointOut/><expression>stop</expression></inVariable>
        <block localId="3" typeName="RS" instanceName="latch"><position x="120" y="10"/>
          <inputVariables>
            <variable formalParameter="S"><connectionPointIn><connection refLocalId="1"/></connectionPointIn></variable>
            <variable formalParameter="R1"><connectionPointIn><connection refLocalId="2"/></connectionPointIn></variable>
          </inputVariables><inOutVariables/>
          <outputVariables><variable formalParameter="Q1"><connectionPointOut/></variable></outputVariables>
        </block>
        <outVariable localId="4"><position x="240" y="10"/><connectionPointIn><connection refLocalId="3" formalParameter="Q1"/></connectionPointIn><expression>running</expression></outVariable>
        <inVariable localId="5"><position x="10" y="140"/><connectionPointOut/><expression>running</expression></inVariable>
        <inVariable localId="6"><position x="10" y="180"/><connectionPointOut/><expression>T#2s</expression></inVariable>
        <block localId="7" typeName="TON" instanceName="delay"><position x="120" y="140"/>
          <inputVariables>
            <variable formalParameter="IN"><connectionPointIn><connection refLocalId="5"/></connectionPointIn></variable>
            <variable formalParameter="PT"><connectionPointIn><connection refLocalId="6"/></connectionPointIn></variable>
          </inputVariables><inOutVariables/>
          <outputVariables><variable formalParameter="Q"><connectionPointOut/></variable><variable formalParameter="ET"><connectionPointOut/></variable></outputVariables>
        </block>
        <connector name="slow" localId="8"><position x="240" y="140"/><connectionPointIn><connection refLocalId="7" formalParameter="Q"/></connectionPointIn></connector>
        <continuation name="slow" localId="9"><position x="300" y="140"/><connectionPointOut/></continuation>
        <outVariable localId="10"><position x="400" y="140"/><connectionPointIn><connection refLocalId="9"/></connectionPointIn><expression>motor</expression></outVariable>
        <block localId="11" typeName="AND"><position x="120" y="260"/>
          <inputVariables>
            <variable formalParameter="IN1"><connectionPointIn><connection refLocalId="1"/></connectionPointIn></variable>
            <variable formalParameter="IN2"><connectionPointIn><connection refLocalId="2"/></connectionPointIn></variable>
            <variable formalParameter="IN3" negated="true"><connectionPointIn><connection refLocalId="5"/></connectionPointIn></variable>
          </inputVariables><inOutVariables/>
          <outputVariables><variable formalParameter="OUT" negated="true"><connectionPointOut/></variable></outputVariables>
        </block>
        <outVariable localId="12"><position x="300" y="260"/><connectionPointIn><connection refLocalId="11" formalParameter="OUT"/></connectionPointIn><expression>alarm</expression></outVariable>
        <inVariable localId="13"><position x="10" y="380"/><connectionPointOut/><expression>5</expression></inVariable>
        <block localId="14" typeName="CTU" instanceName="cnt"><position x="120" y="380"/>
          <inputVariables>
            <variable formalParameter="CU"><connectionPointIn><connection refLocalId="1"/></connectionPointIn></variable>
            <variable formalParameter="R"><connectionPointIn><connection refLocalId="2"/></connectionPointIn></variable>
            <variable formalParameter="PV"><connectionPointIn><connection refLocalId="13"/></connectionPointIn></variable>
          </inputVariables><inOutVariables/>
          <outputVariables><variable formalParameter="Q"><connectionPointOut/></variable><variable formalParameter="CV"><connectionPointOut/></variable></outputVariables>
        </block>
      </FBD></body>
    </pou>
  </pous></types>
  <instances><configurations><configuration name="c"><resource name="r"><task name="t" priority="0" interval="T#50ms"><pouInstance name="i" typeName="pump"/></task></resource></configuration></configurations></instances>
</project>`;

test('imports a file written by another IEC tool', () => {
  const { prog, warnings } = P.importPLCopen(foreign);
  const types = prog.blocks.map((b) => b.type).sort();
  assert.deepEqual(types, ['CTR', 'DI', 'DI', 'DO', 'DO', 'NAND', 'NOT', 'SR', 'TON'].sort());
  assert.equal(prog.cycleMs, 50);
  const ton = prog.blocks.find((b) => b.type === 'TON');
  assert.equal(ton.p.t, 2);
  assert.equal(prog.blocks.find((b) => b.type === 'CTR').p.preset, 5);
  assert.equal(prog.blocks.find((b) => b.type === 'SR').p.prio, 'R');
  assert.ok(warnings.some((w) => /GPIO/.test(w)), 'pins were auto-assigned and reported');
  assert.equal(new Engine(new NullHal()).load(prog), null, 'imported program loads in the engine');

  // behaviour: start latches, motor follows 2 s later, alarm = NOT(start AND stop AND NOT running)
  const hal = new FakeHal();
  const eng = new Engine(hal);
  eng.load(prog); eng.run();
  const di = prog.blocks.filter((b) => b.type === 'DI');
  const pin = (name) => di.find((b) => b.note === name).p.pin;
  const out = (name) => hal.dout[prog.blocks.find((b) => b.note === name).p.pin];
  hal.din[pin('start')] = 1; eng.scan(0);
  hal.din[pin('start')] = 0; eng.scan(100);
  assert.equal(out('motor'), 0);
  eng.scan(2100);
  assert.equal(out('motor'), 1);
  assert.equal(out('alarm'), 1);
  hal.din[pin('stop')] = 1; eng.scan(2200);
  eng.scan(2300);
  assert.equal(out('motor'), 0);
});

test('clear errors for files EspressOS cannot use', () => {
  const st = foreign.replace(/<pou name="pump"[\s\S]*?<\/pou>/, '<pou name="p" pouType="program"><body><ST><xhtml:p>x := 1;</xhtml:p></ST></body></pou>');
  assert.throws(() => P.importPLCopen(st), /FBD.*ST/);
  assert.throws(() => P.importPLCopen('<project><a></b></project>'), /XML/);
  assert.throws(() => P.importPLCopen('<hello/>'), /PLCopen/);
});

test('exports validate against the PLCopen TC6 v2.01 schema', (t) => {
  const xsd = process.env.PLCOPEN_XSD;
  if (!xsd || !fs.existsSync(xsd)) return t.skip('set PLCOPEN_XSD to tc6_xml_v201.xsd to run');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-plcopen-'));
  const files = [allBlocks, greenhouse].map((p, i) => { const f = path.join(dir, `p${i}.xml`); fs.writeFileSync(f, exp(p).xml); return f; });
  const f2 = path.join(dir, 'foreign.xml');
  fs.writeFileSync(f2, foreign);
  const r = spawnSync('python', [path.join(__dirname, 'validate_plcopen.py'), xsd, ...files], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
