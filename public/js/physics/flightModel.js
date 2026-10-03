// public/js/physics/flightModel.js
// ---------------------------------------------------------------------------
// 737-800 flight dynamics — pure math, no rendering, no DOM, no THREE import.
// Equations follow ~/workspace/flight-model-reference.md; constants match
// js/core/config.js AIRCRAFT (imported for OEW / max fuel / thrust ratings).
//
// Frames
//   World: ENU, x=east, y=up, z=south (north = -z), meters. (see core/geo.js)
//   Body:  x=forward, y=right(starboard), z=down. Right-handed.
//   state.quat maps reference-pose vectors into world-frame vectors:
//     nose  = q * (0,0,-1),  right wing = q * (1,0,0),  belly = q * (0,-1,0).
//   Identity quat = nose true-north, wings level, belly down.
//
// Body-rate sign convention (deg/s, stored in state._p/_q/_r):
//   _p (roll)  > 0 : right wing goes down
//   _q (pitch) > 0 : nose goes up
//   _r (yaw)   > 0 : nose goes right (heading increases)
//
// State vectors are plain {x,y,z} / {x,y,z,w} objects (no THREE dependency).
// They are copy()-compatible with THREE.Vector3/Quaternion (.x/.y/.z/.w).
//
// NOTE for main.js: spawn the aircraft with pos.y = groundElevM + 3.75
// (gear-extended, struts at static compression). Spawning at 3.9 works too but
// produces a ~1 s settle transient; a hard strut-compression clamp keeps any
// bad spawn from exploding.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { MS_TO_KT, M_TO_FT } from '../core/geo.js';
import { AIRCRAFT } from '../core/config.js';

// --- constants -------------------------------------------------------------
const DEG = Math.PI / 180;
const G = 9.80665;          // m/s^2
const RHO0 = 1.225;         // kg/m^3 sea-level ISA
const R_AIR = 287.05;       // J/(kg*K)

const S = 124.6;                       // wing area, m^2
const AR = 10.28;                      // aspect ratio
const EFF = 0.80;                      // Oswald efficiency
const CD0 = 0.025;                     // clean parasite drag
const CLA = 0.087;                     // lift slope, per deg
const SPAN = AIRCRAFT.wingspanM;       // 35.79 m
const T0 = AIRCRAFT.engines[0].maxThrustN; // 121400 N per engine (CFM56-7B27)
const OEW = AIRCRAFT.oewKg;            // 41413 kg
const MAXFUEL = AIRCRAFT.maxFuelKg;    // ~20892 kg

const GEAR_REST = 3.9;      // CG height above ground, gear down, uncompressed (m)
const GEAR_TRAVEL = 0.45;   // max oleo compression (m)
const WHEELBASE = 12.0;     // nose-gear to main-gear distance (m)

const FIXED_DT_MAX = 0.05;

// Flap tables per detent index 0..8 -> degrees [0,1,2,5,10,15,25,30,40]
const DETENT_DEG = [0, 1, 2, 5, 10, 15, 25, 30, 40];
const F_DCL0   = [0, 0.15, 0.25, 0.40, 0.60, 0.75, 1.00, 1.10, 1.20];
const F_DCLMAX = [0, 0.10, 0.18, 0.30, 0.42, 0.55, 0.70, 0.75, 0.85];
const F_DCD0   = [0, 0.004, 0.006, 0.010, 0.016, 0.022, 0.035, 0.045, 0.060];
const F_STALLR = [0, 0, 0.2, 0.5, 0.8, 1.0, 1.3, 1.5, 2.0]; // stall-AoA reduction (deg)

// --- tiny helpers ----------------------------------------------------------
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

// linear interpolation over a detent-indexed table (d may be fractional)
function detentInterp(table, d) {
  d = clamp(d, 0, 8);
  const i = Math.min(7, Math.floor(d));
  const f = d - i;
  return table[i] * (1 - f) + table[i + 1] * f;
}

// rotate vector (x,y,z) by unit quaternion q={x,y,z,w}; result into out{x,y,z}
function rotVec(q, x, y, z, out) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

function finiteOr(v, fallback) {
  return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}

