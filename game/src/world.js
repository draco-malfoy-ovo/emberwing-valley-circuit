// Emberwing — Valley Circuit: the world itself. A seeded heightfield valley with a
// river, an airfield plateau with one runway, the ring circuit, and the scenery
// (forest, a village, clouds) placed once from the seed and never changed.
import { CIRCUIT, FIELD, WATER_LEVEL, WORLD_HALF, WORLD_SEED } from './config.js';
import { createFbm2D, createRandom } from './random.js';

/** Grid the analytic terrain is baked into: 25 m cells across the whole world. */
const GRID_N = 257;
const GRID_STEP = (WORLD_HALF * 2) / (GRID_N - 1);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Smooth 0..1 ramp between two edges, for blending terrain features. */
const ramp = (v, from, to) => {
  const t = clamp((v - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
};

/** The river's centre line: it wanders down the valley as z runs north. */
function riverCentreX(z) {
  return 420 * Math.sin(z * 0.00055) + 260 * Math.sin(z * 0.0016 + 1.3);
}

/**
 * Build the world from the seed. Everything the game and the screenshots need is
 * decided here: terrain heights, the ring circuit with each ring's facing, and the
 * scenery lists the renderer walks.
 */
export function createWorld(seed = WORLD_SEED) {
  const random = createRandom(seed);
  const hills = createFbm2D(random, 1150, 4);
  const detail = createFbm2D(random, 260, 3);

  /** The raw terrain height before the airfield is flattened into it. */
  function analyticHeight(x, z) {
    const distRiver = Math.abs(x - riverCentreX(z));
    const valley = Math.exp(-((distRiver / 780) ** 2)); // 1 in the river, 0 on the hills
    let h = 118 + hills(x, z) * 235 * (1 - valley * 0.82) + detail(x, z) * 26;
    h = lerp(h, WATER_LEVEL - 5, valley * 0.88); // the river bed sits under the water
    // Rim mountains close the valley in: past 2.3 km from the centre the ground climbs.
    const rim = ramp(Math.max(Math.abs(x), Math.abs(z)), 2300, 3150);
    h += rim * (430 + hills(x * 0.6, z * 0.6) * 160);
    // The airfield plateau: a broad smooth shelf the runway strip sits on.
    const dx = Math.abs(x - FIELD.x) / 430;
    const dz = Math.abs(z - (FIELD.zFrom + FIELD.zTo) / 2) / 980;
    const shelf = 1 - ramp(Math.max(dx, dz), 0.55, 1);
    return lerp(h, FIELD.height, shelf);
  }

  // Bake the heightfield once; the renderer and the flight model both sample it.
  const grid = new Float32Array(GRID_N * GRID_N);
  for (let j = 0; j < GRID_N; j += 1) {
    for (let i = 0; i < GRID_N; i += 1) {
      grid[j * GRID_N + i] = analyticHeight(-WORLD_HALF + i * GRID_STEP, -WORLD_HALF + j * GRID_STEP);
    }
  }

  /** Ground height at a point: exact on the runway, bilinear from the grid elsewhere. */
  function heightAt(x, z) {
    if (Math.abs(x - FIELD.x) <= FIELD.width / 2 && z >= FIELD.zFrom && z <= FIELD.zTo) return FIELD.height;
    const fx = clamp((x + WORLD_HALF) / GRID_STEP, 0, GRID_N - 1.001);
    const fz = clamp((z + WORLD_HALF) / GRID_STEP, 0, GRID_N - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const a = grid[iz * GRID_N + ix];
    const b = grid[iz * GRID_N + ix + 1];
    const c = grid[(iz + 1) * GRID_N + ix];
    const d = grid[(iz + 1) * GRID_N + ix + 1];
    return lerp(lerp(a, b, fx - ix), lerp(c, d, fx - ix), fz - iz);
  }

  /** Outward ground normal, from the heightfield's slope. */
  function groundNormal(x, z) {
    const e = 14;
    const dx = heightAt(x + e, z) - heightAt(x - e, z);
    const dz = heightAt(x, z + e) - heightAt(x, z - e);
    const inv = 1 / Math.hypot(dx, 2 * e, dz);
    return { x: -dx * inv, y: 2 * e * inv, z: -dz * inv };
  }

  // The circuit: fixed gates down the valley and back, each lifted clear of its ground.
  const gatePlan = [
    [-520, 150, 128], [-300, -800, 168], [250, -1600, 188], [950, -2150, 228],
    [1650, -1300, 238], [1550, -100, 218], [950, 900, 178], [-50, 2350, 118],
  ];
  const rings = gatePlan.slice(0, CIRCUIT.rings).map(([x, z, y], i) => {
    const next = gatePlan[Math.min(i + 1, gatePlan.length - 1)];
    const to = i === gatePlan.length - 1 ? { x: FIELD.x, z: FIELD.zTo } : { x: next[0], z: next[1] };
    const dirX = to.x - x;
    const dirZ = to.z - z;
    const len = Math.hypot(dirX, dirZ) || 1;
    return {
      index: i,
      x,
      z,
      y: Math.max(y, heightAt(x, z) + 58),
      dirX: dirX / len, // the way through the ring points along the course
      dirZ: dirZ / len,
    };
  });

  // Forest: conifers where the ground is gentle, dry and clear of the strip.
  const trees = [];
  const treeRandom = createRandom(seed ^ 0x51ab);
  for (let n = 0; n < 2600 && trees.length < 820; n += 1) {
    const x = treeRandom.range(-3050, 3050);
    const z = treeRandom.range(-3050, 3050);
    const h = heightAt(x, z);
    if (h < WATER_LEVEL + 4 || h > 265) continue;
    if (Math.abs(x - FIELD.x) < 190 && z > FIELD.zFrom - 260 && z < FIELD.zTo + 260) continue;
    const slope = 1 - groundNormal(x, z).y;
    if (slope > 0.16) continue;
    trees.push({ x, z, y: h, s: treeRandom.range(0.75, 1.5), shade: treeRandom.range(-0.14, 0.14) });
  }

  // The village: houses east of the strip's south end, and a hangar row by the field.
  const buildings = [];
  const town = createRandom(seed ^ 0x70f1);
  for (let i = 0; i < 30; i += 1) {
    const x = 260 + town.range(-190, 210);
    const z = 2380 + town.range(-170, 190);
    buildings.push({
      x, z, y: heightAt(x, z), w: town.range(11, 20), d: town.range(10, 17),
      h: town.range(6, 13), rot: town.range(-0.4, 0.4), warm: town.range(0, 1),
    });
  }
  for (let i = 0; i < 3; i += 1) {
    const x = FIELD.x + 120;
    const z = 1080 + i * 150;
    buildings.push({ x, z, y: FIELD.height, w: 34, d: 24, h: 9, rot: 0, warm: 0.4, hangar: true });
  }

  // Clouds: flat dawn-lit blobs high over the valley, drifting nowhere (shots stay exact).
  const clouds = [];
  const cloudRandom = createRandom(seed ^ 0xc10d);
  for (let i = 0; i < 16; i += 1) {
    clouds.push({
      x: cloudRandom.range(-3000, 3000),
      z: cloudRandom.range(-3000, 3000),
      y: cloudRandom.range(470, 680),
      r: cloudRandom.range(150, 330),
      shade: cloudRandom.range(-0.05, 0.08),
    });
  }

  return { heightAt, groundNormal, rings, trees, buildings, clouds, waterY: WATER_LEVEL };
}
