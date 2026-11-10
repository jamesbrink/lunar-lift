#!/usr/bin/env node
/* Weather harness: fixed cameras over the pad at fixed mission time, a screenshot of each, and the
   GPU time of its passes from EXT_disjoint_timer_query_webgl2 (rAF deltas are vsync, see AGENTS.md).

     node server.js 8101 &
     node tools/cloud-views.mjs <outdir> [port=8101] [only=pad,orbit,...] [--no-gpu] [--climb] [--flicker]

   --climb    replaces the stations with one camera at 40 .. 300 km: the weather goes from the pad's
              drawing to the orbital one between 50 and 200 km, and this is where a pop would show.
   --flicker  no GPU timing; ten screenshots of each station ~0.1 s apart, the camera bolted to the
              ground under the station (so nothing in frame moves but the weather on its wind), and
              the three counts tools/flicker-test.mjs makes: `unstable` (a step between consecutive
              frames over 24 in channel sum), `strong` (over 90) and `flips` — a pixel that changes
              by more than 60 and comes straight back, A B A. An outline moving on the wind changes
              pixels without doing that; a flip is flicker. <station>-diff.png shows where.
   --freeze=drift,sun,ride   with --flicker: hold those weather uniforms still (the octaves' wind,
              the sun's direction, the macro sheet's ride). With all three held nothing the weather
              reads changes between frames, and whatever still flips is not the weather's doing.

   Drawing buffer 2160 x 1250 (deviceScaleFactor 2).

   The vehicle is teleported to each station, because the sky, the haze and the star clock all read
   the vehicle's altitude; the camera is then forced relative to it, so the frame is the same frame
   before and after a change. */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const out = args[0] || 'cloud-views', port = args[1] || 8101;
const only = args[2] ? args[2].split(',') : null;
const flicker = process.argv.includes('--flicker');
const gpu = !process.argv.includes('--no-gpu') && !flicker;
const freeze = (process.argv.find(a => a.startsWith('--freeze=')) || '').slice(9).split(',').filter(Boolean);
mkdirSync(out, { recursive: true });

/* alt: vehicle altitude, km. az/el: where the camera looks, degrees (az from north through east,
   el above the horizon; el -90 is nadir). lon: degrees the station is turned east of the pad about
   the spin axis — the sun does not move, so this is what puts a station near the terminator.
   fov: vertical, degrees. `natural` leaves the game's own chase camera alone. */
const VIEWS = [
  { name: 'pad', natural: true },
  { name: 'pad-up', alt: 0.3, az: 60, el: 28, fov: 70 },
  { name: 'pad-sun', alt: 0.3, az: 150, el: 22, fov: 70 },
  { name: 'pad-antisun', alt: 0.3, az: 330, el: 22, fov: 70 },
  { name: 'pad-zenith', alt: 0.3, az: 0, el: 80, fov: 80 },
  { name: 'band-8km', alt: 8, az: 60, el: -4, fov: 70 },
  { name: 'ascent-15km', alt: 15, az: 60, el: -12, fov: 70 },
  { name: 'high-60km', alt: 60, az: 60, el: -30, fov: 70 },
  { name: 'low-150km', alt: 150, az: 60, el: -30, fov: 70 },
  { name: 'orbit-500-nadir', alt: 500, az: 0, el: -90, fov: 70 },
  { name: 'orbit-500-limb', alt: 500, az: 60, el: -35, fov: 70 },
  { name: 'orbit-500-lowsun', alt: 500, az: 90, el: -40, fov: 70, lon: 62 },
  { name: 'orbit-1500', alt: 1500, az: 0, el: -90, fov: 70 },
  { name: 'far-4000', alt: 4000, az: 0, el: -90, fov: 70 },
];

if (process.argv.includes('--climb')) {
  VIEWS.length = 0;
  for (const alt of [40, 60, 80, 100, 125, 150, 200, 300]) VIEWS.push({ name: `climb-${String(alt).padStart(3, '0')}km`, alt, az: 60, el: -30, fov: 70 });
}

