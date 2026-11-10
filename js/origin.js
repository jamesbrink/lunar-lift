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

/* ...and in the Earth's own axes. Shifting to the eye removed the half-metre steps, but every matrix
   under the planet was still rebuilt each frame from a rotation that had advanced, and an edge of
   sub-pixel steel sitting on a sample boundary could land either side: ~125 pixels of 1.3 million
   still changed on an idle pad (tools/flicker-test.mjs). So the whole scene is also turned back by
   the planet's spin: a thing bolted to the ground gets RotY(−spin)·RotY(+spin) = the same matrix
   every frame, to the last bit that float32 keeps. The camera, the sun and the Moon are children of
   the scene and turn with it, so the picture is unchanged — it is the same view, described in axes
   in which the ground stands still.

   What follows from it:
   - uOrigin is the eye in those turned axes; a shader that adds it gets a planet-centred position
     in the EARTH-FIXED frame. Any inertial direction such a shader uses (the sun) must be turned
     the same way first: frameDir().
   - a matrixWorld read in JavaScript is eye-relative AND turned: absolute() undoes both. */
const Y = new THREE.Vector3(0, 1, 0);
const frameQ = new THREE.Quaternion(), frameQi = new THREE.Quaternion(), _eye = new THREE.Vector3(), _m = new THREE.Matrix4();

export function setOrigin(scene, eye, spin = 0) {
  frameQ.setFromAxisAngle(Y, -spin); frameQi.copy(frameQ).invert();
  _eye.copy(eye);
  uOrigin.value.copy(eye).applyQuaternion(frameQ);
  scene.quaternion.copy(frameQ);
  scene.position.copy(uOrigin.value).negate();
}

/* An inertial direction, in the axes the frame is drawn in. */
export function frameDir(v) { return v.applyQuaternion(frameQ); }

/* A matrixWorld read back in JavaScript, put back into the game's inertial, planet-centred frame. */
export function absolute(matrixWorld, out) {
  out.copy(matrixWorld).premultiply(_m.makeRotationFromQuaternion(frameQi));
  const e = out.elements, o = _eye;       // the rotation moved the translation to R⁻¹·(R·(p − eye)) = p − eye
  e[12] += o.x; e[13] += o.y; e[14] += o.z;
  return out;
}
