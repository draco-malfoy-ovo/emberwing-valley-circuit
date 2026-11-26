// Emberwing — Valley Circuit: shared constants. One place for the numbers every other
// file agrees on: the world's size, the airfield, the fixed step and the palette.

/** Fixed simulation step, seconds. The world advances in these and nothing else. */
export const STEP = 1 / 60;

/** The world is a square this many metres across, centred on (0, 0). */
export const WORLD_SIZE = 6400;
/** Half the world: flyable ground runs from -WORLD_HALF to +WORLD_HALF on x and z. */
export const WORLD_HALF = WORLD_SIZE / 2;

/** The airfield plateau: flat ground the runway sits on. */
export const FIELD = {
  x: -520, // centre of the runway strip, east-west position
  zFrom: 620, // south end of the runway
  zTo: 1980, // north end of the runway
  width: 46, // runway tarmac width in metres
  height: 42, // plateau altitude in metres
  heading: 0, // take off toward -z (north); heading degrees, 0 = north
};

/** Sea level of the valley river and the lake, metres. */
export const WATER_LEVEL = 13;

/** Dawn-gold palette the whole scene is lit in; sky top, horizon and fog. */
export const SKY = {
  top: [0.16, 0.32, 0.55],
  horizon: [0.98, 0.72, 0.45],
  fog: [0.92, 0.68, 0.47],
  fogNear: 900,
  fogFar: 5200,
  sunDir: [-0.45, 0.38, -0.62], // toward the sun, normalised by the engine
  sunTint: [1.0, 0.83, 0.62],
};

/** The one world seed: the valley is the same valley for every pilot and every screenshot. */
export const WORLD_SEED = 20261126;

/** The aeroplane: a small high-wing tourer, and the numbers that make it fly like one. */
export const PLANE = {
  /** Airspeeds, metres per second: stall, comfortable cruise, never-exceed. */
  stallSpeed: 21,
  cruiseSpeed: 42,
  maxSpeed: 78,
  /** Engine: full-throttle acceleration along the nose, and the drag that caps it. */
  thrustAccel: 7.5,
  /** Fuel tank in litres and full-throttle burn in litres per second. */
  fuelCapacity: 62,
  fuelBurn: 0.055,
  /** Control authority: radians per second at cruise, scaled by airflow over the tail. */
  pitchRate: 0.85,
  rollRate: 1.9,
  yawRate: 0.22,
  /** How hard a banked wing turns the nose, radians per second per radian of bank. */
  turnPerBank: 0.55,
  /** Gravity, and the sink a stalled wing gives back. */
  gravity: 9.81,
  stallSink: 7.5,
  /** Touchdown vertical speed that starts to bend the aeroplane, metres per second. */
  firmLanding: 2.6,
  crashLanding: 5.2,
  /** The camera: metres behind and above the tail in chase view. */
  cameraBack: 13.5,
  cameraUp: 4.2,
};

/** The circuit: how many rings, and the radius a crossing is measured against. */
export const CIRCUIT = {
  rings: 8,
  ringRadius: 26,
  /** Seconds a clean crossing is worth, and the bonus for bringing fuel home. */
  ringSeconds: 12,
  fuelBonusPerLitre: 6,
};

/** Score bookkeeping: the flight is graded out of a clean 1000 plus time bonuses. */
export const SCORE = {
  base: 1000,
  perRing: 90,
  landingGood: 220,
  landingFirm: 90,
  damagePerPoint: 4,
};
