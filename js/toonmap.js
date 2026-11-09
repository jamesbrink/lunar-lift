import * as THREE from 'three';
import { boxBlurRGBA, sampleGrid } from './paintkit.js';
import { paintEarthJob } from './earthpaint.js';
import { paintMoonJob } from './moonpaint.js';

export { sampleGrid } from './paintkit.js';
export { moonPatchDetail } from './moonpaint.js';
export { padWeight, padShoreWeight, padAuthored, padShoreSd, padShoreZone, shoreDistance, fineEarth } from './padsite.js';

/* The planets are painted, not photographed.

   The shipped blue-marble JPEG is 2 048 × 1 024 of real satellite data, which is about 20 km per
   pixel: stretched over a sphere and seen from orbit it is a soft mud-coloured smear, and under a
   three-band cel ramp it gets worse, because the ramp quantises mush into more mush. Repainting the
   photo's own pixels does not help — that only posterises the mud.

   So the photo is used as *data* and never as a picture. The specular sheet is the useful one: it is
   a binary map of the world, ocean white and land black with almost nothing in between, so a
   threshold gives a clean land mask, and a majority filter over it gives crisp coastlines. From that
   mask every pixel of the visible map is authored colour — deep ocean, a shallow shelf band hugging
   the coast, a coastline stroke, and land sorted into ice, desert, forest, grass and rock by the
   diffuse sheet's hue and brightness plus latitude. The geography is still the real geography; the
   palette is a cartographer's, which is what cel shading wants.

   The decoded sheets yield one more thing: a height field per body, built by the same pass so the
   relief never costs a second decode. Painted colour on perfect spheres reads as a flat disc from
   orbit — a dead horizon and nothing moving under the terminator — so the fields displace the mesh
   vertices (js/world.js) and are differenced into tangent-space normal maps; see the relief section
   below the painting code. */

const loaded = new Map();

/* The Earth's painted map: 2 048 × 1 024, one output pixel per source texel. The height field and
   the signed coastline hang off the same decode: one paint job, several products. */
export function paintEarth(diffusePath, maskPath) {
  const job = paintEarthJob(diffusePath, maskPath);
  if (!fields.has('earth')) {
    fields.set('earth', job.then((r) => r.field));
    coasts.set('earth', job.then((r) => r.coast));
    job.then((r) => softOf.set('earth', r.soft));
  }
  registerCanvas('earth', job);
  return job.then((r) => r.canvas);
}

/* The Moon is regolith with no hue worth keeping, so the painting is about contrast: box-blur away
   the JPEG's ringing, then snap to four flat tones. The dark patches become the maria and the bright
   spots the highlands and ray systems, which is exactly how a cartoon Moon is drawn. */
export function paintMoon(path) {
  const job = paintMoonJob(path);
  if (!fields.has('moon')) fields.set('moon', job.then((r) => r.field));
  registerCanvas('moon', job);
  return job.then((r) => r.canvas);
}

/* ---------------- relief ----------------

   A painted sphere with no shape reads as a flat disc from orbit: a dead horizon and nothing moving
   under the terminator. Every paint pass therefore yields a height field too, consumed at two levels
   of detail: the far level displaces the body's mesh vertices (applyRelief, used by js/world.js),
   and the near level is a dense patch js/terrain.js lays over the ground under the vehicle. Both
   levels call the SAME functions below — the patch is the global field with extra octaves on top,
   faded out at its border — so they cannot disagree, which is the seam requirement.

   Everything is seeded lattice noise, hashed distance transforms and authored geometry: no
   Math.random anywhere, so the geology is identical every run and the mesh, the normal map, the
   patch and js/camera.js's colliders are all views of one field.

   Amplitudes are bounded for landing honesty: physics touches down on the exact spheres RE / RM, so
   the Moon's upward displacement is capped near 1.5 km and drama beyond that comes from the normal
   map, not from geometry the lander would sink into. The launch-pad neighbourhood is flattened to
   exactly zero (padWeight) because the pad mesh is welded to the Earth mesh at PAD_UP. */


const fields = new Map();                  // key → Promise<{w,h,km}>      heights in km
const coasts = new Map();                  // key → Promise<{w,h,km}>      signed shore distance in km
const canvases = new Map();                // key → Promise<HTMLCanvasElement>
const softOf = new Map();                  // key → Uint8ClampedArray, blurred at paint time
const softPx = new Map();                  // key → Promise<ImageData> of the blurred copy
const painted = new Map();                 // key → canvas, once landed (paintedCanvas)
const pixelsOf = new Map();                // key → Promise<ImageData>     raw authored pixels

