#!/usr/bin/env node
/* Camera clipping sweep: at the pad, in flight, in orbit and landed on the Moon, drive the view
   through every yaw / pitch / zoom the mouse can reach and assert the camera is never under the
   drawn terrain, never inside the vehicle's hull, and never closer to anything than the near plane.

     node tools/clip-test.mjs [port=8078]        exits 1 on any violation */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
const port = process.argv[2] || 8078;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.game, null, { timeout: 20000 });
await page.waitForTimeout(2000);

const sweep = name => page.evaluate(async name => {
  const P = await import('/js/physics.js'), C = await import('/js/constants.js'), T = await import('three'), W = await import('/js/world.js');
  const { updateCamera, camera } = await import('/js/camera.js');
  const moon = new T.Vector3(), d = new T.Vector3(), ax = new T.Vector3(), rel = new T.Vector3();
  let n = 0, minGround = 1e9, minHull = 1e9; const bad = [];
  for (const mode of ['orbit', 'chase']) {
    game.camera(mode);
    for (const dist of [0.02, 0.05, 0.13, 0.6, 3])
      for (let pitch = -1.3; pitch <= 1.31; pitch += 0.26)
        for (let yaw = 0; yaw < 6.28; yaw += 0.393) {
          game.setView(yaw, pitch, dist);
          updateCamera(1 / 60); updateCamera(1 / 60);
          const c = camera.position; n++;
          const hE = c.length() - C.RE - W.groundHeight(d.copy(c).normalize());
          C.moonPos(P.getSimTime(), moon);
          rel.subVectors(c, moon);
          const hM = rel.length() - C.RM - W.moonGroundHeight(d.copy(rel).normalize());
          const ground = Math.min(hE, hM);
          /* distance from the hull: a capsule along the axis between the live tail and the apex */
          ax.copy(P.fwd());
          rel.subVectors(c, P.S.pos);
          const z = T.MathUtils.clamp(rel.dot(ax), P.tailStation() * C.VS, 28.7 * C.VS);
          const hull = rel.addScaledVector(ax, -z).length() - 3.6 * C.VS;       // 5 m radius
          minGround = Math.min(minGround, ground); minHull = Math.min(minHull, hull);
          if (ground < 0.002 || hull < 0.002 || !Number.isFinite(ground + hull))
            bad.push({ mode, dist, pitch: +pitch.toFixed(2), yaw: +yaw.toFixed(2), ground: +(ground * 1000).toFixed(1), hull: +(hull * 1000).toFixed(1) });
        }
  }
  game.camera('orbit'); game.setView(2.33, 0, 0.13);
  return { name, n, minGround_m: +(minGround * 1000).toFixed(1), minHull_m: +(minHull * 1000).toFixed(1), violations: bad.length, first: bad.slice(0, 4) };
}, name);

let fail = 0;
const run = async name => { const r = await sweep(name); console.log(JSON.stringify(r)); fail += r.violations; };
await run('pad');
await page.evaluate(() => { game.ignite(); game.setSas(true, false); game.ff(14); });
await run('liftoff +14 s');
await page.evaluate(() => game.ff(60));
await run('ascent');
await page.evaluate(() => game.ff(600));
await run('orbit');
await page.evaluate(async () => {
  const P = await import('/js/physics.js'), C = await import('/js/constants.js'), T = await import('three'), W = await import('/js/world.js');
  const t = 1000, m = C.moonPos(t, new T.Vector3()), mv = C.moonVel(t, new T.Vector3());
  const up = m.clone().normalize().negate().applyAxisAngle(new T.Vector3(0, 1, 0), 0.5).normalize();
  game.teleport(m.clone().addScaledVector(up, C.RM + W.moonGroundHeight(up) + 0.02).toArray(), mv.toArray(), t);
  game.stage(); game.stage();
  P.S.q.setFromUnitVectors(new T.Vector3(0, 0, 1), up);
});
await run('moon, 30 m up');
await browser.close();
console.log(fail ? `clip-test: ${fail} VIOLATIONS` : 'clip-test: ok');
process.exit(fail ? 1 : 0);
