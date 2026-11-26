// Emberwing — Valley Circuit: the flight model and the flight itself. A fixed-step
// arcade-true simulation: the wing lifts when the air moves fast enough, a banked
// wing turns the nose, fuel burns, firm arrivals bend the aeroplane, and the
// circuit is scored when the wheels stop back on the home strip.
import { CIRCUIT, FIELD, PLANE, SCORE, STEP, WORLD_HALF } from './config.js';

/** Flight phases, named for the screens the renderer draws over them. */
export const PHASE_TITLE = 'title';
export const PHASE_FLYING = 'flying';
export const PHASE_FINISHED = 'finished';
export const PHASE_CRASHED = 'crashed';

/** Step events, bit flags, so a caller can react to the moment something happens. */
export const EVENT_LIFTOFF = 1;
export const EVENT_RING = 2;
export const EVENT_TOUCHDOWN = 4;
export const EVENT_FINISHED = 8;
export const EVENT_CRASHED = 16;

/** Gear height: the fuselage reference point rides this far above the ground. */
const GEAR = 1.15;
/** A generous par for the circuit, seconds; beating it earns the time bonus. */
const PAR_TIME = 470;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Smallest signed difference between two headings, radians. */
function headingDelta(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Create a flight on a world. The plane starts parked at the south end of the
 * strip, engine off, full tanks, facing north — the way every flight here begins.
 */
export function createFlight(world) {
  const state = {
    phase: PHASE_TITLE,
    x: FIELD.x,
    y: FIELD.height + GEAR,
    z: FIELD.zTo - 90,
    heading: 0, // radians, 0 = north, clockwise from above
    pitch: 0,
    roll: 0,
    speed: 0,
    vy: 0,
    throttle: 0,
    flap: false,
    onGround: true,
    stalled: false,
    fuel: PLANE.fuelCapacity,
    damage: 0,
    ringsCleared: 0,
    ringSide: -1, // which side of the target ring's plane we were last on
    time: 0,
    airborneTime: 0,
    airStint: 0, // seconds since this particular liftoff; arrivals need a real flight first
    hasTakenOff: false,
    touchdown: null, // the verdict of the last arrival: {quality, note}
    score: null,
    message: '',
    messageTime: 0,
  };

  /** The ring the pilot should be aiming at, or null once the circuit is done. */
  function targetRing() {
    return state.ringsCleared < world.rings.length ? world.rings[state.ringsCleared] : null;
  }

  /** Grade an arrival the moment the wheels meet the ground; may end the flight. */
  function judgeTouchdown(events) {
    const ground = world.heightAt(state.x, state.z);
    const onStrip = Math.abs(state.x - FIELD.x) <= FIELD.width / 2 + 8
      && state.z >= FIELD.zFrom - 60 && state.z <= FIELD.zTo + 60;
    const slope = 1 - world.groundNormal(state.x, state.z).y;
    const sink = -state.vy;
    let quality = 'good';
    let note = 'A gentle arrival.';
    if (ground <= world.waterY + 0.5 && !onStrip) {
      state.phase = PHASE_CRASHED;
      state.message = 'Down in the river. The Emberwing floats, briefly.';
      return events | EVENT_CRASHED;
    }
    if (!onStrip && state.speed > 34) {
      state.phase = PHASE_CRASHED;
      state.message = 'Far too fast to put down away from the strip.';
      return events | EVENT_CRASHED;
    }
    if (sink > PLANE.crashLanding + 1.4 || Math.abs(state.roll) > 0.55 || slope > 0.42) {
      state.phase = PHASE_CRASHED;
      state.message = 'That arrival was more than the airframe could take.';
      return events | EVENT_CRASHED;
    }
    if (sink > PLANE.firmLanding) {
      quality = 'firm';
      note = 'Firm — the gear felt that one.';
      state.damage = Math.min(100, state.damage + (sink - PLANE.firmLanding) * 9);
    } else if (sink <= 1.7) {
      quality = 'greased';
      note = 'Greased it on.';
    }
    if (!onStrip) {
      quality = quality === 'greased' ? 'field' : quality;
      note = 'Down in the field, away from the strip.';
      state.damage = Math.min(100, state.damage + 6);
    }
    if (Math.abs(headingDelta(state.heading, Math.PI)) < 0.4 && onStrip) {
      note += ' (Downwind, mind — the strip runs north.)';
    }
    state.touchdown = { quality, note, onStrip };
    return events | EVENT_TOUCHDOWN;
  }

  /** Work out the final score once the wheels have stopped at home. */
  function finishFlight() {
    const t = state.touchdown;
    let score = state.ringsCleared * SCORE.perRing;
    if (t && t.onStrip) score += t.quality === 'firm' ? SCORE.landingFirm : SCORE.landingGood;
    else if (t) score += 40;
    score += Math.round(state.fuel) * CIRCUIT.fuelBonusPerLitre;
    score += Math.max(0, Math.round((PAR_TIME - state.airborneTime) * 1.5));
    score -= Math.round(state.damage) * SCORE.damagePerPoint;
    state.score = Math.max(0, Math.round(score));
    state.phase = PHASE_FINISHED;
    state.message = t ? t.note : '';
  }

  /**
   * Advance the flight one fixed step under `controls`
   * ({pitch, roll, yaw in -1..1, throttle 0..1, brake, flap}) and return events.
   */
  function step(controls) {
    let events = 0;
    if (state.phase === PHASE_FINISHED || state.phase === PHASE_CRASHED) return events;
    if (state.phase === PHASE_TITLE) state.phase = PHASE_FLYING;
    const dt = STEP;
    state.time += dt;
    if (state.messageTime > 0) state.messageTime -= dt;

    state.throttle = clamp(controls.throttle, 0, 1);
    state.flap = Boolean(controls.flap);
    const engineOn = state.fuel > 0;
    if (!state.onGround || state.throttle > 0) {
      state.fuel = Math.max(0, state.fuel - PLANE.fuelBurn * (0.3 + 0.7 * state.throttle) * dt * (engineOn ? 1 : 0));
    }

    // Control authority grows with airflow; on the ground the rudder steers instead.
    const authority = clamp(state.speed / 30, 0.22, 1);
    const targetRoll = controls.roll * 1.02;
    const rollStep = PLANE.rollRate * authority * dt;
    state.roll += clamp(targetRoll - state.roll, -rollStep, rollStep);
    state.pitch += controls.pitch * PLANE.pitchRate * authority * dt;
    if (state.onGround && controls.pitch === 0) {
      state.pitch += clamp(0 - state.pitch, -0.5 * dt, 0.5 * dt); // the nose settles on the gear
    }
    state.pitch = clamp(state.pitch, state.onGround ? -0.05 : -0.95, 0.72);
    if (state.onGround) {
      state.heading += controls.yaw * clamp(state.speed / 14, 0, 1) * 0.55 * dt;
      state.roll *= 1 - Math.min(1, 4 * dt);
    } else {
      const turn = Math.sin(state.roll) * PLANE.turnPerBank * clamp(state.speed / PLANE.cruiseSpeed, 0.3, 1.35);
      state.heading += (turn + controls.yaw * PLANE.yawRate * authority) * dt;
      state.airborneTime += dt;
      state.airStint += dt;
    }

    // Speed: thrust against drag, gravity trading height for pace along the pitch.
    const power = engineOn ? state.throttle * PLANE.thrustAccel : 0;
    let drag = PLANE.thrustAccel * (state.speed / PLANE.maxSpeed) ** 2;
    if (state.flap) drag += 0.55 + state.speed * 0.012;
    if (state.onGround && controls.brake) drag += 2.4;
    if (state.onGround) drag += 0.25; // rolling resistance
    state.speed += (power - drag - PLANE.gravity * Math.sin(state.pitch) * (state.onGround ? 0 : 1)) * dt;
    state.speed = Math.max(0, state.speed);

    // Vertical: the wing carries the aeroplane when the air is fast enough.
    const stallSpeed = PLANE.stallSpeed * (state.flap ? 0.84 : 1);
    state.stalled = !state.onGround && state.speed < stallSpeed;
    let vyTarget;
    if (state.onGround) vyTarget = 0;
    else if (state.stalled) vyTarget = -PLANE.stallSink + Math.sin(state.pitch) * state.speed * 0.35;
    else vyTarget = Math.sin(state.pitch) * state.speed;
    const vyRate = state.stalled ? 2.2 : 3.4;
    state.vy += clamp(vyTarget - state.vy, -vyRate * dt * 10, vyRate * dt * 10);

    // Move.
    const vh = Math.cos(state.pitch) * state.speed;
    state.x += Math.sin(state.heading) * vh * dt;
    state.z += -Math.cos(state.heading) * vh * dt;
    state.y += state.vy * dt;
    state.x = clamp(state.x, -WORLD_HALF + 30, WORLD_HALF - 30);
    state.z = clamp(state.z, -WORLD_HALF + 30, WORLD_HALF - 30);

    // The ground, met three ways: taking off, arriving, or hitting it.
    const ground = world.heightAt(state.x, state.z) + GEAR;
    if (state.onGround) {
      state.y = ground;
      state.vy = 0;
      // Rolling fast with the nose raised, the wing takes the weight: she flies.
      if (state.speed > stallSpeed * 1.02 && state.pitch > 0.1) {
        state.onGround = false;
        state.hasTakenOff = true;
        state.airStint = 0;
        state.vy = Math.sin(state.pitch) * state.speed * 0.45;
        events |= EVENT_LIFTOFF;
      }
    }
    if (!state.onGround && state.y <= ground && state.airStint > 0.4) {
      state.y = ground;
      events = judgeTouchdown(events);
      if (state.phase === PHASE_CRASHED) return events;
      state.onGround = true;
      state.vy = 0;
      state.pitch = Math.max(0, state.pitch);
    }
    if (state.onGround && state.hasTakenOff && state.speed < 0.6 && state.touchdown) {
      finishFlight();
      events |= EVENT_FINISHED;
    }

    // Rings: crossing the target's plane inside its radius counts, in order.
    const ring = targetRing();
    if (ring && !state.onGround) {
      const dx = state.x - ring.x;
      const dy = state.y - ring.y;
      const dz = state.z - ring.z;
      const side = dx * ring.dirX + dz * ring.dirZ;
      if (state.ringSide < 0 && side >= 0) {
        const along = side;
        const px = dx - ring.dirX * along;
        const pz = dz - ring.dirZ * along;
        const radial = Math.hypot(px, dy, pz);
        if (radial <= CIRCUIT.ringRadius) {
          state.ringsCleared += 1;
          state.ringSide = -1;
          state.message = state.ringsCleared >= world.rings.length
            ? 'Circuit complete — bring her home.'
            : `Ring ${state.ringsCleared} of ${world.rings.length}.`;
          state.messageTime = 3.2;
          events |= EVENT_RING;
        }
      }
      if (Math.abs(side) > 1) state.ringSide = Math.sign(side);
    } else if (ring) {
      const dx = state.x - ring.x;
      const dz = state.z - ring.z;
      state.ringSide = Math.sign(dx * ring.dirX + dz * ring.dirZ) || -1;
    }

    if (state.damage >= 100) {
      state.phase = PHASE_CRASHED;
      state.message = 'The airframe gave up.';
      events |= EVENT_CRASHED;
    }
    return events;
  }

  /** Put the aeroplane back on the strip, ready to fly again. */
  function reset() {
    const fresh = createFlight(world).state;
    Object.assign(state, fresh);
  }

  return { state, step, reset, targetRing };
}

export { PAR_TIME };
