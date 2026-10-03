// Scripted AI traffic: 5 low-poly procedural airliners flying loops
// (arrival, departure, pattern, taxi, overflight) + TCAS-lite advisories.
import * as THREE from 'three';
import { AIRPORTS } from '../core/config.js';
import {
  latLonToWorld, headingToVector, vectorToHeading,
  FT_TO_M, KT_TO_MS, NM_TO_M,
} from '../core/geo.js';

const DEG = Math.PI / 180;
const ACTIVE_RWY = { KJFK: '13L', KLGA: '4', KEWR: '4R', KTEB: '19' };
const TCAS_LATERAL_NM = 3;
const TCAS_VERT_FT = 1200;
const TCAS_THROTTLE_S = 20;

// ---------------------------------------------------------------------------
// Procedural low-poly airliner (~1.5k tris). Nose faces local -Z.
function buildAirliner(accent = 0xc8102e) {
  const g = new THREE.Group();
  const white = new THREE.MeshLambertMaterial({ color: 0xeef1f4 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x18222e });
  const accentM = new THREE.MeshLambertMaterial({ color: accent });
  const metal = new THREE.MeshLambertMaterial({ color: 0x8f979f });

  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };

  // Fuselage (axis Y -> Z), nose at -Z.
  const fusGeo = new THREE.CylinderGeometry(1.9, 1.9, 32, 10, 1);
  fusGeo.rotateX(Math.PI / 2);
  add(fusGeo, white, 0, 4, 1);

  // Nose dome.
  const noseGeo = new THREE.SphereGeometry(1.9, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  noseGeo.rotateX(-Math.PI / 2);
  add(noseGeo, white, 0, 4, -15);

  // Tail cone (tapers aft).
  const tailGeo = new THREE.CylinderGeometry(0.35, 1.9, 7, 10, 1);
  tailGeo.rotateX(Math.PI / 2);
  add(tailGeo, white, 0, 4, 20.5);

  // Cockpit windows.
  add(new THREE.BoxGeometry(3.0, 0.9, 1.4), dark, 0, 4.9, -14.4);

  // Wings + winglets.
  add(new THREE.BoxGeometry(30, 0.35, 4.2), white, 0, 3.4, 0);
  add(new THREE.BoxGeometry(0.25, 1.7, 1.7), accentM, -14.9, 4.2, 0.4);
  add(new THREE.BoxGeometry(0.25, 1.7, 1.7), accentM, 14.9, 4.2, 0.4);

  // Horizontal + vertical stabilizers.
  add(new THREE.BoxGeometry(10.5, 0.3, 2.4), white, 0, 4.4, 19);
  add(new THREE.BoxGeometry(0.35, 5.5, 3.6), accentM, 0, 7.0, 19.5);

  // Engines under wings.
  const engGeo = new THREE.CylinderGeometry(1.05, 1.15, 4.2, 8, 1);
  engGeo.rotateX(Math.PI / 2);
  add(engGeo, metal, -6.2, 2.5, -2);
  add(engGeo.clone(), metal, 6.2, 2.5, -2);
  const intGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.3, 8, 1);
  intGeo.rotateX(Math.PI / 2);
  add(intGeo, dark, -6.2, 2.5, -4.2);
  add(intGeo.clone(), dark, 6.2, 2.5, -4.2);

  // Landing gear (toggleable).
  const gearGroup = new THREE.Group();
  const strutM = new THREE.MeshLambertMaterial({ color: 0x555c63 });
  const tireM = new THREE.MeshLambertMaterial({ color: 0x141414 });
  const gearLeg = (x, z) => {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 6), strutM);
    strut.position.set(x, 2.3, z);
    const wheelGeo = new THREE.CylinderGeometry(0.48, 0.48, 0.34, 8);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheel = new THREE.Mesh(wheelGeo, tireM);
    wheel.position.set(x, 1.0, z);
    gearGroup.add(strut, wheel);
  };
  gearLeg(0, -11); gearLeg(-3.4, 2.5); gearLeg(3.4, 2.5);
  g.add(gearGroup);

  // Nav / strobe / beacon lights.
  const light = (color, x, y, z, r = 0.18) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 6, 6),
      new THREE.MeshBasicMaterial({ color })
    );
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  light(0xff2222, -15.1, 3.4, 0);          // left red
  light(0x22ff44, 15.1, 3.4, 0);           // right green
  light(0xffffff, 0, 4, 24.2);             // tail white
  const strobeL = light(0xffffff, -15.1, 3.7, 0, 0.22);
  const strobeR = light(0xffffff, 15.1, 3.7, 0, 0.22);
  const beacon = light(0xff3333, 0, 6.1, 8, 0.22);

  g.traverse((o) => { if (o.isMesh) o.frustumCulled = true; });
  return { group: g, gearGroup, strobeL, strobeR, beacon };
}

