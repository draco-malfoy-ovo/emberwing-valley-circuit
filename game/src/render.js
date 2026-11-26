// Emberwing — Valley Circuit: the renderer. A small software 3D engine on a 2D
// canvas — project every polygon, sort far to near, fill — lit in dawn gold and
// fogged with distance, with a glass-cockpit HUD drawn over the top. No images,
// no libraries: every pixel is computed from the world each frame.
import { CIRCUIT, FIELD, PLANE, SCORE, SKY } from './config.js';
import { PAR_TIME, PHASE_CRASHED, PHASE_FINISHED, PHASE_TITLE } from './flight.js';

const FOV = 1.05; // vertical field of view, radians
const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Multiply an [r,g,b] colour by a light factor and a fog blend, as a CSS colour. */
function paint(rgb, light, fogT) {
  const f = SKY.fog;
  const r = clamp(lerp(rgb[0] * light, f[0], fogT) * 255, 0, 255) | 0;
  const g = clamp(lerp(rgb[1] * light, f[1], fogT) * 255, 0, 255) | 0;
  const b = clamp(lerp(rgb[2] * light, f[2], fogT) * 255, 0, 255) | 0;
  return `rgb(${r},${g},${b})`;
}

/** Fog amount at a distance: none inside fogNear, full at fogFar. */
function fogAt(dist) {
  return clamp((dist - SKY.fogNear) / (SKY.fogFar - SKY.fogNear), 0, 1) ** 1.35;
}

/** Terrain colours by height band; the slope check turns steep ground to rock. */
function terrainColour(h, slopeY) {
  if (slopeY < 0.72) return [0.42, 0.36, 0.33]; // rock on the steep faces
  if (h < 30) return [0.36, 0.47, 0.22]; // valley meadow
  if (h < 95) return [0.44, 0.5, 0.24]; // pasture
  if (h < 190) return [0.5, 0.47, 0.27]; // dry high grass
  if (h < 300) return [0.47, 0.4, 0.34]; // high rock
  return [0.6, 0.57, 0.53]; // pale tops
}

const WATER = [0.13, 0.3, 0.38];
const ASPHALT = [0.30, 0.31, 0.34];
const MARKING = [0.88, 0.87, 0.8];

/**
 * Create the renderer bound to a canvas. `draw(world, state, ui)` paints one
 * frame; ui carries {screen, best, cockpit} from the main loop.
 */
