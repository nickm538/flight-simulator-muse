// NYC metro scenery: terrain, water, sky, airports, vegetation, buildings, lights.
// Three.js r160, ES modules, no build step. Vendored three only (no addons import).
import * as THREE from 'three';
import {
  latLonToWorld, worldToLatLon, headingToVector, vectorToHeading,
  EARTH_R, FT_TO_M,
} from '../core/geo.js';
import { AIRPORTS } from '../core/config.js';

const DEG = Math.PI / 180;
const ASSET_BASE = 'assets/';
const BBOX = { latMin: 40.3, latMax: 41.1, lonMin: -74.5, lonMax: -73.5 };
const HM_SIZE = 1024;

// Small physical offsets (m) above flattened field elevation; polygonOffset
// handles depth precision at range so aircraft wheels don't visibly sink.
const SURF = { detail: 0.12, taxi: 0.18, runway: 0.25 };

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function distM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG * EARTH_R;
  const dLon = (lon2 - lon1) * DEG * EARTH_R * Math.cos(lat1 * DEG);
  return Math.hypot(dLat, dLon);
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Merge indexed BufferGeometries with position/normal/uv (+optional color).
// Caller must applyMatrix4() beforehand.
function mergeGeometries(geoms) {
  let vCount = 0, iCount = 0, hasColor = true;
  for (const g of geoms) {
    vCount += g.attributes.position.count;
    iCount += g.index.count;
    if (!g.attributes.color) hasColor = false;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const col = hasColor ? new Float32Array(vCount * 3) : null;
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (const g of geoms) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    if (col) col.set(g.attributes.color.array, vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += n; io += gi.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function oppositeRunwayId(id) {
  const m = /^(\d{1,2})([LRC]?)$/.exec(id);
  if (!m) return id;
  const num = ((parseInt(m[1], 10) + 18 - 1) % 36) + 1;
  const letter = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return String(num) + letter;
}

const PARKING = {
  KJFK: { lat: 40.6417, lon: -73.7815, headingTrue: 90 },   // Terminal 4 apron
  KLGA: { lat: 40.7748, lon: -73.8715, headingTrue: 40 },
  KEWR: { lat: 40.6925, lon: -74.1765, headingTrue: 260 },
  KTEB: { lat: 40.8512, lon: -74.0615, headingTrue: 180 },
};

const CALM_RWY = { KJFK: '13L', KLGA: '4', KEWR: '4R', KTEB: '19' };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createScenery(scene) {
  const airportList = Object.values(AIRPORTS);

  // --- state ---------------------------------------------------------------
  let elev = null;               // Float32Array(HM_SIZE*HM_SIZE), meters, raw (no flatten)
  let attribution = '';
  let simT = 0;
  let timeOfDay = 'day';

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();

  // animated refs
  let sun = null, hemi = null, skyUniforms = null, stars = null, moonSprite = null, sunSprite = null;
  let waterShimmer = null;
  const windsocks = [];          // {group, icao}
  const beacons = [];            // {mat, phase}
  const flashers = [];           // {sprite, icao}
  const dimMats = [];            // {mat, base: Color} airfield lights, dimmed by day
  const facadeMats = [];         // building materials with night emissive
  const sunDir = new THREE.Vector3(0, 1, 0);

  // --- elevation -----------------------------------------------------------
  function sampleRaw(lat, lon) {
    if (!elev) return 0;
    const fx = ((lon - BBOX.lonMin) / (BBOX.lonMax - BBOX.lonMin)) * (HM_SIZE - 1);
    const fy = ((BBOX.latMax - lat) / (BBOX.latMax - BBOX.latMin)) * (HM_SIZE - 1);
    const x0 = Math.max(0, Math.min(HM_SIZE - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(HM_SIZE - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const i00 = y0 * HM_SIZE + x0;
    const a = elev[i00], b = elev[i00 + 1], c = elev[i00 + HM_SIZE], d = elev[i00 + HM_SIZE + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  // Bilinear sample + airport plateau flattening (smooth blend 1.2 -> 2.2 km).
  function getGroundElevation(lat, lon) {
    let e = sampleRaw(lat, lon);
    for (const ap of airportList) {
      const d = distM(lat, lon, ap.lat, ap.lon);
      if (d < 2200) {
        const fe = ap.elevationFt * FT_TO_M;
        if (d < 1200) e = fe;
        else e = fe + (e - fe) * smoothstep(1200, 2200, d);
      }
    }
    return e;
  }

  function getGroundElevationXZ(x, z) {
    const ll = worldToLatLon(x, z);
    return getGroundElevation(ll.lat, ll.lon);
  }

  async function loadHeightmap() {
    try {
      const img = await loadImage(ASSET_BASE + 'heightmap.png');
      if (!img) return;
      const c = document.createElement('canvas');
      c.width = HM_SIZE; c.height = HM_SIZE;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, HM_SIZE, HM_SIZE);
      const data = ctx.getImageData(0, 0, HM_SIZE, HM_SIZE).data;
      elev = new Float32Array(HM_SIZE * HM_SIZE);
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        elev[j] = v / 100 - 100;
      }
      // sanitize: clamp nodata pits / spikes (metro range is about -40..+420 m)
      for (let j = 0; j < elev.length; j++) {
        if (elev[j] < -30) elev[j] = -30;
        else if (elev[j] > 600) elev[j] = 600;
      }
    } catch (e) { elev = null; }
  }

  // --- runway selection ------------------------------------------------------
  function getActiveRunway(icao, windDirDeg, windKt) {
    const ap = AIRPORTS[icao];
    if (!ap) return null;
    if (windKt == null || windDirDeg == null || windKt < 3) {
      const id = CALM_RWY[icao];
      const r = ap.runways.find((r) => r.id === id) || ap.runways.find((r) => r.ils) || ap.runways[0];
      return { ...r, lengthM: r.lengthFt * FT_TO_M };
    }
    const cands = ap.runways.filter((r) => r.ils);
    let best = cands[0] || ap.runways[0], bestHw = -Infinity;
    for (const r of cands) {
      const hw = windKt * Math.cos((windDirDeg - r.headingTrue) * DEG);
      if (hw > bestHw) { bestHw = hw; best = r; }
    }
    return { ...best, lengthM: best.lengthFt * FT_TO_M };
  }

  function getParkingSpot(icao) {
    return PARKING[icao] ? { ...PARKING[icao] } : null;
  }

  function getAirport(icao) { return AIRPORTS[icao] || null; }

  // =========================================================================
  // BUILDERS
  // =========================================================================

  function buildTerrain(groundImg) {
    const nw = latLonToWorld(BBOX.latMax, BBOX.lonMin, new THREE.Vector3());
    const se = latLonToWorld(BBOX.latMin, BBOX.lonMax, new THREE.Vector3());
    const w = se.x - nw.x, d = se.z - nw.z;
    const cx = (nw.x + se.x) / 2, cz = (nw.z + se.z) / 2;

    const SEG = 220;
    const geo = new THREE.PlaneGeometry(w, d, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, 0, cz);

    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const water = new THREE.Color(0x14385e);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const ll = worldToLatLon(x, z);
      const e = getGroundElevation(ll.lat, ll.lon);
      p.setY(i, e);
      const isWater = sampleRaw(ll.lat, ll.lon) < 0.4;
      if (isWater) { colors[i * 3] = water.r; colors[i * 3 + 1] = water.g; colors[i * 3 + 2] = water.b; }
      else { colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1; }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    let map = null;
    if (groundImg) {
      map = new THREE.Texture(groundImg);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 8;
      map.needsUpdate = true;
    }
    const mat = new THREE.MeshStandardMaterial({
      map, color: map ? 0xffffff : 0x4d7c43,
      vertexColors: true, roughness: 1.0, metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  function buildWater() {
    const nw = latLonToWorld(BBOX.latMax, BBOX.lonMin, new THREE.Vector3());
    const se = latLonToWorld(BBOX.latMin, BBOX.lonMax, new THREE.Vector3());
    const w = se.x - nw.x, d = se.z - nw.z;

    // alpha mask: water where raw elevation < 0.4 m
    const alphaTex = canvasTexture(256, 256, (ctx) => {
      const img = ctx.createImageData(256, 256);
      for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
          const lon = BBOX.lonMin + ((px + 0.5) / 256) * (BBOX.lonMax - BBOX.lonMin);
          const lat = BBOX.latMax - ((py + 0.5) / 256) * (BBOX.latMax - BBOX.latMin);
          const a = sampleRaw(lat, lon) < 0.4 ? 235 : 0;
          const o = (py * 256 + px) * 4;
          // alphaMap samples the GREEN channel: grayscale mask, not alpha
          img.data[o] = img.data[o + 1] = img.data[o + 2] = a;
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }, false);

    waterShimmer = canvasTexture(256, 256, (ctx, cw, ch) => {
      const rnd = mulberry32(7);
      ctx.fillStyle = '#9fb6c4'; ctx.fillRect(0, 0, cw, ch);
      for (let i = 0; i < 900; i++) {
        const g = 140 + Math.floor(rnd() * 90);
        ctx.fillStyle = `rgba(${g},${g + 12},${g + 22},0.35)`;
        const s = 3 + rnd() * 14;
        ctx.beginPath();
        ctx.ellipse(rnd() * cw, rnd() * ch, s * 2.2, s * 0.7, rnd() * 0.6, 0, 7);
        ctx.fill();
      }
    }, false);
    waterShimmer.wrapS = waterShimmer.wrapT = THREE.RepeatWrapping;
    waterShimmer.repeat.set(48, 48);

    const mat = new THREE.MeshPhongMaterial({
      color: 0x1b4d75, specular: 0xaad4f0, shininess: 160,
      transparent: true, opacity: 0.92, depthWrite: false,
      map: waterShimmer, alphaMap: alphaTex,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.25;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Airport construction
  // -------------------------------------------------------------------------
  function runwayTexture(rwy) {
    const W = 256, H = 1024;
    const lengthM = rwy.lengthFt * FT_TO_M;
    const widthM = rwy.widthFt * FT_TO_M;
    const pxM = H / lengthM;         // px per meter along length
    const pxW = W / widthM;          // px per meter across width
    return canvasTexture(W, H, (ctx) => {
      // asphalt
      ctx.fillStyle = '#2e3136'; ctx.fillRect(0, 0, W, H);
      const rnd = mulberry32(rwy.id.charCodeAt(0) * 131 + rwy.lengthFt);
      for (let i = 0; i < 2200; i++) {
        const g = 38 + Math.floor(rnd() * 26);
        ctx.fillStyle = `rgba(${g},${g + 2},${g + 5},0.5)`;
        ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
      }
      ctx.fillStyle = '#f2f4f6';
      // edge stripes
      ctx.fillRect(7, 14, 6, H - 28);
      ctx.fillRect(W - 13, 14, 6, H - 28);
      // threshold piano keys (both ends)
      const nBars = rwy.widthFt >= 200 ? 8 : 6;
      const barW = (W - 44) / nBars;
      for (let i = 0; i < nBars; i++) {
        const x = 22 + i * barW + 3;
        ctx.fillRect(x, H - 96, barW - 6, 62);   // near threshold (v=0, canvas bottom)
        ctx.fillRect(x, 34, barW - 6, 62);       // far threshold (v=1, canvas top)
      }
      // designators
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 104px Arial, sans-serif';
      ctx.fillText(rwy.id, W / 2, H - 190);       // near end, read from threshold
      ctx.save();
      ctx.translate(W / 2, 190); ctx.rotate(Math.PI);
      ctx.fillText(oppositeRunwayId(rwy.id), 0, 0); // far end, rotated
      ctx.restore();
      // aiming point markers (~300 m from each threshold)
      const aimY = 300 * pxM;
      ctx.fillRect(W / 2 - 62, H - aimY - 44, 48, 16);
      ctx.fillRect(W / 2 + 14, H - aimY - 44, 48, 16);
      ctx.fillRect(W / 2 - 62, aimY + 28, 48, 16);
      ctx.fillRect(W / 2 + 14, aimY + 28, 48, 16);
      // touchdown zone pairs (150..750 m)
      for (let d = 150; d <= 750; d += 150) {
        if (Math.abs(d - 300) < 60) continue;
        const y = d * pxM;
        for (const yy of [H - y, y]) {
          ctx.fillRect(W / 2 - 74, yy - 8, 34, 14);
          ctx.fillRect(W / 2 + 40, yy - 8, 34, 14);
        }
      }
      // centerline dashes
      const dashM = 30, gapM = 20, cw = Math.max(4, 0.9 * pxW);
      for (let d = 200; d < lengthM - 200; d += dashM + gapM) {
        const y0 = H - d * pxM, y1 = H - (d + dashM) * pxM;
        ctx.fillRect(W / 2 - cw / 2, y1, cw, y0 - y1);
      }
    });
  }

  // strip geometry helper: plane centered at lat/lon, sized len x wid (m),
  // length axis along headingDeg. y set by caller.
  function stripGeo(lenM, widM, headingDeg, lat, lon, uvRepeatM) {
    const g = new THREE.PlaneGeometry(widM, lenM);
    if (uvRepeatM) {
      const uvA = g.attributes.uv;
      for (let i = 0; i < uvA.count; i++) uvA.setY(i, uvA.getY(i) * (lenM / uvRepeatM));
    }
    g.rotateX(-Math.PI / 2);
    g.rotateY(-headingDeg * DEG);
    latLonToWorld(lat, lon, tmpV);
    g.translate(tmpV.x, 0, tmpV.z);
    return g;
  }

  const taxiwayTex = () => canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#62666c'; ctx.fillRect(0, 0, 128, 128);
    const rnd = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      const g = 86 + Math.floor(rnd() * 30);
      ctx.fillStyle = `rgba(${g},${g + 2},${g + 4},0.5)`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
    ctx.fillStyle = '#d8b93a';            // taxiway centerline (along v)
    ctx.fillRect(60, 0, 8, 128);
  });

  const apronTex = () => canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#6e7278'; ctx.fillRect(0, 0, 128, 128);
    const rnd = mulberry32(55);
    for (let i = 0; i < 600; i++) {
      const g = 96 + Math.floor(rnd() * 34);
      ctx.fillStyle = `rgba(${g},${g + 2},${g + 4},0.5)`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
    ctx.strokeStyle = 'rgba(40,42,46,0.6)'; ctx.lineWidth = 2;  // concrete joints
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * 32, 0); ctx.lineTo(i * 32, 128); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * 32); ctx.lineTo(128, i * 32); ctx.stroke();
    }
  });

  const facadeTex = () => canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#8f959d'; ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 32) {
      for (let x = 0; x < 256; x += 21) {
        ctx.fillStyle = '#26303d';
        ctx.fillRect(x + 3, y + 9, 15, 15);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + 3, y + 9, 15, 4);
      }
    }
  });

  const facadeNightTex = () => canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 256, 256);
    const rnd = mulberry32(1234);
    for (let y = 0; y < 256; y += 32) {
      for (let x = 0; x < 256; x += 21) {
        if (rnd() < 0.55) { ctx.fillStyle = '#ffca7a'; ctx.fillRect(x + 3, y + 9, 15, 15); }
      }
    }
  });

  function facadeBox(w, h, d, x, y, z, rotY) {
    const g = new THREE.BoxGeometry(w, h, d);
    const uvA = g.attributes.uv;   // stretch window grid: ~1 tile per 24m x 12m
    const su = Math.max(w, d) / 24, sv = Math.max(h / 12, 0.5);
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * su, uvA.getY(i) * sv);
    g.rotateY(rotY);
    g.translate(x, y, z);
    return g;
  }

  // light collectors (global instanced meshes built after all airports)
  const edgeLightXf = [];   // {x,y,z,amber}
  const thrLightXf = [];    // {x,y,z,green} green=threshold approach side, red=far end
  const taxiLightXf = [];   // {x,y,z}
  const apprLightXf = [];   // {x,y,z}
  const papiXf = [];        // {x,y,z,white}

  function addRunwayLights(rwy, fieldElev) {
    const L = rwy.lengthFt * FT_TO_M, Wd = rwy.widthFt * FT_TO_M;
    latLonToWorld(rwy.thresholdLat, rwy.thresholdLon, tmpV);
    const dir = headingToVector(rwy.headingTrue, new THREE.Vector3());
    const perp = headingToVector(rwy.headingTrue + 90, new THREE.Vector3());
    const at = (d, s) => tmpV2.copy(tmpV).addScaledVector(dir, d).addScaledVector(perp, s);
    // edge lights every 60 m, amber within 600 m of either end
    for (let d = 30; d < L; d += 60) {
      for (const s of [-Wd / 2 - 2, Wd / 2 + 2]) {
        const p = at(d, s);
        edgeLightXf.push({ x: p.x, y: fieldElev + 0.7, z: p.z, amber: d < 600 || d > L - 600 });
      }
    }
    // threshold: green bar just outside landing threshold, red just past far end
    for (let i = 0; i < 8; i++) {
      const s = -Wd / 2 + (i + 0.5) * (Wd / 8);
      const pg = at(-4, s);
      thrLightXf.push({ x: pg.x, y: fieldElev + 0.6, z: pg.z, red: false });
      const pr = at(L + 4, s);
      thrLightXf.push({ x: pr.x, y: fieldElev + 0.6, z: pr.z, red: true });
    }
    // PAPI: 4 units, 300 m from threshold, right of centerline
    for (let i = 0; i < 4; i++) {
      const p = at(300 + i * 9, Wd / 2 + 15);
      papiXf.push({ x: p.x, y: fieldElev + 1.0, z: p.z, white: i < 2 });
    }
    // approach lights (ILS only): centerline row 60..750 m + crossbar at 300 m
    if (rwy.ils) {
      for (let d = 60; d <= 750; d += 30) {
        const p = at(-d, 0);
        apprLightXf.push({ x: p.x, y: fieldElev + 1.0, z: p.z });
      }
      for (let i = -4; i <= 4; i++) {
        const p = at(-300, i * 4);
        apprLightXf.push({ x: p.x, y: fieldElev + 1.0, z: p.z });
      }
    }
  }

  function buildAirport(icao, img, mats) {
    const ap = AIRPORTS[icao];
    const fieldElev = ap.elevationFt * FT_TO_M;
    const park = PARKING[icao];
    latLonToWorld(ap.lat, ap.lon, tmpV);
    const ax = tmpV.x, az = tmpV.z;

    // --- high-res ground detail plane (±0.020 deg) ---
    const span = 0.020;
    const c1 = latLonToWorld(ap.lat + span, ap.lon - span, new THREE.Vector3());
    const c2 = latLonToWorld(ap.lat - span, ap.lon + span, new THREE.Vector3());
    const dw = c2.x - c1.x, dd = c2.z - c1.z;
    const dmat = new THREE.MeshStandardMaterial({
      color: img ? 0xffffff : 0x6f747a, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    if (img) {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true;
      dmat.map = t;
    }
    const dg = new THREE.PlaneGeometry(dw, dd);
    dg.rotateX(-Math.PI / 2);
    const dmesh = new THREE.Mesh(dg, dmat);
    dmesh.position.set((c1.x + c2.x) / 2, fieldElev + SURF.detail, (c1.z + c2.z) / 2);
    dmesh.receiveShadow = true;
    dmesh.renderOrder = 1;
    scene.add(dmesh);

    // --- runways ---
    for (const rwy of ap.runways) {
      const L = rwy.lengthFt * FT_TO_M, Wd = rwy.widthFt * FT_TO_M;
      const g = new THREE.PlaneGeometry(Wd, L);
      g.rotateX(-Math.PI / 2);
      g.rotateY(-rwy.headingTrue * DEG);
      latLonToWorld(rwy.thresholdLat, rwy.thresholdLon, tmpV);
      const dir = headingToVector(rwy.headingTrue, tmpV2);
      g.translate(tmpV.x + dir.x * L / 2, 0, tmpV.z + dir.z * L / 2);
      const m = new THREE.MeshStandardMaterial({
        map: runwayTexture(rwy), roughness: 0.94,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.y = fieldElev + SURF.runway;
      mesh.receiveShadow = true;
      mesh.renderOrder = 3;
      scene.add(mesh);
      addRunwayLights(rwy, fieldElev);
    }

    // --- taxiways + apron (merged per material) ---
    const twyGeos = [], apronGeos = [];
    const main = ap.runways.reduce((a, b) => (b.lengthFt > a.lengthFt ? b : a));
    latLonToWorld(park.lat, park.lon, tmpV);
    const px = tmpV.x, pz = tmpV.z;
    const parkH = park.headingTrue;
    // apron (nudged slightly below taxiway strips to avoid coplanar overlap)
    const ag = stripGeo(240, 380, parkH, park.lat, park.lon, 60);
    ag.translate(0, fieldElev + SURF.taxi - 0.03, 0);
    apronGeos.push(ag);
    // parallel taxiway, 170 m left of main runway centerline
    const mdir = headingToVector(main.headingTrue, new THREE.Vector3());
    const mperp = headingToVector(main.headingTrue + 90, new THREE.Vector3());
    const mainLenM = main.lengthFt * FT_TO_M;
    const thrW = latLonToWorld(main.thresholdLat, main.thresholdLon, new THREE.Vector3());
    const midW = thrW.clone().addScaledVector(mdir, mainLenM / 2).addScaledVector(mperp, 170);
    const midLL = worldToLatLon(midW.x, midW.z);
    const tg = stripGeo(mainLenM, 23, main.headingTrue, midLL.lat, midLL.lon, 40);
    tg.translate(0, fieldElev + SURF.taxi, 0);
    twyGeos.push(tg);
    // taxiway edge blue lights along parallel
    {
      const L = mainLenM;
      const start = midW.clone().addScaledVector(mdir, -L / 2);
      for (let d = 0; d <= L; d += 40) {
        for (const s of [-13.5, 13.5]) {
          const p = start.clone().addScaledVector(mdir, d).addScaledVector(mperp, s);
          taxiLightXf.push({ x: p.x, y: fieldElev + 0.6, z: p.z });
        }
      }
    }
    // two connectors: taxiway -> runway at 1/3 and 2/3
    // (each nudged up 2.5 cm to avoid coplanar z-fighting at junctions)
    let connK = 1;
    for (const f of [1 / 3, 2 / 3]) {
      const onRwy = thrW.clone().addScaledVector(mdir, mainLenM * f);
      const toTwy = midW.clone().addScaledVector(mdir, mainLenM * f - mainLenM / 2);
      const a = onRwy, b = toTwy;
      const len = a.distanceTo(b);
      const hdg = (Math.atan2(b.x - a.x, -(b.z - a.z)) / DEG + 360) % 360;
      const cLL = worldToLatLon((a.x + b.x) / 2, (a.z + b.z) / 2);
      const cg = stripGeo(len, 23, hdg, cLL.lat, cLL.lon, 40);
      cg.translate(0, fieldElev + SURF.taxi + 0.025 * connK++, 0);
      twyGeos.push(cg);
    }
    // apron -> parallel taxiway connector
    {
      const a = new THREE.Vector3(px, 0, pz);
      const b = midW.clone();
      const len = a.distanceTo(b);
      if (len > 60) {
        const hdg = (Math.atan2(b.x - a.x, -(b.z - a.z)) / DEG + 360) % 360;
        const cLL = worldToLatLon((a.x + b.x) / 2, (a.z + b.z) / 2);
        const cg = stripGeo(len, 23, hdg, cLL.lat, cLL.lon, 40);
        cg.translate(0, fieldElev + SURF.taxi + 0.025 * connK++, 0);
        twyGeos.push(cg);
      }
    }
    const twyMat = new THREE.MeshStandardMaterial({
      map: mats.taxiway, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    twyMat.map.wrapS = twyMat.map.wrapT = THREE.RepeatWrapping;
    const twyMesh = new THREE.Mesh(mergeGeometries(twyGeos), twyMat);
    twyMesh.receiveShadow = true; twyMesh.renderOrder = 2;
    scene.add(twyMesh);
    const apronMat = new THREE.MeshStandardMaterial({
      map: mats.apron, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    apronMat.map.wrapS = apronMat.map.wrapT = THREE.RepeatWrapping;
    const apronMesh = new THREE.Mesh(mergeGeometries(apronGeos), apronMat);
    apronMesh.receiveShadow = true; apronMesh.renderOrder = 2;
    scene.add(apronMesh);

    // --- tower + terminals (merged structures + glass cab) ---
    const structGeos = [];
    const shaft = new THREE.CylinderGeometry(7, 9.5, 38, 10);
    shaft.translate(ax + 280, fieldElev + 19, az + 150);
    structGeos.push(shaft);
    const roof = new THREE.CylinderGeometry(11.5, 11.5, 1.2, 10);
    roof.translate(ax + 280, fieldElev + 38.6, az + 150);
    structGeos.push(roof);
    const pr = -parkH * DEG;
    structGeos.push(facadeBox(170, 16, 46, px + Math.cos(pr) * 130, fieldElev + 8, pz - Math.sin(pr) * 130, pr));
    structGeos.push(facadeBox(120, 13, 40, px - Math.cos(pr) * 40, fieldElev + 6.5, pz + Math.sin(pr) * 170, pr + 0.12));
    const structMesh = new THREE.Mesh(mergeGeometries(structGeos), mats.facade);
    structMesh.castShadow = true; structMesh.receiveShadow = true;
    scene.add(structMesh);
    const cab = new THREE.CylinderGeometry(11, 8.5, 7, 10);
    const cabMesh = new THREE.Mesh(cab, mats.glass);
    cabMesh.position.set(ax + 280, fieldElev + 42.5, az + 150);
    scene.add(cabMesh);

    // --- windsock near parking ---
    const sockTex = canvasTexture(64, 64, (ctx) => {
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = i % 2 ? '#f5f5f5' : '#ff6a00';
        ctx.fillRect(0, i * 8, 64, 8);
      }
    });
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 7, 6),
      mats.pole);
    pole.position.set(px + 90, fieldElev + 3.5, pz + 60);
    scene.add(pole);
    const cone = new THREE.ConeGeometry(0.85, 3.4, 12, 1, true);
    cone.rotateZ(-Math.PI / 2);   // axis -> +x
    cone.translate(1.9, 0, 0);
    const sockMesh = new THREE.Mesh(cone, new THREE.MeshStandardMaterial({
      map: sockTex, side: THREE.DoubleSide, roughness: 0.9,
    }));
    const sockGroup = new THREE.Group();
    sockGroup.position.set(px + 90, fieldElev + 6.8, pz + 60);
    sockGroup.add(sockMesh);
    scene.add(sockGroup);
    windsocks.push({ group: sockGroup, icao });

    // --- rotating beacon ---
    const bPole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 9, 6), mats.pole);
    bPole.position.set(ax - 320, fieldElev + 4.5, az - 120);
    scene.add(bPole);
    const bMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const bLamp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), bMat);
    bLamp.position.set(ax - 320, fieldElev + 9.6, az - 120);
    scene.add(bLamp);
    beacons.push({ mat: bMat, phase: beacons.length * 0.37 });

    // --- sequenced flasher sprite (positioned on active runway in update) ---
    const fTex = canvasTexture(64, 64, (ctx) => {
      const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    });
    const fmat = new THREE.SpriteMaterial({
      map: fTex, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, toneMapped: false,
    });
    const sprite = new THREE.Sprite(fmat);
    sprite.scale.set(14, 14, 1);
    scene.add(sprite);
    flashers.push({ sprite, icao });
  }

  function buildLightMeshes() {
    const dummy = new THREE.Object3D();
    // runway edge lights (white / amber)
    {
      const g = new THREE.SphereGeometry(0.4, 6, 5);
      const m = new THREE.MeshBasicMaterial({ toneMapped: false });
      const im = new THREE.InstancedMesh(g, m, edgeLightXf.length);
      const cW = new THREE.Color(0xffffff), cA = new THREE.Color(0xffb300);
      edgeLightXf.forEach((L, i) => {
        dummy.position.set(L.x, L.y, L.z); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        im.setColorAt(i, L.amber ? cA : cW);
      });
      im.instanceColor.needsUpdate = true;
      scene.add(im);
      dimMats.push({ mat: m, base: new THREE.Color(0xffffff) });
    }
    // threshold lights (green approach side / red runway end)
    {
      const g = new THREE.BoxGeometry(0.7, 0.5, 0.7);
      const m = new THREE.MeshBasicMaterial({ toneMapped: false });
      const im = new THREE.InstancedMesh(g, m, thrLightXf.length);
      const cG = new THREE.Color(0x22ff55), cR = new THREE.Color(0xff2222);
      thrLightXf.forEach((L, i) => {
        dummy.position.set(L.x, L.y, L.z); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        im.setColorAt(i, L.red ? cR : cG);
      });
      im.instanceColor.needsUpdate = true;
      scene.add(im);
      dimMats.push({ mat: m, base: new THREE.Color(0xffffff) });
    }
    // taxiway edge (blue)
    {
      const g = new THREE.SphereGeometry(0.35, 6, 5);
      const m = new THREE.MeshBasicMaterial({ toneMapped: false });
      const im = new THREE.InstancedMesh(g, m, taxiLightXf.length);
      const cB = new THREE.Color(0x2a6bff);
      taxiLightXf.forEach((L, i) => {
        dummy.position.set(L.x, L.y, L.z); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        im.setColorAt(i, cB);
      });
      im.instanceColor.needsUpdate = true;
      scene.add(im);
      dimMats.push({ mat: m, base: new THREE.Color(0xffffff) });
    }
    // approach steady-burn (white)
    {
      const g = new THREE.SphereGeometry(0.45, 6, 5);
      const m = new THREE.MeshBasicMaterial({ toneMapped: false });
      const im = new THREE.InstancedMesh(g, m, apprLightXf.length);
      const cW = new THREE.Color(0xfff6e0);
      apprLightXf.forEach((L, i) => {
        dummy.position.set(L.x, L.y, L.z); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        im.setColorAt(i, cW);
      });
      im.instanceColor.needsUpdate = true;
      scene.add(im);
      dimMats.push({ mat: m, base: new THREE.Color(0xffffff) });
    }
    // PAPI (2 white / 2 red per runway end)
    {
      const g = new THREE.BoxGeometry(1.6, 1.0, 1.0);
      const m = new THREE.MeshBasicMaterial({ toneMapped: false });
      const im = new THREE.InstancedMesh(g, m, papiXf.length);
      const cW = new THREE.Color(0xffffff), cR = new THREE.Color(0xff2222);
      papiXf.forEach((L, i) => {
        dummy.position.set(L.x, L.y, L.z); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        im.setColorAt(i, L.white ? cW : cR);
      });
      im.instanceColor.needsUpdate = true;
      scene.add(im);
      dimMats.push({ mat: m, base: new THREE.Color(0xffffff) });
    }
  }

  // -------------------------------------------------------------------------
  // Vegetation
  // -------------------------------------------------------------------------
  const URBAN_RECTS = [
    { lat0: 40.70, lat1: 40.78, lon0: -74.02, lon1: -73.97 },  // Manhattan
    { lat0: 40.62, lat1: 40.70, lon0: -74.00, lon1: -73.93 },  // Brooklyn
    { lat0: 40.70, lat1: 40.78, lon0: -73.93, lon1: -73.80 },  // Queens
    { lat0: 40.68, lat1: 40.73, lon0: -74.20, lon1: -74.14 },  // Newark
  ];

  function inUrban(lat, lon) {
    for (const r of URBAN_RECTS) {
      if (lat >= r.lat0 && lat <= r.lat1 && lon >= r.lon0 && lon <= r.lon1) return true;
    }
    return false;
  }

  function nearAirport(lat, lon, km) {
    for (const ap of airportList) {
      if (distM(lat, lon, ap.lat, ap.lon) < km * 1000) return true;
    }
    return false;
  }

  function buildTrees() {
    const COUNT = 12000;
    const rnd = mulberry32(20261003);
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.38, 3, 5);
    trunkGeo.translate(0, 1.5, 0);
    const c1 = new THREE.ConeGeometry(2.6, 5.2, 7); c1.translate(0, 5.0, 0);
    const c2 = new THREE.ConeGeometry(1.8, 3.6, 7); c2.translate(0, 7.4, 0);
    const canopyGeo = mergeGeometries([c1, c2]);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4230, roughness: 1 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, COUNT);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, COUNT);
    trunks.frustumCulled = canopies.frustumCulled = false;

    const dummy = new THREE.Object3D();
    const green1 = new THREE.Color(0x2e5a1f), green2 = new THREE.Color(0x3f7030);
    let placed = 0, tries = 0;
    while (placed < COUNT && tries < 160000) {
      tries++;
      const lat = BBOX.latMin + rnd() * (BBOX.latMax - BBOX.latMin);
      const lon = BBOX.lonMin + rnd() * (BBOX.lonMax - BBOX.lonMin);
      const e = sampleRaw(lat, lon);
      if (e < 1 || e > 60) continue;
      if (inUrban(lat, lon) || nearAirport(lat, lon, 1.5)) continue;
      // slope check (15 m stencil)
      const dE = 0.00015;
      const sx = (sampleRaw(lat, lon + dE) - sampleRaw(lat, lon - dE)) / (2 * dE * 111195 * Math.cos(lat * DEG));
      const sz = (sampleRaw(lat - dE, lon) - sampleRaw(lat + dE, lon)) / (2 * dE * 110575);
      if (Math.hypot(sx, sz) > 0.35) continue;
      const g = getGroundElevation(lat, lon);
      latLonToWorld(lat, lon, tmpV);
      const s = 0.7 + rnd() * 0.8;
      dummy.position.set(tmpV.x, g - 0.2, tmpV.z);
      dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
      dummy.scale.set(s, s * (0.85 + rnd() * 0.4), s);
      dummy.updateMatrix();
      trunks.setMatrixAt(placed, dummy.matrix);
      canopies.setMatrixAt(placed, dummy.matrix);
      canopies.setColorAt(placed, rnd() < 0.5 ? green1 : green2);
      placed++;
    }
    trunks.count = canopies.count = placed;
    canopies.instanceColor.needsUpdate = true;
    scene.add(trunks); scene.add(canopies);
  }

  // -------------------------------------------------------------------------
  // Buildings
  // -------------------------------------------------------------------------
  function buildBuildings(mats) {
    const rnd = mulberry32(777);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);   // base at y=0
    const dummy = new THREE.Object3D();

    function scatter(list, count, placer) {
      let placed = 0, tries = 0;
      while (placed < count && tries < count * 12) {
        tries++;
        const s = placer(rnd);
        if (!s) continue;
        list.push(s); placed++;
      }
    }

    // --- Manhattan towers ---
    const man = [];
    const midtown = { lat: 40.7580, lon: -73.9855 }, downtown = { lat: 40.7075, lon: -74.0113 };
    scatter(man, 800, () => {
      const lat = 40.70 + rnd() * 0.08, lon = -74.02 + rnd() * 0.05;
      if (sampleRaw(lat, lon) < 1) return null;
      const d = Math.min(distM(lat, lon, midtown.lat, midtown.lon), distM(lat, lon, downtown.lat, downtown.lon));
      const cluster = Math.exp(-((d / 950) ** 2));
      const h = Math.min(280, 18 + 265 * cluster * (0.35 + rnd() * 0.65) + rnd() * 22);
      return { lat, lon, h, w: 18 + rnd() * 22, d: 18 + rnd() * 22, rot: -29 * DEG + (rnd() - 0.5) * 0.1 };
    });
    const manMesh = new THREE.InstancedMesh(boxGeo, mats.facade, Math.max(man.length, 1));
    man.forEach((b, i) => {
      latLonToWorld(b.lat, b.lon, tmpV);
      dummy.position.set(tmpV.x, getGroundElevation(b.lat, b.lon) - 0.5, tmpV.z);
      dummy.rotation.set(0, b.rot, 0);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();
      manMesh.setMatrixAt(i, dummy.matrix);
      manMesh.setColorAt(i, new THREE.Color().setScalar(0.82 + rnd() * 0.22));
    });
    manMesh.count = man.length;
    manMesh.instanceColor.needsUpdate = true;
    manMesh.castShadow = true; manMesh.receiveShadow = true;
    scene.add(manMesh);

    // --- outer boroughs: low-rise blocks ---
    const rects = [
      { lat0: 40.62, lat1: 40.70, lon0: -74.00, lon1: -73.93 },
      { lat0: 40.70, lat1: 40.78, lon0: -73.93, lon1: -73.80 },
      { lat0: 40.68, lat1: 40.73, lon0: -74.20, lon1: -74.15 },
    ];
    const outer = [];
    scatter(outer, 1500, () => {
      const r = rects[Math.floor(rnd() * rects.length)];
      const lat = r.lat0 + rnd() * (r.lat1 - r.lat0);
      const lon = r.lon0 + rnd() * (r.lon1 - r.lon0);
      if (sampleRaw(lat, lon) < 1) return null;
      if (nearAirport(lat, lon, 2.0)) return null;
      return { lat, lon, h: 8 + rnd() * 32, w: 12 + rnd() * 14, d: 12 + rnd() * 14, rot: (rnd() - 0.5) * 0.2 };
    });
    const outMesh = new THREE.InstancedMesh(boxGeo, mats.facade, Math.max(outer.length, 1));
    outer.forEach((b, i) => {
      latLonToWorld(b.lat, b.lon, tmpV);
      dummy.position.set(tmpV.x, getGroundElevation(b.lat, b.lon) - 0.5, tmpV.z);
      dummy.rotation.set(0, b.rot, 0);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();
      outMesh.setMatrixAt(i, dummy.matrix);
      outMesh.setColorAt(i, new THREE.Color().setScalar(0.8 + rnd() * 0.25));
    });
    outMesh.count = outer.length;
    outMesh.instanceColor.needsUpdate = true;
    outMesh.castShadow = true; outMesh.receiveShadow = true;
    scene.add(outMesh);
  }

  // -------------------------------------------------------------------------
  // Sky + lighting
  // -------------------------------------------------------------------------
  function buildSky() {
    skyUniforms = {
      topColor: { value: new THREE.Color(0x2e6fd8) },
      bottomColor: { value: new THREE.Color(0xcfe3f5) },
      sunDir: { value: sunDir },
      sunColor: { value: new THREE.Color(0xfff3e2) },
    };
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: skyUniforms,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor; uniform vec3 bottomColor;
        uniform vec3 sunDir; uniform vec3 sunColor;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = mix(bottomColor, topColor, smoothstep(-0.08, 0.55, d.y));
          col = mix(col, bottomColor * 0.5, smoothstep(-0.08, -0.6, d.y));
          float s = max(dot(d, normalize(sunDir)), 0.0);
          col += sunColor * (pow(s, 600.0) * 1.6 + pow(s, 10.0) * 0.22);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(90000, 32, 16), skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    scene.add(sky);

    // sun sprite
    const sunTex = canvasTexture(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      g.addColorStop(0, 'rgba(255,252,240,1)');
      g.addColorStop(0.25, 'rgba(255,240,200,0.9)');
      g.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    });
    sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sunTex, transparent: true, depthWrite: false, fog: false, toneMapped: false,
    }));
    sunSprite.scale.set(14000, 14000, 1);
    scene.add(sunSprite);

    // moon sprite
    const moonTex = canvasTexture(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 60);
      g.addColorStop(0, 'rgba(235,242,255,1)');
      g.addColorStop(0.7, 'rgba(200,215,240,0.85)');
      g.addColorStop(1, 'rgba(180,200,235,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    });
    moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: moonTex, transparent: true, depthWrite: false, fog: false, toneMapped: false,
    }));
    moonSprite.scale.set(7000, 7000, 1);
    moonSprite.visible = false;
    scene.add(moonSprite);

    // stars
    const N = 900, sp = new Float32Array(N * 3), rnd = mulberry32(42);
    for (let i = 0; i < N; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 0.92);
      const r = 88000;
      sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
      sp[i * 3 + 1] = r * Math.cos(ph) + 4000;
      sp[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    stars = new THREE.Points(sg, new THREE.PointsMaterial({
      color: 0xffffff, size: 1.8, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    stars.frustumCulled = false;
    stars.renderOrder = -9;
    scene.add(stars);
  }

  function buildLights() {
    sun = new THREE.DirectionalLight(0xfff3e2, 2.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -160; sun.shadow.camera.right = 160;
    sun.shadow.camera.top = 160; sun.shadow.camera.bottom = -160;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 2500;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 1.5;
    scene.add(sun);
    scene.add(sun.target);
    hemi = new THREE.HemisphereLight(0xbcd6f5, 0x5a6a55, 0.85);
    scene.add(hemi);
  }

  // -------------------------------------------------------------------------
  // Time of day
  // -------------------------------------------------------------------------
  function setTimeOfDay(tod) {
    timeOfDay = tod;
    if (!sun) return;
    const el = (deg) => deg * DEG;
    let sunEl, sunAz, sunCol, sunI, hemiI, top, bot, starO, facadeE, lightDim, moon;
    switch (tod) {
      case 'dawn':
        sunEl = 10; sunAz = 95; sunCol = 0xffb066; sunI = 1.9; hemiI = 0.5;
        top = 0x46549a; bot = 0xffab63; starO = 0.12; facadeE = 0.55; lightDim = 1.0; moon = false;
        break;
      case 'dusk':
        sunEl = 7; sunAz = 265; sunCol = 0xff8f4d; sunI = 1.7; hemiI = 0.45;
        top = 0x3b3f77; bot = 0xf97b3f; starO = 0.18; facadeE = 0.6; lightDim = 1.0; moon = false;
        break;
      case 'night':
        sunEl = 42; sunAz = 140; sunCol = 0x9db8ff; sunI = 0.35; hemiI = 0.18;
        top = 0x04070f; bot = 0x0e1626; starO = 1.0; facadeE = 0.9; lightDim = 1.0; moon = true;
        break;
      default: // day
        sunEl = 55; sunAz = 210; sunCol = 0xfff3e2; sunI = 2.8; hemiI = 0.85;
        top = 0x2e6fd8; bot = 0xcfe3f5; starO = 0; facadeE = 0; lightDim = 0.25; moon = false;
    }
    sunDir.set(
      Math.cos(el(sunEl)) * Math.sin(el(sunAz)),
      Math.sin(el(sunEl)),
      -Math.cos(el(sunEl)) * Math.cos(el(sunAz)));
    sun.color.setHex(sunCol);
    sun.intensity = sunI;
    sun.position.copy(sunDir).multiplyScalar(900);
    sun.target.position.set(0, 0, 0);
    hemi.intensity = hemiI;
    if (skyUniforms) {
      skyUniforms.topColor.value.setHex(top);
      skyUniforms.bottomColor.value.setHex(bot);
      skyUniforms.sunColor.value.setHex(sunCol);
    }
    if (sunSprite) {
      sunSprite.visible = !moon;
      sunSprite.position.copy(sunDir).multiplyScalar(85000);
      sunSprite.material.color.setHex(sunCol);
    }
    if (moonSprite) {
      moonSprite.visible = moon;
      if (moon) moonSprite.position.copy(sunDir).multiplyScalar(85000);
    }
    if (stars) stars.material.opacity = starO;
    for (const f of facadeMats) f.emissiveIntensity = facadeE;
    for (const d of dimMats) d.mat.color.copy(d.base).multiplyScalar(lightDim);
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------
  function update(dt, env) {
    env = env || {};
    simT += dt;
    if (waterShimmer) {
      waterShimmer.offset.x = (simT * 0.008) % 1;
      waterShimmer.offset.y = (simT * 0.005) % 1;
    }
    // wind -> dir FROM (deg) and speed (kt)
    let windDirDeg = null, windKt = 0;
    const wind = env.wind;
    if (wind && (wind.x !== 0 || wind.z !== 0)) {
      windKt = Math.hypot(wind.x, wind.z) * 1.94384;
      windDirDeg = (vectorToHeading(-wind.x, -wind.z) + 360) % 360;
    }
    // windsocks point downwind, droop when calm
    for (const w of windsocks) {
      if (windKt > 1) {
        const wx = wind.x, wz = wind.z, m = Math.hypot(wx, wz) || 1;
        w.group.rotation.y = Math.atan2(-wz / m, wx / m);
        w.group.rotation.z = -Math.max(0, 1 - windKt / 18) * 0.85;
      } else {
        w.group.rotation.z = -0.85;
      }
    }
    // beacons: alternating white/green flash
    for (const b of beacons) {
      const ph = (simT * 0.9 + b.phase) % 1;
      if (ph < 0.08) b.mat.color.setHex(0xffffff);
      else if (ph < 0.5) b.mat.color.setHex(0x22ff66);
      else b.mat.color.setHex(0x0a2012);
    }
    // sequenced flashers ("the rabbit") on each airport's active runway
    for (const f of flashers) {
      const rwy = getActiveRunway(f.icao, windDirDeg, windKt);
      if (!rwy) { f.sprite.visible = false; continue; }
      const phase = (simT % 1.6) / 1.6;
      const dist = 750 * (1 - phase);
      latLonToWorld(rwy.thresholdLat, rwy.thresholdLon, tmpV);
      const dir = headingToVector(rwy.headingTrue, tmpV2);
      const fe = AIRPORTS[f.icao].elevationFt * FT_TO_M;
      f.sprite.position.set(
        tmpV.x - dir.x * dist, fe + 1.5, tmpV.z - dir.z * dist);
      f.sprite.visible = timeOfDay !== 'day' || phase < 1; // always animate; dimmer by day
      f.sprite.material.opacity = timeOfDay === 'day' ? 0.35 : 1.0;
    }
    // keep the shadow frustum near the player
    if (sun && env.playerPos) {
      sun.position.copy(env.playerPos).addScaledVector(sunDir, 900);
      sun.target.position.copy(env.playerPos);
    }
  }

  // -------------------------------------------------------------------------
  // load()
  // -------------------------------------------------------------------------
  async function load(progressCb) {
    const prog = (p, l) => { try { (progressCb || (() => {}))(p, l); } catch (e) { /* noop */ } };
    prog(0.02, 'Loading terrain elevation…');
    await loadHeightmap();
    try {
      const meta = await (await fetch(ASSET_BASE + 'meta.json')).json();
      attribution = meta.attribution || '';
    } catch (e) { attribution = ''; }

    prog(0.15, 'Loading satellite imagery…');
    const groundImg = await loadImage(ASSET_BASE + 'ground.jpg');

    prog(0.30, 'Loading airport imagery…');
    const airportImgs = {};
    for (const icao of Object.keys(AIRPORTS)) {
      airportImgs[icao] = await loadImage(`${ASSET_BASE}airport_${icao}.jpg`);
      prog(0.30 + 0.1 * (Object.keys(airportImgs).length / 4), `Loading airport imagery… ${icao}`);
    }

    const mats = {
      taxiway: taxiwayTex(),
      apron: apronTex(),
      facade: new THREE.MeshStandardMaterial({
        map: facadeTex(), emissiveMap: facadeNightTex(),
        emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.92,
      }),
      glass: new THREE.MeshStandardMaterial({ color: 0x18242f, roughness: 0.12, metalness: 0.65 }),
      pole: new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.6, metalness: 0.4 }),
    };
    facadeMats.push(mats.facade);
    // repeating textures need wrap set before first render
    for (const t of [mats.taxiway, mats.apron, mats.facade.map, mats.facade.emissiveMap]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    }

    prog(0.45, 'Building terrain mesh…');
    buildTerrain(groundImg);
    buildWater();
    await tick();

    prog(0.60, 'Building airports…');
    for (const icao of Object.keys(AIRPORTS)) buildAirport(icao, airportImgs[icao], mats);
    buildLightMeshes();
    await tick();

    prog(0.75, 'Planting forests…');
    buildTrees();
    await tick();

    prog(0.85, 'Raising the skyline…');
    buildBuildings(mats);
    await tick();

    prog(0.93, 'Painting the sky…');
    buildSky();
    buildLights();
    setTimeOfDay('day');
    prog(1.0, 'Scenery ready');
  }

  return {
    load,
    getGroundElevation,
    getGroundElevationXZ,
    getActiveRunway,
    getParkingSpot,
    getAirport,
    setTimeOfDay,
    update,
    get attribution() { return attribution; },
  };
}
