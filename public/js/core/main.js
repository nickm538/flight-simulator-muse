// Main bootstrap: loading -> menu -> flight loop.
import * as THREE from 'three';
import { CONFIG, AIRPORTS, AIRCRAFT } from './config.js';
import { latLonToWorld, headingToVector, FT_TO_M, MS_TO_KT, M_TO_FT, KT_TO_MS } from './geo.js';
import { createScenery } from '../scenery/scenery.js';
import { buildBoeing737 } from '../aircraft/boeing737.js';
import { createFlightModel } from '../physics/flightModel.js';
import { buildCockpit } from '../cockpit/cockpit.js';
import { createATC } from '../systems/atc.js';
import { createTraffic } from '../systems/traffic.js';
import { createWeather } from '../systems/weather.js';
import { createAudio } from '../systems/audio.js';
import { createInput } from '../systems/input.js';
import { createUI } from '../systems/ui.js';

const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
  errBox.classList.remove('hidden');
  errBox.textContent += `[error] ${e.message}\n`;
});
window.addEventListener('unhandledrejection', (e) => {
  errBox.classList.remove('hidden');
  errBox.textContent += `[promise] ${e.reason && e.reason.message ? e.reason.message : e.reason}\n`;
});

const ui = createUI();
const setProgress = (pct, label) => ui.setLoading(pct, label);

