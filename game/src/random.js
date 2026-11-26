// A small deterministic random source (mulberry32). The world is built from a fixed seed
// so the valley, the town and the forests are identical on every run and in every
// screenshot; gameplay scatter that should vary takes its own seed.

/** Create a generator: call it for a float in [0, 1), .range for a span, .pick for a list. */
export function createRandom(seed) {
  let state = seed >>> 0;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  next.range = (from, to) => from + next() * (to - from);
  next.int = (from, to) => Math.floor(next.range(from, to + 1));
  next.pick = (list) => list[Math.floor(next() * list.length) % list.length];
  return next;
}

/** Smooth value-noise field from a seeded lattice: the rolling shape of the hills. */
export function createNoise2D(random, cell) {
  const grid = new Map();
  function lattice(ix, iz) {
    const key = ix * 1000003 + iz;
    if (!grid.has(key)) {
      // Hash the lattice point from the seed grid so the field is stable and tile-free.
      let h = (ix * 374761393 + iz * 668265263 + cell * 974634211) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      grid.set(key, ((h ^ (h >>> 16)) >>> 0) / 4294967296);
    }
    return grid.get(key);
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  void random; // the lattice is hashed from the cell size; the seed stream stays untouched
  return function noise(x, z) {
    const fx = x / cell;
    const fz = z / cell;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = smooth(fx - ix);
    const tz = smooth(fz - iz);
    const a = lattice(ix, iz);
    const b = lattice(ix + 1, iz);
    const c = lattice(ix, iz + 1);
    const d = lattice(ix + 1, iz + 1);
    return (a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz) * 2 - 1;
  };
}

/**
 * Layered noise: a few octaves of value noise summed, for hills that have both a broad
 * shape and a rough edge. Returns a field in roughly [-1, 1].
 */
export function createFbm2D(seedRandom, baseCell, octaves) {
  const layers = [];
  let cell = baseCell;
  let weight = 1;
  let total = 0;
  for (let i = 0; i < octaves; i += 1) {
    layers.push({ noise: createNoise2D(seedRandom, cell), weight });
    total += weight;
    cell /= 2;
    weight /= 2;
  }
  return function fbm(x, z) {
    let sum = 0;
    for (const layer of layers) sum += layer.noise(x, z) * layer.weight;
    return sum / total;
  };
}
