// Emberwing — Valley Circuit: the main loop. Wires the world, the flight, the
// pilot's hands and the renderer together; runs the fixed-step simulation behind
// requestAnimationFrame; and stages the deterministic ?shot= scenes the
// screenshots are taken from.
import { STEP, WORLD_SEED } from './config.js';
import { createFlight, PHASE_CRASHED, PHASE_FINISHED, PHASE_TITLE } from './flight.js';
import { createInput } from './input.js';
import { createRenderer } from './render.js';
import { stageShot } from './shots.js';
import { createWorld } from './world.js';

const canvas = document.getElementById('game');
const status = document.getElementById('status');
const renderer = createRenderer(canvas);

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

const params = new URLSearchParams(window.location.search);
const seed = Number(params.get('seed')) || WORLD_SEED;
const world = createWorld(seed);
const flight = createFlight(world);
const { state } = flight;

let best = 0;
try {
  best = Number(window.localStorage.getItem('emberwing-best')) || 0;
} catch {
  best = 0; // storage can be unavailable; the session best still counts
}

// Screenshot mode: stage the scene, paint exactly one frame, say when it is ready.
if (params.has('shot')) {
  fitCanvas();
  const screen = stageShot(params.get('shot'), flight, world);
  renderer.draw(world, state, { screen, best: 0, cockpit: false, now: 0.4 });
  window.__shotReady = true;
} else {
  window.__flight = flight; // a handle for headless smoke tests; the game ignores it
  const input = createInput();
  let cockpit = false;
  let last = performance.now();
  let carry = 0;
  let shownPhase = state.phase;

  function frame(nowMs) {
    const now = nowMs / 1000;
    fitCanvas();
    let elapsed = Math.min(0.1, (nowMs - last) / 1000);
    last = nowMs;
    input.update(elapsed);
    if (input.pressed('KeyC')) cockpit = !cockpit;
    if (input.pressed('KeyR') && state.phase !== PHASE_TITLE) flight.reset();

    if (state.phase === PHASE_TITLE) {
      if (input.pressed('Enter')) flight.step(input.controls); // the first step lifts the title
    } else {
      carry += elapsed;
      while (carry >= STEP) {
        flight.step(input.controls);
        carry -= STEP;
        if (state.phase === PHASE_FINISHED || state.phase === PHASE_CRASHED) {
          carry = 0;
          break;
        }
      }
      if ((state.phase === PHASE_FINISHED || state.phase === PHASE_CRASHED) && input.pressed('Enter')) {
        flight.reset();
      }
    }
    if (state.phase === PHASE_FINISHED && state.score !== null && state.score > best) {
      best = state.score;
      try {
        window.localStorage.setItem('emberwing-best', String(best));
      } catch { /* the session best is already kept */ }
    }
    if (state.phase !== shownPhase) {
      shownPhase = state.phase;
      status.textContent = shownPhase === PHASE_TITLE
        ? 'Emberwing, Valley Circuit. Press Enter to fly.'
        : shownPhase === PHASE_FINISHED
          ? `Flight complete. Score ${state.score}.`
          : shownPhase === PHASE_CRASHED
            ? 'The aeroplane is down in the valley.'
            : 'Flying.';
    }
    renderer.draw(world, state, { screen: state.phase, best, cockpit, now });
    input.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
