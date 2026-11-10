import { uOrigin } from './origin.js';
import * as THREE from 'three';

/* Aerial perspective: how much air sits between the eye and a point on the ground.

   One module owns this because the ground is TWO meshes and they must agree. The streamed near
   patch (js/terrain.js) is small enough to live in three's scene fog; the far globe cannot, because
   FogExp2 is measured from the camera and a system-view camera 20 000 km out would erase the planet
   (see js/world.js). Two surfaces, two laws, and where they met — at the patch's ±220 km rim — the
   colour jumped. Measured at the pad with the chase camera pulled out to 400 km: the sight line to
   the patch's far rim runs 400-600 km, so FogExp2 at density 0.0038 washes it to 90-100 % sky tone
   while the ocean one step beyond the rim, on the globe, stays saturated navy. That quadrilateral
   of pale ground with straight edges around the ship WAS this mismatch, not weather.

   So both ground surfaces carry this one law instead: exp² in TRUE distance (not view-space depth,
   which differs from it at grazing incidence and would reintroduce a seam), driven by the same
   density clock that already thins scene fog as the vehicle climbs, and tinted with the same horizon
   colour the sky and fog share. The pad, the vehicle and the plume keep three's fog — with the same
   density, and nothing near the eye is far enough for the two distance measures to disagree. */

const HAZE_FRAG = /* glsl */`
uniform vec3 hazeCam;
uniform float hazeK;
uniform vec3 hazeColour;

varying vec3 vHazeW;

void airPerspective() {
  float d = length( vHazeW - hazeCam );
  float f = 1.0 - exp( - hazeK * hazeK * d * d );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeColour, f );
}
`;

export function makeHaze() {
  return {
    hazeCam: { value: new THREE.Vector3() },
    hazeK: { value: 0 },                      // 1/km, the same clock as scene.fog.density
    hazeColour: { value: new THREE.Color(0xb2cfe2) },
  };
}

/* Splice the haze into a built-in material's program. It rides on the SAME world-position varying
   pattern as js/clouds.js's ground shade, declared separately so either injection can be applied
   without the other. Inserted after <fog_fragment>, so where three's fog does apply it lands under
   this, and this is the last thing the surface does before toning. */
export function hazeInject(sh, U) {
  for (const key of ['hazeCam', 'hazeK', 'hazeColour']) sh.uniforms[key] = U[key];
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vHazeW;' + (sh.uniforms.uOrigin ? '' : '\nuniform vec3 uOrigin;'))
    .replace('#include <project_vertex>',
      '#include <project_vertex>\n  vHazeW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz + uOrigin;');
  sh.uniforms.uOrigin = uOrigin;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + HAZE_FRAG)
    .replace('#include <fog_fragment>', '#include <fog_fragment>\n  airPerspective();');
}

/* Called from js/world.js's updateSky, which already owns the density clock and the horizon tone. */
export function updateHaze(U, camPos, density, colour) {
  U.hazeCam.value.copy(camPos);
  U.hazeK.value = density;
  U.hazeColour.value.copy(colour);
}