async function boot() {
  setProgress(4, 'Creating renderer…');
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const isMobile = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = !isMobile && CONFIG.features.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5e0);
  scene.fog = new THREE.Fog(0xbfd4e6, 8000, 60000);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 220000);
  scene.add(camera);

  setProgress(10, 'Building New York metro scenery…');
  const scenery = createScenery(scene);
  await scenery.load((p, l) => setProgress(10 + p * 0.45, l));

  setProgress(58, 'Assembling Boeing 737-800…');
  const aircraft = buildBoeing737();
  scene.add(aircraft.group);

  setProgress(66, 'Warming up flight model…');
  const flightModel = createFlightModel();
  const fstate = flightModel.createState();

  setProgress(72, 'Building cockpit…');
  const cockpit = buildCockpit(scene, camera, aircraft);

  setProgress(80, 'Connecting systems…');
  const weather = createWeather();
  const audio = createAudio();
  const input = createInput(canvas, ui);
  const traffic = CONFIG.features.traffic ? createTraffic(scene, scenery) : null;
  const atc = createATC(ui, audio);

  setProgress(90, 'Reading live weather…');
  await weather.refresh().catch(() => {});

  const game = {
    renderer, scene, camera, scenery, aircraft, flightModel, fstate,
    cockpit, weather, audio, input, traffic, atc, ui,
    running: false, paused: false, view: 'cockpit',
    timeOfDay: 'day', simTime: 0,
  };

  // Camera director state
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const chaseSm = new THREE.Vector3();
  let mouseLook = { x: 0, y: 0 };

  canvas.addEventListener('mousemove', (e) => {
    if (game.view !== 'cockpit' || game.paused || !game.running) return;
    mouseLook.x = (e.clientX / innerWidth - 0.5) * 1.2;
    mouseLook.y = (e.clientY / innerHeight - 0.5) * 0.7;
  });

  function placeAircraft(menuCfg) {
    const ap = AIRPORTS[menuCfg.airport];
    const elevM = ap.elevationFt * FT_TO_M;
    const wp = new THREE.Vector3();
    game.atcAirport = menuCfg.airport;
    if (menuCfg.start === 'runway') {
      const rwy = scenery.getActiveRunway(ap.icao);
      latLonToWorld(rwy.thresholdLat, rwy.thresholdLon, wp);
      fstate.pos.set(wp.x, scenery.getGroundElevation(rwy.thresholdLat, rwy.thresholdLon) + 3.6, wp.z);
      fstate.heading = rwy.headingTrue;
    } else if (menuCfg.start === 'air') {
      // 10 nm final, 5000 ft
      const rwy = scenery.getActiveRunway(ap.icao);
      const dir = headingToVector(rwy.headingTrue, new THREE.Vector3());
      latLonToWorld(rwy.thresholdLat, rwy.thresholdLon, wp);
      wp.addScaledVector(dir, -10 * 1852);
      fstate.pos.set(wp.x, 5000 * FT_TO_M, wp.z);
      fstate.heading = rwy.headingTrue;
      fstate.vel.copy(headingToVector(rwy.headingTrue, new THREE.Vector3()).multiplyScalar(140 * KT_TO_MS));
      fstate.vel.y = -3;
    } else {
      const spot = scenery.getParkingSpot(ap.icao);
      latLonToWorld(spot.lat, spot.lon, wp);
      fstate.pos.set(wp.x, elevM + 3.6, wp.z);
      fstate.heading = spot.headingTrue;
    }
    fstate.quat.setFromEuler(new THREE.Euler(0, -fstate.heading * Math.PI / 180, 0, 'YXZ'));
    if (menuCfg.start !== 'air') fstate.vel.set(0, 0, 0);
    fstate.gearDown = true; fstate.gearPos = 1;
    fstate.fuelKg = AIRCRAFT.maxFuelKg * 0.35;
    fstate.massKg = AIRCRAFT.oewKg + fstate.fuelKg + 15000; // pax + cargo approx
    atc.setAirport(ap.icao, menuCfg.start);
    if (atc.setWeatherProvider) atc.setWeatherProvider(weather);
    if (traffic) { traffic.setHomeAirport(ap.icao); traffic.setUI(ui); }
  }

  function applyTimeOfDay(tod) {
    game.timeOfDay = tod;
    scenery.setTimeOfDay(tod);
  }

  // ---- UI wiring ----
  ui.onFly((menuCfg) => {
    placeAircraft(menuCfg);
    applyTimeOfDay(menuCfg.time);
    weather.setMode(menuCfg.weather);
    game.running = true; game.paused = false; game.view = 'cockpit';
    ui.hideMenu(); ui.showHUD(); ui.showATC();
    audio.unlock();
    ui.toast(`Southwest 1458 · ${menuCfg.airport} · clearance delivery: contact ${AIRPORTS[menuCfg.airport].groundFreq} for taxi`);
  });
  ui.onPauseToggle(() => {
    if (!game.running) return;
    game.paused = !game.paused;
    ui.showPause(game.paused);
    if (game.paused) audio.suspend(); else audio.resume();
  });
  ui.onQuitToMenu(() => {
    game.running = false; game.paused = false;
    ui.showMenu(); ui.hideHUD(); ui.hideATC(); ui.showPause(false);
  });
  input.onAction('view', () => {
    const order = ['cockpit', 'chase', 'tower', 'flyby'];
    game.view = order[(order.indexOf(game.view) + 1) % order.length];
    ui.toast('View: ' + game.view);
  });
  input.onAction('atcPanel', () => ui.toggleATC());
  input.onAction('pause', () => ui.togglePause());
  input.onAction('help', () => ui.toggleHelp());

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  setProgress(100, 'Ready');
  ui.showMenu();

  // ---- Main loop ----
  const clock = new THREE.Clock();
  let physAcc = 0;
  const PHYS_DT = 1 / CONFIG.physicsHz;
  const tmpV = new THREE.Vector3();

  function updateCamera(dt) {
    const g = aircraft.group;
    if (game.view === 'cockpit') {
      // Pilot eye position from the aircraft model
      g.localToWorld(tmpV.copy(aircraft.parts.pilotEye));
      camera.position.copy(tmpV);
      // Look direction: aircraft forward + mouse look (suspended while dragging cockpit controls)
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.quaternion);
      if (!cockpit.isInteracting || !cockpit.isInteracting()) {
        const yawOff = -mouseLook.x * 0.9;
        const pitchOff = -mouseLook.y * 0.55;
        const e = new THREE.Euler(pitchOff, yawOff, 0, 'YXZ');
        fwd.applyQuaternion(new THREE.Quaternion().setFromEuler(e));
      }
      camLook.copy(camera.position).addScaledVector(fwd, 50);
      camera.lookAt(camLook);
      camera.fov = 62; camera.updateProjectionMatrix();
    } else if (game.view === 'chase') {
      tmpV.set(0, 9, 42);
      g.localToWorld(tmpV);
      chaseSm.lerp(tmpV, 1 - Math.exp(-dt * 4));
      camera.position.copy(chaseSm);
      g.getWorldPosition(camLook); camLook.y += 2;
      camera.lookAt(camLook);
      camera.fov = 55; camera.updateProjectionMatrix();
    } else {
      // tower / flyby: fixed ground viewpoint looking at aircraft
      const ap = AIRPORTS[game.atcAirport || CONFIG.startAirport];
      latLonToWorld(ap.lat, ap.lon, tmpV);
      tmpV.y += game.view === 'tower' ? 60 : 12;
      if (game.view === 'flyby') {
        g.getWorldPosition(camLook);
        tmpV.copy(camLook).add(new THREE.Vector3(120, 6, 60));
      }
      camera.position.lerp(tmpV, 1 - Math.exp(-dt * 2.5));
      g.getWorldPosition(camLook);
      camera.lookAt(camLook);
      camera.fov = 50; camera.updateProjectionMatrix();
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (!game.running || game.paused) {
      // Idle menu background: slow orbit over Manhattan
      if (!game.running) {
        const t = performance.now() / 1000;
        camera.position.set(Math.sin(t * 0.05) * 12000, 2500, -8000 + Math.cos(t * 0.05) * 12000);
        camera.lookAt(0, 0, -6000);
        scenery.update(dt, { timeOfDay: game.timeOfDay });
        renderer.render(scene, camera);
      }
      return;
    }

    game.simTime += dt;
    const controls = input.getControls();
    cockpit.applyAutopilot(controls, fstate, dt);

    // Keep cockpit ILS receiver tuned to the active runway
    if (cockpit.setILS) {
      const rwy = scenery.getActiveRunway(game.atcAirport || CONFIG.startAirport);
      if (rwy && rwy.ils && !rwy.ils.locOnly) {
        cockpit.setILS({
          lat: rwy.thresholdLat, lon: rwy.thresholdLon,
          headingTrue: rwy.headingTrue, gsDeg: rwy.ils.gs || 3.0,
        });
      }
    }

    // Weather -> env
    const env = weather.getEnv(fstate.pos);
    env.groundElevM = scenery.getGroundElevationXZ(fstate.pos.x, fstate.pos.z);
    env.playerPos = fstate.pos;

    // Fixed-step physics
    physAcc += dt;
    let steps = 0;
    while (physAcc >= PHYS_DT && steps < 12) {
      const events = flightModel.step(fstate, controls, env, PHYS_DT);
      for (const ev of events) handleEvent(ev);
      physAcc -= PHYS_DT; steps++;
    }

    // Sync 3D model
    aircraft.group.position.copy(fstate.pos);
    aircraft.group.quaternion.copy(fstate.quat);
    aircraft.update(dt, fstate, controls);

    cockpit.update(dt, fstate, controls);
    scenery.update(dt, { timeOfDay: game.timeOfDay, wind: env.wind });
    weather.applyToScene(scene, dt);
    if (traffic) traffic.update(dt, fstate);
    atc.update(dt, fstate);
    audio.update(dt, fstate, controls, env);
    if (audio.setView) audio.setView(game.view);
    ui.updateHUD(fstate, controls);
    updateCamera(dt);

    renderer.render(scene, camera);
  }

  function handleEvent(ev) {
    if (ev.type === 'touchdown') {
      ui.toast(`Touchdown · ${Math.round(ev.vs * 60)} fpm`);
      audio.touchdown(ev.vs);
    } else if (ev.type === 'stall') {
      ui.warn('STALL');
      setTimeout(() => ui.warn(''), 1500);
    } else if (ev.type === 'liftoff') {
      ui.toast('Positive rate — gear up');
    } else if (ev.type === 'overspeed') {
      ui.warn('OVERSPEED');
      setTimeout(() => ui.warn(''), 1200);
    }
  }

  frame();
}

boot().catch((e) => {
  errBox.classList.remove('hidden');
  errBox.textContent = '[boot] ' + (e.stack || e.message || e);
  document.getElementById('loadlabel').textContent = 'Failed to start — see error box.';
});
