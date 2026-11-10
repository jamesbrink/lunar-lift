import { launch, openGame } from './lib/browser.mjs';
const b = await launch(), p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const msgs = []; p.on('console', m => { if (m.type() === 'error') msgs.push(m.text().slice(0, 200)); }); p.on('pageerror', e => msgs.push(e.message));
await openGame(p, 8131);
await p.evaluate(`game.ignite(); game.setSas(true,false); game.ff(20); game.stage(); game.stage(); game.teleport([-6990.925, 403.453, 1913.094], [-0.1714, 4.886861, 9.171734], 4647.7); game.setThrottle(0); game.setSas(false)`);
await p.waitForTimeout(400);
const t0 = Date.now();
for (let k = 0; k < 400; k++) {
  await p.evaluate(`for (let i = 0; i < 16; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))`).catch(() => {});
  await p.keyboard.press(']'); await p.keyboard.press(']'); await p.keyboard.press(']');
  await p.waitForTimeout(250);
  const s = await p.evaluate(`(async () => { const P = await import('/js/physics.js'), C = await import('/js/constants.js'); const s = game.state(); const m = C.moonPos(s.simTime); return { t: Math.round(s.simTime), warp: C.WARPS[P.getWarpIndex()], rM: Math.round(P.S.pos.distanceTo(m)), state: s.state }; })()`);
  if (k % 8 === 0 || s.rM < 66200) console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(s));
  if (s.rM < 66184 || s.state !== 'flying') break;
}
console.log('errors', msgs.slice(0, 3));
await b.close();
