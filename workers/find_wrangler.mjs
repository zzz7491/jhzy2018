import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = [
  'E:/D盘备份/miniprogram/workers',
  'E:/D盘备份/miniprogram',
];
for (const root of roots) {
  const nm = join(root, 'node_modules');
  console.log('== root', root, 'node_modules exists?', existsSync(nm));
  if (!existsSync(nm)) continue;
  const candidates = [
    join(nm, 'wrangler', 'bin', 'wrangler.mjs'),
    join(nm, 'wrangler', 'bin', 'wrangler.js'),
    join(nm, 'wrangler', 'wrangler.mjs'),
    join(nm, '.bin', 'wrangler'),
  ];
  for (const c of candidates) {
    console.log('  ', c, '=>', existsSync(c) ? 'EXISTS' : 'no');
  }
  // list wrangler-related entries in .bin
  const binDir = join(nm, '.bin');
  if (existsSync(binDir)) {
    const bins = readdirSync(binDir).filter((x) => /wrangler/i.test(x));
    console.log('   .bin wrangler entries:', bins.join(',') || '(none)');
  }
  // is wrangler even installed?
  const wpk = join(nm, 'wrangler', 'package.json');
  if (existsSync(wpk)) {
    try {
      const pj = JSON.parse(readFileSync ? require('fs').readFileSync(wpk, 'utf8') : '{}');
      console.log('   wrangler pkg version:', pj.version, 'bin:', JSON.stringify(pj.bin));
    } catch (e) {
      console.log('   wrangler pkg read err', e.message);
    }
  } else {
    console.log('   wrangler package.json MISSING');
  }
}
