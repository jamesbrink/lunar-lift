/* The two palettes every painter and both ground shaders share. Bytes are sRGB. */

export const C = {
  deep: [26, 84, 150],
  ocean: [48, 120, 192],
  shelf: [102, 176, 220],
  coast: [14, 40, 66],
  forest: [58, 104, 60],
  grass: [120, 154, 84],
  desert: [212, 184, 120],
  dune: [176, 168, 104],        // dune grass behind the beach line — the seam between sand and field
  rock: [150, 138, 122],
  boreal: [52, 80, 66],
  tundra: [126, 132, 114],
  ice: [233, 241, 246],
  iceEdge: [196, 214, 228],
  concrete: [168, 166, 156],    // LC-39 apron (near level only)
};

/* Daylight regolith, not printer paper (the fact sheet's Bond albedo is 0.11). Measured 2026-11-09
   round 5 against the round-4 commit: under the day ramp the shipped palette (canvas mean 0.836
   sRGB) rendered the near bake at mean 0.834 with 34.2 % of samples above 0.90 and 65.7 % inside
   the top three sixteenths of the histogram — a blown-out white sheet with no headroom left for a
   crater rim to step ABOVE its own ground, so at 9 km the pockmarks were invisible and
   rim-minus-floor measured NEGATIVE at the sub-sun test crater. These bytes put the same canvas —
   the one the far mesh and the near level both read, so they cannot disagree — at mean 0.650 with
   6.5 % above 0.90, and every class keeps its step: 0.074 / 0.087 / 0.138 / 0.059 of sRGB between
   neighbours. */
export const MOON = {
  maria: [94, 98, 108],
  collar: [79, 83, 93],          // the drawn stroke inside a mare border (see mareCollar)
  mid: [130, 133, 142],
  high: [153, 155, 163],
  bright: [172, 174, 182],
};