export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const sun = (() => {
    const [x, y, z] = SKY.sunDir;
    const inv = 1 / Math.hypot(x, y, z);
    return { x: x * inv, y: y * inv, z: z * inv };
  })();

  // The camera basis, rebuilt per frame; project() reads it.
  const cam = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0 };
  let W = 0;
  let H = 0;
  let focal = 0;

  function setCamera(px, py, pz, fx, fy, fz, roll) {
    cam.x = px; cam.y = py; cam.z = pz;
    let inv = 1 / (Math.hypot(fx, fy, fz) || 1);
    const Fx = fx * inv;
    const Fy = fy * inv;
    const Fz = fz * inv;
    cam.fx = Fx; cam.fy = Fy; cam.fz = Fz;
    // Screen right is cross(forward, worldUp) = (-Fz, 0, Fx): facing north, it is east.
    let rx = -Fz;
    let rz = Fx;
    inv = 1 / (Math.hypot(rx, rz) || 1);
    rx *= inv; rz *= inv;
    // Screen up completes the basis: up = cross(right, forward).
    const ux = 0 * Fz - rz * Fy;
    const uy = rz * Fx - rx * Fz;
    const uz = rx * Fy - 0 * Fx;
    // Roll the pair around the forward axis: a camera banked right by `roll` sees
    // the world lean left, so right' = right·cos − up·sin, up' = right·sin + up·cos.
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    cam.rx = rx * c - ux * s;
    cam.ry = 0 * c - uy * s;
    cam.rz = rz * c - uz * s;
    cam.ux = rx * s + ux * c;
    cam.uy = 0 * s + uy * c;
    cam.uz = rz * s + uz * c;
  }

  /** Project a world point; returns [sx, sy, depth] or null when behind the camera. */
  function project(x, y, z) {
    const dx = x - cam.x;
    const dy = y - cam.y;
    const dz = z - cam.z;
    const depth = dx * cam.fx + dy * cam.fy + dz * cam.fz;
    if (depth < 1.1) return null;
    const cx = dx * cam.rx + dy * cam.ry + dz * cam.rz;
    const cy = dx * cam.ux + dy * cam.uy + dz * cam.uz;
    return [W / 2 + (cx * focal) / depth, H / 2 - (cy * focal) / depth, depth];
  }

  /** A world point in camera space: [right, up, depth]. */
  function camSpace(x, y, z) {
    const dx = x - cam.x;
    const dy = y - cam.y;
    const dz = z - cam.z;
    return [
      dx * cam.rx + dy * cam.ry + dz * cam.rz,
      dx * cam.ux + dy * cam.uy + dz * cam.uz,
      dx * cam.fx + dy * cam.fy + dz * cam.fz,
    ];
  }

  const NEAR = 1.2;

  /**
   * Push a world-space polygon onto the draw list with its lit, fogged colour.
   * The polygon is clipped against the near plane in camera space first, so
   * ground sweeping under the camera is cut, never dropped whole. `bias` pulls
   * the sort depth nearer — the strip uses it to stay on top of its own plateau.
   */
  function pushPoly(list, pts, rgb, light, bias = 0) {
    let poly = pts.map(([x, y, z]) => camSpace(x, y, z));
    const clipped = [];
    for (let i = 0; i < poly.length; i += 1) {
      const cur = poly[i];
      const nxt = poly[(i + 1) % poly.length];
      if (cur[2] >= NEAR) clipped.push(cur);
      if ((cur[2] >= NEAR) !== (nxt[2] >= NEAR)) {
        const t = (NEAR - cur[2]) / (nxt[2] - cur[2]);
        clipped.push([
          cur[0] + (nxt[0] - cur[0]) * t,
          cur[1] + (nxt[1] - cur[1]) * t,
          NEAR,
        ]);
      }
    }
    if (clipped.length < 3) return;
    let depth = 0;
    const screen = clipped.map(([cx, cy, d]) => {
      depth += d;
      return [W / 2 + (cx * focal) / d, H / 2 - (cy * focal) / d, d];
    });
    depth = depth / clipped.length + bias;
    list.push({ screen, depth, fill: paint(rgb, light, fogAt(depth)) });
  }

  /** The sky: a dawn gradient, the sun's disc, and its glow. */
  function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    const top = SKY.top;
    const hor = SKY.horizon;
    grad.addColorStop(0, `rgb(${top[0] * 255 | 0},${top[1] * 255 | 0},${top[2] * 255 | 0})`);
    grad.addColorStop(0.62, `rgb(${lerp(top[0], hor[0], 0.65) * 255 | 0},${lerp(top[1], hor[1], 0.65) * 255 | 0},${lerp(top[2], hor[2], 0.65) * 255 | 0})`);
    grad.addColorStop(1, `rgb(${hor[0] * 255 | 0},${hor[1] * 255 | 0},${hor[2] * 255 | 0})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    const sp = project(cam.x + sun.x * 6000, cam.y + sun.y * 6000, cam.z + sun.z * 6000);
    if (sp !== null) {
      const r = H * 0.05;
      const glow = ctx.createRadialGradient(sp[0], sp[1], 0, sp[0], sp[1], r * 5);
      glow.addColorStop(0, 'rgba(255,236,190,0.85)');
      glow.addColorStop(0.25, 'rgba(255,205,130,0.35)');
      glow.addColorStop(1, 'rgba(255,205,130,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(sp[0] - r * 5, sp[1] - r * 5, r * 10, r * 10);
      ctx.fillStyle = 'rgb(255,244,205)';
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], r, 0, TAU);
      ctx.fill();
    }
  }

  /** Terrain, water, the strip and its markings, as one sorted polygon soup. */
  function drawGround(world, list) {
    const cellFar = 640;
    const cellNear = 150;
    const spanFar = 6300;
    const spanNear = 2500;
    const emit = (x0, z0, x1, z1) => {
      const h00 = world.heightAt(x0, z0);
      const h10 = world.heightAt(x1, z0);
      const h01 = world.heightAt(x0, z1);
      const h11 = world.heightAt(x1, z1);
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const distC = Math.hypot(cx - cam.x, cz - cam.z);
      if (distC > SKY.fogFar + 900) return;
      const maxH = Math.max(h00, h10, h01, h11);
      if (maxH < world.waterY + 0.4) {
        // Still water where the ground lies under it: a flat quad at water level.
        const wy = world.waterY;
        const glint = 0.9 + 0.25 * Math.max(0, sun.y);
        pushPoly(list, [[x0, wy, z0], [x1, wy, z0], [x1, wy, z1], [x0, wy, z1]], WATER, glint);
        return;
      }
      const n = world.groundNormal(cx, cz);
      const light = 0.52 + 0.62 * Math.max(0, n.x * sun.x + n.y * sun.y + n.z * sun.z);
      const rgb = terrainColour((h00 + h10 + h01 + h11) / 4, n.y);
      pushPoly(list, [[x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1]], rgb, light);
    };
    // Far ring of coarse cells, then the fine patch around the camera.
    for (let x = -spanFar; x < spanFar; x += cellFar) {
      for (let z = -spanFar; z < spanFar; z += cellFar) {
        if (Math.abs(x + cellFar / 2 - cam.x) < spanNear && Math.abs(z + cellFar / 2 - cam.z) < spanNear) continue;
        emit(x, z, x + cellFar, z + cellFar);
      }
    }
    const baseX = Math.floor((cam.x - spanNear) / cellNear) * cellNear;
    const baseZ = Math.floor((cam.z - spanNear) / cellNear) * cellNear;
    for (let x = baseX; x < baseX + spanNear * 2; x += cellNear) {
      for (let z = baseZ; z < baseZ + spanNear * 2; z += cellNear) emit(x, z, x + cellNear, z + cellNear);
    }
  }

  /**
   * The strip, drawn as its own pass after the terrain: one long quad would sort
   * by its middle and lose to every near hillside, so the tarmac, threshold bars
   * and centreline are painted over the ground and under the aeroplane instead.
   */
  function drawStrip() {
    const list = [];
    const y = FIELD.height + 0.18;
    const hw = FIELD.width / 2;
    for (let z = FIELD.zFrom; z < FIELD.zTo; z += 170) {
      const z1 = Math.min(z + 170, FIELD.zTo);
      pushPoly(list, [[FIELD.x - hw, y, z], [FIELD.x + hw, y, z], [FIELD.x + hw, y, z1], [FIELD.x - hw, y, z1]], ASPHALT, 0.95);
    }
    for (const end of [FIELD.zFrom + 14, FIELD.zTo - 14]) {
      for (let i = -3; i <= 3; i += 1) {
        if (i === 0) continue;
        const bx = FIELD.x + i * 5.4;
        pushPoly(list, [[bx - 1.5, y + 0.05, end - 9], [bx + 1.5, y + 0.05, end - 9], [bx + 1.5, y + 0.05, end + 9], [bx - 1.5, y + 0.05, end + 9]], MARKING, 1);
      }
    }
    for (let z = FIELD.zFrom + 90; z < FIELD.zTo - 60; z += 120) {
      pushPoly(list, [[FIELD.x - 1.1, y + 0.05, z], [FIELD.x + 1.1, y + 0.05, z], [FIELD.x + 1.1, y + 0.05, z + 42], [FIELD.x - 1.1, y + 0.05, z + 42]], MARKING, 0.9);
    }
    list.sort((a, b) => b.depth - a.depth);
    for (const poly of list) fillPoly(poly);
  }

  /** Fill one projected polygon from the draw list. */
  function fillPoly(poly) {
    ctx.fillStyle = poly.fill;
    ctx.beginPath();
    poly.screen.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }

  /** One ring of the circuit: a band of quads around its circle, lit by its state. */
  function drawRing(list, ring, role) {
    const SEG = 22;
    // The ring stands in the plane across the line of flight: one axis horizontal
    // (dirZ, 0, -dirX), the other straight up, since the course direction is level.
    const a1 = { x: ring.dirZ, y: 0, z: -ring.dirX };
    const a2 = { x: 0, y: 1, z: 0 };
    const rgb = role === 'done' ? [0.35, 0.62, 0.4] : role === 'next' ? [1.0, 0.55, 0.12] : [0.95, 0.78, 0.4];
    const light = role === 'next' ? 1.25 : 0.9;
    const R = CIRCUIT.ringRadius;
    for (let i = 0; i < SEG; i += 1) {
      const t0 = (i / SEG) * TAU;
      const t1 = ((i + 1) / SEG) * TAU;
      const pt = (t, r) => [
        ring.x + (a1.x * Math.cos(t) + a2.x * Math.sin(t)) * r,
        ring.y + (a1.y * Math.cos(t) + a2.y * Math.sin(t)) * r,
        ring.z + (a1.z * Math.cos(t) + a2.z * Math.sin(t)) * r,
      ];
      pushPoly(list, [pt(t0, R + 1.7), pt(t1, R + 1.7), pt(t1, R - 1.7), pt(t0, R - 1.7)], rgb, light);
    }
    if (role === 'next') {
      // A faint disc fills the target gate so it reads from across the valley.
      const disc = [];
      for (let i = 0; i < SEG; i += 1) {
        const t = (i / SEG) * TAU;
        disc.push([ring.x + a1.x * Math.cos(t) * R, ring.y + Math.sin(t) * R, ring.z + a1.z * Math.cos(t) * R]);
      }
      let depth = 0;
      const screen = [];
      for (const p of disc) {
        const s = project(p[0], p[1], p[2]);
        if (s === null) return;
        screen.push(s);
        depth += s[2];
      }
      list.push({ screen, depth: depth / disc.length, fill: 'rgba(255,150,40,0.10)' });
    }
  }

  /** Scenery: forest triangles, village boxes, hangars — into the same sorted soup. */
  function drawScenery(world, list) {
    for (const tree of world.trees) {
      const dx = tree.x - cam.x;
      const dz = tree.z - cam.z;
      if (dx * dx + dz * dz > 2600 * 2600) continue;
      // A billboarded conifer: one triangle across the view, apex high.
      const rxv = cam.rx;
      const rzv = cam.rz;
      const wdt = 1.7 * tree.s;
      pushPoly(list, [
        [tree.x - rxv * wdt, tree.y, tree.z - rzv * wdt],
        [tree.x + rxv * wdt, tree.y, tree.z + rzv * wdt],
        [tree.x, tree.y + 9.5 * tree.s, tree.z],
      ], [0.15 + tree.shade, 0.3 + tree.shade, 0.13 + tree.shade], 0.95);
    }
    for (const b of world.buildings) {
      const dx = b.x - cam.x;
      const dz = b.z - cam.z;
      if (dx * dx + dz * dz > 3400 * 3400) continue;
      const c = Math.cos(b.rot);
      const s = Math.sin(b.rot);
      const corner = (lx, lz, y) => [b.x + lx * c + lz * s, y, b.z - lx * s + lz * c];
      const g = [
        corner(-b.w / 2, -b.d / 2, b.y), corner(b.w / 2, -b.d / 2, b.y),
        corner(b.w / 2, b.d / 2, b.y), corner(-b.w / 2, b.d / 2, b.y),
      ];
      const t = g.map(([x, , z]) => [x, b.y + b.h, z]);
      const wall = b.hangar ? [0.52, 0.5, 0.47] : [0.78, 0.7, 0.58];
      const roof = b.hangar ? [0.4, 0.38, 0.36] : [0.52, 0.3, 0.2];
      const faces = [
        { pts: [t[0], t[1], t[2], t[3]], rgb: roof, light: 1.05 },
        { pts: [g[0], g[1], t[1], t[0]], rgb: wall, light: 0.8 },
        { pts: [g[1], g[2], t[2], t[1]], rgb: wall, light: 0.92 },
        { pts: [g[2], g[3], t[3], t[2]], rgb: wall, light: 0.72 },
        { pts: [g[3], g[0], t[0], t[3]], rgb: wall, light: 0.86 },
      ];
      for (const face of faces) {
        // Only the faces turned toward the camera can be seen; skip the rest.
        const [a, bb, cc] = face.pts;
        const ux = bb[0] - a[0]; const uy = bb[1] - a[1]; const uz = bb[2] - a[2];
        const vx = cc[0] - a[0]; const vy = cc[1] - a[1]; const vz = cc[2] - a[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const facing = nx * (cam.x - a[0]) + ny * (cam.y - a[1]) + nz * (cam.z - a[2]);
        if (facing <= 0) continue;
        pushPoly(list, face.pts, face.rgb, face.light);
      }
    }
  }

  /** Clouds after the solid world: soft dawn ellipses, far ones first. */
  function drawClouds(world) {
    const sorted = [];
    for (const cloud of world.clouds) {
      const p = project(cloud.x, cloud.y, cloud.z);
      if (p !== null) sorted.push({ p, cloud });
    }
    sorted.sort((a, b) => b.p[2] - a.p[2]);
    for (const { p, cloud } of sorted) {
      const r = (focal * cloud.r) / p[2];
      if (r < 6) continue;
      const shade = 235 + cloud.shade * 200 | 0;
      ctx.fillStyle = `rgba(${shade},${shade - 8},${shade - 56},0.30)`;
      for (const [ox, oy, orr] of [[0, 0, 1], [-0.55, 0.1, 0.7], [0.55, 0.08, 0.75], [0.1, -0.14, 0.6]]) {
        ctx.beginPath();
        ctx.ellipse(p[0] + ox * r, p[1] + oy * r * 0.4, r * orr, r * 0.3 * orr, 0, 0, TAU);
        ctx.fill();
      }
    }
  }

  /** The aeroplane, built from lit panels in its own frame, into the sorted soup. */
  function drawPlane(list, state) {
    const H = state.heading;
    const P = state.pitch;
    const R = state.roll;
    const fwd = { x: Math.sin(H) * Math.cos(P), y: Math.sin(P), z: -Math.cos(H) * Math.cos(P) };
    const r0 = { x: Math.cos(H), y: 0, z: Math.sin(H) };
    const u0 = {
      x: r0.y * fwd.z - r0.z * fwd.y,
      y: r0.z * fwd.x - r0.x * fwd.z,
      z: r0.x * fwd.y - r0.y * fwd.x,
    };
    const cr = Math.cos(R);
    const sr = Math.sin(R);
    const right = { x: r0.x * cr - u0.x * sr, y: r0.y * cr - u0.y * sr, z: r0.z * cr - u0.z * sr };
    const up = { x: r0.x * sr + u0.x * cr, y: r0.y * sr + u0.y * cr, z: r0.z * sr + u0.z * cr };
    // Local frame: x right, y up, z toward the tail; nose at z = -3.7.
    const at = (lx, ly, lz) => [
      state.x + right.x * lx + up.x * ly - fwd.x * lz,
      state.y + right.y * lx + up.y * ly - fwd.y * lz,
      state.z + right.z * lx + up.z * ly - fwd.z * lz,
    ];
    const CREAM = [0.93, 0.89, 0.81];
    const RED = [0.74, 0.17, 0.12];
    const GLASS = [0.12, 0.17, 0.23];
    // Fuselage: rectangular sections swept from nose to tail, four faces a section.
    const stations = [
      { z: -3.7, w: 0.07, t: 0.07, b: -0.07, cy: 0 },
      { z: -2.0, w: 0.37, t: 0.37, b: -0.37, cy: 0 },
      { z: 0.4, w: 0.58, t: 0.52, b: -0.48, cy: 0.02 },
      { z: 2.8, w: 0.3, t: 0.46, b: -0.16, cy: 0.15 },
      { z: 4.0, w: 0.08, t: 0.34, b: 0.1, cy: 0.22 },
    ];
    for (let i = 0; i < stations.length - 1; i += 1) {
      const A = stations[i];
      const B = stations[i + 1];
      const quad = (pa, pb, pc, pd, light) => pushPoly(list, [at(...pa), at(...pb), at(...pc), at(...pd)], CREAM, light);
      quad([-A.w, A.cy + A.t, A.z], [A.w, A.cy + A.t, A.z], [B.w, B.cy + B.t, B.z], [-B.w, B.cy + B.t, B.z], 1.06); // top
      quad([A.w, A.cy + A.t, A.z], [A.w, A.cy + A.b, A.z], [B.w, B.cy + B.b, B.z], [B.w, B.cy + B.t, B.z], 0.86); // right
      quad([-A.w, A.cy + A.b, A.z], [A.w, A.cy + A.b, A.z], [B.w, B.cy + B.b, B.z], [-B.w, B.cy + B.b, B.z], 0.58); // belly
      quad([-A.w, A.cy + A.b, A.z], [-A.w, A.cy + A.t, A.z], [-B.w, B.cy + B.t, B.z], [-B.w, B.cy + B.b, B.z], 0.78); // left
    }
    // The high wing, its tips, and the tail feathers, in Emberwing red.
    pushPoly(list, [at(-4.7, 0.6, -0.95), at(4.7, 0.6, -0.95), at(4.7, 0.6, 0.55), at(-4.7, 0.6, 0.55)], RED, 1.08);
    pushPoly(list, [at(-4.7, 0.5, -0.95), at(-4.7, 0.5, 0.55), at(4.7, 0.5, 0.55), at(4.7, 0.5, -0.95)], RED, 0.55);
    pushPoly(list, [at(-1.55, 0.46, 3.25), at(1.55, 0.46, 3.25), at(1.55, 0.46, 4.0), at(-1.55, 0.46, 4.0)], RED, 1.0);
    pushPoly(list, [at(0, 0.3, 2.85), at(0, 1.3, 3.55), at(0, 1.18, 4.05), at(0, 0.36, 4.05)], RED, 0.9);
    // The glasshouse.
    pushPoly(list, [at(-0.42, 0.52, -1.55), at(0.42, 0.52, -1.55), at(0.42, 0.52, 0.05), at(-0.42, 0.52, 0.05)], GLASS, 0.7);
    pushPoly(list, [at(-0.42, 0.52, -1.55), at(-0.42, 0.88, -0.75), at(-0.42, 0.52, 0.05), at(-0.42, 0.52, -1.55)], GLASS, 1.0);
    pushPoly(list, [at(0.42, 0.52, -1.55), at(0.42, 0.52, 0.05), at(0.42, 0.88, -0.75), at(0.42, 0.52, -1.55)], GLASS, 1.0);
    pushPoly(list, [at(-0.42, 0.88, -0.75), at(0.42, 0.88, -0.75), at(0.42, 0.52, 0.05), at(-0.42, 0.52, 0.05)], GLASS, 0.8);
    // Gear legs and wheels, simple dark panels under the belly.
    for (const side of [-1, 1]) {
      pushPoly(list, [at(side * 0.5, -0.45, -0.35), at(side * 0.62, -0.45, -0.35), at(side * 0.62, -1.08, -0.3), at(side * 0.5, -1.08, -0.3)], [0.1, 0.1, 0.11], 0.8);
    }
    // The propeller: a blurred disc while it turns, two blades when it rests.
    if (state.throttle > 0.03 || state.speed > 2) {
      const disc = [];
      for (let i = 0; i < 12; i += 1) {
        const t = (i / 12) * TAU;
        disc.push(at(Math.cos(t) * 1.08, Math.sin(t) * 1.08, -3.82));
      }
      let depth = 0;
      const screen = [];
      for (const p of disc) {
        const s = project(p[0], p[1], p[2]);
        if (s === null) return;
        screen.push(s);
        depth += s[2];
      }
      list.push({ screen, depth: depth / disc.length, fill: 'rgba(24,20,16,0.30)' });
    } else {
      const a = 0.5;
      pushPoly(list, [at(Math.cos(a) * -1.02, Math.sin(a) * -1.02, -3.82), at(Math.cos(a) * 1.02, Math.sin(a) * 1.02, -3.82), at(Math.cos(a) * 0.9, Math.sin(a) * 0.9, -3.86), at(Math.cos(a) * -0.9, Math.sin(a) * -0.9, -3.86)], [0.12, 0.11, 0.1], 0.9);
    }
  }

  // ------------------------------------------------------------ HUD and screens

  const INK = 'rgba(240,244,248,0.96)';
  const AMBER = 'rgba(255,176,66,0.98)';
  const DIM = 'rgba(200,208,216,0.75)';

  function panel(x, y, w, h) {
    ctx.fillStyle = 'rgba(8,11,16,0.46)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function text(str, x, y, size, fill, align = 'left', weight = 600) {
    ctx.fillStyle = fill;
    ctx.font = `${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }

  function bar(x, y, w, h, frac, fill) {
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
  }

  const pad = (n, len) => String(Math.max(0, Math.floor(n))).padStart(len, '0');

  /** The compass strip: ticks every 15 degrees, letters for the cardinals. */
  function drawCompass(state) {
    const cx = W / 2;
    const y = 16;
    panel(cx - 150, y - 4, 300, 40);
    const headingDeg = ((state.heading * 180 / Math.PI) % 360 + 360) % 360;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - 148, y - 2, 296, 36);
    ctx.clip();
    for (let d = -60; d <= 60; d += 3) {
      const deg = Math.round((headingDeg + d) / 15) * 15;
      const off = (deg - headingDeg) * 3.4;
      if (Math.abs(off) > 145) continue;
      const norm = ((deg % 360) + 360) % 360;
      const label = norm === 0 ? 'N' : norm === 90 ? 'E' : norm === 180 ? 'S' : norm === 270 ? 'W' : pad(norm / 10, 2);
      text(label, cx + off, y + 12, 13, norm % 90 === 0 ? AMBER : DIM, 'center');
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(cx + off - 0.5, y + 24, 1, 6);
    }
    ctx.restore();
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(cx - 5, y - 3);
    ctx.lineTo(cx + 5, y - 3);
    ctx.lineTo(cx, y + 3);
    ctx.fill();
    text(pad(headingDeg, 3) + '°', cx, y + 44, 13, INK, 'center');
  }

  /** The artificial horizon: a small lit ball in the lower centre of the panel. */
  function drawHorizon(state) {
    const cx = W / 2 - 128;
    const cy = H - 64;
    const r = 40;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    ctx.fillStyle = 'rgba(10,14,20,0.5)';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.translate(cx, cy);
    ctx.rotate(-state.roll);
    const lift = clamp(state.pitch, -0.6, 0.6) * 62;
    ctx.fillStyle = 'rgba(64,110,168,0.92)';
    ctx.fillRect(-r, -r, r * 2, r + lift);
    ctx.fillStyle = 'rgba(122,84,48,0.95)';
    ctx.fillRect(-r, lift, r * 2, r * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-r, lift);
    ctx.lineTo(r, lift);
    ctx.stroke();
    for (const deg of [-20, -10, 10, 20]) {
      const ly = lift - deg * 3.1;
      const wdt = deg % 20 === 0 ? 15 : 10;
      ctx.beginPath();
      ctx.moveTo(-wdt, ly);
      ctx.lineTo(wdt, ly);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx - 5, cy);
    ctx.lineTo(cx, cy + 4);
    ctx.lineTo(cx + 5, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.stroke();
  }

  /** Everything over the world while the flight is live. */
  function drawHud(world, state, ui) {
    drawCompass(state);
    const knots = state.speed * 1.944;
    const altFt = state.y * 3.281;
    const vsi = state.vy * 197;
    // Left: airspeed and throttle. Right: altitude and climb.
    panel(16, 16, 128, 64);
    text('SPD KT', 26, 30, 11, DIM);
    text(pad(knots, 3), 26, 56, 30, state.stalled ? 'rgba(255,84,64,0.98)' : INK, 'left', 700);
    panel(W - 144, 16, 128, 64);
    text('ALT FT', W - 134, 30, 11, DIM);
    text(pad(altFt, 5), W - 134, 56, 24, INK, 'left', 700);
    text((vsi >= 0 ? '+' : '−') + pad(Math.abs(vsi), 4), W - 26, 30, 12, DIM, 'right');
    // Lower left: throttle, fuel, hull.
    panel(16, H - 118, 208, 102);
    text('THR', 26, H - 100, 11, DIM);
    bar(66, H - 105, 148, 9, state.throttle, AMBER);
    text('FUEL', 26, H - 76, 11, DIM);
    bar(66, H - 81, 148, 9, state.fuel / PLANE.fuelCapacity, state.fuel < 9 ? 'rgba(255,84,64,0.95)' : 'rgba(96,200,120,0.95)');
    text('HULL', 26, H - 52, 11, DIM);
    bar(66, H - 57, 148, 9, 1 - state.damage / 100, state.damage > 55 ? 'rgba(255,84,64,0.95)' : 'rgba(120,170,255,0.95)');
    text(state.flap ? 'FLAP DOWN' : 'FLAP UP', 26, H - 28, 11, state.flap ? AMBER : DIM);
    text(state.onGround ? 'ON GROUND' : state.stalled ? 'STALL' : 'AIRBORNE', 214, H - 28, 11, state.stalled ? 'rgba(255,84,64,0.98)' : DIM, 'right');
    drawHorizon(state);
    // Lower right: the mission clock and the rings.
    panel(W - 224, H - 82, 208, 66);
    const mm = pad(state.time / 60, 2);
    const ss = pad(state.time % 60, 2);
    text(`TIME ${mm}:${ss}`, W - 134, H - 58, 17, INK, 'center', 700);
    text(`RINGS ${state.ringsCleared} / ${world.rings.length}`, W - 134, H - 32, 13, AMBER, 'center');
    // Centre: the reticle, the flight-path marker, warnings and messages.
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 9, 0, TAU);
    ctx.stroke();
    if (state.stalled && Math.floor(ui.now * 2.4) % 2 === 0) {
      text('STALL', W / 2, H / 2 + 42, 22, 'rgba(255,84,64,0.98)', 'center', 700);
    }
    if (state.fuel < 9 && state.fuel > 0) text('LOW FUEL', W / 2, H / 2 + 66, 13, AMBER, 'center');
    if (state.fuel <= 0) text('ENGINE DRY — GLIDE', W / 2, H / 2 + 66, 13, 'rgba(255,84,64,0.98)', 'center');
    if (state.messageTime > 0 && state.message) {
      text(state.message, W / 2, H * 0.3, 19, AMBER, 'center', 700);
    }
    drawGuidance(world, state);
  }

  /** Point the pilot at the next ring: a bracket on it, or an arrow at the edge. */
  function drawGuidance(world, state) {
    if (state.ringsCleared >= world.rings.length) {
      if (!state.onGround) text('ALL RINGS — LAND ON THE STRIP', W / 2, 92, 14, AMBER, 'center');
      return;
    }
    const ring = world.rings[state.ringsCleared];
    const dist = Math.hypot(ring.x - state.x, ring.y - state.y, ring.z - state.z);
    const p = project(ring.x, ring.y, ring.z);
    if (p !== null && p[0] > -40 && p[0] < W + 40 && p[1] > -40 && p[1] < H + 40) {
      const r = clamp((focal * CIRCUIT.ringRadius) / p[2], 10, 260);
      ctx.strokeStyle = 'rgba(255,176,66,0.9)';
      ctx.lineWidth = 2;
      const [x, y] = p;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * r, y + sy * r - sy * r * 0.45);
        ctx.lineTo(x + sx * r, y + sy * r);
        ctx.lineTo(x + sx * r - sx * r * 0.45, y + sy * r);
        ctx.stroke();
      }
      text(`${Math.round(dist)} M`, x, y + r + 16, 12, AMBER, 'center');
      return;
    }
    // Off-screen: an arrow on an ellipse around the centre, aimed the right way.
    const dx = ring.x - state.x;
    const dz = ring.z - state.z;
    const relX = dx * cam.rx + dz * cam.rz;
    const relF = dx * cam.fx + dz * cam.fz;
    let ang = Math.atan2(-relX, relF >= 0 ? 1 : -1);
    if (relF < 0) ang = Math.PI - ang;
    const ex = W / 2 + Math.sin(ang) * (W * 0.4);
    const ey = H / 2 - Math.cos(ang) * (H * 0.36);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(255,176,66,0.92)';
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 3);
    ctx.lineTo(-7, 8);
    ctx.fill();
    ctx.restore();
    text(`RING ${state.ringsCleared + 1} · ${Math.round(dist)} M`, ex, ey + 24, 12, AMBER, 'center');
  }

  /** The cockpit furniture drawn over the head view: coaming, posts, a panel strip. */
  function drawCockpit(state) {
    ctx.fillStyle = 'rgba(16,15,14,0.96)';
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, H * 0.8);
    ctx.lineTo(W * 0.3, H * 0.72);
    ctx.lineTo(W * 0.7, H * 0.72);
    ctx.lineTo(W, H * 0.8);
    ctx.lineTo(W, H);
    ctx.fill();
    ctx.fillStyle = 'rgba(24,22,20,0.9)';
    ctx.fillRect(0, 0, W * 0.045, H);
    ctx.fillRect(W * 0.955, 0, W * 0.045, H);
    text('EMBERWING', W / 2, H * 0.76, 13, 'rgba(214,178,110,0.9)', 'center');
    void state;
  }

  function veil(alpha, tint = '8,10,16') {
    ctx.fillStyle = `rgba(${tint},${alpha})`;
    ctx.fillRect(0, 0, W, H);
  }

  function drawTitle(ui) {
    veil(0.34);
    text('EMBERWING', W / 2, H * 0.26, 64, 'rgba(255,226,170,0.98)', 'center', 800);
    text('V A L L E Y   C I R C U I T', W / 2, H * 0.26 + 52, 19, AMBER, 'center', 700);
    text('Eight amber rings down a dawn valley — thread them in order, then land her back on the strip.', W / 2, H * 0.4, 16, INK, 'center', 500);
    const lines = [
      '↓ / ↑  stick — climb / descend        ← / →  bank and turn',
      'A / D  rudder                          W / S  throttle   (0 idle · 1 full)',
      'SPACE  brake                           F  flaps   ·   C  cockpit view',
      'Mind the fuel, the stall, and the ground. A firm arrival bends the hull.',
    ];
    lines.forEach((line, i) => text(line, W / 2, H * 0.57 + i * 25, 14.5, DIM, 'center', 500));
    if (Math.floor(ui.now * 1.6) % 2 === 0) text('PRESS ENTER TO FLY', W / 2, H * 0.78, 20, 'rgba(255,226,170,0.98)', 'center', 700);
    if (ui.best > 0) text(`BEST ${ui.best}`, W / 2, H * 0.84, 14, DIM, 'center');
  }

  function drawFinished(world, state) {
    veil(0.42);
    const cx = W / 2;
    text('FLIGHT COMPLETE', cx, H * 0.24, 40, 'rgba(255,226,170,0.98)', 'center', 800);
    if (state.touchdown) text(state.touchdown.note, cx, H * 0.24 + 44, 16, INK, 'center', 500);
    const rows = [
      [`Rings  ${state.ringsCleared} of ${world.rings.length}`, state.ringsCleared * SCORE.perRing],
      ['Landing', state.touchdown ? (state.touchdown.onStrip ? (state.touchdown.quality === 'firm' ? SCORE.landingFirm : SCORE.landingGood) : 40) : 0],
      ['Fuel brought home', Math.round(state.fuel) * CIRCUIT.fuelBonusPerLitre],
      ['Under par time', Math.max(0, Math.round((PAR_TIME - state.airborneTime) * 1.5))],
      ['Damage', -Math.round(state.damage) * SCORE.damagePerPoint],
    ];
    rows.forEach(([label, pts], i) => {
      const y = H * 0.42 + i * 30;
      text(label, cx - 170, y, 16, DIM, 'left', 500);
      text((pts > 0 ? '+' : '') + pts, cx + 170, y, 16, INK, 'right', 700);
    });
    text(`SCORE  ${state.score}`, cx, H * 0.42 + rows.length * 30 + 26, 30, AMBER, 'center', 800);
    text('ENTER — FLY AGAIN', cx, H * 0.82, 16, DIM, 'center');
  }

  function drawCrashed(state) {
    veil(0.4, '52,10,6');
    text('DOWN', W / 2, H * 0.3, 52, 'rgba(255,150,120,0.98)', 'center', 800);
    text(state.message || 'The flight ended in the valley.', W / 2, H * 0.3 + 56, 17, INK, 'center', 500);
    text('ENTER — TRY AGAIN', W / 2, H * 0.62, 16, DIM, 'center');
  }

  /**
   * Paint one frame. `ui` = {screen, best, cockpit, now}: the screen to overlay,
   * the session's best score, the camera choice, and a wall-clock for pulses.
   */
  function draw(world, state, ui) {
    W = canvas.width;
    H = canvas.height;
    focal = (H / 2) / Math.tan(FOV / 2);
    // The aeroplane's own frame, for the chase and head cameras.
    const Hh = state.heading;
    const Pp = state.pitch;
    const fwd = { x: Math.sin(Hh) * Math.cos(Pp), y: Math.sin(Pp), z: -Math.cos(Hh) * Math.cos(Pp) };
    const r0 = { x: Math.cos(Hh), y: 0, z: Math.sin(Hh) };
    const u0 = {
      x: r0.y * fwd.z - r0.z * fwd.y,
      y: r0.z * fwd.x - r0.x * fwd.z,
      z: r0.x * fwd.y - r0.y * fwd.x,
    };
    const cr = Math.cos(state.roll);
    const sr = Math.sin(state.roll);
    const up = { x: r0.x * sr + u0.x * cr, y: r0.y * sr + u0.y * cr, z: r0.z * sr + u0.z * cr };

    if (ui.screen === PHASE_TITLE) {
      // A slow admiring orbit of the parked aeroplane on its strip.
      const a = 1.25 + ui.now * 0.045;
      const px = state.x + Math.sin(a) * 44;
      const pz = state.z + Math.cos(a) * 44;
      setCamera(px, state.y + 11, pz, state.x - px, state.y + 0.6 - (state.y + 11), state.z - pz, 0);
    } else if (ui.cockpit) {
      setCamera(
        state.x + up.x * 1.02 + fwd.x * 0.15,
        state.y + up.y * 1.02 + fwd.y * 0.15,
        state.z + up.z * 1.02 + fwd.z * 0.15,
        fwd.x, fwd.y, fwd.z, state.roll * 0.88,
      );
    } else {
      let cxp = state.x - fwd.x * PLANE.cameraBack + up.x * PLANE.cameraUp;
      let cyp = state.y - fwd.y * PLANE.cameraBack + up.y * PLANE.cameraUp;
      let czp = state.z - fwd.z * PLANE.cameraBack + up.z * PLANE.cameraUp;
      const floor = world.heightAt(cxp, czp) + 1.7;
      if (cyp < floor) cyp = floor;
      setCamera(cxp, cyp, czp, state.x + fwd.x * 26 - cxp, state.y + fwd.y * 26 - cyp, state.z + fwd.z * 26 - czp, state.roll * 0.45);
    }

    drawSky();
    const list = [];
    drawGround(world, list);
    world.rings.forEach((ring, i) => {
      drawRing(list, ring, i < state.ringsCleared ? 'done' : i === state.ringsCleared ? 'next' : 'todo');
    });
    drawScenery(world, list);
    list.sort((a, b) => b.depth - a.depth);
    for (const poly of list) fillPoly(poly);
    drawStrip();
    if (!ui.cockpit || ui.screen === PHASE_TITLE) {
      const planeList = [];
      drawPlane(planeList, state);
      planeList.sort((a, b) => b.depth - a.depth);
      for (const poly of planeList) fillPoly(poly);
    }
    drawClouds(world);

    if (ui.screen === PHASE_TITLE) {
      drawTitle(ui);
    } else if (ui.screen === PHASE_FINISHED) {
      drawFinished(world, state); // veils and scores first, so the HUD stays lit on top
      drawHud(world, state, ui);
    } else if (ui.screen === PHASE_CRASHED) {
      drawCrashed(state);
      drawHud(world, state, ui);
    } else {
      if (ui.cockpit) drawCockpit(state);
      drawHud(world, state, ui);
    }
  }

  return { draw };
}
