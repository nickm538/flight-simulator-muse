// public/js/cockpit/cockpit.js
// =============================================================================
// Boeing 737-800 (Southwest) cockpit for the browser flight simulator.
// Canvas-texture instrument panel (PFD / ND / EICAS / standby), functional MCP,
// throttle quadrant, yoke, gear lever, overhead panel, and an autopilot-lite.
//
// COORDINATE FRAME (must match the aircraft model contract):
//   Aircraft-local: x = right (starboard), y = up, z = aft.
//   Nose toward -z, tail toward +z. Pilot eye (captain): (-0.55, 3.15, 9.20).
//   All cockpit geometry is placed relative to EYE below. If
//   aircraft.parts.pilotEye exists it is used instead of the default.
//
// Exports: buildCockpit(scene, camera, aircraft) ->
//   { update(dt, fstate, controls), applyAutopilot(controls, fstate, dt),
//     setILS(ils|null), isInteracting() }
// main.js should call cockpit.applyAutopilot(controls, fstate, dt) once per
// frame AFTER input.getControls() and BEFORE the physics steps.
// =============================================================================

import * as THREE from 'three';
import { AIRPORTS, AIRCRAFT } from '../core/config.js';
import { latLonToWorld, FT_TO_M, M_TO_FT, NM_TO_M } from '../core/geo.js';

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const wrap180 = (d) => { d = ((d + 180) % 360 + 360) % 360 - 180; return d; };
const wrap360 = (d) => ((d % 360) + 360) % 360;

function fmtInt(n, pad = 0) {
  const s = String(Math.round(n));
  return pad > 0 ? s.padStart(pad, '0') : s;
}

// V-speed bugs (mid-weight, flaps 5 — FMC would compute these from GW/CG).
const V1 = 140, VR = 143, V2 = 152;

// Panel canvas layout: 2048x1024, 5 cols x 2 rows.
const PC_W = 2048, PC_H = 1024, PC_COLS = 5, PC_ROWS = 2;
const CELL_W = PC_W / PC_COLS, CELL_H = PC_H / PC_ROWS;
const COL = { CAPT_PFD: 0, CAPT_ND: 1, EICAS: 2, FO_ND: 3, FO_PFD: 4 };

// 737NG palette
const C = {
  bg: '#0a0c10', panel: '#14161b', sky: '#2f7fd0', gnd: '#8a5a2b',
  white: '#ffffff', dim: '#9aa3ad', green: '#2eff5e', magenta: '#ff3df0',
  amber: '#ffb300', cyan: '#35e0ff', red: '#ff3b30', blue: '#3d7bff',
  dark: '#05070a',
};

// MCP canvas: 1024x256 — selector windows (top) + painted button labels.
const MCP_W = 1024, MCP_H = 256;

