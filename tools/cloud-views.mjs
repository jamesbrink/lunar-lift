#!/usr/bin/env node
/* Weather harness: fixed cameras over the pad at fixed mission time, a screenshot of each, and the
   GPU time of its passes from EXT_disjoint_timer_query_webgl2 (rAF deltas are vsync, see agents.md).

     node server.js 8101 &
     node tools/cloud-views.mjs <outdir> [port=8101] [only=pad,orbit,...] [--no-gpu] [--climb] [--flicker]

   --climb    replaces the stations with one camera at 40 .. 300 km: the weather goes from the pad's
              drawing to the orbital one between 50 and 200 km, and this is where a pop would show.
   --flicker  no GPU timing; two screenshots of each station ~0.1 s apart and how they differ:
              `changed` pixels (any channel off by more than 24) and `thick`, the changed pixels
              whose whole 3 x 3 neighbourhood changed too. An edge that moved a pixel leaves a line
              one pixel wide and no thick pixels; a shape that flickers leaves a blot.

   Drawing buffer 2160 x 1250 (deviceScaleFactor 2).

   The vehicle is teleported to each station, because the sky, the haze and the star clock all read
   the vehicle's altitude; the camera is then forced relative to it, so the frame is the same frame
   before and after a change. */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const out = args[0] || 'cloud-views', port = args[1] || 8101;
const only = args[2] ? args[2].split(',') : null;
const flicker = process.argv.includes('--flicker');
const gpu = !process.argv.includes('--no-gpu') && !flicker;
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

await page.evaluate(async (still) => {
  const THREE = await import('three');
  const { S } = await import('/js/physics.js');
  const { RE, MU_E, EARTH_SPIN } = await import('/js/constants.js');
  const cam = window.game._cam, scene = window.game._pred.parent;
  const Y = new THREE.Vector3(0, 1, 0);
  const shell = [];
  scene.traverse(o => { if (o.geometry && o.geometry.parameters && [RE + 11, RE + 4].includes(o.geometry.parameters.radius)) shell.push(o.geometry); });
  let forced = null;
  /* The scene is drawn from a floating origin (js/origin.js): main.js shifts the scene by minus the
     game camera's position and hands the weather that eye, then renders. A forced camera has to move
     all three together, and it has to do it before the scene's matrices are built — so the hook is
     the scene's updateMatrixWorld, the first thing every render calls. Orientation is set by hand:
     Object3D.lookAt would aim from the camera's shifted world position at an unshifted target. */
  const { uOrigin } = await import('/js/origin.js');
  const { setWeatherEye } = await import('/js/clouds.js');
  let weather = null;
  scene.traverse(o => { if (!weather && o.material && o.material.uniforms && o.material.uniforms.cloudCells) weather = o.material.uniforms; });
  const base = scene.updateMatrixWorld.bind(scene);
  const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3(), dir = new THREE.Vector3();
  const look = new THREE.Matrix4(), zero = new THREE.Vector3();
  scene.updateMatrixWorld = force => {
    if (forced) {
      up.copy(S.pos).normalize(); east.crossVectors(Y, up).normalize(); north.crossVectors(up, east);
      const az = forced.az * Math.PI / 180, el = forced.el * Math.PI / 180;
      dir.set(0, 0, 0).addScaledVector(north, Math.cos(az) * Math.cos(el)).addScaledVector(east, Math.sin(az) * Math.cos(el)).addScaledVector(up, Math.sin(el));
      cam.position.copy(S.pos).addScaledVector(east, 0.3).addScaledVector(up, 0.05);   // beside the stack, never inside it
      cam.quaternion.setFromRotationMatrix(look.lookAt(zero, dir, Math.abs(forced.el) > 80 ? north : up));
      if (cam.fov !== forced.fov) { cam.fov = forced.fov; cam.updateProjectionMatrix(); }
      scene.position.copy(cam.position).negate(); uOrigin.value.copy(cam.position);
      setWeatherEye(weather, cam.position);
    }
    base(force);
  };
  let pad = null, t0 = 0;
  window.__views = {
    fly() {                       // leave the pad once, engine off, and remember where it was
      const g = window.game; g.ignite(); g.ff(20); g.stage();
      pad = S.pos.clone().normalize(); t0 = g.state().simTime;
    },
    go(v) {
      if (v.natural) { forced = null; return; }
      forced = v;
      const u = pad.clone().applyAxisAngle(Y, (v.lon || 0) * Math.PI / 180);
      const r = RE + v.alt, e = new THREE.Vector3().crossVectors(Y, u).normalize();
      /* below 150 km it rides with the ground, above it is in a circular orbit — except for
         --flicker, where every station rides with the ground: at 7.6 km/s the two screenshots are
         five pixels of honest parallax apart, and that is not what is being measured */
      const vel = v.alt < 150 || still ? e.multiplyScalar(EARTH_SPIN * r * Math.hypot(u.x, u.z)) : e.multiplyScalar(Math.sqrt(MU_E / r));
      window.game.teleport(u.multiplyScalar(r).toArray(), vel.toArray(), t0);
    },
    shell(on) { for (const g of shell) g.setDrawRange(0, on ? Infinity : 0); },
    shellCount: () => shell.length,
    hud(on) { for (const el of document.body.children) if (el.tagName !== 'CANVAS' && el.tagName !== 'SCRIPT') el.style.visibility = on ? '' : 'hidden'; },
  };
}, flicker);

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
    const a = await page.screenshot(), b = await page.screenshot();
    const d = await differ.evaluate(async ([A, B]) => {
      const load = async (b64) => { const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
        const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height); };
      const p = await load(A), q = await load(B), w = p.width, h = p.height, m = new Uint8Array(w * h);
      let changed = 0, thick = 0;
      for (let i = 0; i < w * h; i++) if (Math.max(Math.abs(p.data[i * 4] - q.data[i * 4]), Math.abs(p.data[i * 4 + 1] - q.data[i * 4 + 1]), Math.abs(p.data[i * 4 + 2] - q.data[i * 4 + 2])) > 24) { m[i] = 1; changed++; }
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!m[(y + dy) * w + x + dx]) { all = 0; break; }
        thick += all;
      }
      return { changed, thick };
    }, [a.toString('base64'), b.toString('base64')]);
    console.log(v.name.padEnd(18), 'changed', String(d.changed).padStart(7), ' thick', String(d.thick).padStart(6));
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
