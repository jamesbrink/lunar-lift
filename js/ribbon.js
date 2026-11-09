import * as THREE from 'three';

/* Screen-space ribbon lines. THREE.Line is hard-capped at 1 px and world-space thickness is
   hopeless in this scene (0.001 km off a pad to 3,000,000 km in cislunar space), so the band is
   extruded in the VERTEX shader: two vertices per path point (aSide -1/+1) pushed apart in
   clip space by widthPx/2 pixels. Pixels-to-NDC is exactly 2/resolution and the multiply by
   clip.w keeps the width constant in pixels at any depth — no world units involved.
   One geometry shared by two passes: a ~3 px normal-blended core and an ~11 px additive halo
   whose alpha falls off toward its own edge, so it reads as light bleed rather than a fat
   stripe. The logdepthbuf chunks appear in both shader stages; without them the ribbon lands at
   linear depth and sinks behind the planet in this logarithmic-depth scene.
   The resolution uniform mirrors renderer.setPixelRatio(Math.min(devicePixelRatio, 2)) +
   innerWidth/innerHeight and tracks resize events; call setResolution() if you draw elsewhere.
   Usage (handle IS a THREE.Group — scene.add(handle) directly):
     const r = ribbon({ color, widthPx, glowWidthPx, glowColor, vertexColors });
     r.setPoints(pts, n?)   pts: Float32Array [x,y,z,...] | THREE.Vector3[] | [x,y,z][]
     r.setColors(cols, n?)  cols: Float32Array [r,g,b,...] | THREE.Color[]
     r.setAlphas(a, n?)     a: Float32Array, one opacity per point (default 1 everywhere)
     r.setColorAt(i, c)     c: THREE.Color | hex — colours point i
     r.clear()              hide everything (drawRange 0)
     r.visible              Object3D flag, works as expected
     r.material             the core ShaderMaterial; .opacity is live (both passes also via
     r.setOpacity(o, glowO?))
     r.count                current point count                                            */

const VERT = `
#include <common> // logdepthbuf_vertex calls isPerspectiveMatrix; ShaderMaterial omits it
attribute vec3 aDir;
attribute float aSide;
attribute vec3 aColor;
attribute float aAlpha;
uniform vec2 uResolution;
uniform float uWidthPx;
uniform vec3 uColor;
varying float vSide;
varying vec3 vCol;
varying float vAlpha;
#include <logdepthbuf_pars_vertex>

void main() {
  vSide = aSide;
  vAlpha = aAlpha;
  #ifdef USE_VCOLOR
    vCol = aColor;
  #else
    vCol = uColor;
  #endif
  vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  vec3 dirV = normalize( ( modelViewMatrix * vec4( aDir, 0.0 ) ).xyz );
  vec2 t = ( projectionMatrix * vec4( dirV, 0.0 ) ).xy;
  vec2 nrm = vec2( -t.y, t.x );
  float nl = length( nrm );
  // Looking straight down the path: the projected tangent collapses; any perpendicular will do.
  nrm = nl > 1e-7 ? nrm / nl : vec2( 1.0, 0.0 );
  clip.xy += nrm * ( uWidthPx / uResolution ) * aSide * clip.w;
  gl_Position = clip;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = `
varying float vSide;
varying vec3 vCol;
varying float vAlpha;
uniform float uOpacity;
#include <logdepthbuf_pars_fragment>