function registerCanvas(key, job) {
  if (canvases.has(key)) return;
  canvases.set(key, job.then((r) => r.canvas));
  job.then((r) => painted.set(key, r.canvas));
}

/* The painted canvas itself, for anything that must author from the same pixels as the texture —
   the orbital map reads it through js/world.js:planetCanvas rather than kicking off a second paint. */
export function paintedCanvas(key) { return painted.get(key) || null; }

export function reliefField(key) { return fields.get(key) || null; }
export function coastField() { return coasts.get('earth') || null; }

/* Raw ImageData of the painted map, extracted once per body: the near patch colours itself from
   exactly these bytes so a biome on the ground is the biome the orbit showed. getImageData is the
   one unavoidable readback; it costs ~10 ms and happens once per body off the paint promise. */
/* A blurred copy of the paint, for the GROUND to sample instead of the crisp map. The map is
   classified on a ~20 km grid: perfect when it is wrapped around a 40 000 km sphere, wrong under a
   vehicle, where a hundred kilometres of grass meeting a hundred kilometres of forest at a hard edge
   reads as cut-out rectangles rather than landscape. Averaging seven texels keeps every biome where it
   is and turns each border into the soft transition a real landscape has. Averaging is done over LAND
   ONLY: an ordinary blur would drag the navy of the sea 140 km inland and tint the coastal plain blue.
   The orbit keeps the crisp canvas; only js/terrain.js reads this. */
export function canvasDataSoft(key) {
  if (!softPx.has(key)) {
    softPx.set(key, Promise.all([canvasData(key), softOf.has(key) ? softOf.get(key) : null])
      .then(([src, pre]) => {
        const out = new ImageData(src.width, src.height);
        if (pre) out.data.set(pre);
        else boxBlurRGBA(src.data, out.data, src.width, src.height, 3);
        return out;
      }));
  }
  return softPx.get(key);
}

export function canvasData(key) {
  if (!pixelsOf.has(key)) {
    pixelsOf.set(key, canvases.get(key).then((cv) =>
      cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height)));
  }
  return pixelsOf.get(key);
}

/* ---- far level: displace the mesh itself ---- */

export function applyRelief(geometry, key) {
  const f = reliefField(key);
  if (!f) return Promise.reject(new Error('applyRelief: paint ' + key + ' first'));
  return f.then((g) => {
    const pos = geometry.attributes.position, uvs = geometry.attributes.uv;
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const h = sampleGrid(g, uvs.getX(i), uvs.getY(i));
      if (h === 0) continue;
      n.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      pos.setXYZ(i, pos.getX(i) + n.x * h, pos.getY(i) + n.y * h, pos.getZ(i) + n.z * h);
    }
    geometry.computeVertexNormals();
    weldSeamNormals(geometry);
    pos.needsUpdate = true;
    geometry.computeBoundingSphere();
  });
}

/* computeVertexNormals leaves a crease at the dateline: three's sphere duplicates the u=0/u=1
   column and each copy only ever averages faces on one side, so the two copies of the same vertex
   shade differently and the seam shows against the sky. Average them into agreement. */
function weldSeamNormals(geometry) {
  const p = geometry.parameters;
  if (!p) return;
  const cols = p.widthSegments + 1, rows = p.heightSegments + 1;
  const nrm = geometry.attributes.normal;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let y = 0; y < rows; y++) {
    const i0 = y * cols, i1 = i0 + cols - 1;
    a.fromBufferAttribute(nrm, i0);
    b.fromBufferAttribute(nrm, i1);
    a.add(b).normalize();
    nrm.setXYZ(i0, a.x, a.y, a.z);
    nrm.setXYZ(i1, a.x, a.y, a.z);
  }
}

/* A texture now, the real paint later. The placeholder canvas MUST already be the size the paint
   will be, because WebGL2 gives a canvas texture immutable storage (texStorage2D) at its first
   upload size: a 2×2 placeholder makes every later texSubImage2D of the 2048×1024 canvas a silent
   GL error, and the body then samples one ocean-blue texel forever — flat continents-looking-blue
   from orbit while the painted canvas itself is perfect. Copy into the existing surface instead of
   swapping the image. */
export function paintedTexture(promise, key, w, h) {
  let t = loaded.get(key);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#1c4a8c';
  cx.fillRect(0, 0, w, h);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  loaded.set(key, t);
  promise.then((painted) => {
    cx.clearRect(0, 0, w, h);
    cx.drawImage(painted, 0, 0, w, h);   // scaled only if an asset arrives at an unexpected size
    t.needsUpdate = true;
  });
  return t;
}
