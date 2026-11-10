import * as THREE from 'three';

/* Floating origin. The game's coordinates are kilometres from the centre of the Earth, and the GPU
   works in 32-bit floats: at 6 371 km a float steps in 0.49 m. The pad moves 409 m/s through this
   frame with the planet's spin, so every world-space quantity a shader computed — above all the
   shadow coordinate three derives from modelMatrix × position — landed on a different half-metre
   step each frame, and every shadow edge on the tower, the deck and the ground crawled while the
   rocket sat still (measured idle on the pad: 9 561 pixels changing frame to frame).

   So the scene is drawn from where the eye is. Each frame, just before rendering, the scene's own
   position is set to minus the camera's: object positions stay absolute in JavaScript (doubles),
   but every matrix three uploads is now relative to the eye, where floats are fine. The camera is
   a child of the scene so it takes the same shift.

   The few shaders that need a planet-centred position add uOrigin back: the answer is as coarse as
   it ever was, but it is only used for things kilometres across (cloud fields, haze, the limb). */
export const uOrigin = { value: new THREE.Vector3() };

export function setOrigin(scene, eye) {
  uOrigin.value.copy(eye);
  scene.position.copy(eye).negate();
}

/* A matrixWorld read back in JavaScript is eye-relative; this puts the planet back under it. */
export function absolute(matrixWorld, out) {
  out.copy(matrixWorld);
  out.elements[12] += uOrigin.value.x; out.elements[13] += uOrigin.value.y; out.elements[14] += uOrigin.value.z;
  return out;
}
