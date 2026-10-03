// Weather system: live NWS observations + scripted presets, ISA atmosphere,
// fog/visibility and procedural cloud deck applied to the scene.
// No API keys. Live source: https://api.weather.gov (CORS-open).
import * as THREE from 'three';
import { AIRPORTS } from '../core/config.js';
import { latLonToWorld, headingToVector } from '../core/geo.js';

const STATIONS = ['KJFK', 'KLGA', 'KEWR', 'KTEB'];
const FETCH_TIMEOUT_MS = 10000;
const KMH_TO_KT = 0.539957;
const M_TO_SM = 1 / 1609.344;
const M_TO_FT = 3.28084;
const PA_TO_INHG = 0.0002953;
const DEG = Math.PI / 180;

const PRESETS = {
  vfr:   { windDirDeg: 270, windKt: 5,  gustKt: 0,  visSM: 10,  ceilingFt: 5000, tempC: 20, dewpC: 8,  altimInHg: 29.98, skyCover: 'FEW', raw: 'VFR preset: wind 270 at 5, vis 10SM, few at 5000' },
  windy: { windDirDeg: 300, windKt: 22, gustKt: 32, visSM: 10,  ceilingFt: 8000, tempC: 16, dewpC: 5,  altimInHg: 29.85, skyCover: 'SCT', raw: 'Windy preset: wind 300 at 22 gust 32' },
  ifr:   { windDirDeg: 180, windKt: 8,  gustKt: 0,  visSM: 1.5, ceilingFt: 600,  tempC: 12, dewpC: 11, altimInHg: 29.70, skyCover: 'OVC', raw: 'IFR preset: wind 180 at 8, vis 1.5SM, overcast 600, light rain' },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function flightCategory(visSM, ceilingFt) {
  const v = visSM == null ? 10 : visSM;
  const c = ceilingFt;
  if (v < 1 || (c != null && c < 500)) return 'LIFR';
  if (v < 3 || (c != null && c < 1000)) return 'IFR';
  if (v <= 5 || (c != null && c <= 3000)) return 'MVFR';
  return 'VFR';
}

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Parse an api.weather.gov /stations/{id}/observations/latest payload.
function parseObservation(icao, json) {
  const p = (json && json.properties) || {};
  const num = (o) => (o && typeof o.value === 'number' && isFinite(o.value) ? o.value : null);

  const windKt = num(p.windSpeed) != null ? num(p.windSpeed) * KMH_TO_KT : null;
  const gustKt = num(p.windGust) != null ? num(p.windGust) * KMH_TO_KT : 0;
  const visSM = num(p.visibility) != null ? num(p.visibility) * M_TO_SM : null;
  const tempC = num(p.temperature);
  const dewpC = num(p.dewpoint);
  const altimInHg = num(p.barometricPressure) != null ? num(p.barometricPressure) * PA_TO_INHG : null;

  let ceilingFt = null;
  let skyCover = 'CLR';
  const layers = Array.isArray(p.cloudLayers) ? p.cloudLayers : [];
  for (const L of layers) {
    const amt = L && L.amount;
    const baseM = num(L && L.base);
    if (!amt) continue;
    skyCover = amt; // last (highest) layer wins for coverage label
    if ((amt === 'BKN' || amt === 'OVC' || amt === 'VV') && baseM != null) {
      const ft = baseM * M_TO_FT;
      if (ceilingFt == null || ft < ceilingFt) ceilingFt = ft;
    }
  }

  const m = {
    icao,
    windDirDeg: num(p.windDirection),
    windKt: windKt != null ? Math.round(windKt) : 0,
    gustKt: Math.round(gustKt) || 0,
    visSM: visSM != null ? Math.round(visSM * 10) / 10 : 10,
    ceilingFt: ceilingFt != null ? Math.round(ceilingFt) : null,
    tempC: tempC != null ? Math.round(tempC * 10) / 10 : 20,
    dewpC: dewpC != null ? Math.round(dewpC * 10) / 10 : 10,
    altimInHg: altimInHg != null ? Math.round(altimInHg * 100) / 100 : 29.92,
    skyCover,
    raw: (p.textDescription || 'NWS observation') + '',
    fetchedAt: Date.now(),
  };
  m.fltCat = flightCategory(m.visSM, m.ceilingFt);
  return m;
}

function makeCloudTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(244,247,250,0.55)');
  grad.addColorStop(0.8, 'rgba(235,240,245,0.22)');
  grad.addColorStop(1, 'rgba(235,240,245,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const COVER_OPACITY = { OVC: 0.95, BKN: 0.7, SCT: 0.42, FEW: 0.22, CLR: 0, SKC: 0 };
const FOG_CLEAR = new THREE.Color(0xbfd4e6);
const FOG_GRAY = new THREE.Color(0x9aa3ad);

export function createWeather() {
  let mode = 'vfr';
  const live = { KJFK: null, KLGA: null, KEWR: null, KTEB: null };

  // Precompute station world positions for nearest-station lookup.
  const stationWorld = {};
  for (const icao of STATIONS) {
    const ap = AIRPORTS[icao];
    const v = new THREE.Vector3();
    if (ap) latLonToWorld(ap.lat, ap.lon, v);
    stationWorld[icao] = v;
  }

  // ---- cloud deck (lazy) ----
  let cloudGroup = null;
  let puffs = [];
  function ensureClouds(scene) {
    if (cloudGroup) return;
    cloudGroup = new THREE.Group();
    cloudGroup.name = 'weatherClouds';
    const tex = makeCloudTexture();
    puffs = [];
    for (let i = 0; i < 40; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.5,
        depthWrite: false, fog: false,
      });
      const s = new THREE.Sprite(mat);
      const r = 4000 + Math.random() * 16000;
      const a = Math.random() * Math.PI * 2;
      const sc = 700 + Math.random() * 900;
      s.position.set(Math.cos(a) * r, 1500, Math.sin(a) * r);
      s.scale.set(sc, sc * 0.42, 1);
      s.userData.seed = Math.random() * 100;
      cloudGroup.add(s);
      puffs.push(s);
    }
    scene.add(cloudGroup);
  }

  function presetMetar() {
    const p = PRESETS[mode] || PRESETS.vfr;
    const m = Object.assign({}, p);
    m.fltCat = flightCategory(m.visSM, m.ceilingFt);
    return m;
  }

  function nearestLiveMetar(pos) {
    let best = null, bestD = Infinity;
    for (const icao of STATIONS) {
      if (!live[icao]) continue;
      const d = pos.distanceToSquared(stationWorld[icao]);
      if (d < bestD) { bestD = d; best = live[icao]; }
    }
    return best;
  }

  // Region-wide reference metar for scene effects (fog/clouds).
  function sceneMetar() {
    if (mode !== 'live') return presetMetar();
    const have = STATIONS.map((s) => live[s]).filter(Boolean);
    if (!have.length) return presetMetar();
    let sx = 0, sy = 0, kt = 0, vis = 0, t = 0, n = have.length;
    let ceil = null;
    const rank = { OVC: 4, BKN: 3, SCT: 2, FEW: 1, CLR: 0, SKC: 0 };
    let cover = 'CLR', coverRank = -1;
    for (const m of have) {
      const dir = (m.windDirDeg || 0) * DEG;
      sx += Math.sin(dir); sy += Math.cos(dir);
      kt += m.windKt; vis += m.visSM; t += m.tempC;
      if (m.ceilingFt != null && (ceil == null || m.ceilingFt < ceil)) ceil = m.ceilingFt;
      const r = rank[m.skyCover] || 0;
      if (r > coverRank) { coverRank = r; cover = m.skyCover; }
    }
    const avgDir = (Math.atan2(sx / n, sy / n) / DEG + 360) % 360;
    const m = {
      windDirDeg: Math.round(avgDir), windKt: Math.round(kt / n), gustKt: 0,
      visSM: Math.round((vis / n) * 10) / 10, ceilingFt: ceil,
      tempC: Math.round((t / n) * 10) / 10, skyCover: cover, raw: 'live average',
    };
    m.fltCat = flightCategory(m.visSM, m.ceilingFt);
    return m;
  }

  function refresh() {
    const jobs = STATIONS.map((icao) =>
      fetchWithTimeout(`https://api.weather.gov/stations/${icao}/observations/latest`, FETCH_TIMEOUT_MS)
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((json) => { live[icao] = parseObservation(icao, json); })
        .catch(() => { /* keep previous data; never throws */ })
    );
    return Promise.allSettled(jobs).then(() => undefined);
  }

  function setMode(m) {
    if (m === 'live' || m === 'vfr' || m === 'windy' || m === 'ifr') mode = m;
  }

  function getMode() { return mode; }

  function getMetar(icao) {
    if (mode === 'live' && live[icao]) return Object.assign({}, live[icao]);
    const p = PRESETS[mode] || PRESETS.vfr;
    const m = Object.assign({ icao }, p);
    m.fltCat = flightCategory(m.visSM, m.ceilingFt);
    return m;
  }

  function getEnv(pos) {
    let m;
    if (mode === 'live') {
      const near = pos ? nearestLiveMetar(pos) : null;
      m = near ? Object.assign({}, near) : presetMetar();
      if (!near) { const p = PRESETS.vfr; m = Object.assign({}, p); m.fltCat = flightCategory(m.visSM, m.ceilingFt); }
    } else {
      m = presetMetar();
    }
    const altM = Math.max(0, (pos && pos.y) || 0);
    const k = Math.min(altM / 3000, 1); // ramps to 2x wind by 3000 m, veers 15 deg
    const dirFrom = m.windDirDeg != null ? m.windDirDeg : 270;
    const dirTo = (dirFrom + 180 + 15 * k) % 360;
    const spdMs = (m.windKt || 0) * (1 + k) * 0.514444;
    const wind = headingToVector(dirTo, new THREE.Vector3()).multiplyScalar(spdMs);
    const tK = 288.15 - 0.0065 * altM;
    const airDensity = 1.225 * Math.pow(Math.max(tK, 1) / 288.15, 4.2561);
    const oatC = 15 - 0.0065 * altM;
    return { wind, airDensity, oatC };
  }

  function getVisibilityM() {
    const m = sceneMetar();
    return (m.visSM != null ? m.visSM : 10) * 1609.344;
  }

  // 0..1 sunlight dim factor for scenery lighting (1 = full VFR sun).
  function getDimFactor() {
    const m = sceneMetar();
    const t = clamp(((m.visSM != null ? m.visSM : 10) - 1.5) / 8.5, 0, 1);
    return 0.35 + 0.65 * t;
  }

  function applyToScene(scene, dt) {
    if (!scene) return;
    const m = sceneMetar();
    const visSM = m.visSM != null ? m.visSM : 10;
    const t = clamp((visSM - 1.5) / 8.5, 0, 1);
    const near = 800 + t * (30000 - 800);
    const far = 4000 + t * (90000 - 4000);
    if (!scene.fog || !scene.fog.isFog) scene.fog = new THREE.Fog(FOG_CLEAR.getHex(), near, far);
    scene.fog.near = near;
    scene.fog.far = far;
    scene.fog.color.copy(FOG_GRAY).lerp(FOG_CLEAR, t);

    // Cloud deck at reported ceiling (fallback 5000 ft when no ceiling).
    ensureClouds(scene);
    const ceilFt = m.ceilingFt != null ? m.ceilingFt : 5000;
    const ceilM = ceilFt * 0.3048;
    const opacity = COVER_OPACITY[m.skyCover] != null ? COVER_OPACITY[m.skyCover] : 0.4;
    cloudGroup.visible = opacity > 0.01;
    if (cloudGroup.visible) {
      const wEnv = getEnv(new THREE.Vector3(0, ceilM, 0));
      const wvx = wEnv.wind.x * 1.5, wvz = wEnv.wind.z * 1.5;
      const d = dt != null ? dt : 0;
      for (const s of puffs) {
        s.position.x += wvx * d;
        s.position.z += wvz * d;
        s.position.y = ceilM + Math.sin(s.userData.seed) * 120;
        // wrap inside a 44 km box around origin
        if (s.position.x > 22000) s.position.x -= 44000;
        if (s.position.x < -22000) s.position.x += 44000;
        if (s.position.z > 22000) s.position.z -= 44000;
        if (s.position.z < -22000) s.position.z += 44000;
        s.material.opacity = opacity * (0.75 + 0.25 * Math.sin(s.userData.seed * 3.7));
      }
    }
  }

  return { refresh, setMode, getMode, getMetar, getEnv, getVisibilityM, getDimFactor, applyToScene };
}
