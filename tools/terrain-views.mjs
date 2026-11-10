#!/usr/bin/env node
/* Terrain review stations: the ground photographed from the heights a reviewer judges it at.

     node tools/terrain-views.mjs <outdir> [port=8078] [only=pad,cape,...] [--hud] [--weather]

   The weather is hidden unless --weather is given: from 500 km a third of any frame is cloud, and
   this is the ground's review.

   Earth: pad default and from 3 km, 2 / 8 / 27 km over the Cape, 500 km nadir over two continents
   and over open ocean with the sun's reflection in frame, 4,000 km whole-Earth, dusk and night at
   the pad. Moon: 4,000 km, 100 km, 10 km toward the horizon, and three landings from 30 m (the
   lander must come to rest ON the drawn ground: the script prints the height of the vehicle's
   lowest point over moonGroundHeight at rest, and the raycast gap between that function and the
   drawn patch under it).

   Every station is a fresh teleport with the clock paused, so a frame is a still. Prints console
   errors and warnings and exits 1 on any (a dead ShaderMaterial logs exactly one console.error). */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const out = args[0] || 'terrain-shots', port = args[1] || 8078;
const only = args[2] ? args[2].split(',') : null;
const hud = process.argv.includes('--hud'), weather = process.argv.includes('--weather');
mkdirSync(out, { recursive: true });