// ---------------------------------------------------------------------------
// Route construction (world-space waypoints).
function activeRunway(icao) {
  const ap = AIRPORTS[icao];
  if (!ap) return null;
  const id = ACTIVE_RWY[icao];
  return ap.runways.find((r) => r.id === id) || ap.runways[0];
}

function buildRoutes(icao) {
  const ap = AIRPORTS[icao];
  const rwy = activeRunway(icao);
  const fe = ap.elevationFt;
  const thr = latLonToWorld(rwy.thresholdLat, rwy.thresholdLon, new THREE.Vector3());
  const hv = headingToVector(rwy.headingTrue, new THREE.Vector3());
  const rv = headingToVector((rwy.headingTrue + 90) % 360, new THREE.Vector3());

  // alongM: + ahead of threshold (landing direction), - behind (on final).
  // latM: + to the right of centerline.
  const P = (alongM, latM, altFt, kt, gear) => ({
    x: thr.x + hv.x * alongM + rv.x * latM,
    z: thr.z + hv.z * alongM + rv.z * latM,
    altFt, kt, gear,
  });

  // (a) Arrival: 10nm final -> touchdown -> rollout -> exit -> respawn.
  const arrival = [
    P(-10 * NM_TO_M, 0, fe + 3200, 180, true),
    P(-6 * NM_TO_M, 0, fe + 1900, 160, true),
    P(-3 * NM_TO_M, 0, fe + 950, 145, true),
    P(300, 0, fe, 130, true),
    P(2000, 0, fe, 60, true),
    P(2600, 130, fe, 15, true),
  ];
  // (b) Departure: roll -> climb straight out -> respawn.
  const departure = [
    P(0, 0, fe, 0, false),
    P(1500, 0, fe + 250, 175, false),
    P(5 * NM_TO_M, 0, fe + 3200, 250, false),
    P(12 * NM_TO_M, 0, 6500, 300, false),
  ];
  // (c) Left-hand pattern (closed loop).
  const L = (alongM, offM, altFt, kt, gear) => P(alongM, -offM, altFt, kt, gear);
  const pattern = [
    L(4200, 2300, fe + 1500, 165, false),
    L(-5500, 2300, fe + 1500, 165, false),
    P(-3 * NM_TO_M, 0, fe + 950, 150, true),
    P(300, 0, fe, 140, true),
    P(2800, 0, fe + 900, 175, false),
  ];
  // (d) Taxi loop near the terminal area.
  const c = latLonToWorld(ap.lat, ap.lon, new THREE.Vector3());
  const taxi = [
    { x: c.x + 420, z: c.z + 320, altFt: fe, kt: 15, gear: true },
    { x: c.x - 420, z: c.z + 320, altFt: fe, kt: 15, gear: true },
    { x: c.x - 420, z: c.z - 320, altFt: fe, kt: 15, gear: true },
    { x: c.x + 420, z: c.z - 320, altFt: fe, kt: 15, gear: true },
  ];
  // (e) High overflight, west -> east.
  const overflight = [
    { x: c.x - 55000, z: c.z, altFt: 8000, kt: 320, gear: false },
    { x: c.x + 55000, z: c.z, altFt: 8000, kt: 320, gear: false },
  ];
  return { arrival, departure, pattern, taxi, overflight };
}

