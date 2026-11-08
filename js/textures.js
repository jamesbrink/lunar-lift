import * as THREE from 'three';

/* ---- procedural textures ---- */
export function makeTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping; return t;
}

export function earthTex() {
  return makeTexture(2048, 1024, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#123c66'); grd.addColorStop(.5, '#0e5f8a'); grd.addColorStop(1, '#123c66');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 46; i++) {                       // continents as clustered blobs
      const cx = Math.random() * w, cy = h * .12 + Math.random() * h * .76;
      const n = 12 + (Math.random() * 20) | 0, R = 26 + Math.random() * 90;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * 6.283, d = Math.pow(Math.random(), .6) * R;
        const x = cx + Math.cos(a) * d * 1.7, y = cy + Math.sin(a) * d;
        const green = 60 + Math.random() * 70 | 0;
        g.fillStyle = Math.random() < .75 ? `rgb(${40 + Math.random() * 40 | 0},${green},${35 + Math.random() * 30 | 0})`
                                          : `rgb(${120 + Math.random() * 40 | 0},${100 + Math.random() * 30 | 0},60)`;
        g.beginPath(); g.arc(((x % w) + w) % w, Math.min(h - 4, Math.max(4, y)), 8 + Math.random() * 34, 0, 6.283); g.fill();
      }
    }
    g.fillStyle = 'rgba(240,248,255,.9)'; g.fillRect(0, 0, w, 46); g.fillRect(0, h - 46, w, 46);  // ice caps
  });
}

export function cloudTex() {
  const t = makeTexture(1024, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 620; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = 6 + Math.random() * 28;
      const a = .05 + Math.random() * .22;
      g.fillStyle = `rgba(255,255,255,${a})`;
      g.beginPath(); g.ellipse(x, y, r * (1.6 + Math.random() * 2), r * .6, 0, 0, 6.283); g.fill();
    }
  });
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function moonTex() {
  return makeTexture(2048, 1024, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#a8a8ad'); grd.addColorStop(.5, '#b6b6bb'); grd.addColorStop(1, '#9c9ca2');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {                        // maria
      const x = Math.random() * w, y = Math.random() * h, r = 60 + Math.random() * 170;
      g.fillStyle = `rgba(84,84,92,${.25 + Math.random() * .3})`;
      g.beginPath(); g.ellipse(x, y, r, r * (.6 + Math.random() * .5), Math.random() * 6.283, 0, 6.283); g.fill();
    }
    for (let i = 0; i < 520; i++) {                       // craters
      const x = Math.random() * w, y = Math.random() * h, r = 2 + Math.pow(Math.random(), 2.6) * 46;
      g.fillStyle = 'rgba(60,60,68,.55)'; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      g.strokeStyle = 'rgba(235,235,240,.4)'; g.lineWidth = Math.max(1, r * .28);
      g.beginPath(); g.arc(x, y - r * .1, r, 2.6, 5.9); g.stroke();
    }
  });
}

// glowTex is shared by the world (sun flare, pad lamps) and the vehicle (engine glow): cached so both get one texture.
let _glow = null;
export function glowTex() {
  if (!_glow) _glow = makeTexture(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grd.addColorStop(0, 'rgba(255,235,190,1)'); grd.addColorStop(.4, 'rgba(255,170,70,.65)'); grd.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  });
  return _glow;
}
