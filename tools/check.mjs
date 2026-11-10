#!/usr/bin/env node
/* One command for everything that can fail:   npm test   (or: node tools/check.mjs [--no-browser])

   Headless: shader-lint, the shipped mission (must WIN), the recorded retro stack (must LOSE),
   mission-math, crater-stats. Browser (needs a GPU and a Playwright Chromium, so not in CI): shots (console must
   be clean), clip-test, trail-offset, orbit-line, debris-orbit, flicker-test — run against a private dev server on its own port, so a file
   saved in an editor cannot reload the page mid-measurement the way it does on the shared one. */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const browser = !process.argv.includes('--no-browser');
const PHASE = (await import('../js/constants.js')).MOON_PHASE0;
const results = [];
function run(name, cmd, args) {
  const t = Date.now(), r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 900000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.split('\n').filter(l => l.trim() && !/TYPELESS|Reparsing|eliminate this warning|trace-warnings/.test(l)).slice(-2).join(' | ').slice(0, 150);
  results.push({ name, ok: r.status === 0, s: ((Date.now() - t) / 1000).toFixed(0), tail });
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${String(results.at(-1).s).padStart(4)} s   ${tail}`);
}
run('shader-lint', 'node', ['tools/shader-lint.mjs']);
run('mission (shipped)', 'node', ['tools/mission-sim.mjs', 'game', `--phase=${PHASE}`]);
run('mission (retro loses)', 'node', ['tools/mission-sim.mjs', 'retro', '--phase=1.4742618']);
run('mission-math', 'python3', ['tools/mission-math.py']);
run('crater-stats', 'node', ['tools/crater-stats.mjs']);        // the lunar relief is continuous: no crater cut off along a lattice plane
if (browser) {
  const port = await new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const server = spawn('node', ['server.js', String(port)], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const out = mkdtempSync(`${tmpdir()}/lunarlift-check-`);
  try {
    run('shots (console clean)', 'node', ['tools/shots.mjs', out, String(port)]);
    run('clip-test', 'node', ['tools/clip-test.mjs', String(port)]);
    run('trail-offset', 'node', ['tools/trail-offset.mjs', String(port)]);
    run('orbit-line', 'node', ['tools/orbit-line.mjs', String(port)]);
    run('debris-orbit', 'node', ['tools/debris-orbit.mjs', String(port)]);
    run('flicker-test', 'node', ['tools/flicker-test.mjs', String(port), out]);
  } finally { server.kill(); }
  console.log(`screenshots and diff maps: ${out}`);
}
const bad = results.filter(r => !r.ok);
console.log(bad.length ? `\ncheck: ${bad.length} FAILED (${bad.map(b => b.name).join(', ')})` : '\ncheck: all ok');
process.exit(bad.length ? 1 : 0);