function findChrome() {
  if (process.env.EXE) return process.env.EXE;
  const cache = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const p = `${cache}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
}
const browser = await chromium.launch({ headless: true, executablePath: findChrome(),
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const msgs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => msgs.push('PAGEERR ' + e.message));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.game, null, { timeout: 20000 });
await page.waitForTimeout(3500);
if (!weather) await page.evaluate(() => { window.__noWeather = true; });
if (!hud) await page.addStyleTag({ content: '.hud,.panel,#views,#helpBtn,#log,#next{visibility:hidden!important}' });

/* helpers living in the page */
await page.evaluate(async () => {
  const T = await import('three'), C = await import('/js/constants.js'), P = await import('/js/physics.js'), W = await import('/js/world.js');
  const Y = new T.Vector3(0, 1, 0);
  const H = window.__tv = { T, C, P, W };
  /* hover over a body-fixed lat/lon (degrees) at alt km, co-rotating, paused */
  H.earth = (lat, lon, alt, t = 0) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const d = new T.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyAxisAngle(Y, C.EARTH_SPIN * t);
    const p = d.clone().multiplyScalar(C.RE + alt), v = new T.Vector3().crossVectors(Y, p).multiplyScalar(C.EARTH_SPIN);
    game.reset(); game.stage(); game.teleport(p.toArray(), v.toArray(), t); game.warp(0);
  };
  /* over the pad at alt km (above the pad's own state point) */
  H.cape = (alt, t = 0) => {
    const p = C.PAD_POS.clone().applyAxisAngle(Y, C.EARTH_SPIN * t); p.setLength(p.length() + alt);
    const v = new T.Vector3().crossVectors(Y, p).multiplyScalar(C.EARTH_SPIN);
    game.reset(); game.stage(); game.teleport(p.toArray(), v.toArray(), t); game.warp(0);
  };
  /* hover x km east, y km north of the pad at alt km above the ground, paused */
  H.site = (x, y, alt, t = 0) => {
    const n = new T.Vector3().crossVectors(C.PAD_UP, C.PAD_EAST).normalize();
    const p = C.PAD_UP.clone().multiplyScalar(C.RE).addScaledVector(C.PAD_EAST, x).addScaledVector(n, y).setLength(C.RE + alt).applyAxisAngle(Y, C.EARTH_SPIN * t);
    const v = new T.Vector3().crossVectors(Y, p).multiplyScalar(C.EARTH_SPIN);
    game.reset(); game.stage(); game.teleport(p.toArray(), v.toArray(), t); game.warp(0);
  };
  /* over the Moon: `turn` rad round the pole from the sub-solar meridian, `tilt` rad toward the pole */
  H.moonDir = (turn, tilt, t) => {
    const up = W.SUN_DIR.clone().setY(0).normalize().applyAxisAngle(Y, turn);
    const ax = new T.Vector3().crossVectors(up, Y).normalize();
    return up.applyAxisAngle(ax, tilt).normalize();
  };
  H.moon = (turn, tilt, alt, t = 1000, landed = false) => {
    const m = C.moonPos(t, new T.Vector3()), mv = C.moonVel(t, new T.Vector3());
    const up = H.moonDir(turn, tilt, t);
    game.reset();
    const put = (a) => game.teleport(m.clone().addScaledVector(up, C.RM + W.moonGroundHeight(up) + a).toArray(), mv.toArray(), t);
    put(alt + 1); game.stage(); game.stage();       // staging only works in flight: teleport first
    put(alt);
    P.S.q.setFromUnitVectors(new T.Vector3(0, 0, 1), up);
    /* `alt` is the height of the LOWEST point for a landing: the state point is the middle of the
       full stack, 58 m above the service module's bell */
    if (landed) { put(alt + alt - P.surfaceAlt(true)); P.S.q.setFromUnitVectors(new T.Vector3(0, 0, 1), up); }
    else game.warp(0);
    return up.toArray();
  };
});

const wait = ms => page.waitForTimeout(ms);
const want = n => !only || only.some(o => n.startsWith(o));
const shot = async (n, setup, settle = 1400) => {
  if (!want(n)) return;
  await page.evaluate(setup);
  await wait(settle);
  await page.screenshot({ path: `${out}/${n}.png` });
  console.log('shot', n);
};

/* ---- Earth ---- */
await shot('pad-default', `game.reset()`);
await shot('pad-3km', `game.reset(); game.setView(0.5, 0.15, 3)`);
await shot('pad-low-west', `game.reset(); game.setView(-1.57, 0.06, 0.9)`);
await shot('pad-low-east', `game.reset(); game.setView(1.57, 0.10, 1.4)`);
await shot('pad-6km-high', `game.reset(); game.setView(2.6, 0.5, 7)`);
await shot('site-vab', `__tv.site(-4.6, -0.5, 0.25); game.setView(2.0, 0.12, 0.3)`);
await shot('site-vab-low', `__tv.site(-5.1, 0.25, 0.09); game.setView(1.2, 0.05, 0.25)`);
await shot('site-crawlerway', `__tv.site(-2.5, -0.1, 0.4); game.setView(1.57, 0.2, 0.4)`);
await shot('site-padb', `__tv.site(-0.9, 1.6, 0.3); game.setView(0.6, 0.2, 0.3)`);
await shot('site-beach', `__tv.site(1.3, 0.2, 0.3); game.setView(-1.2, 0.25, 0.3)`);
await shot('cape-2km', `__tv.cape(2); game.setView(0.4, 0.5, 0.6)`);
await shot('cape-2km-down', `__tv.cape(2); game.setView(0, 1.3, 0.5)`);
await shot('cape-8km', `__tv.cape(8); game.setView(0, 1.3, 0.5)`);
await shot('cape-8km-oblique', `__tv.cape(8); game.setView(2.4, 0.55, 0.5)`);
await shot('cape-27km', `__tv.cape(27); game.setView(0, 1.3, 0.5)`);
await shot('cape-27km-oblique', `__tv.cape(27); game.setView(2.4, 0.45, 0.5)`);
await shot('orbit-500-africa', `__tv.earth(8, 20, 500); game.setView(0, 1.3, 0.3)`);
await shot('orbit-500-europe', `__tv.earth(46, 8, 500); game.setView(0, 1.3, 0.3)`);
await shot('orbit-500-namerica', `__tv.earth(40, -100, 500); game.setView(0, 1.3, 0.3)`);
await shot('orbit-500-ocean-glint', `__tv.earth(20, -45, 500); game.setView(0, 1.3, 0.3)`);
await shot('orbit-500-limb', `__tv.earth(20, -45, 500); game.setView(0, 0.25, 0.3)`);
await shot('earth-4000', `__tv.earth(15, -60, 4000); game.setView(0, 1.3, 0.3)`);
await shot('earth-4000-b', `__tv.earth(25, 60, 4000, 30000); game.setView(0, 1.3, 0.3)`);
await shot('dusk-pad', `game.reset(); game.ff(12 * 3600)`);
await shot('dusk-pad-3km', `game.reset(); game.ff(12 * 3600); game.setView(0.5, 0.15, 3)`);
await shot('dusk-pad-40km', `game.reset(); game.ff(12 * 3600); game.setView(0.5, 0.35, 40)`);
await shot('night-pad', `game.reset(); game.ff(16.5 * 3600)`);
await shot('night-pad-3km', `game.reset(); game.ff(16.5 * 3600); game.setView(0.5, 0.15, 3)`);
await shot('night-pad-40km', `game.reset(); game.ff(16.5 * 3600); game.setView(0.5, 0.35, 40)`);
await shot('tod-15h', `game.reset(); game.ff(15 * 3600)`);
await shot('tod-9h-3km', `game.reset(); game.ff(9 * 3600); game.setView(0.5, 0.15, 3)`);

/* ---- Moon ---- */
await shot('moon-4000', `__tv.moon(0.7, 0.1, 4000); game.setView(0, 1.3, 0.3)`);
await shot('moon-4000-b', `__tv.moon(-0.9, -0.3, 4000); game.setView(0, 1.3, 0.3)`);
await shot('moon-100', `__tv.moon(0.7, 0.1, 100); game.setView(0, 1.3, 0.3)`);
await shot('moon-100-limb', `__tv.moon(0.7, 0.1, 100); game.setView(0.6, 0.3, 0.3)`);
await shot('moon-10-horizon', `__tv.moon(0.7, 0.1, 10); game.setView(0.6, 0.12, 0.2)`);
await shot('moon-10-horizon-b', `__tv.moon(1.1, 0.4, 10); game.setView(2.6, 0.1, 0.2)`);
await shot('moon-2-horizon', `__tv.moon(0.7, 0.1, 2); game.setView(0.6, 0.1, 0.15)`);

/* three landings: drop from 30 m, wait for rest, measure */
let landFail = 0;
const sites = [['a', 0.7, 0.1], ['b', 1.1, 0.4], ['c', -0.5, -0.5]];
for (const [tag, turn, tilt] of sites) {
  if (!want('moon-landed')) break;
  await page.evaluate(([turn, tilt]) => { __tv.moon(turn, tilt, 0.03, 1000, true); game.warp(1); game.setView(0.6, 0.2, 0.09); }, [turn, tilt]);
  await wait(9000);
  const r = await page.evaluate(async () => {
    const { T, C, P, W } = __tv, PR = await import('/js/predictor.js');
    const s = game.state(), m = C.moonPos(P.getSimTime(), new T.Vector3());
    const rel = P.S.pos.clone().sub(m), up = rel.clone().normalize();
    /* the drawn ground: raycast the lunar patch straight down from the vehicle, in absolute doubles */
    const scene = PR.predLine.parent; let patch = null;
    scene.traverse(o => { if (o.isMesh && o.geometry.attributes.sfUv && !o.geometry.parameters && Math.abs(o.parent.geometry?.parameters?.radius - C.RM) < 1) patch = o; });
    let gap = null;
    if (patch && patch.visible) {
      const moonMesh = patch.parent, a = moonMesh.rotation.y;
      const loc = rel.clone().applyAxisAngle(new T.Vector3(0, 1, 0), -a).sub(patch.position);       // patch-local, km
      const dn = up.clone().applyAxisAngle(new T.Vector3(0, 1, 0), -a);
      const pos = patch.geometry.attributes.position, idx = patch.geometry.index;
      const ray = new T.Ray(loc.clone().addScaledVector(dn, 0.5), dn.clone().negate());
      const A = new T.Vector3(), B = new T.Vector3(), Cc = new T.Vector3(), hit = new T.Vector3();
      const cols = Math.round(Math.sqrt(pos.count)), mid = (cols >> 1), span = 14;
      let best = null;
      for (let y = mid - span; y < mid + span; y++) for (let x = mid - span; x < mid + span; x++) {
        const q = (y * (cols - 1) + x) * 6;
        for (let k = 0; k < 6; k += 3) {
          A.fromBufferAttribute(pos, idx.getX(q + k)); B.fromBufferAttribute(pos, idx.getX(q + k + 1)); Cc.fromBufferAttribute(pos, idx.getX(q + k + 2));
          if (ray.intersectTriangle(A, B, Cc, false, hit)) best = hit.clone();
        }
      }
      if (best) {
        const drawnR = best.add(patch.position).length();
        gap = (drawnR - (C.RM + W.moonGroundHeight(up))) * 1000;
      }
    }
    return { state: s.state, restAlt_m: +((rel.length() - C.RM - W.moonGroundHeight(up)) * 1000).toFixed(2),
      contact_m: +(P.surfaceAlt(true) * 1000).toFixed(2), ground_km: +W.moonGroundHeight(up).toFixed(4),
      drawnMinusFn_m: gap === null ? null : +gap.toFixed(2), touchdown: document.getElementById('overlayText')?.textContent.replace(/\s+/g, ' ').slice(0, 90) };
  });
  console.log(`landing ${tag}`, JSON.stringify(r));
  if (r.drawnMinusFn_m === null || Math.abs(r.drawnMinusFn_m) > 1 || Math.abs(r.contact_m) > 1) landFail++;
  await page.screenshot({ path: `${out}/moon-landed-${tag}.png` });
  await page.evaluate(() => game.setView(2.2, 0.12, 0.6)); await wait(1200);
  await page.screenshot({ path: `${out}/moon-landed-${tag}-wide.png` });
}

console.log(`total ${(Date.now() - t0) / 1000 | 0} s`);
console.log(msgs.length ? `console (${msgs.length}):\n  ` + [...new Set(msgs)].slice(0, 12).join('\n  ') : 'console: clean');
if (landFail) console.log(`landings off the drawn ground: ${landFail}`);
await browser.close();
process.exit(msgs.length || landFail ? 1 : 0);
