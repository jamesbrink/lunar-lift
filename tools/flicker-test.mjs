#!/usr/bin/env node
/* Flicker gate. Flicker is a pixel that changes when nothing it shows has changed, so the test
   builds views in which nothing SHOULD change and counts the pixels that do.

     node tools/flicker-test.mjs [port=8078] [outdir]        exits 1 if any gated view fails

   Views (HUD hidden, 10 frames ~100 ms apart, a pixel is 'unstable' if any channel-sum step
   between consecutive frames exceeds 24, 'strong' above 90):
     pad, weather off     GATED at <= 300 unstable / <= 20 strong / <= 20 flips of 1,296,000.
                          Everything in frame is bolted to the ground, and the ground is moving
                          409 m/s through the game's inertial frame: this is the precision test.
                          History of the 'strong' count: 1,976 with the terrain patch stored
                          planet-centred; 127 after it was stored from its own centre; 2 after the
                          camera's heading was made to turn with the planet near the ground (carried
                          in inertial space it drifted against the pad a thousandth of a pixel a frame).
     pad close, weather off   from 60 m, <= 400 / 25 / 25: z-fighting between pad and vehicle parts.
     pad, weather on      clouds drift on the wind, so their hard outlines legitimately change pixels
                          and the gate is loose: <= 6,000 unstable / 1,500 strong / 600 flips (a flip
                          is a pixel that changes and comes straight back). KNOWN: the flips are the
                          cloud-outline shimmer; the target is 150. This view measures real motion; on a
                          loaded machine its strong count goes over the gate (measured: 1,674 and 1,709 with
                          33 other Chromium processes running, 1,102 minutes later with the machine quiet)
                          — presumably the ten frames spread further apart; that cause is inferred.
     paused, in flight    GATED at exactly 0: a paused frame must be a still.
   A separate static check lists coplanar, overlapping faces between meshes of the vehicle and the
   pad (the cause of z-fighting): GATED at 0 pairs. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, openGame } from './lib/browser.mjs';
const port = process.argv[2] || 8078, out = process.argv[3] || '';
if (out) mkdirSync(out, { recursive: true });
const browser = await launch();
const differ = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let fail = 0;

async function view(name, setup, gate) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openGame(page, port);
  await page.waitForTimeout(6000);                          // let boot-time work (texture bakes, patch builds) finish
  await page.evaluate(setup);
  await page.evaluate(() => document.querySelectorAll('.hud,.panel,#views,#helpBtn').forEach(e => e.style.visibility = 'hidden'));
  await page.waitForTimeout(1500);
  const shots = [];
  for (let k = 0; k < 10; k++) { shots.push((await page.screenshot()).toString('base64')); await page.waitForTimeout(100); }
  await page.close();
  const r = await differ.evaluate(async (shots) => {
    const imgs = await Promise.all(shots.map(b => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b; })));
    const w = imgs[0].width, h = imgs[0].height, c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
    const data = imgs.map(i => { g.drawImage(i, 0, 0); return g.getImageData(0, 0, w, h).data; });
    const o = g.createImageData(w, h); let n = 0, strong = 0, flips = 0;
    const dist = (a, b, q) => Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1]) + Math.abs(a[q + 2] - b[q + 2]);
    for (let p = 0; p < w * h; p++) {
      let mx = 0;
      for (let k = 1; k < data.length; k++) { const a = data[k - 1], b = data[k], q = p * 4; const d = Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1]) + Math.abs(a[q + 2] - b[q + 2]); if (d > mx) mx = d; }
      if (mx > 24) n++; if (mx > 90) strong++;
      /* a FLIP is a pixel that changes and comes straight back: A, B, A. A hard edge that is really
         moving (a cloud on the wind) changes pixels without doing that. */
      for (let k = 1; k + 1 < data.length; k++) if (dist(data[k], data[k - 1], p * 4) > 60 && dist(data[k + 1], data[k - 1], p * 4) < 20) { flips++; break; }
      const v = Math.min(255, mx * 3), q = p * 4; o.data[q] = v; o.data[q + 1] = mx > 90 ? 0 : v; o.data[q + 2] = mx > 90 ? 0 : v; o.data[q + 3] = 255;
    }
    g.putImageData(o, 0, 0);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let s = ''; for (const x of buf) s += String.fromCharCode(x);
    return { n, strong, flips, png: btoa(s) };
  }, shots);
  if (out) { writeFileSync(`${out}/${name.replace(/\W+/g, '-')}-diff.png`, Buffer.from(r.png, 'base64')); writeFileSync(`${out}/${name.replace(/\W+/g, '-')}.png`, Buffer.from(shots[0], 'base64')); }
  const ok = r.n <= gate.unstable && r.strong <= gate.strong && r.flips <= (gate.flips ?? Infinity);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(26)} unstable ${String(r.n).padStart(6)} (<= ${gate.unstable})   strong ${String(r.strong).padStart(6)} (<= ${gate.strong})   flips ${String(r.flips).padStart(5)}${gate.flips !== undefined ? ` (<= ${gate.flips})` : ''}`);
}

await view('pad, weather off', () => { window.__noWeather = true; }, { unstable: 300, strong: 20, flips: 20 });
await view('pad close, weather off', () => { window.__noWeather = true; game.setView(1.2, 0.25, 0.06); }, { unstable: 400, strong: 25, flips: 25 });
await view('pad, weather on', () => {}, { unstable: 6000, strong: 1500, flips: 150 });   // measured 353 before the weather's rays were built from the pixel and its coverage made one ramp, 58 after
await view('paused in flight', async () => { game.ignite(); game.setSas(true, false); game.ff(70); await new Promise(r => setTimeout(r, 5000)); game.warp(0); await new Promise(r => setTimeout(r, 2500)); }, { unstable: 0, strong: 0 });

/* Static check: coplanar overlapping faces between different meshes of the vehicle and the pad. */
{
  const page = await browser.newPage();
  await openGame(page, port);
  await page.waitForTimeout(4000);
  const pairs = await page.evaluate(async () => {
    const T = await import('three'), SAT = await import('/js/saturn.js'), P = await import('/js/predictor.js');
    const scene = P.predLine.parent; let padGroup = null;
    scene.traverse(o => { if (!padGroup && o.isGroup && o.children.length > 3 && o.children.some(c => c.isMesh && c.material && c.material.name === 'deck')) padGroup = o; });
    const found = [];
    for (const [label, root] of [['vehicle', SAT.rocketGroup], ['pad', padGroup]]) {
      if (!root) continue;
      root.updateWorldMatrix(true, true);
      const inv = new T.Matrix4().copy(root.matrixWorld).invert(), m = new T.Matrix4();
      const tris = [], a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), n = new T.Vector3(), e1 = new T.Vector3(), e2 = new T.Vector3();
      let id = 0;
      root.traverse(o => {
        if (!o.isMesh || !o.visible || o.material.transparent || o.material.isShaderMaterial) return;      // opaque lit surfaces only (outline shells are ShaderMaterial)
        const g = o.geometry, pos = g.attributes.position, idx = g.index; m.multiplyMatrices(inv, o.matrixWorld);
        const count = idx ? idx.count : pos.count, mid = id++;
        for (let i = 0; i < count; i += 3) {
          const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
          a.fromBufferAttribute(pos, i0).applyMatrix4(m); b.fromBufferAttribute(pos, i1).applyMatrix4(m); c.fromBufferAttribute(pos, i2).applyMatrix4(m);
          n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)); const area = n.length() / 2; if (area < 0.02) continue;
          n.normalize(); const d = n.dot(a);
          tris.push({ mid, geo: o.geometry.type + ' ' + (o.geometry.parameters ? JSON.stringify(Object.values(o.geometry.parameters).slice(0, 4)) : ''), name: o.material.name || o.material.color.getHexString(), n: [n.x, n.y, n.z], d, area,
            min: [Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.min(a.z, b.z, c.z)], max: [Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y), Math.max(a.z, b.z, c.z)],
            cx: (a.x + b.x + c.x) / 3, cy: (a.y + b.y + c.y) / 3, cz: (a.z + b.z + c.z) / 3 });
        }
      });
      /* bucket by plane (normal to 0.02, offset to 0.02 u), then compare across meshes */
      const buckets = new Map();
      for (const t of tris) {
        const s = t.n[0] + t.n[1] * 1.7 + t.n[2] * 2.9 < 0 ? -1 : 1;                 // one orientation per plane
        const key = [Math.round(t.n[0] * s * 400), Math.round(t.n[1] * s * 400), Math.round(t.n[2] * s * 400), Math.round(t.d * s * 100)].join(',');   // same plane: normal within 0.15 deg, offset within 0.01 u (1.4 cm)
        if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(t);
      }
      const seen = new Set();
      for (const list of buckets.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const p = list[i], q = list[j]; if (p.mid === q.mid) continue;
        if (p.n[0] * q.n[0] + p.n[1] * q.n[1] + p.n[2] * q.n[2] < 0) continue;      // back to back (a box standing on a deck): each hides the other, nothing fights
        /* overlap by 0.05 u on every axis the faces HAVE extent in. A face lying in an axis plane has
           none along its normal, and asking for 0.05 u of overlap there rejected every axis-aligned
           pair: the scan read 0 while the crane's jib and counterweight shared a top (user screenshot). */
        let ov = true; for (let k = 0; k < 3; k++) { const thin = Math.min(p.max[k] - p.min[k], q.max[k] - q.min[k]) < 0.1, m = thin ? -0.02 : 0.05; if (p.min[k] > q.max[k] - m || q.min[k] > p.max[k] - m) ov = false; }
        if (!ov) continue;
        const key = Math.min(p.mid, q.mid) + ':' + Math.max(p.mid, q.mid) + ':' + Math.round(p.d * 10);
        if (seen.has(key)) continue; seen.add(key);
        found.push(`${label}: ${p.name} [${p.geo}] vs ${q.name} [${q.geo}] share a plane near (${p.cx.toFixed(1)}, ${p.cy.toFixed(1)}, ${p.cz.toFixed(1)}) / (${q.cx.toFixed(1)}, ${q.cy.toFixed(1)}, ${q.cz.toFixed(1)}) u`);
      }
    }
    return found;
  });
  console.log(`${pairs.length ? 'FAIL' : 'ok  '} coplanar overlapping faces: ${pairs.length}`);
  for (const p of pairs.slice(0, 25)) console.log('     ' + p);
  if (pairs.length) fail++;
  /* The rest of the Cape (js/cape.js) is ONE merged mesh, which the scan above cannot see into — it
     compares meshes. The group audits itself primitive against primitive, and counts non-finite
     attribute values while it is there. */
  const cape = await page.evaluate(async () => {
    const P = await import('/js/predictor.js'); let g = null;
    P.predLine.parent.traverse(o => { if (o.name === 'cape') g = o; });
    return g ? g.userData.audit() : null;
  });
  const capeOk = cape && cape.coplanar === 0 && cape.nonFinite === 0;
  console.log(`${capeOk ? 'ok  ' : 'FAIL'} cape: ${cape ? `${cape.triangles} triangles, coplanar pairs ${cape.coplanar}, non-finite ${cape.nonFinite} ${cape.pairs.join(' ')}` : 'group not found'}`);
  if (!capeOk) fail++;
  await page.close();
}
await browser.close();
console.log(fail ? `flicker-test: ${fail} FAILED` : 'flicker-test: ok');
process.exit(fail ? 1 : 0);
