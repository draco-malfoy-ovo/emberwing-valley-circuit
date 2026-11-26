// Emberwing — Valley Circuit: the pilot's hands. Keyboard controls with smoothed
// stick axes, a throttle that stays where it is left, and edge-triggered toggles
// (flaps, camera, restart) the main loop can consume once per press.

/** Keys that steer: arrows fly the aeroplane, A/D work the rudder. */
const AXIS_KEYS = {
  pitchUp: ['ArrowUp'],
  pitchDown: ['ArrowDown'],
  rollLeft: ['ArrowLeft'],
  rollRight: ['ArrowRight'],
  rudderLeft: ['KeyA', 'KeyQ'],
  rudderRight: ['KeyD', 'KeyE'],
};

/**
 * Create the input state and start listening. `controls` is a live object the
 * flight model reads each step; `pressed` reports a key's fresh press once.
 */
export function createInput() {
  const held = new Set();
  const fresh = new Set();
  const controls = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: false, flap: false,
  };
  let throttleKeys = 0; // -1 idle-ward, +1 full-ward, while W/S are held

  function onKey(down) {
    return (event) => {
      if (event.repeat) {
        if (down) event.preventDefault();
        return;
      }
      if (down) {
        held.add(event.code);
        fresh.add(event.code);
      } else {
        held.delete(event.code);
      }
      if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
    };
  }
  const down = onKey(true);
  const up = onKey(false);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);

  const anyHeld = (codes) => codes.some((code) => held.has(code));

  /** Move the smoothed axes and the throttle toward what the keys ask for. */
  function update(dt) {
    const drive = (current, positive, negative) => {
      const target = (anyHeld(positive) ? 1 : 0) - (anyHeld(negative) ? 1 : 0);
      const rate = target === 0 ? 2.6 : 3.4; // centres a touch slower than it deflects
      const next = current + Math.max(-rate * dt, Math.min(rate * dt, target - current));
      return Math.max(-1, Math.min(1, next));
    };
    // Pull back (ArrowDown) raises the nose, as a stick does; ArrowUp pushes it down.
    controls.pitch = drive(controls.pitch, AXIS_KEYS.pitchDown, AXIS_KEYS.pitchUp);
    controls.roll = drive(controls.roll, AXIS_KEYS.rollRight, AXIS_KEYS.rollLeft);
    controls.yaw = drive(controls.yaw, AXIS_KEYS.rudderRight, AXIS_KEYS.rudderLeft);
    throttleKeys = (anyHeld(['KeyW']) ? 1 : 0) - (anyHeld(['KeyS']) ? 1 : 0);
    controls.throttle = Math.max(0, Math.min(1, controls.throttle + throttleKeys * 0.55 * dt));
    if (fresh.has('Digit0')) controls.throttle = 0;
    if (fresh.has('Digit1')) controls.throttle = 1;
    controls.brake = anyHeld(['Space', 'KeyB']);
    if (fresh.has('KeyF')) controls.flap = !controls.flap;
  }

  /** True once per fresh press of a key code since the last call. */
  function pressed(code) {
    const was = fresh.has(code);
    if (was) fresh.delete(code);
    return was;
  }

  /** Clear the per-frame press set (call at the end of each frame). */
  function endFrame() {
    fresh.clear();
  }

  return { controls, update, pressed, endFrame };
}
