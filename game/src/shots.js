// Emberwing — Valley Circuit: the screenshot scenes behind ?shot=start|play|end,
// and the autopilot that flies them. The pilot steers for the next ring the way a
// careful human would — bank toward it, mind the altitude, slow down for home —
// and because the world and the step are fixed, a seed always gives the same frame.
import { FIELD, PLANE } from './config.js';
import { PHASE_CRASHED, PHASE_FINISHED, PHASE_FLYING, PHASE_TITLE } from './flight.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Smallest signed difference between two headings, radians. */
function headingDelta(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * A pilot that flies the whole sortie: take off, thread the rings, come home and
 * land. It keeps its own throttle setting and approach waypoints between calls.
 */
export function createAutopilot(world) {
  let throttle = 0;
  let rejoin = false; // set when a ring is overshot: fly back out and come in again
  let rejoinRing = -1;
  let leg = 0; // which homecoming waypoint we are flying to, once the rings are done
  // One joining point south of the strip: past z 2500 the rim hills climb into
  // the glide, so the approach joins there and comes down steeper than a liner.
  const homeLegs = [
    { x: FIELD.x, z: FIELD.zTo + 560, y: 108, r: 200 },
  ];

  return function autopilot(state) {
    const controls = { pitch: 0, roll: 0, yaw: 0, throttle, brake: false, flap: false };
    const steerTo = (tx, tz, ty, cruise, avoid = true) => {
      const desired = Math.atan2(tx - state.x, -(tz - state.z));
      const err = headingDelta(desired, state.heading);
      controls.roll = clamp(err * 1.05, -0.8, 0.8);
      // Never aim below the ground between here and there: sample ahead and midway.
      let targetY = ty;
      if (avoid) {
        const aheadX = state.x + Math.sin(state.heading) * 300;
        const aheadZ = state.z - Math.cos(state.heading) * 300;
        const clearance = Math.max(
          world.heightAt(aheadX, aheadZ),
          world.heightAt((state.x + tx) / 2, (state.z + tz) / 2),
        ) + 58;
        targetY = Math.max(ty, clearance);
      }
      let desiredPitch = clamp((targetY - state.y) * 0.011, -0.3, 0.34);
      if (state.speed > cruise + 13) desiredPitch += 0.08; // trade pace for height
      if (state.speed < 26) desiredPitch -= 0.1; // never mush into a stall
      controls.pitch = clamp((desiredPitch - state.pitch) * 2.4, -1, 1);
      throttle += clamp((cruise - state.speed) * 0.012, -0.012, 0.012);
      throttle = clamp(throttle, 0, 1);
      controls.throttle = throttle;
    };

    if (state.onGround && !state.hasTakenOff) {
      // The take-off roll: full power, sit still, rotate at pace.
      throttle = 1;
      controls.throttle = 1;
      controls.pitch = state.speed > PLANE.stallSpeed + 2 ? 0.55 : 0;
      return controls;
    }
    if (state.onGround && state.hasTakenOff) {
      // Rolling out after arrival: brakes on, throttle shut.
      throttle = 0;
      controls.throttle = 0;
      controls.brake = true;
      return controls;
    }
    if (state.ringsCleared < world.rings.length) {
      const ring = world.rings[state.ringsCleared];
      if (ring.index !== rejoinRing) {
        rejoinRing = ring.index;
        rejoin = false;
      }
      const side = (state.x - ring.x) * ring.dirX + (state.z - ring.z) * ring.dirZ;
      if (side > 30) rejoin = true; // through the gate's plane but wide of the hoop
      if (rejoin) {
        const jx = ring.x - ring.dirX * 640;
        const jz = ring.z - ring.dirZ * 640;
        if (Math.hypot(state.x - jx, state.z - jz) < 180) rejoin = false;
        steerTo(jx, jz, ring.y, 41);
      } else {
        const dist = Math.hypot(ring.x - state.x, ring.z - state.z);
        steerTo(ring.x, ring.z, ring.y, dist < 320 ? 36 : 41); // slow a touch to tighten the turn
      }
      return controls;
    }
    if (leg < homeLegs.length) {
      const target = homeLegs[leg];
      const dist = Math.hypot(target.x - state.x, target.z - state.z);
      if (dist < target.r) leg += 1;
      steerTo(target.x, target.z, target.y, 34);
      controls.flap = leg >= 1;
      return controls;
    }
    // Final: a straight glide at the near end of the strip. In the last stretch
    // the slope shallows (the flare) so she floats down; past the threshold the
    // aim walks down the strip and the glide settles her onto the tarmac.
    const distToStrip = state.z - FIELD.zTo; // positive while south of the threshold
    const flaring = distToStrip < 170;
    const slope = flaring ? 0.05 : 0.105;
    const glideY = FIELD.height + 1.15 + Math.max(0, distToStrip) * slope;
    const aimZ = distToStrip > 0 ? FIELD.zTo - 160 : FIELD.zTo - 700;
    steerTo(FIELD.x, aimZ, glideY, flaring ? 24.5 : 27.5, false);
    controls.flap = true;
    return controls;
  };
}

/**
 * Stage the named scene on a fresh flight and return the screen to draw.
 * start: parked on the strip under the title. play: mid-circuit, rings ahead.
 * end: the whole sortie flown, however it turned out.
 */
export function stageShot(name, flight, world) {
  const { state } = flight;
  if (name !== 'play' && name !== 'end') return PHASE_TITLE;
  const autopilot = createAutopilot(world);
  const stepCap = name === 'end' ? 60 * 60 * 14 : 60 * 60 * 3;
  for (let i = 0; i < stepCap; i += 1) {
    flight.step(autopilot(state));
    if (name === 'play' && state.airborneTime > 24 && state.ringsCleared >= 1) break;
    if (state.phase === PHASE_FINISHED || state.phase === PHASE_CRASHED) break;
  }
  return state.phase === PHASE_TITLE ? PHASE_FLYING : state.phase;
}