function findChrome() {
  if (process.env.EXE) return process.env.EXE;
  const cache = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const p = `${cache}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const browser = await chromium.launch({ headless: true, executablePath: findChrome(),
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 625 }, deviceScaleFactor: 2 });
const msgs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
page.on('pageerror', e => msgs.push('PAGEERR ' + e.message));

/* GPU time, amplified. One query around a single frame reads anywhere between 0.7 and 2.5 ms for
   the same picture on an Apple GPU (the clock scales with load, and a light frame is a slow one),
   so after the game has drawn its frame the pass under test is drawn K more times inside ONE
   query and the result divided by K. Two passes are timed:
     sky     the weather march into the half-resolution target (what js/halfres.js draws first);
     ink     the shell's composite alone, at full resolution (every other object hidden);
     ground  the planet alone — the globe and its near patch, which carry the cloud shade.
   The renderer and the sky target are picked up from scene.onBeforeRender — nothing in the game
   has to expose them. */
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const T = window.__gpu = { ms: [], pending: [], gl: null, ext: null, R: null, sky: null, scene: null, mode: null, K: 16 };
  window.requestAnimationFrame = cb => raf(t => {
    cb(t);
    if (!window.game) return;
    if (!T.scene) {
      T.scene = window.game._pred.parent;
      T.scene.onBeforeRender = (r, s, cam, rt) => { T.R = r; if (cam.layers.mask === 1 << 4) T.sky = rt; };
      return;
    }
    if (!T.R || !T.sky || !T.mode) return;
    const gl = T.gl || (T.gl = T.R.getContext()), ext = T.ext || (T.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'));
    if (!ext) return;
    for (let i = T.pending.length - 1; i >= 0; i--) {
      const q = T.pending[i];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) T.ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / T.K);
        gl.deleteQuery(q); T.pending.splice(i, 1);
      }
    }
    const R = T.R, cam = window.game._cam, scene = T.scene;
    const bg = scene.background, ac = R.autoClear, sh = R.shadowMap.autoUpdate;
    R.shadowMap.autoUpdate = false;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    if (T.mode === 'sky') {
      /* autoClear stays on: every draw must be its own render pass. Sixteen opaque draws in ONE pass
         are one draw to a tile-based GPU — it shades only the last — and the figure comes out 16x low. */
      scene.background = null; R.autoClear = true;
      R.setRenderTarget(T.sky); cam.layers.set(4);
      for (let k = 0; k < T.K; k++) R.render(scene, cam);
      cam.layers.set(0); R.setRenderTarget(null);
    } else {
      /* one top-level object alone: the one whose subtree holds a sphere of the wanted radius */
      const want = T.mode === 'ink' ? 6382 : 6371, hidden = [];
      for (const c of scene.children) {
        let has = false;
        c.traverse(o => { if (o.geometry && o.geometry.parameters && o.geometry.parameters.radius === want) has = true; });
        if (!has && c.visible) { c.visible = false; hidden.push(c); }
      }
      for (let k = 0; k < T.K; k++) R.render(scene, cam);
      for (const c of hidden) c.visible = true;
    }
    gl.endQuery(ext.TIME_ELAPSED_EXT); T.pending.push(q);
    scene.background = bg; R.autoClear = ac; R.shadowMap.autoUpdate = sh;
  });
});

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.game, null, { timeout: 20000 });
const wait = ms => page.waitForTimeout(ms);
await wait(2500);

await page.evaluate(async ([still, freeze]) => {
  const THREE = await import('three');
  const { S } = await import('/js/physics.js');
  const { RE, MU_E, EARTH_SPIN } = await import('/js/constants.js');
  const cam = window.game._cam, scene = window.game._pred.parent;
  const Y = new THREE.Vector3(0, 1, 0);
  const shell = [];
  scene.traverse(o => { if (o.geometry && o.geometry.parameters && [RE + 11, RE + 4].includes(o.geometry.parameters.radius)) shell.push(o.geometry); });
  let forced = null;
  /* The scene is drawn from a floating origin, in Earth-fixed axes (js/origin.js): main.js shifts
     and turns the scene for the game camera and hands the weather that eye, then renders. A forced
     camera has to redo all of that, and before the scene's matrices are built — so the hook is the
     scene's updateMatrixWorld, the first thing every render calls. The camera is a child of the
     scene, so its position and quaternion stay in the game's inertial frame; orientation is set by
     hand because Object3D.lookAt would aim from its shifted world position at an unshifted target. */
  const { setOrigin } = await import('/js/origin.js');
  const { getSpin } = await import('/js/world.js');
  const { setWeatherEye } = await import('/js/clouds.js');
  let weather = null;
  scene.traverse(o => { if (!weather && o.material && o.material.uniforms && o.material.uniforms.cloudCells) weather = o.material.uniforms; });
  const base = scene.updateMatrixWorld.bind(scene);
  const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3(), dir = new THREE.Vector3();
  const look = new THREE.Matrix4(), zero = new THREE.Vector3(), at = new THREE.Vector3();
  let station = null, spin0 = 0;
  scene.updateMatrixWorld = force => {
    if (forced) {
      /* --flicker: the station is a point of the ground, carried round by the spin; otherwise the vehicle */
      if (still && station) at.copy(station).applyAxisAngle(Y, getSpin() - spin0); else at.copy(S.pos);
      up.copy(at).normalize(); east.crossVectors(Y, up).normalize(); north.crossVectors(up, east);
      const az = forced.az * Math.PI / 180, el = forced.el * Math.PI / 180;
      dir.set(0, 0, 0).addScaledVector(north, Math.cos(az) * Math.cos(el)).addScaledVector(east, Math.sin(az) * Math.cos(el)).addScaledVector(up, Math.sin(el));
      cam.position.copy(at).addScaledVector(east, 0.3).addScaledVector(up, 0.05);   // beside the stack, never inside it
      /* --flicker: and well away from it. Above 5 km the vehicle is still teleported to the station
         (the sky and the haze read its altitude) but it is falling, so the camera goes 25 km AHEAD
         of it and it is behind the lens; near the ground it stays on the pad, 3 km in front. */
      if (still) { const k = forced.alt < 5 ? -3 : 25; cam.position.addScaledVector(north, Math.cos(az) * k).addScaledVector(east, Math.sin(az) * k); }
      cam.quaternion.setFromRotationMatrix(look.lookAt(zero, dir, Math.abs(forced.el) > 80 ? north : up));
      if (cam.fov !== forced.fov) { cam.fov = forced.fov; cam.updateProjectionMatrix(); }
      if (still) window.game._pred.visible = false;          // the path ribbon follows the (falling) vehicle
      setOrigin(scene, cam.position, getSpin());
      setWeatherEye(weather, cam.position);
    }
    base(force);
  };
  /* --freeze: the uniforms keep the values they have now; updateWeather's writes go nowhere */
  if (freeze.includes('drift')) for (const k of ['drift1', 'drift2', 'drift3', 'driftV']) weather[k].value.set = () => weather[k].value;
  if (freeze.includes('sun')) { const dummy = new THREE.Vector3(); weather.sunWorld.value.copy = (v) => dummy.copy(v); }
  if (freeze.includes('ride')) { const v0 = weather.macroRide.value; Object.defineProperty(weather.macroRide, 'value', { get: () => v0, set: () => {} }); }
  let pad = null, t0 = 0;
  window.__views = {
    fly() {                       // leave the pad once, engine off, and remember where it was
      const g = window.game;
      if (!still) { g.ignite(); g.ff(20); g.stage(); }       // --flicker: no smoke, no falling stage — nothing in frame but weather
      pad = S.pos.clone().normalize(); t0 = g.state().simTime;
    },
    go(v) {
      if (v.natural) { forced = null; return; }
      forced = v;
      const u = pad.clone().applyAxisAngle(Y, (v.lon || 0) * Math.PI / 180);
      const r = RE + v.alt, e = new THREE.Vector3().crossVectors(Y, u).normalize();
      station = u.clone().multiplyScalar(r); spin0 = getSpin();
      /* below 150 km it rides with the ground, above it is in a circular orbit — except for
         --flicker, where every station rides with the ground: at 7.6 km/s the two screenshots are
         five pixels of honest parallax apart, and that is not what is being measured */
      const vel = v.alt < 150 || still ? e.multiplyScalar(EARTH_SPIN * r * Math.hypot(u.x, u.z)) : e.multiplyScalar(Math.sqrt(MU_E / r));
      /* --flicker near the ground: the vehicle stays on the pad. Teleported to 300 m it falls through the frame. */
      if (!(still && v.alt < 5)) window.game.teleport(u.multiplyScalar(r).toArray(), vel.toArray(), t0);
    },
    shell(on) { for (const g of shell) g.setDrawRange(0, on ? Infinity : 0); },
    shellCount: () => shell.length,
    hud(on) { for (const el of document.body.children) if (el.tagName !== 'CANVAS' && el.tagName !== 'SCRIPT') el.style.visibility = on ? '' : 'hidden'; },
  };
}, [flicker, freeze]);

const gpuMs = async (mode) => {
  await page.evaluate((m) => { window.__gpu.mode = m; }, mode);
  await wait(400);                              // let the GPU's clock settle on the new load
  await page.evaluate(() => { window.__gpu.ms.length = 0; });
  await page.waitForFunction(() => window.__gpu.ms.length >= 40, null, { timeout: 60000 });
  return page.evaluate(() => {
    const d = window.__gpu.ms.slice().sort((a, b) => a - b); window.__gpu.mode = null;
    return +d[d.length >> 1].toFixed(3);
  });
};

const differ = flicker ? await browser.newPage() : null;
console.log('shell geometries:', await page.evaluate(() => window.__views.shellCount()));
if (gpu) console.log('GPU ms per pass (median of 40 queries, each 16 draws):');
let flown = false;
for (const v of VIEWS) {
  if (only && !only.includes(v.name)) continue;
  if (!v.natural && !flown) { await page.evaluate(() => window.__views.fly()); flown = true; }
  const place = () => page.evaluate(view => window.__views.go(view), v);
  await place(); await wait(700);
  await place(); await wait(250);
  await page.evaluate(() => window.__views.hud(false));
  await page.screenshot({ path: `${out}/${v.name}.png` });
  if (flicker) {
    const shots = [];
    for (let k = 0; k < 10; k++) { shots.push((await page.screenshot()).toString('base64')); await wait(100); }
    const d = await differ.evaluate(async (shots) => {
      const imgs = await Promise.all(shots.map(async b => { const im = new Image(); im.src = 'data:image/png;base64,' + b; await im.decode(); return im; }));
      const w = imgs[0].width, h = imgs[0].height, c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      const data = imgs.map(i => { g.drawImage(i, 0, 0); return g.getImageData(0, 0, w, h).data; });
      const o = g.createImageData(w, h); let unstable = 0, strong = 0, flips = 0;
      const dist = (a, b, q) => Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1]) + Math.abs(a[q + 2] - b[q + 2]);
      for (let p = 0; p < w * h; p++) {
        const q = p * 4; let mx = 0, flip = 0;
        for (let k = 1; k < data.length; k++) mx = Math.max(mx, dist(data[k - 1], data[k], q));
        for (let k = 1; k + 1 < data.length; k++) if (dist(data[k], data[k - 1], q) > 60 && dist(data[k + 1], data[k - 1], q) < 20) { flip = 1; break; }
        if (mx > 24) unstable++; if (mx > 90) strong++; flips += flip;
        const v = Math.min(255, mx * 3); o.data[q] = flip ? 255 : v; o.data[q + 1] = flip ? 0 : v; o.data[q + 2] = flip ? 0 : v; o.data[q + 3] = 255;
      }
      g.putImageData(o, 0, 0);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let str = ''; for (const x of buf) str += String.fromCharCode(x);
      return { unstable, strong, flips, png: btoa(str) };
    }, shots);
    writeFileSync(`${out}/${v.name}-diff.png`, Buffer.from(d.png, 'base64'));
    console.log(v.name.padEnd(18), 'unstable', String(d.unstable).padStart(6), ' strong', String(d.strong).padStart(6), ' flips', String(d.flips).padStart(5));
  }
  await page.evaluate(() => window.__views.hud(true));
  if (!gpu) { if (!flicker) console.log(v.name); continue; }
  await place(); await wait(200);
  const sky = await gpuMs('sky'); await place();
  const ink = await gpuMs('ink'); await place();
  const ground = await gpuMs('ground');
  console.log(v.name.padEnd(18), 'sky', sky.toFixed(3), ' ink', ink.toFixed(3), ' ground', ground.toFixed(3), ' sum', (sky + ink + ground).toFixed(3));
}
console.log(msgs.length ? `console (${msgs.length}):\n  ` + [...new Set(msgs)].slice(0, 12).join('\n  ') : 'console: clean');
await browser.close();
