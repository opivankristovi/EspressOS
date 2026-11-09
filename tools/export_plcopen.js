#!/usr/bin/env node
// Exports EspressOS program JSON files to PLCopen XML.
//   node tools/export_plcopen.js <out-dir> <program.json>...
// Writes <out-dir>/<name>.xml for each input and prints any export warnings.
const fs = require('fs');
const path = require('path');
const P = require('../web/js/plcopen.js');

const [outDir, ...inputs] = process.argv.slice(2);
if (!outDir || !inputs.length) {
  console.error('usage: node tools/export_plcopen.js <out-dir> <program.json>...');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
for (const f of inputs) {
  const name = path.basename(f, '.json').replace(/[^A-Za-z0-9_]/g, '_');
  const prog = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = P.exportPLCopen(prog, { name, date: '2026-01-01T00:00:00' });
  fs.writeFileSync(path.join(outDir, name + '.xml'), r.xml);
  console.log(`${f} -> ${name}.xml`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
}
