/* ---------------- audio (simple, procedural) ---------------- */
let AC = null, out = null, engGain = null, engSrc = null, windSrc = null, windBand = null, windGain = null;

/* Mute is one gain on the way out, remembered between visits (a per-viewer convenience: the game
   plays the same without storage). */
let muted = false;
try { muted = localStorage.getItem('lunarlift.muted') === '1'; } catch (e) { /* private window: not remembered */ }
export const isMuted = () => muted;
export function toggleMute() {
  muted = !muted;
  if (out) out.gain.setTargetAtTime(muted ? 0 : 1, AC.currentTime, 0.02);
  try { localStorage.setItem('lunarlift.muted', muted ? '1' : '0'); } catch (e) { /* see above */ }
  return muted;
}

export function audioInit() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    out = AC.createGain(); out.gain.value = muted ? 0 : 1; out.connect(AC.destination);     // everything goes through here: N mutes it
    const len = AC.sampleRate * 2, buf = AC.createBuffer(1, len, AC.sampleRate), ch = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; ch[i] = last * 3.2; }
    engSrc = AC.createBufferSource(); engSrc.buffer = buf; engSrc.loop = true;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
    engGain = AC.createGain(); engGain.gain.value = 0;
    engSrc.connect(lp).connect(engGain).connect(out); engSrc.start();
    /* Wind: the same noise through a band that opens with dynamic pressure. It is the sound of
       speed through air, and its absence is the sound of having left the air behind. */
    windSrc = AC.createBufferSource(); windSrc.buffer = buf; windSrc.loop = true; windSrc.playbackRate.value = 2.3;
    windBand = AC.createBiquadFilter(); windBand.type = 'bandpass'; windBand.frequency.value = 400; windBand.Q.value = 0.6;
    windGain = AC.createGain(); windGain.gain.value = 0;
    windSrc.connect(windBand).connect(windGain).connect(out); windSrc.start();
  } catch (e) { /* audio optional */ }
}

export function audioEngine(on) { if (!AC || !engGain) return; engGain.gain.setTargetAtTime(on ? .12 : 0, AC.currentTime, .08); }

export function audioThud() {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'square'; o.frequency.setValueAtTime(70, AC.currentTime); o.frequency.exponentialRampToValueAtTime(28, AC.currentTime + .25);
  g.gain.setValueAtTime(.25, AC.currentTime); g.gain.exponentialRampToValueAtTime(.001, AC.currentTime + .3);
  o.connect(g).connect(out); o.start(); o.stop(AC.currentTime + .32);
}

export function audioExplosion() {
  if (!AC) return;
  audioEngine(false);
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(160, AC.currentTime); o.frequency.exponentialRampToValueAtTime(30, AC.currentTime + 1.1);
  g.gain.setValueAtTime(.5, AC.currentTime); g.gain.exponentialRampToValueAtTime(.001, AC.currentTime + 1.2);
  o.connect(g).connect(out); o.start(); o.stop(AC.currentTime + 1.25);
}

export function audioWin() {
  if (!AC) return; audioEngine(false);
  [261.6, 329.6, 392, 523.2].forEach((f, i) => {
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    const t0 = AC.currentTime + i * .12;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.18, t0 + .05); g.gain.exponentialRampToValueAtTime(.001, t0 + 1.4);
    o.connect(g).connect(out); o.start(t0); o.stop(t0 + 1.5);
  });
}

/* What the air carries. `rho` is density over sea-level density, `q` dynamic pressure normalised to
   max-Q. The engine is loudest on the pad and falls to a structure-borne murmur in vacuum; the wind
   rises to max-Q and is silent by the time the sky is black. */
export function updateAudio({ burning, throttle, rho, q }) {
  if (!AC || !engGain) return;
  engGain.gain.setTargetAtTime(burning ? 0.05 + 0.3 * throttle * (0.2 + 0.8 * Math.sqrt(rho)) : 0, AC.currentTime, .05);
  windGain.gain.setTargetAtTime(0.26 * q, AC.currentTime, .12);
  windBand.frequency.setTargetAtTime(350 + 1300 * q, AC.currentTime, .2);
}