export function buildCockpit(scene, camera, aircraft) {
  // ---------------------------------------------------------------------------
  // Eye position + cockpit root
  // ---------------------------------------------------------------------------
  const EYE = (aircraft && aircraft.parts && aircraft.parts.pilotEye)
    ? aircraft.parts.pilotEye.clone()
    : new THREE.Vector3(-0.55, 3.15, 9.20);

  const root = new THREE.Group();
  root.name = 'cockpit';
  aircraft.group.add(root);

  // ---------------------------------------------------------------------------
  // Canvases & textures
  // ---------------------------------------------------------------------------
  const panelCanvas = document.createElement('canvas');
  panelCanvas.width = PC_W; panelCanvas.height = PC_H;
  const pctx = panelCanvas.getContext('2d');

  const panelTex = new THREE.CanvasTexture(panelCanvas);
  panelTex.colorSpace = THREE.SRGBColorSpace;
  panelTex.anisotropy = 4;
  panelTex.minFilter = THREE.LinearMipmapLinearFilter;
  panelTex.magFilter = THREE.LinearFilter;

  const mcpCanvas = document.createElement('canvas');
  mcpCanvas.width = MCP_W; mcpCanvas.height = MCP_H;
  const mctx = mcpCanvas.getContext('2d');
  const mcpTex = new THREE.CanvasTexture(mcpCanvas);
  mcpTex.colorSpace = THREE.SRGBColorSpace;
  mcpTex.anisotropy = 4;

  // One shared material for every DU; geometry UVs are cropped to a cell so a
  // single texture upload serves all displays.
  const duMat = new THREE.MeshBasicMaterial({ map: panelTex });
  function duGeometry(col, row, w, h) {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      uv.setXY(i, (col + u) / PC_COLS, 1 - (row + 1 - v) / PC_ROWS);
    }
    uv.needsUpdate = true;
    return g;
  }

  const matPanel = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.9, metalness: 0.08 });
  const matPanelDark = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95, metalness: 0.05 });
  const matKnob = new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.6, metalness: 0.35 });
  const matLever = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.5, metalness: 0.5 });
  const matGrip = new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.9 });

  // ---------------------------------------------------------------------------
  // Canvas drawing helpers
  // ---------------------------------------------------------------------------
  function cell(col, row) {
    pctx.save();
    pctx.beginPath();
    pctx.rect(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    pctx.clip();
    pctx.translate(col * CELL_W, row * CELL_H);
    return { w: CELL_W, h: CELL_H };
  }
  function txt(s, x, y, size, color, align = 'center', weight = 600, font = 'monospace') {
    pctx.fillStyle = color;
    pctx.font = `${weight} ${size}px ${font}, monospace`;
    pctx.textAlign = align; pctx.textBaseline = 'middle';
    pctx.fillText(s, x, y);
  }
  function hline(x1, x2, y, color, wdt = 2) {
    pctx.strokeStyle = color; pctx.lineWidth = wdt;
    pctx.beginPath(); pctx.moveTo(x1, y); pctx.lineTo(x2, y); pctx.stroke();
  }
  function rrect(x, y, w, h, r) {
    pctx.beginPath();
    pctx.moveTo(x + r, y);
    pctx.arcTo(x + w, y, x + w, y + h, r);
    pctx.arcTo(x + w, y + h, x, y + h, r);
    pctx.arcTo(x, y + h, x, y, r);
    pctx.arcTo(x, y, x + w, y, r);
    pctx.closePath();
  }

  // ---------------------------------------------------------------------------
  // ILS geometry (shared by PFD diamonds and APP autopilot mode)
  // ---------------------------------------------------------------------------
  // ils = { lat, lon, headingTrue, gsDeg, freq, id, thrElevM? }
  const _thr = new THREE.Vector3();
  function ilsGeometry(fstate, ils) {
    if (!ils) return null;
    latLonToWorld(ils.lat, ils.lon, _thr);
    const dx = fstate.pos.x - _thr.x, dz = fstate.pos.z - _thr.z;
    const h = ils.headingTrue * DEG;
    const fx = Math.sin(h), fz = -Math.cos(h);      // runway forward (x=east,z=south)
    const rx = Math.cos(h), rz = Math.sin(h);       // runway right
    const along = dx * fx + dz * fz;                 // + ahead of threshold
    const cross = dx * rx + dz * rz;                 // + right of centerline
    const distM = Math.hypot(dx, dz);
    const thrY = (ils.thrElevM != null ? ils.thrElevM : 5);
    const hgt = fstate.pos.y - thrY;
    const gsRad = (ils.gsDeg || 3.0) * DEG;
    // Angular deviations in "dots" (2.5 dots = full scale)
    const brg = Math.atan2(dx, -dz) / DEG;           // bearing threshold->acft
    const locDots = clamp(wrap180(brg - ils.headingTrue) / 0.6, -2.5, 2.5);
    let gsDots = 0;
    if (along < -50) { // on final, ahead of the threshold
      const actAng = Math.atan2(hgt, Math.abs(along)) / DEG;
      gsDots = clamp(((ils.gsDeg || 3.0) - actAng) / 0.35, -2.5, 2.5); // <0 = above GS
    }
    return { along, cross, distM, hgt, locDots, gsDots };
  }

  // ---------------------------------------------------------------------------
  // PFD drawing
  // ---------------------------------------------------------------------------
  function fmaText(ap, flash) {
    // [A/T, ROLL, PITCH]
    let at = '', roll = '', pitch = '';
    if (ap.apEngaged) {
      at = ap.atArmed ? (ap.vertMode === 'LVLCHG' ? 'N1' : 'SPD') : '';
      roll = ap.latMode === 'APP' ? 'LOC' : (ap.latMode === 'HDG' ? 'HDG SEL' : '');
      pitch = ap.vertMode === 'ALTHLD' ? 'ALT HLD'
        : ap.vertMode === 'VS' ? 'V/S'
        : ap.vertMode === 'LVLCHG' ? 'LVL CHG'
        : ap.vertMode === 'GS' ? 'G/S'
        : ap.vertMode === 'VNAV' ? 'VNAV PTH' : '';
    } else {
      if (ap.atArmed) at = 'A/T ARM';
    }
    return { at, roll, pitch, flash };
  }

  function drawPFD(col, fstate, ap, ilsGeo, showILS, flashOn) {
    const { w, h } = cell(col, 0);
    try {
      const ias = fstate.iasKt, alt = fstate.altFtMSL, hdg = fstate.heading;
      const pitch = fstate.pitch, roll = fstate.roll, vs = fstate.vsFpm;

      pctx.fillStyle = C.bg; pctx.fillRect(0, 0, w, h);

      // ---- FMA ----
      const fma = fmaText(ap, flashOn);
      pctx.fillStyle = '#000'; pctx.fillRect(0, 0, w, 46);
      hline(0, w, 46, '#2a2e35', 2);
      if (ap.apEngaged) {
        pctx.fillStyle = flashOn ? C.amber : C.green;
        rrect(6, 6, 64, 34, 4); pctx.fill();
        txt('CMD', 38, 24, 20, '#000', 'center', 800);
      }
      if (ap.fdOn) txt('FD', 84, 24, 18, C.green);
      txt(fma.at, w * 0.22, 24, 20, fma.flash && flashOn ? C.amber : C.green);
      txt(fma.roll, w * 0.5, 24, 20, fma.flash && flashOn ? C.amber : C.green);
      txt(fma.pitch, w * 0.78, 24, 20, fma.flash && flashOn ? C.amber : C.green);

      // ---- Attitude ----
      const ax = 78, ay = 56, aw = w - 78 - 74, ah = 336; // attitude rect
      const cx = ax + aw / 2, cy = ay + ah / 2;
      const pxPerDeg = 3.4;
      pctx.save();
      rrect(ax, ay, aw, ah, 6); pctx.clip();
      pctx.translate(cx, cy);
      pctx.rotate(-roll * DEG);
      const yOff = pitch * pxPerDeg; // +pitch -> horizon drawn lower on screen
      // sky / ground
      pctx.fillStyle = C.sky; pctx.fillRect(-aw, -2 * ah, aw * 2, 2 * ah + yOff);
      pctx.fillStyle = C.gnd; pctx.fillRect(-aw, yOff, aw * 2, 2 * ah - yOff);
      pctx.strokeStyle = C.white; pctx.lineWidth = 3;
      pctx.beginPath(); pctx.moveTo(-aw, yOff); pctx.lineTo(aw, yOff); pctx.stroke();
      // pitch ladder
      pctx.fillStyle = C.white; pctx.strokeStyle = C.white; pctx.lineWidth = 2;
      pctx.font = '600 15px monospace'; pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
      for (let p = -30; p <= 30; p += 10) {
        if (p === 0) continue;
        const y = yOff - p * pxPerDeg;
        const len = p % 20 === 0 ? 46 : 26;
        pctx.beginPath(); pctx.moveTo(-len, y); pctx.lineTo(len, y); pctx.stroke();
        if (p % 20 === 0) { pctx.fillText(String(Math.abs(p)), -len - 22, y); pctx.fillText(String(Math.abs(p)), len + 22, y); }
      }
      // bank scale
      pctx.strokeStyle = C.white; pctx.lineWidth = 2;
      const bankMarks = [[-60, 8], [-45, 12], [-30, 8], [-20, 12], [-10, 8], [0, 14], [10, 8], [20, 12], [30, 8], [45, 12], [60, 8]];
      for (const [b, l] of bankMarks) {
        const a = b * DEG;
        pctx.beginPath();
        pctx.moveTo(Math.sin(a) * 118, -Math.cos(a) * 118);
        pctx.lineTo(Math.sin(a) * (118 - l), -Math.cos(a) * (118 - l));
        pctx.stroke();
      }
      pctx.restore();
      // bank pointer (aircraft-fixed)
      pctx.save(); pctx.translate(cx, cy); pctx.rotate(-roll * DEG);
      pctx.fillStyle = C.white;
      pctx.beginPath(); pctx.moveTo(0, -104); pctx.lineTo(-8, -118); pctx.lineTo(8, -118); pctx.closePath(); pctx.fill();
      pctx.restore();
      // attitude frame
      pctx.strokeStyle = '#2a2e35'; pctx.lineWidth = 3; rrect(ax, ay, aw, ah, 6); pctx.stroke();
      // fixed aircraft symbol
      pctx.strokeStyle = '#ffcf00'; pctx.lineWidth = 5;
      pctx.beginPath(); pctx.moveTo(cx - 52, cy); pctx.lineTo(cx - 18, cy); pctx.lineTo(cx - 18, cy + 8); pctx.stroke();
      pctx.beginPath(); pctx.moveTo(cx + 52, cy); pctx.lineTo(cx + 18, cy); pctx.lineTo(cx + 18, cy + 8); pctx.stroke();
      pctx.fillStyle = '#ffcf00'; pctx.fillRect(cx - 3, cy - 3, 6, 6);
      // flight director bars
      if (ap.fdOn && ap.apEngaged) {
        pctx.strokeStyle = C.magenta; pctx.lineWidth = 4;
        const fdx = clamp(wrap180((ap.latMode === 'HDG' ? (ap.hdgSel ?? hdg) : hdg) - hdg) * 2, -40, 40);
        const fdy = clamp(((ap.vertMode === 'VS' ? 0 : 0)), -40, 40);
        pctx.beginPath(); pctx.moveTo(cx - 46 + fdx, cy + fdy); pctx.lineTo(cx + 46 + fdx, cy + fdy); pctx.stroke();
        pctx.beginPath(); pctx.moveTo(cx + fdx, cy - 40 + fdy); pctx.lineTo(cx + fdx, cy + 40 + fdy); pctx.stroke();
      }
      // ILS diamonds
      if (showILS && ilsGeo) {
        // LOC scale (bottom of attitude)
        const ly = ay + ah - 14;
        hline(cx - 80, cx + 80, ly, C.white, 2);
        for (let d = -2; d <= 2; d++) { pctx.fillStyle = C.white; pctx.fillRect(cx + d * 32 - 1, ly - 5, 2, 10); }
        const lx = clamp(cx + ilsGeo.locDots * 32, cx - 80, cx + 80);
        pctx.fillStyle = C.magenta;
        pctx.beginPath(); pctx.moveTo(lx, ly - 10); pctx.lineTo(lx + 8, ly); pctx.lineTo(lx, ly + 10); pctx.lineTo(lx - 8, ly); pctx.closePath(); pctx.fill();
        // GS scale (right of attitude)
        const gx = ax + aw + 12;
        pctx.strokeStyle = C.white; pctx.lineWidth = 2;
        pctx.beginPath(); pctx.moveTo(gx, cy - 80); pctx.lineTo(gx, cy + 80); pctx.stroke();
        for (let d = -2; d <= 2; d++) { pctx.fillStyle = C.white; pctx.fillRect(gx - 5, cy + d * 32 - 1, 10, 2); }
        const gy = clamp(cy - ilsGeo.gsDots * 32, cy - 80, cy + 80);
        pctx.fillStyle = C.magenta;
        pctx.beginPath(); pctx.moveTo(gx - 10, gy); pctx.lineTo(gx, gy - 8); pctx.lineTo(gx + 10, gy); pctx.lineTo(gx, gy + 8); pctx.closePath(); pctx.fill();
      }
      // radio altitude
      if (fstate.aglM * M_TO_FT < 2500) {
        txt('R ' + fmtInt(fstate.aglM * M_TO_FT), cx, ay + ah - 34, 22, C.green, 'center', 700);
      }

      // ---- Airspeed tape ----
      const sx = 6, sy = 56, sw = 62, sh = 336;
      const sCy = sy + sh / 2, pxKt = sh / 90;
      pctx.fillStyle = '#000'; pctx.fillRect(sx, sy, sw, sh);
      pctx.save(); pctx.beginPath(); pctx.rect(sx, sy, sw, sh); pctx.clip();
      const sLo = Math.floor((ias - 45) / 10) * 10;
      for (let s = sLo; s < ias + 50; s += 5) {
        if (s < 40) continue;
        const y = sCy - (s - ias) * pxKt;
        const maj = s % 10 === 0;
        pctx.strokeStyle = C.white; pctx.lineWidth = maj ? 2 : 1;
        pctx.beginPath(); pctx.moveTo(sx + sw - (maj ? 14 : 8), y); pctx.lineTo(sx + sw, y); pctx.stroke();
        if (maj) txt(String(s), sx + sw / 2 - 8, y, 15, C.white);
      }
      // V-speed bugs
      const bug = (v, color, label) => {
        const y = sCy - (v - ias) * pxKt;
        if (y < sy || y > sy + sh) return;
        pctx.fillStyle = color;
        pctx.beginPath(); pctx.moveTo(sx, y - 7); pctx.lineTo(sx + 12, y); pctx.lineTo(sx, y + 7); pctx.closePath(); pctx.fill();
        txt(label, sx + 22, y, 13, color, 'left', 700);
      };
      bug(V1, C.blue, '1'); bug(VR, C.green, 'R'); bug(V2, C.magenta, '2');
      // flap maneuver speeds (green F)
      const flapSpd = [158, 148, 138, 128]; // approx for UP..15
      const det = fstate.flapDetent;
      if (det < 4) { const y = sCy - (flapSpd[det] - ias) * pxKt; if (y > sy && y < sy + sh) txt('F', sx + 8, y, 16, C.green, 'left', 800); }
      pctx.restore();
      pctx.strokeStyle = '#2a2e35'; pctx.lineWidth = 2; pctx.strokeRect(sx, sy, sw, sh);
      // current speed box
      pctx.fillStyle = '#000'; pctx.strokeStyle = C.white; pctx.lineWidth = 2;
      rrect(sx - 4, sCy - 17, sw + 12, 34, 4); pctx.fill(); pctx.stroke();
      txt(fmtInt(ias, 3), sx + sw / 2 + 2, sCy, 24, C.white, 'center', 700);
      // selected speed bug (magenta) when A/T armed
      if (ap.spdSelKt != null) {
        const y = sCy - (ap.spdSelKt - ias) * pxKt;
        if (y > sy && y < sy + sh) { pctx.fillStyle = C.magenta; pctx.fillRect(sx + sw + 2, y - 6, 6, 12); }
      }

      // ---- Altitude tape ----
      const tx = w - 68, ty = 56, tw = 62, th = 336;
      const tCy = ty + th / 2, pxFt = th / 900;
      pctx.fillStyle = '#000'; pctx.fillRect(tx, ty, tw, th);
      pctx.save(); pctx.beginPath(); pctx.rect(tx, ty, tw, th); pctx.clip();
      const aLo = Math.floor((alt - 450) / 100) * 100;
      for (let a = aLo; a < alt + 500; a += 50) {
        if (a < 0) continue;
        const y = tCy - (a - alt) * pxFt;
        const maj = a % 100 === 0;
        pctx.strokeStyle = C.white; pctx.lineWidth = maj ? 2 : 1;
        pctx.beginPath(); pctx.moveTo(tx, y); pctx.lineTo(tx + (maj ? 12 : 7), y); pctx.stroke();
        if (maj) txt(fmtInt(a), tx + tw / 2 + 6, y, 14, C.white);
      }
      pctx.restore();
      pctx.strokeStyle = '#2a2e35'; pctx.lineWidth = 2; pctx.strokeRect(tx, ty, tw, th);
      // selected altitude bug
      if (ap.altSelFt != null) {
        const y = tCy - (ap.altSelFt - alt) * pxFt;
        if (y > ty && y < ty + th) {
          pctx.strokeStyle = C.magenta; pctx.lineWidth = 3;
          pctx.beginPath(); pctx.moveTo(tx - 2, y - 9); pctx.lineTo(tx - 14, y); pctx.lineTo(tx - 2, y + 9); pctx.stroke();
        }
        pctx.fillStyle = '#000'; pctx.strokeStyle = C.magenta; pctx.lineWidth = 2;
        rrect(tx - 6, ty - 30, tw + 12, 26, 4); pctx.fill(); pctx.stroke();
        txt(fmtInt(ap.altSelFt, 5), tx + tw / 2, ty - 17, 18, C.magenta, 'center', 700);
      }
      // current altitude box
      pctx.fillStyle = '#000'; pctx.strokeStyle = C.white; pctx.lineWidth = 2;
      rrect(tx - 6, tCy - 17, tw + 14, 34, 4); pctx.fill(); pctx.stroke();
      txt(fmtInt(alt, 5), tx + tw / 2 + 2, tCy, 22, C.white, 'center', 700);
      txt('29.92', tx + tw / 2, ty + th + 16, 15, C.cyan); // baro inHg

      // ---- VSI strip ----
      const vx = w - 6, vy = 56, vh = 336, vCy = vy + vh / 2;
      pctx.fillStyle = '#000'; pctx.fillRect(vx, vy, 6, vh);
      const vClamped = clamp(vs, -2000, 2000);
      const vY = vCy - (vClamped / 2000) * (vh / 2);
      pctx.strokeStyle = C.white; pctx.lineWidth = 3;
      pctx.beginPath(); pctx.moveTo(vx, vCy); pctx.lineTo(vx + 6, vY); pctx.stroke();
      txt((vs >= 0 ? '+' : '') + fmtInt(vs / 100), vx - 4, vy + vh + 16, 14, C.white, 'right');

      // ---- Heading strip ----
      const hx = 6, hy = h + -104, hw = w - 12, hh = 58;
      const hCx = hx + hw / 2, pxHdg = hw / 90;
      pctx.fillStyle = '#000'; pctx.fillRect(hx, hy, hw, hh);
      pctx.save(); pctx.beginPath(); pctx.rect(hx, hy, hw, hh); pctx.clip();
      const hLo = Math.floor((hdg - 45) / 10) * 10;
      for (let d = hLo; d < hdg + 50; d += 10) {
        const dd = wrap360(d);
        const x = hCx + wrap180(dd - hdg) * pxHdg;
        pctx.strokeStyle = C.white; pctx.lineWidth = 2;
        pctx.beginPath(); pctx.moveTo(x, hy); pctx.lineTo(x, hy + 10); pctx.stroke();
        const lbl = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd / 10);
        txt(lbl, x, hy + 26, 16, C.white);
      }
      // selected heading bug
      if (ap.hdgSel != null) {
        const x = hCx + wrap180(ap.hdgSel - hdg) * pxHdg;
        if (x > hx && x < hx + hw) {
          pctx.fillStyle = C.magenta;
          pctx.beginPath(); pctx.moveTo(x, hy + hh - 4); pctx.lineTo(x - 8, hy + hh - 18); pctx.lineTo(x + 8, hy + hh - 18); pctx.closePath(); pctx.fill();
        }
      }
      pctx.restore();
      pctx.strokeStyle = '#2a2e35'; pctx.lineWidth = 2; pctx.strokeRect(hx, hy, hw, hh);
      pctx.fillStyle = '#000'; pctx.strokeStyle = C.white;
      rrect(hCx - 34, hy - 4, 68, 26, 4); pctx.fill(); pctx.stroke();
      txt(fmtInt(hdg, 3), hCx, hy + 9, 20, C.white, 'center', 700);
    } finally { pctx.restore(); }
  }

  // ---------------------------------------------------------------------------
  // ND (navigation display, heading-up)
  // ---------------------------------------------------------------------------
  const _aptW = new THREE.Vector3();
  function drawND(col, fstate, ap, ils) {
    const { w, h } = cell(col, 0);
    try {
      const hdg = fstate.heading, gs = fstate.gsKt;
      pctx.fillStyle = C.bg; pctx.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h * 0.54, R = 168;
      const RANGE_NM = 40, pxNm = (R - 12) / RANGE_NM;

      const toScreen = (lat, lon) => {
        latLonToWorld(lat, lon, _aptW);
        const dx = _aptW.x - fstate.pos.x, dz = _aptW.z - fstate.pos.z;
        const hr = hdg * DEG;
        const fx = Math.sin(hr), fz = -Math.cos(hr);
        const rx = Math.cos(hr), rz = Math.sin(hr);
        return { f: dx * fx + dz * fz, r: dx * rx + dz * rz };
      };

      // range rings
      pctx.strokeStyle = '#3a4048'; pctx.lineWidth = 1.5;
      for (const nm of [10, 20, 30]) {
        pctx.beginPath(); pctx.arc(cx, cy, nm * pxNm, 0, Math.PI * 2); pctx.stroke();
        txt(String(nm), cx + nm * pxNm - 4, cy - 10, 13, C.dim, 'right');
      }
      // compass rose
      const hLo = Math.floor((hdg - 70) / 10) * 10;
      for (let d = hLo; d < hdg + 75; d += 10) {
        const dd = wrap360(d), rel = wrap180(dd - hdg) * DEG;
        if (Math.abs(wrap180(dd - hdg)) > 70) continue;
        const x1 = cx + Math.sin(rel) * R, y1 = cy - Math.cos(rel) * R;
        const x2 = cx + Math.sin(rel) * (R - (dd % 30 === 0 ? 14 : 7)), y2 = cy - Math.cos(rel) * (R - (dd % 30 === 0 ? 14 : 7));
        pctx.strokeStyle = C.white; pctx.lineWidth = dd % 30 === 0 ? 2.5 : 1.5;
        pctx.beginPath(); pctx.moveTo(x1, y1); pctx.lineTo(x2, y2); pctx.stroke();
        if (dd % 30 === 0) {
          const lbl = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd / 10);
          txt(lbl, cx + Math.sin(rel) * (R - 28), cy - Math.cos(rel) * (R - 28), 17, C.white);
        }
      }
      // selected heading bug (magenta)
      if (ap.hdgSel != null) {
        const rel = wrap180(ap.hdgSel - hdg) * DEG;
        const bx = cx + Math.sin(rel) * R, by = cy - Math.cos(rel) * R;
        pctx.strokeStyle = C.magenta; pctx.lineWidth = 3;
        pctx.beginPath(); pctx.moveTo(bx - 9, by); pctx.lineTo(bx + 9, by); pctx.moveTo(bx, by - 9); pctx.lineTo(bx, by + 9); pctx.stroke();
        pctx.save(); pctx.translate(bx, by); pctx.rotate(rel);
        pctx.fillStyle = C.magenta;
        pctx.beginPath(); pctx.moveTo(0, -16); pctx.lineTo(-7, -4); pctx.lineTo(7, -4); pctx.closePath(); pctx.fill();
        pctx.restore();
      }
      // airports + runways
      pctx.save();
      pctx.beginPath(); pctx.arc(cx, cy, R, 0, Math.PI * 2); pctx.clip();
      for (const key of Object.keys(AIRPORTS)) {
        const apt = AIRPORTS[key];
        const s = toScreen(apt.lat, apt.lon);
        const distNm = Math.hypot(s.f, s.r) / NM_TO_M;
        if (distNm > RANGE_NM + 3) continue;
        const px = cx + s.r * pxNm, py = cy - s.f * pxNm;
        // runways (threshold -> far end along runway heading)
        pctx.strokeStyle = '#e8ecf1'; pctx.lineWidth = 2.5;
        for (const rwy of apt.runways) {
          const b = toScreen(rwy.thresholdLat, rwy.thresholdLon);
          const lenM = rwy.lengthFt * FT_TO_M;
          const rel = wrap180(rwy.headingTrue - hdg) * DEG;
          const f2 = b.f + Math.cos(rel) * lenM;
          const r2 = b.r + Math.sin(rel) * lenM;
          const p1x = cx + b.r * pxNm, p1y = cy - b.f * pxNm;
          const p2x = cx + r2 * pxNm, p2y = cy - f2 * pxNm;
          pctx.beginPath(); pctx.moveTo(p1x, p1y); pctx.lineTo(p2x, p2y); pctx.stroke();
          if (rwy.ils) { pctx.fillStyle = C.green; pctx.fillRect(p1x - 2, p1y - 2, 4, 4); }
        }
        // airport symbol
        pctx.strokeStyle = C.cyan; pctx.lineWidth = 2;
        pctx.beginPath(); pctx.arc(px, py, 9, 0, Math.PI * 2); pctx.stroke();
        pctx.beginPath(); pctx.moveTo(px - 13, py); pctx.lineTo(px + 13, py); pctx.stroke();
        txt(apt.icao.replace('K', ''), px, py + 22, 15, C.cyan, 'center', 700);
      }
      pctx.restore();
      // ownship
      pctx.fillStyle = C.white;
      pctx.beginPath(); pctx.moveTo(cx, cy - 14); pctx.lineTo(cx - 10, cy + 10); pctx.lineTo(cx + 10, cy + 10); pctx.closePath(); pctx.fill();
      // top data
      txt('GS ' + fmtInt(gs, 3), 12, 24, 20, C.green, 'left', 700);
      txt(fmtInt(fstate.iasKt, 3) + ' KT', w - 12, 24, 20, C.white, 'right', 700);
      txt('HDG ' + fmtInt(hdg, 3) + '°', cx, 24, 20, C.white, 'center', 700);
      txt(RANGE_NM + ' NM', cx, h - 18, 16, C.cyan);
      if (ils) txt('ILS ' + (ils.id || '') + ' ' + (ils.freq || ''), 12, h - 18, 15, C.green, 'left');
      txt('MAP', w - 12, h - 18, 15, C.dim, 'right');
    } finally { pctx.restore(); }
  }

  // ---------------------------------------------------------------------------
  // EICAS upper: N1 / EGT / FF / fuel
  // ---------------------------------------------------------------------------
  function drawN1Gauge(x, y, r, n1, label) {
    const a0 = 135 * DEG, a1 = 405 * DEG;
    pctx.lineWidth = 10; pctx.lineCap = 'butt';
    pctx.strokeStyle = '#2c313a';
    pctx.beginPath(); pctx.arc(x, y, r, a0, a1); pctx.stroke();
    pctx.strokeStyle = C.green;
    pctx.beginPath(); pctx.arc(x, y, r, a0, a0 + (a1 - a0) * clamp(n1 / 1.1, 0, 1)); pctx.stroke();
    // redline > 1.04
    pctx.strokeStyle = C.red; pctx.lineWidth = 12;
    pctx.beginPath(); pctx.arc(x, y, r, a0 + (a1 - a0) * (1.04 / 1.1), a1); pctx.stroke();
    // ticks
    pctx.strokeStyle = C.white; pctx.lineWidth = 2;
    for (let v = 0; v <= 110; v += 10) {
      const a = a0 + (a1 - a0) * (v / 110);
      pctx.beginPath();
      pctx.moveTo(x + Math.cos(a) * (r - 8), y + Math.sin(a) * (r - 8));
      pctx.lineTo(x + Math.cos(a) * (r + 8), y + Math.sin(a) * (r + 8));
      pctx.stroke();
      if (v % 20 === 0) txt(String(v), x + Math.cos(a) * (r - 26), y + Math.sin(a) * (r - 26), 13, C.dim);
    }
    // needle
    const na = a0 + (a1 - a0) * clamp(n1 / 1.1, 0, 1);
    pctx.strokeStyle = C.white; pctx.lineWidth = 4;
    pctx.beginPath(); pctx.moveTo(x, y); pctx.lineTo(x + Math.cos(na) * (r - 14), y + Math.sin(na) * (r - 14)); pctx.stroke();
    txt((n1 * 100).toFixed(1), x, y + r + 26, 30, C.white, 'center', 700);
    txt(label, x, y + r + 56, 16, C.dim);
  }

  function drawEicasUpper(fstate) {
    const { w, h } = cell(COL.EICAS, 0);
    try {
      pctx.fillStyle = C.bg; pctx.fillRect(0, 0, w, h);
      txt('ENG', w / 2, 22, 20, C.dim, 'center', 700);
      hline(10, w - 10, 40, '#2a2e35', 2);
      drawN1Gauge(w * 0.27, 150, 74, fstate.n1[0], 'N1  1');
      drawN1Gauge(w * 0.73, 150, 74, fstate.n1[1], 'N1  2');
      // EGT + FF
      for (let i = 0; i < 2; i++) {
        const x = w * (0.27 + 0.46 * i);
        txt('EGT ' + fmtInt(fstate.egtC[i]) + '°C', x, 268, 19, fstate.egtC[i] > 900 ? C.red : C.white, 'center', 600);
        txt('FF ' + fmtInt(fstate.fuelFlowKgH[i]), x, 296, 19, C.white, 'center', 600);
        txt('kg/h', x, 316, 13, C.dim);
      }
      hline(10, w - 10, 344, '#2a2e35', 2);
      txt('FUEL QTY  ' + fmtInt(fstate.fuelKg) + ' KG', w / 2, 372, 22, C.white, 'center', 700);
      txt('OIL P  ' + (fstate.n1[0] > 0.05 ? '62' : '0') + '   ' + (fstate.n1[1] > 0.05 ? '62' : '0') + ' PSI', w / 2, 406, 17, C.dim);
      txt('VIB  ' + '0.4   0.4', w / 2, 432, 17, C.dim);
      txt('N2  ' + fmtInt(30 + fstate.n1[0] * 70) + '   ' + fmtInt(30 + fstate.n1[1] * 70), w / 2, 458, 17, C.dim);
    } finally { pctx.restore(); }
  }

  // ---------------------------------------------------------------------------
  // EICAS lower: flaps / gear / trim / messages
  // ---------------------------------------------------------------------------
  function drawEicasLower(fstate, msgs) {
    const { w, h } = cell(COL.EICAS, 1);
    try {
      pctx.fillStyle = C.bg; pctx.fillRect(0, 0, w, h);
      // flap dial
      const fx = w * 0.24, fy = 150, fr = 78;
      const detents = AIRCRAFT.flapDetents;
      const a0 = 150 * DEG, a1 = 390 * DEG;
      pctx.strokeStyle = '#2c313a'; pctx.lineWidth = 12;
      pctx.beginPath(); pctx.arc(fx, fy, fr, a0, a1); pctx.stroke();
      pctx.font = '600 14px monospace'; pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
      detents.forEach((d, i) => {
        const a = a0 + (a1 - a0) * (i / (detents.length - 1));
        const px = fx + Math.cos(a) * fr, py = fy + Math.sin(a) * fr;
        pctx.fillStyle = i === fstate.flapDetent ? C.green : C.dim;
        pctx.fillText(d === 0 ? 'UP' : String(d), fx + Math.cos(a) * (fr - 30), fy + Math.sin(a) * (fr - 30));
      });
      const fa = a0 + (a1 - a0) * (fstate.flapDetent / (detents.length - 1));
      pctx.strokeStyle = C.green; pctx.lineWidth = 5;
      pctx.beginPath(); pctx.moveTo(fx, fy); pctx.lineTo(fx + Math.cos(fa) * (fr - 12), fy + Math.sin(fa) * (fr - 12)); pctx.stroke();
      txt('FLAP', fx, fy + fr + 30, 16, C.dim);
      txt(detents[fstate.flapDetent] === 0 ? 'UP' : String(detents[fstate.flapDetent]), fx, fy + fr + 54, 22, C.green, 'center', 700);

      // gear lights
      const gx = w * 0.62, gy = 130;
      txt('GEAR', gx, gy - 62, 16, C.dim);
      const transit = fstate.gearPos > 0.02 && fstate.gearPos < 0.98;
      for (let i = -1; i <= 1; i++) {
        const x = gx + i * 56;
        pctx.beginPath(); pctx.arc(x, gy, 20, 0, Math.PI * 2);
        if (fstate.gearPos > 0.98) { pctx.fillStyle = '#0d3'; pctx.fill(); txt(i === 0 ? 'N' : i < 0 ? 'L' : 'R', x, gy, 15, '#000', 'center', 800); }
        else if (transit) { pctx.fillStyle = C.red; pctx.fill(); }
        else { pctx.strokeStyle = '#3a4048'; pctx.lineWidth = 3; pctx.stroke(); }
      }
      txt(transit ? 'TRANSIT' : (fstate.gearPos > 0.98 ? 'DOWN 3 GREEN' : 'UP'), gx, gy + 44, 16, transit ? C.red : C.green, 'center', 700);

      // stab trim
      txt('STAB TRIM', w * 0.88, 90, 14, C.dim);
      txt('5.0', w * 0.88, 120, 26, C.green, 'center', 700);
      txt('UNITS', w * 0.88, 146, 13, C.dim);

      // messages
      hline(10, w - 10, 250, '#2a2e35', 2);
      txt('MEMO', w / 2, 272, 16, C.dim, 'center', 700);
      msgs.forEach((m, i) => txt(m.t, w / 2, 300 + i * 28, 19, m.c, 'center', 700));
    } finally { pctx.restore(); }
  }

  // ---------------------------------------------------------------------------
  // Standby instruments (ASI / ATT / ALT strip under the captain's side)
  // ---------------------------------------------------------------------------
  function drawStandby(fstate) {
    pctx.save();
    pctx.beginPath(); pctx.rect(0, CELL_H, CELL_W * 2, CELL_H); pctx.clip();
    pctx.translate(0, CELL_H);
    const w = CELL_W * 2, h = CELL_H;
    try {
      pctx.fillStyle = '#101216'; pctx.fillRect(0, 0, w, h);
      txt('STBY', w / 2, 26, 18, C.dim, 'center', 700);
      const gy = 200, gr = 105;
      const gauges = [
        { x: w * 0.2, label: 'AIRSPEED', val: fmtInt(fstate.iasKt, 3) + ' KT' },
        { x: w * 0.5, label: 'ATTITUDE', val: null },
        { x: w * 0.8, label: 'ALTITUDE', val: fmtInt(fstate.altFtMSL, 5) + ' FT' },
      ];
      gauges.forEach((g, gi) => {
        pctx.fillStyle = '#000';
        pctx.beginPath(); pctx.arc(g.x, gy, gr, 0, Math.PI * 2); pctx.fill();
        pctx.strokeStyle = '#3a4048'; pctx.lineWidth = 3;
        pctx.beginPath(); pctx.arc(g.x, gy, gr, 0, Math.PI * 2); pctx.stroke();
        if (gi === 1) {
          // mini attitude ball
          pctx.save();
          pctx.beginPath(); pctx.arc(g.x, gy, gr - 6, 0, Math.PI * 2); pctx.clip();
          pctx.translate(g.x, gy); pctx.rotate(-fstate.roll * DEG);
          const yo = fstate.pitch * 2.4;
          pctx.fillStyle = C.sky; pctx.fillRect(-gr, -2 * gr, gr * 2, 2 * gr + yo);
          pctx.fillStyle = C.gnd; pctx.fillRect(-gr, yo, gr * 2, 2 * gr - yo);
          pctx.strokeStyle = C.white; pctx.lineWidth = 2;
          pctx.beginPath(); pctx.moveTo(-gr, yo); pctx.lineTo(gr, yo); pctx.stroke();
          pctx.restore();
          pctx.strokeStyle = '#ffcf00'; pctx.lineWidth = 3;
          pctx.beginPath(); pctx.moveTo(g.x - 34, gy); pctx.lineTo(g.x + 34, gy); pctx.stroke();
        } else if (gi === 0) {
          // mini ASI dial
          pctx.strokeStyle = C.white; pctx.lineWidth = 2;
          for (let s = 0; s <= 400; s += 50) {
            const a = (135 + s / 400 * 270) * DEG;
            pctx.beginPath();
            pctx.moveTo(g.x + Math.cos(a) * (gr - 12), gy + Math.sin(a) * (gr - 12));
            pctx.lineTo(g.x + Math.cos(a) * (gr - 4), gy + Math.sin(a) * (gr - 4));
            pctx.stroke();
          }
          const na = (135 + clamp(fstate.iasKt, 0, 400) / 400 * 270) * DEG;
          pctx.strokeStyle = C.red; pctx.lineWidth = 4;
          pctx.beginPath(); pctx.moveTo(g.x, gy); pctx.lineTo(g.x + Math.cos(na) * (gr - 18), gy + Math.sin(na) * (gr - 18)); pctx.stroke();
        } else {
          // mini altimeter: digital + needle
          const na = (fstate.altFtMSL % 1000) / 1000 * 360 * DEG;
          pctx.strokeStyle = C.white; pctx.lineWidth = 3;
          pctx.beginPath(); pctx.moveTo(g.x, gy); pctx.lineTo(g.x + Math.sin(na) * (gr - 18), gy - Math.cos(na) * (gr - 18)); pctx.stroke();
        }
        txt(g.label, g.x, gy + gr + 26, 15, C.dim);
        if (g.val) txt(g.val, g.x, gy + gr + 52, 20, C.white, 'center', 700);
      });
      // lower-right cells: dark fill
      pctx.fillStyle = C.dark; pctx.fillRect(CELL_W * 2, 0, CELL_W * 3, h);
    } finally { pctx.restore(); }
  }

  // ---------------------------------------------------------------------------
  // MCP window strip canvas (1024x256): selector windows + painted button labels
  // ---------------------------------------------------------------------------
  function drawMCPWindows(ap, fstate) {
    const W = MCP_W, H = MCP_H;
    try {
      mctx.fillStyle = '#05070a'; mctx.fillRect(0, 0, W, H);
      const xPx = (x) => (x + 0.31) / 0.62 * W; // MCP-local x -> canvas px
      // ---- selector windows ----
      const wins = [
        { label: 'IAS/MACH', val: ap.spdSelKt != null ? fmtInt(ap.spdSelKt, 3) : '---', x: -0.225 },
        { label: 'HDG', val: ap.hdgSel != null ? fmtInt(ap.hdgSel, 3) : '---', x: -0.075 },
        { label: 'ALTITUDE', val: ap.altSelFt != null ? fmtInt(ap.altSelFt, 5) : '-----', x: 0.075 },
        { label: 'VERT SPEED', val: ((ap.vsSelFpm || 0) >= 0 ? '+' : '-') + fmtInt(Math.abs(ap.vsSelFpm || 0), 4), x: 0.225 },
      ];
      mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
      for (const wn of wins) {
        const cxp = xPx(wn.x), cyp = 52, ww = 190, wh = 84;
        mctx.fillStyle = '#0d1117'; mctx.fillRect(cxp - ww / 2, cyp - wh / 2, ww, wh);
        mctx.strokeStyle = '#2a2e35'; mctx.lineWidth = 2;
        mctx.strokeRect(cxp - ww / 2, cyp - wh / 2, ww, wh);
        mctx.fillStyle = '#8a94a0'; mctx.font = '600 19px monospace';
        mctx.fillText(wn.label, cxp, cyp - 24);
        mctx.fillStyle = '#7df9ff'; mctx.font = '700 40px monospace';
        mctx.fillText(wn.val, cxp, cyp + 14);
      }
      // ---- painted button labels (3D buttons sit just above each label) ----
      mctx.fillStyle = '#aeb6c2'; mctx.font = '700 20px monospace';
      const row1 = [['FD', -0.135], ['A/T', -0.045], ['CMD A', 0.045], ['HDG SEL', 0.135]];
      const row2 = [['LVL CHG', -0.18], ['VNAV', -0.09], ['ALT HLD', 0.0], ['V/S', 0.09], ['APP', 0.18]];
      for (const [lbl, x] of row1) mctx.fillText(lbl, xPx(x), 185);
      for (const [lbl, x] of row2) mctx.fillText(lbl, xPx(x), 242);
      mcpTex.needsUpdate = true;
    } catch (e) { /* guarded */ }
  }

  // ---------------------------------------------------------------------------
  // 3D GEOMETRY
  // ---------------------------------------------------------------------------
  const interactives = []; // { root, kind, id, data }
  function reg(root, kind, id, data = {}) {
    const idx = interactives.length;
    root.traverse((o) => { if (o.userData.iid === undefined) o.userData.iid = idx; });
    interactives.push({ root, kind, id, data });
    return idx;
  }

  function box(w, h, d, mat, x, y, z, parent = root) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  function cyl(rt, rb, h, mat, x, y, z, parent = root, seg = 20) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  // ---- Main instrument panel ----
  const PANEL_Z = EYE.z - 0.88, PANEL_Y = 2.98;
  const DU_W = 0.26, DU_H = 0.325;
  const duCols = [
    { col: COL.CAPT_PFD, x: -0.78, pilot: -0.55 },
    { col: COL.CAPT_ND, x: -0.47, pilot: -0.55 },
    { col: COL.EICAS, x: 0.0, pilot: 0.0 },
    { col: COL.FO_ND, x: 0.47, pilot: 0.55 },
    { col: COL.FO_PFD, x: 0.78, pilot: 0.55 },
  ];
  // full-width panel plate + glareshield brow
  box(1.98, 0.62, 0.05, matPanel, 0, PANEL_Y - 0.02, PANEL_Z - 0.035);
  const brow = box(2.0, 0.09, 0.30, matPanelDark, 0, PANEL_Y + 0.36, PANEL_Z + 0.06);
  brow.rotation.x = 0.18;

  for (const dc of duCols) {
    const yaw = Math.atan2(dc.pilot - dc.x, 0.88);
    const g = new THREE.Group();
    g.position.set(dc.x, PANEL_Y, PANEL_Z);
    g.rotation.y = yaw;
    root.add(g);
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(DU_W + 0.03, DU_H + 0.03, 0.05), matPanelDark);
    g.add(bezel);
    const scr = new THREE.Mesh(duGeometry(dc.col, 0, DU_W, DU_H), duMat);
    scr.position.z = 0.026;
    g.add(scr);
  }
  // EICAS lower screen (center, below)
  {
    const g = new THREE.Group();
    g.position.set(0, PANEL_Y - 0.385, PANEL_Z + 0.008);
    root.add(g);
    g.add(new THREE.Mesh(new THREE.BoxGeometry(DU_W + 0.03, DU_H + 0.03, 0.05), matPanelDark));
    const scr = new THREE.Mesh(duGeometry(COL.EICAS, 1, DU_W, DU_H), duMat);
    scr.position.z = 0.026; g.add(scr);
  }
  // Standby cluster screen (below captain's ND)
  {
    const g = new THREE.Group();
    g.position.set(-0.625, PANEL_Y - 0.385, PANEL_Z + 0.008);
    root.add(g);
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.30, 0.05), matPanelDark));
    // standby art lives in canvas row 1, cols 0-1 (819px wide region)
    const geo = new THREE.PlaneGeometry(0.47, 0.27);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      uv.setXY(i, (u * 2) / PC_COLS, 1 - (1 + (1 - v)) / PC_ROWS); // cols 0-1, row 1
    }
    uv.needsUpdate = true;
    const scr = new THREE.Mesh(geo, duMat);
    scr.position.z = 0.026; g.add(scr);
  }

  // ---- MCP (mode control panel) on the glareshield ----
  const mcp = new THREE.Group();
  mcp.position.set(0, PANEL_Y + 0.44, PANEL_Z + 0.10);
  mcp.rotation.x = -0.42; // face up/aft toward pilots
  root.add(mcp);
  const mcpBase = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.055, 0.20), matPanel);
  mcp.add(mcpBase);
  const mcpWin = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.155),
    new THREE.MeshBasicMaterial({ map: mcpTex })
  );
  mcpWin.rotation.x = -Math.PI / 2;
  mcpWin.position.set(0, 0.0285, 0.008);
  mcp.add(mcpWin);

  const knobMeshes = {};
  function mcpKnob(id, x, get, set, min, max, step, pxPerStep) {
    const k = cyl(0.021, 0.024, 0.028, matKnob, x, 0.042, -0.005, mcp);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.032, 0.046), matGrip);
    k.add(ridge); // child of knob -> covered by the knob's raycast iid
    reg(k, 'knob', id, { get, set, min, max, step, pxPerStep });
    knobMeshes[id] = [k];
    return k;
  }
  // (knobs are registered after `S` state is defined — see below)

  const btnLampMats = {};
  function mcpButton(id, x, z, label, color = 0x2eff5e) {
    const b = box(0.052, 0.014, 0.034, matPanelDark, x, 0.034, z, mcp);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 0 });
    const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.044, 0.010), lampMat);
    lamp.rotation.x = -Math.PI / 2;
    lamp.position.set(x, 0.0415, z - 0.008);
    mcp.add(lamp);
    btnLampMats[id] = lampMat;
    reg(b, 'button', id, {});
    return b;
  }
  // AP disengage bar (red striped)
  const disBar = box(0.60, 0.012, 0.022, new THREE.MeshStandardMaterial({ color: 0x8a1a1a, roughness: 0.7 }), 0, 0.030, 0.088, mcp);
  reg(disBar, 'button', 'ap_disc', {});

  // ---- Center pedestal + throttle quadrant ----
  const ped = new THREE.Group();
  root.add(ped);
  box(0.56, 0.10, 1.05, matPanel, 0, 2.52, 9.55, ped);            // pedestal base
  const quadPlate = box(0.50, 0.03, 0.62, matPanelDark, 0, 2.60, 9.28, ped);
  quadPlate.rotation.x = 0.10;

  const THR_PIVOT_Y = 2.66, THR_Z = 9.22, THR_X = 0.075;
  const thrLevers = [];
  for (let i = 0; i < 2; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(i === 0 ? -THR_X : THR_X, THR_PIVOT_Y, THR_Z);
    ped.add(pivot);
    const arm = box(0.035, 0.30, 0.055, matLever, 0, 0.15, 0, pivot);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), matGrip);
    knob.position.set(0, 0.30, 0); pivot.add(knob);
    // TOGA button on knob
    const toga = cyl(0.012, 0.012, 0.01, new THREE.MeshStandardMaterial({ color: 0x222222 }), 0, 0.335, 0, pivot, 10);
    // reverser lever (separate interactive, rides on the throttle)
    const rev = new THREE.Group();
    rev.position.set(0, 0.22, 0.02); pivot.add(rev);
    const revArm = box(0.02, 0.12, 0.03, matLever, 0, 0.06, 0, rev);
    reg(rev, 'toggle', 'rev' + i, { idx: i });
    reg(pivot, 'lever', 'thr' + i, {
      idx: i, minAngle: 0.62, maxAngle: -0.62,
      get: () => S.hw['thr' + i],
      set: (v) => {
        S.hw['thr' + i] = v; S.hw['thr' + i + 'Src'] = 'cockpit';
        const a = getAP(); if (a && a.atArmed) a.atArmed = false; // manual throttle disconnects A/T
      },
    });
    thrLevers.push(pivot);
  }
  // speedbrake lever (left of throttles)
  const spbPivot = new THREE.Group();
  spbPivot.position.set(-0.21, THR_PIVOT_Y, 9.30);
  ped.add(spbPivot);
  box(0.03, 0.22, 0.04, matLever, 0, 0.11, 0, spbPivot);
  reg(spbPivot, 'lever', 'spdBrk', {
    minAngle: 0.55, maxAngle: -0.55,
    get: () => S.hw.spoilers,
    set: (v) => {
      // ARM detent: snap zone 0.04..0.12 -> armed
      if (v > 0.04 && v < 0.12) { S.hw.armSpoilers = true; S.hw.spoilers = 0; }
      else { S.hw.armSpoilers = false; S.hw.spoilers = v; }
      S.hw.spoilersSrc = 'cockpit';
    },
  });
  // flap lever (right of throttles) — 9 detents
  const flapPivot = new THREE.Group();
  flapPivot.position.set(0.21, THR_PIVOT_Y, 9.30);
  ped.add(flapPivot);
  box(0.03, 0.22, 0.04, matLever, 0, 0.11, 0, flapPivot);
  const flapKnob = new THREE.Mesh(new THREE.SphereGeometry(0.028, 14, 10), matGrip);
  flapKnob.position.set(0, 0.22, 0); flapPivot.add(flapKnob);
  reg(flapPivot, 'lever', 'flaps', {
    minAngle: 0.55, maxAngle: -0.55, detents: 9,
    get: () => S.hw.flaps / 8,
    set: (v) => { S.hw.flaps = clamp(Math.round(v * 8), 0, 8); S.hw.flapsSrc = 'cockpit'; },
  });
  // fuel cutoff switches
  const fuelCutLevers = [];
  for (let i = 0; i < 2; i++) {
    const sw = new THREE.Group();
    sw.position.set(i === 0 ? -0.10 : 0.10, 2.62, 9.78);
    ped.add(sw);
    box(0.05, 0.02, 0.09, matPanelDark, 0, 0, 0, sw);
    const lv = box(0.02, 0.09, 0.02, matLever, 0, 0.045, -0.02, sw);
    lv.rotation.x = -0.5;
    fuelCutLevers.push({ g: sw, lv, idx: i });
    reg(sw, 'toggle', 'fuelcut' + i, { idx: i });
  }
  // parking brake T-handle
  const parkG = new THREE.Group();
  parkG.position.set(0, 2.60, 10.02);
  ped.add(parkG);
  const parkHandle = box(0.10, 0.03, 0.03, matGrip, 0, 0.02, 0, parkG);
  const parkLampMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffb300, emissiveIntensity: 0 });
  const parkLamp = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.02), parkLampMat);
  parkLamp.rotation.x = -Math.PI / 2; parkLamp.position.set(0, 0.045, 0.05);
  parkG.add(parkLamp);
  reg(parkG, 'toggle', 'parkbrake', {});
  // stabilizer trim wheels (cosmetic)
  const trimWheels = [];
  for (const sx of [-0.30, 0.30]) {
    const tw = cyl(0.085, 0.085, 0.025, matPanelDark, sx, 2.52, 9.80, ped, 24);
    tw.rotation.z = Math.PI / 2;
    trimWheels.push(tw);
  }

  // ---- Yoke (captain) ----
  const yokeBase = new THREE.Group();
  yokeBase.position.set(-0.55, 2.70, 8.52);
  root.add(yokeBase);
  const column = cyl(0.028, 0.034, 0.42, matPanelDark, 0, 0.16, 0.10, yokeBase);
  column.rotation.x = 0.5;
  const yoke = new THREE.Group();
  yoke.position.set(0, 0.30, 0.20);
  yokeBase.add(yoke);
  const horn = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.017, 10, 24, Math.PI * 1.25), matGrip);
  horn.rotation.z = Math.PI * 0.875; // ram's-horn opening downward
  horn.rotation.y = Math.PI / 2;      // plane facing pilot
  yoke.add(horn);
  const gripL = box(0.035, 0.11, 0.035, matGrip, -0.10, -0.02, 0, yoke);
  const gripR = box(0.035, 0.11, 0.035, matGrip, 0.10, -0.02, 0, yoke);
  gripL.rotation.z = 0.15; gripR.rotation.z = -0.15;
  // AP disengage switch on yoke
  const yokeApBtn = cyl(0.014, 0.014, 0.012, new THREE.MeshStandardMaterial({ color: 0xaa2222 }), -0.10, 0.045, 0, yoke, 10);
  reg(yokeApBtn, 'button', 'ap_disc', {});

  // ---- Gear lever (forward panel, right of EICAS lower) ----
  const gearG = new THREE.Group();
  gearG.position.set(0.24, PANEL_Y - 0.385, PANEL_Z + 0.03);
  root.add(gearG);
  box(0.10, 0.16, 0.04, matPanelDark, 0, 0, -0.01, gearG);
  const gearLever = new THREE.Group();
  gearLever.position.set(0, 0, 0.02);
  gearG.add(gearLever);
  const gearArm = box(0.025, 0.11, 0.025, matLever, 0, 0.055, 0, gearLever);
  const gearKnob = new THREE.Mesh(new THREE.SphereGeometry(0.028, 14, 10), matGrip);
  gearKnob.scale.set(1, 0.75, 1); gearKnob.position.set(0, 0.11, 0);
  gearLever.add(gearKnob);
  const gearLampMats = [];
  for (let i = -1; i <= 1; i++) {
    const lm = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x2eff5e, emissiveIntensity: 0 });
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.011, 12), lm);
    lamp.position.set(i * 0.032, 0.105, 0.012);
    gearG.add(lamp);
    gearLampMats.push(lm);
  }
  reg(gearG, 'button', 'gear', {});

  // ---- Overhead panel (simplified) ----
  const ohp = new THREE.Group();
  ohp.position.set(0, EYE.y + 0.78, EYE.z - 0.85);
  ohp.rotation.x = 0.62; // face down/aft toward pilots
  root.add(ohp);
  const ohpBase = new THREE.Mesh(new THREE.BoxGeometry(1.30, 0.03, 0.62), matPanel);
  ohp.add(ohpBase);
  const ohSwitches = {};
  function ohToggle(id, x, z, label, initial, onChange) {
    const sw = new THREE.Group();
    sw.position.set(x, -0.015, z);
    ohp.add(sw);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.10), matPanelDark);
    sw.add(plate);
    const lv = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.05, 0.018), matLever);
    lv.position.y = -0.03; sw.add(lv);
    const st = { on: initial, g: sw, lv };
    ohSwitches[id] = st;
    reg(sw, 'toggle', 'oh_' + id, { id, onChange });
    return st;
  }
  // (states registered below once S exists)

  // ---------------------------------------------------------------------------
  // Cockpit state (S) — hardware positions, ILS, UI timers
  // ---------------------------------------------------------------------------
  const S = {
    hw: {
      thr0: 0, thr1: 0, thr0Src: 'input', thr1Src: 'input', engCut: [false, false],
      flaps: 0, flapsSrc: 'input',
      gearDown: true, gearDownSrc: 'input',
      spoilers: 0, spoilersSrc: 'input', armSpoilers: false,
      reversers: false, reversersSrc: 'input',
      parkBrake: false, parkBrakeSrc: 'input',
    },
    ils: null,          // set via setILS()
    flashT: 0,          // AP-disconnect FMA flash timer
    redrawT: 1,         // force first draw
    interacting: false,
    atThr: 0.5,         // autothrottle integrator state
    // last-seen INPUT values per channel (keyboard/gamepad/touch side).
    // A cockpit drag/toggle takes ownership ('cockpit'); ownership returns to
    // 'input' only when the input side actually transitions.
    inpPrev: { thr0: 0, thr1: 0, flaps: 0, gearDown: true, spoilers: 0, reversers: false, parkBrake: false },
    oh: { batt: true, apu: false, belts: true, smoke: true, landL: true, landR: true, engL: 1, engR: 1 },
  };
  let curFstate = null; // latest fstate (set in update)
  const getAP = () => (curFstate ? curFstate.ap : null);
  const seedFromCurrent = (ap) => {
    if (!curFstate) return;
    if (ap.hdgSel == null) ap.hdgSel = Math.round(curFstate.heading);
    if (ap.altSelFt == null) ap.altSelFt = Math.round(curFstate.altFtMSL / 100) * 100;
    if (ap.spdSelKt == null) ap.spdSelKt = Math.round(curFstate.iasKt);
  };

  // ---- MCP knobs (SPD / HDG / ALT / VS) ----
  mcpKnob('spd', -0.225,
    () => { const a = getAP(); return a && a.spdSelKt != null ? a.spdSelKt : 250; },
    (v) => { const a = getAP(); if (a) a.spdSelKt = clamp(Math.round(v), 100, 340); },
    100, 340, 1, 6);
  mcpKnob('hdg', -0.075,
    () => { const a = getAP(); return a && a.hdgSel != null ? a.hdgSel : (curFstate ? curFstate.heading : 0); },
    (v) => { const a = getAP(); if (a) a.hdgSel = wrap360(Math.round(v)); },
    0, 360, 1, 6);
  mcpKnob('alt', 0.075,
    () => { const a = getAP(); return a && a.altSelFt != null ? a.altSelFt : 10000; },
    (v) => { const a = getAP(); if (a) a.altSelFt = clamp(Math.round(v / 100) * 100, 0, 45000); },
    0, 45000, 100, 8);
  mcpKnob('vs', 0.225,
    () => { const a = getAP(); return a ? (a.vsSelFpm || 0) : 0; },
    (v) => { const a = getAP(); if (a) a.vsSelFpm = clamp(Math.round(v / 100) * 100, -6000, 6000); },
    -6000, 6000, 100, 8);

  // ---- MCP buttons ----
  function apEngageDefaults(ap) {
    seedFromCurrent(ap);
    if (!ap.latMode) ap.latMode = 'HDG';
    if (!ap.vertMode) ap.vertMode = 'ALTHLD';
    ap.fdOn = true;
  }
  mcpButton('fd', -0.135, 0.035);
  mcpButton('at_arm', -0.045, 0.035);
  mcpButton('cmd_a', 0.045, 0.035);
  mcpButton('hdg_sel', 0.135, 0.035);
  mcpButton('lvl_chg', -0.18, 0.068);
  mcpButton('vnav', -0.09, 0.068);
  mcpButton('alt_hld', 0.0, 0.068);
  mcpButton('vs_btn', 0.09, 0.068);
  mcpButton('app', 0.18, 0.068);

  function onMcpButton(id) {
    const ap = getAP(); if (!ap) return;
    switch (id) {
      case 'fd': ap.fdOn = !ap.fdOn; break;
      case 'at_arm': ap.atArmed = !ap.atArmed; if (!ap.atArmed) { S.hw.thr0Src = 'cockpit'; S.hw.thr1Src = 'cockpit'; } break;
      case 'cmd_a':
        if (ap.apEngaged) { ap.apEngaged = false; }
        else { apEngageDefaults(ap); ap.apEngaged = true; }
        break;
      case 'ap_disc': ap.apEngaged = false; break;
      case 'hdg_sel':
        if (ap.hdgSel == null && curFstate) ap.hdgSel = Math.round(curFstate.heading);
        ap.latMode = ap.latMode === 'HDG' ? null : 'HDG';
        break;
      case 'lvl_chg':
        seedFromCurrent(ap); ap.vertMode = 'LVLCHG';
        break;
      case 'vnav':
        seedFromCurrent(ap); ap.vertMode = 'VNAV';
        break;
      case 'alt_hld':
        if (curFstate) ap.altSelFt = Math.round(curFstate.altFtMSL / 100) * 100;
        ap.vertMode = 'ALTHLD';
        break;
      case 'vs_btn':
        ap.vsSelFpm = 0; ap.vertMode = 'VS';
        break;
      case 'app':
        ap.latMode = 'APP'; ap.vertMode = 'GS';
        if (ap.spdSelKt == null && curFstate) ap.spdSelKt = 140;
        break;
    }
  }

  // ---- Overhead switches ----
  function applyLandingLights() {
    const p = aircraft && aircraft.parts;
    if (p && typeof p.setLandingLights === 'function') {
      try { p.setLandingLights(S.oh.landL || S.oh.landR); } catch (e) { /* guarded */ }
    }
  }
  ohToggle('batt', -0.52, -0.18, 'BAT', true);
  ohToggle('apu', -0.36, -0.18, 'APU', false);
  ohToggle('belts', -0.20, -0.18, 'BELTS', true);
  ohToggle('smoke', -0.04, -0.18, 'SMOKE', true);
  ohToggle('landL', 0.16, -0.18, 'LAND L', true, applyLandingLights);
  ohToggle('landR', 0.32, -0.18, 'LAND R', true, applyLandingLights);
  ohToggle('engL', 0.48, -0.18, 'ENG L', true);
  ohToggle('engR', 0.60, -0.18, 'ENG R', true);

  function onOverheadToggle(id) {
    const map = { batt: 'batt', apu: 'apu', belts: 'belts', smoke: 'smoke', landL: 'landL', landR: 'landR', engL: 'engL', engR: 'engR' };
    const key = map[id]; if (!key) return;
    S.oh[key] = !S.oh[key];
    const st = ohSwitches[key];
    if (st) st.lv.rotation.x = S.oh[key] ? -0.5 : 0.5;
    const entry = interactives.find((e) => e.id === 'oh_' + key);
    if (entry && entry.data.onChange) entry.data.onChange();
  }

  // ---- Generic cockpit toggles ----
  function onToggle(id) {
    const hw = S.hw;
    if (id === 'rev0' || id === 'rev1') { hw.reversers = !hw.reversers; hw.reversersSrc = 'cockpit'; }
    else if (id === 'fuelcut0' || id === 'fuelcut1') {
      const i = id === 'fuelcut0' ? 0 : 1;
      hw.engCut[i] = !hw.engCut[i];
      if (hw.engCut[i]) hw['thr' + i] = 0;
      hw['thr' + i + 'Src'] = 'cockpit';
    }
    else if (id === 'parkbrake') { hw.parkBrake = !hw.parkBrake; hw.parkBrakeSrc = 'cockpit'; }
    else if (id === 'gear') { hw.gearDown = !hw.gearDown; hw.gearDownSrc = 'cockpit'; }
    else if (id && id.startsWith('oh_')) onOverheadToggle(id.slice(3));
  }

  function onButton(id) {
    if (id === 'gear') { onToggle('gear'); return; }
    if (id === 'ap_disc') { const ap = getAP(); if (ap) ap.apEngaged = false; return; }
    onMcpButton(id);
  }

  // id -> entry lookup (built after all registrations)
  const byId = {};
  for (const e of interactives) byId[e.id] = e;

  // ---------------------------------------------------------------------------
  // Pointer interaction (raycast against interactives[])
  // ---------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  let canvasEl = null;
  let drag = null;
  let lastHover = 0;

  function getCanvas() {
    if (!canvasEl || !canvasEl.isConnected) {
      canvasEl = document.getElementById('scene') || document.querySelector('canvas');
    }
    return canvasEl;
  }
  function setNDC(e) {
    const r = getCanvas().getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  function pick(e) {
    setNDC(e);
    raycaster.setFromCamera(_ndc, camera);
    const roots = interactives.map((en) => en.root);
    const hits = raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.iid === undefined) o = o.parent;
      if (o && interactives[o.userData.iid]) return { entry: interactives[o.userData.iid], point: h.point };
    }
    return null;
  }

  function knobDragTo(entry, e) {
    const d = entry.data;
    const dy = drag.ly - e.clientY; // mouse up = increase
    drag.ly = e.clientY;
    drag.acc = (drag.acc || 0) + dy;
    const steps = Math.trunc(drag.acc / d.pxPerStep);
    if (steps !== 0) {
      drag.acc -= steps * d.pxPerStep;
      let v = d.get() + steps * d.step;
      if (entry.id === 'hdg') v = wrap360(v);
      else v = clamp(v, d.min, d.max);
      d.set(v);
    }
  }

  const _plane = new THREE.Plane();
  const _n = new THREE.Vector3();
  const _hitP = new THREE.Vector3();
  function leverDragTo(entry, e) {
    const d = entry.data;
    const pivotW = entry.root.getWorldPosition(new THREE.Vector3());
    _n.set(1, 0, 0).applyQuaternion(aircraft.group.quaternion);
    _plane.setFromNormalAndCoplanarPoint(_n, pivotW);
    setNDC(e);
    raycaster.setFromCamera(_ndc, camera);
    if (!raycaster.ray.intersectPlane(_plane, _hitP)) return;
    const hitL = aircraft.group.worldToLocal(_hitP.clone());
    const pivL = aircraft.group.worldToLocal(pivotW.clone());
    const vx = hitL.x - pivL.x, vy = hitL.y - pivL.y, vz = hitL.z - pivL.z;
    const ang = Math.atan2(vz, vy); // lever points +y at rest
    let v = (d.minAngle - ang) / (d.minAngle - d.maxAngle);
    v = clamp(v, 0, 1);
    if (d.detents) v = Math.round(v * (d.detents - 1)) / (d.detents - 1);
    d.set(v);
  }

  function onPointerDown(e) {
    if (!e.isPrimary) return;
    if (e.button !== undefined && e.button !== 0) return;
    const cv = getCanvas();
    if (!cv || e.target !== cv) return;
    let hit = null;
    try { hit = pick(e); } catch (err) { return; }
    if (!hit) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    drag = { entry: hit.entry, x0: e.clientX, y0: e.clientY, ly: e.clientY, acc: 0, moved: false };
    S.interacting = true;
    cv.style.cursor = 'grabbing';
  }
  function onPointerMove(e) {
    if (drag) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4) drag.moved = true;
      try {
        if (drag.entry.kind === 'knob') knobDragTo(drag.entry, e);
        else if (drag.entry.kind === 'lever') leverDragTo(drag.entry, e);
      } catch (err) { /* guarded */ }
      return;
    }
    const now = performance.now();
    if (now - lastHover < 90) return;
    lastHover = now;
    const cv = getCanvas();
    if (!cv || e.target !== cv) return;
    let hit = null;
    try { hit = pick(e); } catch (err) { return; }
    cv.style.cursor = hit
      ? (hit.entry.kind === 'knob' ? 'ns-resize' : hit.entry.kind === 'lever' ? 'grab' : 'pointer')
      : '';
  }
  function endDrag(e, cancelled) {
    if (!drag) return;
    const { entry, moved } = drag;
    drag = null;
    S.interacting = false;
    const cv = getCanvas();
    if (cv) cv.style.cursor = '';
    if (!cancelled && !moved && (entry.kind === 'button' || entry.kind === 'toggle')) {
      try {
        if (entry.kind === 'button') onButton(entry.id);
        else onToggle(entry.id);
      } catch (err) { /* guarded */ }
    }
  }
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', (e) => endDrag(e, false));
  window.addEventListener('pointercancel', (e) => endDrag(e, true));

  // ---------------------------------------------------------------------------
  // Hardware <-> input merge + autopilot-lite
  // ---------------------------------------------------------------------------
  function mergeHardware(controls, fstate) {
    const hw = S.hw, ip = S.inpPrev;
    if (!controls.throttle) controls.throttle = [0, 0];
    // Generic channel: cockpit owns once touched; input re-takes ownership only
    // on a real transition of its own value (keyboard/gamepad/touch moved).
    function chan(key, read, write, moved) {
      const srcKey = key + 'Src';
      if (hw[srcKey] === 'at') return; // autothrottle owns the throttles
      const inp = read(controls);
      if (moved(inp, ip[key])) hw[srcKey] = 'input';
      ip[key] = inp;
      if (hw[srcKey] === 'cockpit') write(controls);
      else hw[key] = inp;
    }
    const f01 = (v) => clamp(v || 0, 0, 1);
    const movedF = (a, b) => Math.abs(a - b) > 0.02;
    for (let i = 0; i < 2; i++) {
      chan('thr' + i,
        (c) => f01(c.throttle[i]),
        (c) => { c.throttle[i] = hw.engCut[i] ? 0 : hw['thr' + i]; },
        movedF);
    }
    chan('flaps',
      (c) => clamp(c.flaps | 0, 0, 8),
      (c) => { c.flaps = hw.flaps; },
      (a, b) => a !== b);
    chan('gearDown',
      (c) => !!c.gearDown,
      (c) => { c.gearDown = hw.gearDown; },
      (a, b) => a !== b);
    chan('spoilers',
      (c) => f01(c.spoilers),
      (c) => { c.spoilers = hw.armSpoilers ? 0 : hw.spoilers; c.armSpoilers = hw.armSpoilers; },
      (a, b) => Math.abs(a - b) > 0.03);
    chan('reversers',
      (c) => !!c.reversers,
      (c) => { c.reversers = hw.reversers; },
      (a, b) => a !== b);
    chan('parkBrake',
      (c) => !!c.parkingBrake,
      (c) => { c.parkingBrake = hw.parkBrake; },
      (a, b) => a !== b);
  }

  function applyAutopilot(controls, fstate, dt) {
    const ap = fstate.ap;
    if (!ap) return;
    mergeHardware(controls, fstate);

    // snapshot manual stick input BEFORE AP overwrites
    const mPitch = controls.pitch || 0, mRoll = controls.roll || 0;
    if (ap.apEngaged && (Math.abs(mPitch) > 0.5 || Math.abs(mRoll) > 0.5)) {
      ap.apEngaged = false;   // yoke override disconnects
      S.flashT = 3.0;         // flash FMA amber (main.js/audio can also watch this)
    }

    if (ap.apEngaged) {
      // ---- lateral ----
      let bankDes = 0, latActive = false;
      if (ap.latMode === 'HDG' && ap.hdgSel != null) {
        const err = wrap180(ap.hdgSel - fstate.heading);
        bankDes = Math.abs(err) < 1 ? 0 : clamp(err * 1.5, -25, 25);
        latActive = true;
      } else if (ap.latMode === 'APP' && S.ils) {
        const g = ilsGeometry(fstate, S.ils);
        if (g && g.distM < 15 * NM_TO_M && g.along < 2000) {
          const trackErr = wrap180(fstate.heading - S.ils.headingTrue);
          bankDes = clamp(-g.cross * 0.05 - trackErr * 1.4, -22, 22);
          latActive = true;
        }
      }
      if (latActive) controls.roll = clamp((bankDes - fstate.roll) * 0.09, -1, 1);

      // ---- vertical ----
      const altHoldTo = (tgt) =>
        clamp((clamp((tgt - fstate.altFtMSL) * 2.5, -1800, 1800) - fstate.vsFpm) * 0.0011, -1, 1);
      let pitchOut = null;
      if ((ap.vertMode === 'ALTHLD' || ap.vertMode === 'VNAV') && ap.altSelFt != null) {
        pitchOut = altHoldTo(ap.altSelFt);
      } else if (ap.vertMode === 'VS') {
        pitchOut = clamp(((ap.vsSelFpm || 0) - fstate.vsFpm) * 0.0011, -1, 1);
      } else if (ap.vertMode === 'LVLCHG' && ap.spdSelKt != null) {
        pitchOut = clamp((fstate.iasKt - ap.spdSelKt) * 0.025, -1, 1);
      } else if (ap.vertMode === 'GS' && S.ils) {
        const g = ilsGeometry(fstate, S.ils);
        if (g && g.distM < 12 * NM_TO_M && g.along < 0 && g.along > -12 * NM_TO_M) {
          pitchOut = clamp(g.gsDots * 0.30 - (fstate.vsFpm / 1000) * 0.05, -1, 1);
        } else if (ap.altSelFt != null) {
          pitchOut = altHoldTo(ap.altSelFt);
        }
      }
      if (pitchOut != null) controls.pitch = pitchOut;
    }

    // ---- autothrottle ----
    if (ap.atArmed && ap.spdSelKt != null) {
      let thr;
      if (ap.vertMode === 'LVLCHG') {
        thr = (ap.altSelFt != null && ap.altSelFt > fstate.altFtMSL + 100) ? 0.92 : 0.0;
      } else {
        const rate = clamp((ap.spdSelKt - fstate.iasKt) * 0.004, -0.03, 0.03);
        S.atThr = clamp(S.atThr + rate * Math.min(dt * 60, 3), 0, 1);
        thr = S.atThr;
      }
      for (let i = 0; i < 2; i++) {
        const t = S.hw.engCut[i] ? 0 : thr;
        controls.throttle[i] = t;
        S.hw['thr' + i] = t;
        S.hw['thr' + i + 'Src'] = 'at';
      }
    } else {
      for (let i = 0; i < 2; i++) if (S.hw['thr' + i + 'Src'] === 'at') S.hw['thr' + i + 'Src'] = 'cockpit';
    }
  }

  function setILS(ils) { S.ils = ils || null; }
  function isInteracting() { return S.interacting || !!drag; }

  // ---------------------------------------------------------------------------
  // Per-frame update: redraw displays, animate controls
  // ---------------------------------------------------------------------------
  function update(dt, fstate, controls) {
    curFstate = fstate;
    const ap = fstate.ap || {};
    if (S.flashT > 0) S.flashT -= dt;
    const flashOn = S.flashT > 0 && Math.floor(S.flashT * 4) % 2 === 0;

    S.redrawT += dt;
    if (S.redrawT >= 0.05) {
      S.redrawT = 0;
      const ilsGeo = ilsGeometry(fstate, S.ils);
      const showILS = !!(S.ils && ilsGeo && ilsGeo.distM < 15 * NM_TO_M);
      try {
        drawPFD(COL.CAPT_PFD, fstate, ap, ilsGeo, showILS, flashOn);
        drawPFD(COL.FO_PFD, fstate, ap, ilsGeo, showILS, flashOn);
        drawND(COL.CAPT_ND, fstate, ap, S.ils);
        drawND(COL.FO_ND, fstate, ap, S.ils);
        drawEicasUpper(fstate);
        const msgs = [];
        if (fstate.parkingBrake) msgs.push({ t: 'PARK BRK', c: C.amber });
        if (fstate.spoilers > 0.05) msgs.push({ t: 'SPEEDBRAKE', c: C.amber });
        if (fstate.reversersDeployed) msgs.push({ t: 'REVERSERS', c: C.green });
        if (fstate.gearPos > 0.02 && fstate.gearPos < 0.98) msgs.push({ t: 'GEAR TRANSIT', c: C.red });
        drawEicasLower(fstate, msgs);
        drawStandby(fstate);
        panelTex.needsUpdate = true;
        drawMCPWindows(ap, fstate);
      } catch (err) { /* guarded: a canvas fault must never break the frame */ }
    }

    // ---- animate hardware ----
    for (let i = 0; i < 2; i++) {
      const t = S.hw.engCut[i] ? 0 : clamp(controls.throttle[i] || 0, 0, 1);
      thrLevers[i].rotation.x = lerp(0.62, -0.62, t);
      const rev = byId['rev' + i];
      if (rev) rev.root.rotation.x = controls.reversers ? -0.85 : 0;
    }
    const flapE = byId.flaps;
    if (flapE) flapE.root.rotation.x = lerp(0.55, -0.55, clamp((controls.flaps | 0) / 8, 0, 1));
    const spbE = byId.spdBrk;
    if (spbE) spbE.root.rotation.x = lerp(0.55, -0.55, clamp(controls.spoilers || 0, 0, 1));
    yoke.rotation.z = -clamp(controls.roll || 0, -1, 1) * 1.25;
    yoke.rotation.x = clamp(controls.pitch || 0, -1, 1) * 0.18;
    gearLever.rotation.x = fstate.gearDown ? 0.55 : -0.55;
    {
      const transit = fstate.gearPos > 0.02 && fstate.gearPos < 0.98;
      const blink = Math.floor(performance.now() / 300) % 2 === 0;
      for (const m of gearLampMats) {
        if (transit) { m.emissive.setHex(0xff3b30); m.emissiveIntensity = blink ? 2 : 0.2; }
        else if (fstate.gearPos > 0.98) { m.emissive.setHex(0x2eff5e); m.emissiveIntensity = 1.4; }
        else { m.emissiveIntensity = 0; }
      }
    }
    parkHandle.position.z = fstate.parkingBrake ? -0.035 : 0.02;
    parkLampMat.emissiveIntensity = fstate.parkingBrake ? 2 : 0;
    for (const fc of fuelCutLevers) fc.lv.rotation.x = S.hw.engCut[fc.idx] ? 0.5 : -0.5;

    // MCP knob spin + button lamps
    const kv = {
      spd: ap.spdSelKt != null ? ap.spdSelKt : 250,
      hdg: ap.hdgSel != null ? ap.hdgSel : (fstate.heading || 0),
      alt: (ap.altSelFt != null ? ap.altSelFt : 10000) / 200,
      vs: (ap.vsSelFpm || 0) / 200,
    };
    for (const id of Object.keys(knobMeshes)) {
      const v = kv[id] || 0;
      for (const m of knobMeshes[id]) m.rotation.y = v * 0.12;
    }
    const lampState = {
      fd: !!ap.fdOn, at_arm: !!ap.atArmed, cmd_a: !!ap.apEngaged,
      hdg_sel: ap.latMode === 'HDG', lvl_chg: ap.vertMode === 'LVLCHG',
      vnav: ap.vertMode === 'VNAV', alt_hld: ap.vertMode === 'ALTHLD',
      vs_btn: ap.vertMode === 'VS', app: ap.latMode === 'APP',
    };
    for (const id of Object.keys(btnLampMats)) {
      btnLampMats[id].emissiveIntensity = lampState[id] ? 1.8 : 0.0;
    }
    for (const tw of trimWheels) tw.rotation.x += dt * (ap.vertMode === 'VS' ? 2.5 : 0.15);
  }

  // initial draw so panels aren't black on first frame
  try {
    applyLandingLights();
    const f0 = {
      iasKt: 0, altFtMSL: 0, heading: 0, pitch: 0, roll: 0, vsFpm: 0,
      n1: [0, 0], egtC: [15, 15], fuelFlowKgH: [0, 0], fuelKg: 0,
      flapDetent: 0, gearPos: 1, gearDown: true, spoilers: 0,
      parkingBrake: true, reversersDeployed: false, aglM: 0, gsKt: 0,
      ap: { hdgSel: null, altSelFt: null, vsSelFpm: 0, spdSelKt: null, atArmed: false, apEngaged: false, fdOn: false },
    };
    drawPFD(COL.CAPT_PFD, f0, f0.ap, null, false, false);
    drawPFD(COL.FO_PFD, f0, f0.ap, null, false, false);
    drawND(COL.CAPT_ND, f0, f0.ap, null);
    drawND(COL.FO_ND, f0, f0.ap, null);
    drawEicasUpper(f0);
    drawEicasLower(f0, [{ t: 'PARK BRK', c: C.amber }]);
    drawStandby(f0);
    panelTex.needsUpdate = true;
    drawMCPWindows(f0.ap, f0);
  } catch (err) { /* guarded */ }

  return { update, applyAutopilot, setILS, isInteracting };
}
