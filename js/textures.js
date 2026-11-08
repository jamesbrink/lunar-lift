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

let _clouds = null, _cirrus = null;

/* cloudTex: opaque weather map whose luminance IS the cloud density. world.js binds it as both
   map and alphaMap, so density lands directly in the alphaMap channel and alphaTest carves the
   holes that let the deck throw moving shadows on the ground below. Layers, large to fine:
   overcast sheets -> scattered cumulus clusters -> spiral storm systems with cleared eyes. */
export function cloudTex() {
  if (!_clouds) {
    _clouds = makeTexture(1024, 512, (g, w, h) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      const blob = (x, y, r, v, ry) => {                        // soft puff, wraps across the dateline
        if (v <= 0 || r <= 0) return;
        for (const ox of [-w, 0, w]) {
          const cx = x + ox;
          if (cx < -r * 2 || cx > w + r * 2) continue;
          const grd = g.createRadialGradient(cx, y, 0, cx, y, r);
          grd.addColorStop(0, `rgba(255,255,255,${v})`);
          grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd;
          g.save(); g.translate(cx, y); g.scale(1, ry === undefined ? 1 : ry);
          g.beginPath(); g.arc(0, 0, r, 0, 6.283); g.fill(); g.restore();
        }
      };
      for (let s = 0; s < 15; s++) {                            // overcast sheets: dim overlapping platters
        const cx = Math.random() * w, cy = h * (.18 + Math.random() * .64), v = .3 + Math.random() * .14;
        for (let k = 0; k < 11; k++)
          blob(cx + (Math.random() - .5) * 240, cy + (Math.random() - .5) * 90, 50 + Math.random() * 90, v, 1);
      }
      for (let c = 0; c < 34; c++) {                            // fair-weather cumulus clusters
        const cx = Math.random() * w, cy = h * (.15 + Math.random() * .7);
        const n = 12 + (Math.random() * 16) | 0;
        for (let k = 0; k < n; k++)
          blob(cx + (Math.random() - .5) * 90, cy + (Math.random() - .5) * 34, 6 + Math.random() * 14, .52 + Math.random() * .26, .8);
      }
      for (let s = 0; s < 2; s++) {                             // spiral storm systems
        const cx = Math.random() * w, cy = h * (.3 + Math.random() * .4), spin = Math.random() < .5 ? 1 : -1;
        for (const arm of [0, 1, 2]) {
          for (let t = 0; t < 1; t += .012) {                   // three logarithmic arms, denser inward
            const th = arm * 2.094 + spin * t * 7.2, r = 12 + 175 * t;
            blob(cx + Math.cos(th) * r, cy + Math.sin(th) * r * .75, 9 + 13 * (1 - t), .6 * (1 - .3 * t), .7);
          }
        }
        blob(cx, cy, 44, .5, .8); blob(cx, cy, 26, .85, .8);    // eyewall ring
        g.globalCompositeOperation = 'destination-out';         // then clear the eye itself
        const eye = g.createRadialGradient(cx, cy, 0, cx, cy, 13);
        eye.addColorStop(0, 'rgba(0,0,0,1)'); eye.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = eye; g.beginPath(); g.arc(cx, cy, 13, 0, 6.283); g.fill();
        g.globalCompositeOperation = 'source-over';
      }
    });
    _clouds.wrapT = THREE.ClampToEdgeWrapping;
  }
  return _clouds;
}

/* cirrusTex: high thin cirrus — broad dim veils plus long wispy zonal streaks. Same
   luminance-is-density convention as cloudTex so it also drives its own alphaMap. */
export function cirrusTex() {
  if (!_cirrus) {
    _cirrus = makeTexture(1024, 512, (g, w, h) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      const blob = (x, y, r, v, ry) => {
        if (v <= 0 || r <= 0) return;
        for (const ox of [-w, 0, w]) {
          const cx = x + ox;
          if (cx < -r * 2 || cx > w + r * 2) continue;
          const grd = g.createRadialGradient(cx, y, 0, cx, y, r);
          grd.addColorStop(0, `rgba(255,255,255,${v})`);
          grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd;
          g.save(); g.translate(cx, y); g.scale(1, ry === undefined ? 1 : ry);
          g.beginPath(); g.arc(0, 0, r, 0, 6.283); g.fill(); g.restore();
        }
      };
      for (let v = 0; v < 9; v++)                               // cirrostratus veils
        blob(Math.random() * w, h * (.2 + Math.random() * .6), 150 + Math.random() * 110, .16 + Math.random() * .08, .75);
      for (let i = 0; i < 130; i++) {                           // wispy streaks, mostly zonal
        const x0 = Math.random() * w, y0 = h * (.12 + Math.random() * .76);
        const ang = (Math.random() - .5) * .7, len = 80 + Math.random() * 320, wid = 3 + Math.random() * 9;
        const steps = Math.max(6, (len / 10) | 0);
        for (let k = 0; k <= steps; k++) {
          const t = k / steps, bend = Math.sin(t * 3.2 + i) * .22;
          const x = x0 + Math.cos(ang + bend) * len * t, y = y0 + Math.sin(ang + bend) * len * t * .6;
          blob(x, y, wid * (1.15 - Math.abs(t - .4) * 1.1), .62 + .3 * (1 - Math.abs(t - .4) * 1.5), .55);
        }
      }
    });
    _cirrus.wrapT = THREE.ClampToEdgeWrapping;
  }
  return _cirrus;
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