// ---------------------------------------------------------------------------
export function createTraffic(scene, scenery) {
  let uiRef = null;
  let homeIcao = 'KJFK';
  let fleet = [];

  function respawn(ai, wpIndex) {
    const wp = wpIndex == null ? 0 : wpIndex;
    ai.wp = wp % ai.route.length;
    const p = ai.route[ai.wp];
    const n = ai.route[(ai.wp + 1) % ai.route.length];
    ai.pos.set(p.x, p.altFt * FT_TO_M, p.z);
    ai.altFt = p.altFt;
    ai.speedKt = p.kt;
    ai.hdg = vectorToHeading(n.x - p.x, n.z - p.z);
    ai.gearDown = !!p.gear;
    ai.group.position.copy(ai.pos);
    ai.group.rotation.set(0, -ai.hdg * DEG, 0);
  }

  function makeAI(name, route, accent) {
    const parts = buildAirliner(accent);
    const ai = {
      name, route, parts, group: parts.group,
      pos: new THREE.Vector3(), hdg: 0, speedKt: 0, altFt: 0,
      wp: 0, gearDown: false, lastAlert: -1e9,
    };
    scene.add(parts.group);
    // Spread aircraft along their routes so the sky isn't empty at start.
    respawn(ai, Math.floor(Math.random() * route.length));
    return ai;
  }

  function rebuild() {
    for (const ai of fleet) {
      scene.remove(ai.group);
      ai.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    fleet = [];
    const R = buildRoutes(homeIcao);
    fleet.push(makeAI('DAL421', R.arrival, 0x1a3a6b));
    fleet.push(makeAI('UAL883', R.departure, 0x24408a));
    fleet.push(makeAI('AAL102', R.pattern, 0xc8102e));
    fleet.push(makeAI('JBU55', R.taxi, 0x2a9df4));
    fleet.push(makeAI('FDX77', R.overflight, 0x5b2a86));
  }

  function setHomeAirport(icao) {
    if (AIRPORTS[icao]) homeIcao = icao;
    rebuild();
  }

  function setUI(ui) { uiRef = ui || null; }

  function tcasCheck(ai, player, nowS, ui) {
    if (!player || !player.pos) return;
    const dx = ai.pos.x - player.pos.x;
    const dz = ai.pos.z - player.pos.z;
    const latNm = Math.hypot(dx, dz) / NM_TO_M;
    if (latNm > TCAS_LATERAL_NM) return;
    const pAlt = player.altFtMSL != null ? player.altFtMSL : (player.pos.y * 3.28084);
    const dv = Math.abs(ai.altFt - pAlt);
    if (dv > TCAS_VERT_FT) return;
    if (nowS - ai.lastAlert < TCAS_THROTTLE_S) return;
    ai.lastAlert = nowS;
    const pHdg = player.heading != null ? player.heading : 0;
    const rel = (vectorToHeading(dx, dz) - pHdg + 360) % 360;
    let clock = Math.round(rel / 30) % 12;
    if (clock === 0) clock = 12;
    const dAlt = Math.round((ai.altFt - pAlt) / 100) * 100;
    const vtxt = dAlt === 0 ? 'same altitude'
      : `${Math.abs(dAlt)} feet ${dAlt > 0 ? 'above' : 'below'}`;
    try {
      ui.toast(`TRAFFIC ADVISORY — ${ai.name}, ${clock} o'clock, ${latNm.toFixed(1)} NM, ${vtxt}`);
    } catch (e) { /* toast is best-effort */ }
  }

  function update(dt, playerState, uiArg) {
    if (!fleet.length) return;
    const ui = uiArg || uiRef;
    const nowS = performance.now() / 1000;
    const step = dt != null ? dt : 0;
    if (step <= 0) return;

    for (const ai of fleet) {
      const tgt = ai.route[ai.wp];
      const dx = tgt.x - ai.pos.x;
      const dz = tgt.z - ai.pos.z;
      const dist = Math.hypot(dx, dz);

      // Steer toward waypoint (limited turn rate).
      const des = vectorToHeading(dx, dz);
      let diff = ((des - ai.hdg + 540) % 360) - 180;
      const maxTurn = 4.5 * step;
      ai.hdg = (ai.hdg + Math.max(-maxTurn, Math.min(maxTurn, diff)) + 360) % 360;

      // Speed and altitude chase their targets.
      const dSpd = tgt.kt - ai.speedKt;
      ai.speedKt += Math.max(-8 * step, Math.min(8 * step, dSpd));
      const dAlt = tgt.altFt - ai.altFt;
      const vsFps = (1400 / 60) * step;
      ai.altFt += Math.max(-vsFps, Math.min(vsFps, dAlt));

      const v = ai.speedKt * KT_TO_MS * step;
      ai.pos.x += Math.sin(ai.hdg * DEG) * v;
      ai.pos.z += -Math.cos(ai.hdg * DEG) * v;
      ai.pos.y = ai.altFt * FT_TO_M;
      if (tgt.gear !== undefined) ai.gearDown = !!tgt.gear;

      ai.group.position.copy(ai.pos);
      ai.group.rotation.y = -ai.hdg * DEG;
      ai.group.rotation.z = THREE.MathUtils.clamp(diff * 0.008, -0.3, 0.3);
      ai.parts.gearGroup.visible = ai.gearDown;

      // Strobe double-flash + beacon pulse.
      const tt = nowS % 1.4;
      const strobeOn = tt < 0.08 || (tt > 0.18 && tt < 0.26);
      ai.parts.strobeL.visible = strobeOn;
      ai.parts.strobeR.visible = strobeOn;
      ai.parts.beacon.visible = (nowS % 1.1) < 0.55;

      // Waypoint capture -> advance; loop end -> respawn at start.
      if (dist < Math.max(120, ai.speedKt * KT_TO_MS * 2.5)) {
        ai.wp += 1;
        if (ai.wp >= ai.route.length) respawn(ai, 0);
      }

      if (ui) tcasCheck(ai, playerState, nowS, ui);
    }
  }

  rebuild();
  return { setHomeAirport, setUI, update };
}
