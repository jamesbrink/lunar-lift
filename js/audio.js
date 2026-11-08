/* ---------------- audio (simple, procedural) ---------------- */
let AC = null, engGain = null, engSrc = null;

export function audioInit() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    const len = AC.sampleRate * 2, buf = AC.createBuffer(1, len, AC.sampleRate), ch = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; ch[i] = last * 3.2; }
    engSrc = AC.createBufferSource(); engSrc.buffer = buf; engSrc.loop = true;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
    engGain = AC.createGain(); engGain.gain.value = 0;
    engSrc.connect(lp).connect(engGain).connect(AC.destination); engSrc.start();
  } catch (e) { /* audio optional */ }
}

export function audioEngine(on) { if (AC) engGain.gain.setTargetAtTime(on ? .12 : 0, AC.currentTime, .08); }

export function audioThud() {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'square'; o.frequency.setValueAtTime(70, AC.currentTime); o.frequency.exponentialRampToValueAtTime(28, AC.currentTime + .25);
  g.gain.setValueAtTime(.25, AC.currentTime); g.gain.exponentialRampToValueAtTime(.001, AC.currentTime + .3);
  o.connect(g).connect(AC.destination); o.start(); o.stop(AC.currentTime + .32);
}

export function audioExplosion() {
  if (!AC) return;
  audioEngine(false);
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(160, AC.currentTime); o.frequency.exponentialRampToValueAtTime(30, AC.currentTime + 1.1);
  g.gain.setValueAtTime(.5, AC.currentTime); g.gain.exponentialRampToValueAtTime(.001, AC.currentTime + 1.2);
  o.connect(g).connect(AC.destination); o.start(); o.stop(AC.currentTime + 1.25);
}

export function audioWin() {
  if (!AC) return; audioEngine(false);
  [261.6, 329.6, 392, 523.2].forEach((f, i) => {
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    const t0 = AC.currentTime + i * .12;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.18, t0 + .05); g.gain.exponentialRampToValueAtTime(.001, t0 + 1.4);
    o.connect(g).connect(AC.destination); o.start(t0); o.stop(t0 + 1.5);
  });
}

/* engine loudness fades with altitude — the atmosphere carries the rumble */
export function updateEngineGain(burning, alt) {
  if (AC && engGain) {
    engGain.gain.setTargetAtTime(burning ? .1 + .22 * Math.exp(-alt / 240) : 0, AC.currentTime, .05);
  }
}