// ---------------------------------------------------------------------------
export function createFlightModel() {

  function recomputeMass(state) {
    state.massKg = OEW + Math.max(0, state.fuelKg) + Math.max(0, state.payloadKg);
  }

  function createState() {
    const state = {
      pos: new THREE.Vector3(),          // world m (x=east, y=up, z=south)
      vel: new THREE.Vector3(),          // world m/s
      quat: new THREE.Quaternion(),      // body -> world
      heading: 0, pitch: 0, roll: 0,      // deg, derived (heading TRUE)

      payloadKg: 15000,
      massKg: 0, fuelKg: 0,               // filled below
      n1: [0.22, 0.22],                   // fan speed fraction per engine
      egtC: [420, 420],                   // exhaust gas temp per engine
      fuelFlowKgH: [300, 300],            // per engine
      throttle: [0, 0],                   // actual lever position (lags control)

      flapDetent: 0,                      // continuous 0..8
      flapAngleDeg: 0,
      gearDown: true, gearPos: 1,         // gearPos animates toward gearDown
      spoilers: 0,                        // 0..1
      speedbrakeArmed: false,
      reversersDeployed: 0,               // 0..1 continuous (transit); bool-ish
      brakes: 0, parkingBrake: true,

      onGround: true, aglM: 0,
      iasKt: 0, gsKt: 0, tasKt: 0, altFtMSL: 0, vsFpm: 0,
      aoaDeg: 0, stallWarn: false, overspeed: false,

      ap: {
        hdgSel: null, altSelFt: null, vsSelFpm: 0, spdSelKt: null,
        atArmed: false, apEngaged: false, fdOn: false,
      },

      // internal (not part of the shared contract)
      _t: 0,
      _p: 0, _q: 0, _r: 0,                // body rates, deg/s
      _wasStalled: false,
      _gearWarned: false,
      _lastOverspeed: -99,
      _spdAuto: false,                    // auto-deployed speedbrake latch
      _prevOnGround: true,
    };
    state.fuelKg = 0.35 * MAXFUEL;
    recomputeMass(state);
    return state;
  }

  function setPayload(state, kg) {
    state.payloadKg = clamp(finiteOr(kg, 15000), 0, 25000);
    recomputeMass(state);
  }

  // -------------------------------------------------------------------------
  function step(state, controls, env, dt) {
    const events = [];
    if (!(dt > 0)) return events;
    dt = Math.min(dt, FIXED_DT_MAX);
    state._t += dt;
    const t = state._t;

    const rho = Math.max(0.05, finiteOr(env.airDensity, RHO0));
    const oatC = finiteOr(env.oatC, 15);
    const groundY = finiteOr(env.groundElevM, 0);
    const wind = env.wind || { x: 0, y: 0, z: 0 };
    const fr = (env.runwayFriction == null) ? 1 : Math.max(0.2, env.runwayFriction);

    // --- 1. control mirrors (lever/switch transit) --------------------------
    const thrCmd = controls.throttle || [0, 0];
    const thrLag = 1 - Math.exp(-dt / 0.4);
    for (let i = 0; i < 2; i++) {
      state.throttle[i] = clamp(
        state.throttle[i] + (clamp(finiteOr(thrCmd[i], 0), 0, 1) - state.throttle[i]) * thrLag,
        0, 1);
    }

    const flapCmd = clamp(finiteOr(controls.flaps, state.flapDetent), 0, 8);
    // flap transit: 0.25 detent-index per second (~32 s full travel)
    state.flapDetent = clamp(state.flapDetent + clamp(flapCmd - state.flapDetent, -0.25 * dt, 0.25 * dt), 0, 8);
    state.flapAngleDeg = detentInterp(DETENT_DEG, state.flapDetent);

    state.gearDown = !!controls.gearDown;
    const gearTarget = state.gearDown ? 1 : 0;
    state.gearPos = clamp(state.gearPos + clamp(gearTarget - state.gearPos, -dt / 8, dt / 8), 0, 1);

    const spoilCmd = clamp(finiteOr(controls.spoilers, 0), 0, 1);
    // Auto-deployed speedbrake latch: manual lever-up, liftoff, or full
    // takeoff thrust on the ground all hand control back to the lever.
    if (spoilCmd > 0.5) state._spdAuto = false;
    if (!state.onGround) state._spdAuto = false;
    // state.onGround still holds the PREVIOUS step's value here (it is updated
    // later in this step), which is what the latch logic wants.
    if (state.onGround && state.throttle[0] > 0.85 && state.throttle[1] > 0.85) {
      state._spdAuto = false;   // takeoff roll: stow auto-deployed panels
    }
    const spoilTarget = Math.max(spoilCmd, state._spdAuto ? 1 : 0);
    state.spoilers = clamp(state.spoilers + clamp(spoilTarget - state.spoilers, -3 * dt, 3 * dt), 0, 1);
    state.speedbrakeArmed = !!controls.armSpoilers;

    const revTarget = controls.reversers ? 1 : 0;
    state.reversersDeployed = clamp(
      state.reversersDeployed + clamp(revTarget - state.reversersDeployed, -dt / 1.5, dt / 1.5), 0, 1);

    state.parkingBrake = !!controls.parkingBrake;
    state.brakes = Math.max(clamp(finiteOr(controls.brakes, 0), 0, 1), state.parkingBrake ? 1 : 0);

    // --- 2. engines: N1 spool, EGT, fuel flow, fuel burn --------------------
    const flameout = state.fuelKg <= 0;
    for (let i = 0; i < 2; i++) {
      const n1Target = flameout ? 0 : 0.22 + 0.82 * state.throttle[i]; // max 1.04
      const tau = n1Target > state.n1[i] ? 4 : 6;
      state.n1[i] += (n1Target - state.n1[i]) * (1 - Math.exp(-dt / tau));
      state.n1[i] = clamp(state.n1[i], 0, 1.1);

      const n1f = clamp((state.n1[i] - 0.22) / 0.82, 0, 1);
      const egtTarget = 420 + 480 * n1f;                    // 420 idle -> 900 max
      state.egtC[i] += (egtTarget - state.egtC[i]) * (1 - Math.exp(-dt / 4));

      state.fuelFlowKgH[i] = flameout ? 0 : 300 + 3100 * Math.pow(n1f, 1.6);
    }
    const burnKg = (state.fuelFlowKgH[0] + state.fuelFlowKgH[1]) / 3600 * dt;
    state.fuelKg = Math.max(0, state.fuelKg - burnKg);
    recomputeMass(state);
    const m = state.massKg;

    // --- 3. air data ---------------------------------------------------------
    const avx = state.vel.x - (wind.x || 0);
    const avy = state.vel.y - (wind.y || 0);
    const avz = state.vel.z - (wind.z || 0);
    const V = Math.sqrt(avx * avx + avy * avy + avz * avz);
    const Vs = Math.max(V, 1);

    // body basis in world frame (reference-pose convention, see header)
    const F = { x: 0, y: 0, z: 0 };   // nose direction
    const R = { x: 0, y: 0, z: 0 };   // right wing direction
    const D = { x: 0, y: 0, z: 0 };   // belly direction
    rotVec(state.quat, 0, 0, -1, F);
    rotVec(state.quat, 1, 0, 0, R);
    rotVec(state.quat, 0, -1, 0, D);

    const u = avx * F.x + avy * F.y + avz * F.z;   // forward  (+)
    const v = avx * R.x + avy * R.y + avz * R.z;   // right    (+)
    const w = avx * D.x + avy * D.y + avz * D.z;   // down     (+)

    let alphaD = Math.atan2(w, u) / DEG;           // angle of attack, deg (-180,180]
    // Fold into [-90, 90] for the aero model; flag reversed flow (u < 0).
    // Without the fold, a tiny backward drift while parked reads as alpha=±180°
    // and would false-trigger the stall logic.
    const reversedFlow = u < 0;
    let alphaEff = alphaD;
    if (alphaD > 90) alphaEff = 180 - alphaD;
    else if (alphaD < -90) alphaEff = -180 - alphaD;
    alphaEff = clamp(alphaEff, -90, 90);
    const betaR = Math.asin(clamp(v / Vs, -1, 1)); // sideslip, rad

    const dynP = 0.5 * rho * V * V;
    const aSound = Math.sqrt(1.4 * R_AIR * Math.max(180, oatC + 273.15));
    const Mach = V / aSound;
    const iasMs = Math.sqrt(2 * dynP / RHO0);
    state.iasKt = iasMs * MS_TO_KT;
    state.tasKt = V * MS_TO_KT;

    // --- 4. lift / drag ------------------------------------------------------
    // ground contact state first (needed for lift dump + stall gating)
    const hWheel = state.pos.y - groundY;
    const wasGround = state._prevOnGround;
    const contactThresh = wasGround ? GEAR_REST + 0.30 : GEAR_REST + 0.02;
    const onGround = hWheel <= contactThresh;

    const dCL0 = detentInterp(F_DCL0, state.flapDetent);
    const dCLmaxT = detentInterp(F_DCLMAX, state.flapDetent);
    const dCD0f = detentInterp(F_DCD0, state.flapDetent);
    const stallRed = detentInterp(F_STALLR, state.flapDetent);

    const alpha0 = -3;                    // zero-lift angle, deg (all configs)
    const aStall = 15 - stallRed;
    const CLmax = CLA * (15 - alpha0) + dCLmaxT;   // clean 1.57, Flaps30 2.32
    // Effective lift slope chosen so the linear curve hits exactly CLmax at
    // aStall (continuous polar, mild slope reduction with flaps).
    const CLAeff = (CLmax - dCL0) / (aStall - alpha0);
    // aeroStall drives the CL/CD polars; `stalled` (warning/event/buffet) is
    // additionally inhibited on the ground via the squat-switch equivalent.
    const aeroStalled = !reversedFlow && alphaEff > aStall;
    const stalled = aeroStalled && !onGround;
    let CL, revDrag = 0;
    if (reversedFlow) {
      CL = 0;                 // separated bluff-body flow: no lift, big drag
      revDrag = 0.6;
    } else if (!aeroStalled) {
      CL = CLAeff * (alphaEff - alpha0) + dCL0;
    } else {
      CL = Math.max(0.5 * CLmax, CLmax - 0.04 * (alphaEff - aStall));
    }

    if (onGround) CL *= (1 - 0.5 * state.spoilers);   // lift dump

    let CD = CD0 + dCD0f + state.gearPos * 0.025 + state.spoilers * 0.04;
    const CDi = (CL * CL) / (Math.PI * AR * EFF);
    // ground effect: induced-drag multiplier sigma(h/b)
    let sigma = 1;
    const hAG = Math.max(0, hWheel);
    if (hAG < SPAN) {
      const hb = Math.max(hAG, 0.5) / SPAN;
      sigma = 1 - Math.exp(-2.48 * Math.pow(2 * hb, 0.768));
    }
    CD += CDi * sigma;
    CD += revDrag;
    if (aeroStalled) CD += 0.08 * Math.pow((alphaEff - aStall) / 5, 2);
    if (Mach > 0.78) CD += 2.0 * (Mach - 0.78) * (Mach - 0.78);

    const Lift = dynP * S * CL;
    const Drag = dynP * S * CD;
    const Side = dynP * S * (-0.30) * betaR;   // small weathervane side force

    // --- 5. thrust ------------------------------------------------------------
    const lapse = Math.pow(Math.max(rho, 0.01) / RHO0, 0.7);
    const ramF = Math.max(0, 1 - 0.25 * Mach);
    let thrust = 0;
    for (let i = 0; i < 2; i++) {
      // idle offset 0.05: throttle 0 == ground idle (~3-5% T0 per reference §3),
      // which lets the jet creep at idle like the real aircraft.
      let Ti = flameout ? 0 : T0 * lapse * ramF * (0.05 + 0.95 * state.throttle[i]);
      if (state.reversersDeployed > 0 && onGround) Ti *= (1 - 1.65 * state.reversersDeployed);
      thrust += Ti;
    }

    // --- 6. forces: body -> world --------------------------------------------
    const inv = 1 / Vs;
    const Fbx = thrust - Drag * (u * inv);
    const Fby = Side - Drag * (v * inv);
    const Fbz = -Lift - Drag * (w * inv);

    let Fx = Fbx * F.x + Fby * R.x + Fbz * D.x;
    let Fy = Fbx * F.y + Fby * R.y + Fbz * D.y - m * G;
    let Fz = Fbx * F.z + Fby * R.z + Fbz * D.z;

    // --- 7. ground: strut spring, friction, steering --------------------------
    let N = 0;
    const vsFpmNow = state.vel.y * 196.85;
    if (onGround) {
      const kSpring = m * G / 0.15;
      const cDamp = 2 * 0.35 * Math.sqrt(kSpring * m);
      const comp = clamp(GEAR_REST - hWheel, 0, GEAR_TRAVEL);
      const compRate = -state.vel.y;             // > 0 while compressing
      N = Math.max(0, kSpring * comp + cDamp * compRate);
      Fy += N;

      // horizontal velocity + steered wheel direction
      const hvx = state.vel.x, hvz = state.vel.z;
      const Vg = Math.hypot(hvx, hvz);
      const Vkt = Vg * MS_TO_KT;
      let fhx = F.x, fhz = F.z;
      const fhn = Math.hypot(fhx, fhz) || 1;
      fhx /= fhn; fhz /= fhn;

      const maxSteerDeg = Vkt < 60 ? 70 : Vkt > 100 ? 0 : 70 * (100 - Vkt) / 40;
      const steer = (controls.yaw || 0) * maxSteerDeg * DEG;
      const cs = Math.cos(steer), sn = Math.sin(steer);
      const wx = fhx * cs - fhz * sn;
      const wz = fhx * sn + fhz * cs;

      const vW = hvx * wx + hvz * wz;
      const vLx = hvx - wx * vW, vLz = hvz - wz * vW;
      const vL = Math.hypot(vLx, vLz);

      const muF = 0.02 + state.brakes * 0.5 * fr;
      const fLong = muF * N * Math.tanh(vW / 0.6);
      Fx += -wx * fLong;
      Fz += -wz * fLong;
      if (vL > 1e-9) {
        const fLat = 0.8 * N * Math.tanh(vL / 0.6);
        Fx += -(vLx / vL) * fLat;
        Fz += -(vLz / vL) * fLat;
      }

      // touchdown / liftoff events
      if (!wasGround) {
        if (vsFpmNow < -50) {
          events.push({ type: 'touchdown', vs: Math.round(vsFpmNow) });
          if (state.speedbrakeArmed) {
            state._spdAuto = true;
            state.speedbrakeArmed = false;
          }
        }
      }

      // store steering for the rotational section
      state._steerRad = steer;
      state._Vg = Vg;
    } else {
      if (wasGround && vsFpmNow > 100) events.push({ type: 'liftoff' });
      state._steerRad = 0;
      state._Vg = Math.hypot(state.vel.x, state.vel.z);
    }
    state._prevOnGround = onGround;
    state.onGround = onGround;

    // gear warning: landing flaps selected but gear not down, low and slow.
    // (Flap-gated so the normal post-takeoff retraction never triggers it.)
    const aglM = Math.max(0, state.pos.y - groundY);
    if (!state._gearWarned && !state.gearDown && state.flapDetent >= 5.5 &&
        aglM < 152.4 && state.iasKt < 200 && !onGround) {
      state._gearWarned = true;
      events.push({ type: 'gearWarn' });
    }
    if (aglM > 305 || state.gearDown) state._gearWarned = false;

    // --- 8. rotational dynamics (rate-based) ----------------------------------
    const pitchCtrl = clamp(finiteOr(controls.pitch, 0), -1, 1);
    const rollCtrl = clamp(finiteOr(controls.roll, 0), -1, 1);
    const yawCtrl = clamp(finiteOr(controls.yaw, 0), -1, 1);

    // current euler for stability terms (from pre-integration quat)
    const pitchNow = Math.atan2(F.y, Math.hypot(F.x, F.z)) / DEG;
    const rollNow = Math.atan2(-R.y, Math.hypot(R.x, R.z)) / DEG;

    let pT, qT, rT;   // target rates, deg/s
    if (onGround) {
      // Weak pitch leveling: strong enough to hold ~0° on the roll, weak enough
      // to let the pilot rotate to ~10° at Vr (equilibrium ≈ pitchCtrl*10°).
      pT = clamp(rollCtrl * 6 - rollNow * 2.5, -10, 10);
      qT = clamp(pitchCtrl * 3 - pitchNow * 0.3, -6, 6);
      if (pitchNow >= 13 && qT > 0) qT = 0;      // tailstrike protection
      if (pitchNow <= -2 && qT < 0) qT = 0;
      const steer = state._steerRad || 0;
      const Vg = state._Vg || 0;
      rT = (Vg > 0.05 ? steer * Vg / WHEELBASE / DEG : 0)
         + yawCtrl * 4 * clamp(Vg / 40, 0, 1);
    } else {
      const auth = 1 / (1 + state.iasKt / 300);   // roll authority fades with speed
      pT = rollCtrl * 25 * auth;
      qT = pitchCtrl * 4;
      // Gentle pitch stiffness toward trim AoA — fades as the pilot applies
      // sustained control, so full aft stick can still reach stall AoA.
      qT += 0.6 * (3.5 - alphaEff) * (1 - Math.abs(pitchCtrl) * 0.85);
      if (Math.abs(rollCtrl) < 0.05) pT += clamp(-rollNow * 0.15, -3, 3); // dihedral
      rT = yawCtrl * 4;
      if (V > 30) rT += (G * Math.tan(rollNow * DEG) / V) / DEG;  // coordinated turn
      if (stalled) {
        qT += -3;                                  // nose drop
        const buffet = Math.min(6, 2 * (alphaEff - aStall));
        pT += (Math.random() - 0.5) * 2 * buffet;  // buffet + wing rock
        qT += (Math.random() - 0.5) * 2 * buffet;
      }
    }

    const tauP = onGround ? 0.3 : 0.5;
    const tauQ = onGround ? 0.3 : 0.8;
    const tauR = onGround ? 0.3 : 1.0;
    state._p = clamp(state._p + (pT - state._p) * (1 - Math.exp(-dt / tauP)), -60, 60);
    state._q = clamp(state._q + (qT - state._q) * (1 - Math.exp(-dt / tauQ)), -60, 60);
    state._r = clamp(state._r + (rT - state._r) * (1 - Math.exp(-dt / tauR)), -60, 60);

    // integrate quaternion: qdot = 0.5 * Omega ⊗ q
    // Body-rate sign convention (see header): _p>0 roll right, _q>0 nose UP,
    // _r>0 nose right. In world frame: roll about +F, pitch about +R
    // (positive rotation about +right takes nose fwd->up), yaw about +D.
    const pr = state._p * DEG, qr = state._q * DEG, rr = state._r * DEG;
    const wxr = pr * F.x + qr * R.x + rr * D.x;
    const wyr = pr * F.y + qr * R.y + rr * D.y;
    const wzr = pr * F.z + qr * R.z + rr * D.z;
    const q = state.quat;
    const qdx = 0.5 * (wxr * q.w + wyr * q.z - wzr * q.y);
    const qdy = 0.5 * (wyr * q.w + wzr * q.x - wxr * q.z);
    const qdz = 0.5 * (wzr * q.w + wxr * q.y - wyr * q.x);
    const qdw = 0.5 * (-(wxr * q.x + wyr * q.y + wzr * q.z));
    q.x += qdx * dt; q.y += qdy * dt; q.z += qdz * dt; q.w += qdw * dt;
    let qn = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (!(qn > 1e-9)) { q.x = 0; q.y = 0; q.z = 0; q.w = 1; qn = 1; }
    q.x /= qn; q.y /= qn; q.z /= qn; q.w /= qn;

    // --- 9. translational integration -----------------------------------------
    state.vel.x += (Fx / m) * dt;
    state.vel.y += (Fy / m) * dt;
    state.vel.z += (Fz / m) * dt;
    state.pos.x += state.vel.x * dt;
    state.pos.y += state.vel.y * dt;
    state.pos.z += state.vel.z * dt;

    // hard floor: never sink through the ground plane
    const minY = groundY - 2;
    if (state.pos.y < minY) { state.pos.y = minY; if (state.vel.y < 0) state.vel.y = 0; }

    // --- 10. derived values (recompute basis from the NEW quaternion) -----------
    rotVec(q, 0, 0, -1, F);
    rotVec(q, 1, 0, 0, R);
    state.heading = ((Math.atan2(F.x, -F.z) / DEG) % 360 + 360) % 360;
    state.pitch = Math.atan2(F.y, Math.hypot(F.x, F.z)) / DEG;
    state.roll = Math.atan2(-R.y, Math.hypot(R.x, R.z)) / DEG;

    state.altFtMSL = state.pos.y * M_TO_FT;
    state.aglM = Math.max(0, state.pos.y - groundY);
    state.gsKt = Math.hypot(state.vel.x, state.vel.z) * MS_TO_KT;
    state.vsFpm = state.vel.y * 196.85;
    state.aoaDeg = alphaEff;
    state.stallWarn = stalled;
    if (stalled && !state._wasStalled) events.push({ type: 'stall' });
    state._wasStalled = stalled;

    if (state.iasKt > 340) {
      state.overspeed = true;
      if (t - state._lastOverspeed > 3) {
        state._lastOverspeed = t;
        events.push({ type: 'overspeed' });
      }
    } else if (state.iasKt < 335) {
      state.overspeed = false;
    }

    // --- 11. numerical safety ---------------------------------------------------
    for (const vv of [state.pos, state.vel]) {
      if (!isFinite(vv.x)) vv.x = 0;
      if (!isFinite(vv.y)) vv.y = 0;
      if (!isFinite(vv.z)) vv.z = 0;
    }
    for (const k of ['x', 'y', 'z', 'w']) {
      if (!isFinite(q[k])) { q.x = 0; q.y = 0; q.z = 0; q.w = 1; break; }
    }
    state.heading = finiteOr(state.heading, 0);
    state.pitch = finiteOr(state.pitch, 0);
    state.roll = finiteOr(state.roll, 0);
    state.iasKt = finiteOr(state.iasKt, 0);
    state.massKg = finiteOr(state.massKg, OEW);

    return events;
  }

  return { createState, setPayload, step };
}