void main() {
  #ifdef GLOW
    float e = 1.0 - abs( vSide );
    gl_FragColor = vec4( vCol, pow( e, 2.2 ) * uOpacity * vAlpha );
  #else
    // a one-pixel feather on the core's own edge: a hard-edged 2 px band crawls as it moves
    gl_FragColor = vec4( vCol, uOpacity * vAlpha * smoothstep( 0.0, 0.45, 1.0 - abs( vSide ) ) );
  #endif
  #include <logdepthbuf_fragment>
}
`;

export function ribbon(
  { color = 0xffffff, widthPx = 3, glowWidthPx = 11, glowColor = null, vertexColors = false,
    opacity = 0.95, glowOpacity = 0.5, capacity = 4096 } = {},
) {
  // Fixed capacity, refilled in place: the prediction tick reruns several times a second and a
  // fresh BufferGeometry every time would stutter the GC.
  const pos = new Float32Array(capacity * 6);  // each point duplicated for its side -1/+1 vertices
  const dir = new Float32Array(capacity * 6);
  const col = new Float32Array(capacity * 6);
  const alpha = new Float32Array(capacity * 2).fill(1);   // per point; 1 unless setAlphas says otherwise
  const side = new Float32Array(capacity * 2);
  for (let i = 0; i < capacity; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
  const index = new (capacity * 2 - 1 > 65535 ? Uint32Array : Uint16Array)((capacity - 1) * 6);
  for (let i = 0, v = 0; i < capacity - 1; i++, v += 6) {
    const a = i * 2;
    index[v] = a; index[v + 1] = a + 1; index[v + 2] = a + 2;
    index[v + 3] = a + 1; index[v + 4] = a + 3; index[v + 5] = a + 2;
  }
  const geom = new THREE.BufferGeometry();
  const posA = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const dirA = new THREE.BufferAttribute(dir, 3).setUsage(THREE.DynamicDrawUsage);
  const colA = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posA);
  geom.setAttribute('aDir', dirA);
  geom.setAttribute('aColor', colA);
  const alphaA = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aAlpha', alphaA);
  geom.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  geom.setDrawRange(0, 0);

  const uRes = { value: new THREE.Vector2(1, 1) };
  const tint = new THREE.Color(color);
  const tintGlow = new THREE.Color(glowColor ?? color);
  const glowTied = glowColor == null; // glow re-tints with setColor unless it was given its own

  function mkMat(w, blending, alpha, glow) {
    const uOpacity = { value: alpha };
    const m = new THREE.ShaderMaterial({
      uniforms: { uResolution: uRes, uWidthPx: { value: w }, uColor: { value: glow ? tintGlow : tint }, uOpacity },
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: { ...(glow ? { GLOW: '' } : {}), ...(vertexColors ? { USE_VCOLOR: '' } : {}) },
      transparent: true, depthWrite: false, depthTest: true,
      blending, side: THREE.DoubleSide, // which screen side aSide lands on flips with path direction
    });
    // ShaderMaterial.opacity is inert on its own; wire it so `handle.material.opacity = x` works.
    Object.defineProperty(m, 'opacity', { get: () => uOpacity.value, set: v => { uOpacity.value = v; } });
    return m;
  }
  const glowMat = mkMat(glowWidthPx, THREE.AdditiveBlending, glowOpacity, true);
  const coreMat = mkMat(widthPx, THREE.NormalBlending, opacity, false);

  const glow = new THREE.Mesh(geom, glowMat);
  const core = new THREE.Mesh(geom, coreMat);
  glow.renderOrder = 5; core.renderOrder = 6; // core last so it stays bright above the halo
  glow.frustumCulled = core.frustumCulled = false; // drawRange moves; the bounding sphere never does

  const group = new THREE.Group();
  group.add(glow, core);
  group.object3D = group; // symmetry for code written against a { object3D }-style handle

  let count = 0;
  const applyRange = () => geom.setDrawRange(0, count > 1 ? (count - 1) * 6 : 0);

  Object.defineProperty(group, 'material', { get: () => coreMat });
  Object.defineProperty(group, 'glowMaterial', { get: () => glowMat });
  Object.defineProperty(group, 'count', { get: () => count });

  group.setPoints = (src, n) => {
    const flat = src.BYTES_PER_ELEMENT !== undefined || typeof src[0] === 'number';
    const total = flat ? Math.floor(src.length / 3) : src.length;
    const m = Math.min(n === undefined ? total : n, total, capacity);
    for (let i = 0; i < m; i++) {
      let x, y, z;
      if (flat) { x = src[i * 3]; y = src[i * 3 + 1]; z = src[i * 3 + 2]; }
      else if (src[i].isVector3) { x = src[i].x; y = src[i].y; z = src[i].z; }
      else { const a = src[i]; x = a[0]; y = a[1]; z = a[2]; }
      const o = i * 6;
      pos[o] = pos[o + 3] = x; pos[o + 1] = pos[o + 4] = y; pos[o + 2] = pos[o + 5] = z;
    }
    // Centre-differenced tangents: per-segment normals would notch the band at every joint on a
    // curved orbit. A degenerate run (the doubled impact marker point) inherits the last good dir.
    let lx = 0, ly = 0, lz = 1;
    for (let i = 0; i < m; i++) {
      const a = (i > 0 ? i - 1 : i) * 6, b = (i < m - 1 ? i + 1 : i) * 6;
      let dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l > 1e-9) { dx /= l; dy /= l; dz /= l; lx = dx; ly = dy; lz = dz; }
      const o = i * 6;
      dir[o] = dir[o + 3] = lx; dir[o + 1] = dir[o + 4] = ly; dir[o + 2] = dir[o + 5] = lz;
    }
    count = m;
    posA.needsUpdate = dirA.needsUpdate = true;
    applyRange();
  };

  group.setColors = (src, n) => {
    const flat = src.BYTES_PER_ELEMENT !== undefined || typeof src[0] === 'number';
    const total = flat ? Math.floor(src.length / 3) : src.length;
    const m = Math.min(n === undefined ? total : n, total, capacity);
    for (let i = 0; i < m; i++) {
      let r, g, b;
      if (flat) { r = src[i * 3]; g = src[i * 3 + 1]; b = src[i * 3 + 2]; }
      else { const c = src[i]; r = c.r; g = c.g; b = c.b; }
      const o = i * 6;
      col[o] = col[o + 3] = r; col[o + 1] = col[o + 4] = g; col[o + 2] = col[o + 5] = b;
    }
    colA.needsUpdate = true;
  };

  group.setAlphas = (src, n) => {
    const m = Math.min(n === undefined ? src.length : n, src.length, capacity);
    for (let i = 0; i < m; i++) alpha[i * 2] = alpha[i * 2 + 1] = src[i];
    alphaA.needsUpdate = true;
  };

  group.setColorAt = (i, c) => {
    if (i < 0 || i >= capacity) return;
    const o = i * 6;
    col[o] = col[o + 3] = c.r; col[o + 1] = col[o + 4] = c.g; col[o + 2] = col[o + 5] = c.b;
    colA.needsUpdate = true;
  };

  group.setColor = c => { tint.set(c); if (glowTied) tintGlow.set(c); };
  group.setOpacity = (o, glowO = o) => { coreMat.opacity = o; glowMat.opacity = glowO; };
  group.clear = () => { count = 0; applyRange(); };
  group.setResolution = (w, h) => uRes.value.set(w, h);

  const syncRes = () => uRes.value.set(innerWidth, innerHeight).multiplyScalar(Math.min(devicePixelRatio || 1, 2));
  if (typeof window !== 'undefined') { syncRes(); window.addEventListener('resize', syncRes); }

  return group;
}
