// Southwest Boeing 737-800 — fully procedural Three.js model.
// Local frame: x = right, y = up, z = aft (nose toward -z). 1 unit = 1 meter.
// Exports: buildBoeing737() -> { group, parts }  (see docs/ARCHITECTURE.md)

import * as THREE from 'three';
import { LIVERY } from '../core/config.js';

const DEG = Math.PI / 180;
const clamp01 = v => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------- dimensions
const FUSE_LEN = 39.47;                 // m
const FUSE_R = 1.88;                    // m (diameter 3.76)
const FUSE_Y = 3.9;                     // fuselage centerline height (gear accounted)
const NOSE_Z = -FUSE_LEN / 2;
const TAIL_Z = FUSE_LEN / 2;

const WHEEL_R_NOSE = 0.345;
const WHEEL_R_MAIN = 0.585;

// ------------------------------------------------------------------ helpers
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function heartPath(ctx, x, y, s) {
  // stylized heart, s = overall size
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.32);
  ctx.bezierCurveTo(x - s * 0.62, y - s * 0.12, x - s * 0.42, y - s * 0.52, x, y - s * 0.20);
  ctx.bezierCurveTo(x + s * 0.42, y - s * 0.52, x + s * 0.62, y - s * 0.12, x, y + s * 0.32);
  ctx.closePath();
}

function smoothstep01(x) {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
}

// ------------------------------------------------------------------- livery
// Lathe UV: u=0 belly, u=0.25 right side, u=0.5 top, u=0.75 left side,
// v=0 nose -> v=1 tail. Canvas: x = u*W, y = (1-v)*H.
const HEX = n => '#' + n.toString(16).padStart(6, '0');
const C_BLUE = HEX(LIVERY.canyonBlue);    // canyon blue
const C_GOLD = HEX(LIVERY.desertGold);    // desert gold
const C_RED = HEX(LIVERY.heartRed);       // heart red
const C_SILVER = '#dfe3e8';               // summit silver
const C_TAILBLUE = HEX(LIVERY.tailBlue);

// blue belly upper boundary (in u, measured from belly) as a function of v
function bellyBoundaryU(v) {
  // nose: blue rides high; mid: ~0.225; tail: sweeps up to full blue
  const keys = [
    [0.00, 0.30], [0.10, 0.275], [0.25, 0.245], [0.50, 0.225],
    [0.70, 0.175], [0.85, 0.090], [1.00, 0.000],
  ];
  for (let i = 0; i < keys.length - 1; i++) {
    const [v0, u0] = keys[i], [v1, u1] = keys[i + 1];
    if (v <= v1) {
      const t = (v - v0) / (v1 - v0);
      return u0 + (u1 - u0) * (t * t * (3 - 2 * t));
    }
  }
  return 0;
}

// draw text stretched along the fuselage (length along v, height along u)
function drawFuselageText(ctx, W, H, text, uC, vC, lenM, hM, color, mirror) {
  const fs = 120;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `italic 900 ${fs}px Arial, Helvetica, sans-serif`;
  const tw = meas.measureText(text).width;
  const off = document.createElement('canvas');
  off.width = Math.ceil(tw) + 40; off.height = Math.ceil(fs * 1.5);
  const m = off.getContext('2d');
  m.font = `italic 900 ${fs}px Arial, Helvetica, sans-serif`;
  m.fillStyle = color;
  m.textBaseline = 'middle';
  m.fillText(text, 20, off.height / 2);
  const pxPerM_v = H / FUSE_LEN;
  const pxPerM_u = W / (2 * Math.PI * FUSE_R);
  ctx.save();
  ctx.translate(uC * W, (1 - vC) * H);
  // Right side (mirror=false): rotate +90°, negative y-scale.
  // Left side (mirror=true) is the u-mirror of the right: flip both the
  // rotation direction AND the y-scale sign (verified empirically).
  ctx.rotate(mirror ? -Math.PI / 2 : Math.PI / 2);
  const sx = (lenM * pxPerM_v) / off.width, sy = (hM * pxPerM_u) / off.height;
  ctx.scale(sx, mirror ? sy : -sy);
  ctx.drawImage(off, -off.width / 2, -off.height / 2);
  ctx.restore();
}

function makeFuselageTexture() {
  const W = 2048, H = 1024;
  return canvasTexture(W, H, (ctx) => {
    const Y = v => (1 - v) * H;
    // base: summit silver
    ctx.fillStyle = C_SILVER;
    ctx.fillRect(0, 0, W, H);

    // canyon-blue belly: right side u in [0, b(v)], left side u in [1-b(v), 1]
    const trace = (v0, v1, steps, uOf) => {
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const v = v0 + (v1 - v0) * (i / steps);
        const x = uOf(v) * W, y = Y(v);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      return ctx;
    };
    ctx.fillStyle = C_BLUE;
    // right side blue region
    trace(0, 1, 60, v => bellyBoundaryU(v));
    ctx.lineTo(0, Y(1)); ctx.lineTo(0, Y(0)); ctx.closePath(); ctx.fill();
    // left side blue region
    trace(0, 1, 60, v => 1 - bellyBoundaryU(v));
    ctx.lineTo(W, Y(1)); ctx.lineTo(W, Y(0)); ctx.closePath(); ctx.fill();

    // desert-gold cheatline along the boundary, both sides
    ctx.strokeStyle = C_GOLD; ctx.lineWidth = 9; ctx.lineCap = 'round';
    trace(0, 1, 80, v => bellyBoundaryU(v)); ctx.stroke();
    trace(0, 1, 80, v => 1 - bellyBoundaryU(v)); ctx.stroke();

    // dark backing band where the 3D cockpit glass sits (nose, both sides)
    ctx.fillStyle = '#10151c';
    ctx.fillRect(0.27 * W, Y(0.075), 0.17 * W, Y(0.008) - Y(0.075));
    ctx.fillRect(0.56 * W, Y(0.075), 0.17 * W, Y(0.008) - Y(0.075));

    // passenger windows: single row, slightly above side centerline.
    // NOTE texture anisotropy: ~173 px/m around (u) vs ~26 px/m along (v).
    const winU = [0.288, 0.712];
    ctx.fillStyle = '#121a24';
    for (const u of winU) {
      for (let v = 0.135; v <= 0.70; v += 0.0132) {
        // skip door zones
        if ((v > 0.095 && v < 0.120) || (v > 0.720 && v < 0.745)) continue;
        roundedRect(ctx, u * W - 30, Y(v) - 4, 60, 8, 4);   // ~0.35m x 0.30m
        ctx.fill();
      }
    }
    // door outlines (L1/R1 fwd, L2/R2 aft) ~1.9m tall x 0.9m wide
    ctx.strokeStyle = '#9aa0a8'; ctx.lineWidth = 3;
    for (const u of winU) {
      for (const v of [0.1075, 0.7325]) {
        ctx.strokeRect(u * W - 164, Y(v) - 12, 329, 24);
      }
      // overwing exits ~1.1m x 0.5m
      for (const v of [0.44, 0.50]) {
        ctx.strokeRect(u * W - 95, Y(v) - 7, 190, 14);
      }
    }

    // "Southwest" titles, forward fuselage, above window line
    drawFuselageText(ctx, W, H, 'Southwest', 0.345, 0.205, 8.2, 1.25, C_TAILBLUE, false);
    drawFuselageText(ctx, W, H, 'Southwest', 0.655, 0.205, 8.2, 1.25, C_TAILBLUE, true);
    // registration near tail
    drawFuselageText(ctx, W, H, 'N8653A', 0.335, 0.815, 2.4, 0.5, C_TAILBLUE, false);
    drawFuselageText(ctx, W, H, 'N8653A', 0.665, 0.815, 2.4, 0.5, C_TAILBLUE, true);
    // small heart on forward belly, right side (abstract brand mark)
    ctx.save();
    ctx.translate(0.10 * W, Y(0.16));
    ctx.fillStyle = C_RED; heartPath(ctx, 0, 0, 46); ctx.fill();
    ctx.fillStyle = '#f26522'; heartPath(ctx, 0, 0, 32); ctx.fill();
    ctx.fillStyle = C_GOLD; heartPath(ctx, 0, 0, 19); ctx.fill();
    ctx.restore();
  });
}

function makeTailTexture() {
  // vertical stabilizer: tail blue with abstract red/orange/gold heart motif
  return canvasTexture(512, 512, (ctx, W, H) => {
    ctx.fillStyle = C_TAILBLUE;
    ctx.fillRect(0, 0, W, H);
    // subtle vertical shading
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.25)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // layered abstract heart
    const cx = W * 0.5, cy = H * 0.56;
    ctx.fillStyle = C_RED; heartPath(ctx, cx, cy, 150); ctx.fill();
    ctx.fillStyle = '#f26522'; heartPath(ctx, cx, cy - 8, 108); ctx.fill();
    ctx.fillStyle = C_GOLD; heartPath(ctx, cx, cy - 14, 68); ctx.fill();
    // swoosh arcs
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy + 40, 170, Math.PI * 1.15, Math.PI * 1.75); ctx.stroke();
    ctx.strokeStyle = C_GOLD; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.arc(cx, cy + 40, 195, Math.PI * 1.1, Math.PI * 1.7); ctx.stroke();
  });
}

// ------------------------------------------------------- lifting-surface loft
// Generic lofted wing-like surface. Origin at root leading edge:
// span along +x, chord along +z (aft), up +y.
function airfoilSections(n) {
  const secs = [];
  for (let i = 0; i < n; i++) {
    const b = i / (n - 1);
    const x = (1 - Math.cos(b * Math.PI)) / 2;   // cosine spacing, 0=LE
    const t = 1; // thickness fraction applied by caller
    const yt = 5 * (0.2969 * Math.sqrt(Math.max(x, 1e-6)) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    const yc = 0.02 * Math.sin(Math.PI * x);    // slight camber
    secs.push([x, yc + yt * t, yc - yt * t]);
  }
  return secs;
}

function sectionAt(def, x) {
  const s = clamp01(x / def.span);
  return {
    s,
    zLE: def.sweepTan * x,
    chord: def.rootChord + (def.tipChord - def.rootChord) * s,
    y: def.dihedralTan * x,
    thick: def.thickRoot + (def.thickTip - def.thickRoot) * s,
  };
}

function buildLiftingSurface(def, chordwise = 14, spanwise = 14) {
  const secs = airfoilSections(chordwise);
  const n = chordwise;
  const positions = [], uvs = [], indices = [];
  const rows = spanwise + 1;
  for (let i = 0; i < rows; i++) {
    const s = i / spanwise;
    const x = s * def.span;
    const sec = sectionAt(def, x);
    for (let side = 0; side < 2; side++) {       // 0 = top, 1 = bottom
      for (let j = 0; j < n; j++) {
        const [xc, yt, yb] = secs[j];
        const ya = side === 0 ? yt : yb;
        positions.push(x, sec.y + ya * sec.thick * sec.chord, sec.zLE + xc * sec.chord);
        uvs.push(xc, s);
      }
    }
  }
  const rowStride = 2 * n;
  const quad = (a, b, c, d) => indices.push(a, b, d, b, c, d);
  for (let i = 0; i < spanwise; i++) {
    const r0 = i * rowStride, r1 = (i + 1) * rowStride;
    for (let j = 0; j < n - 1; j++) {
      quad(r0 + j, r1 + j, r1 + j + 1, r0 + j + 1);                 // top
      quad(r0 + n + j, r0 + n + j + 1, r1 + n + j + 1, r1 + n + j); // bottom
    }
    // leading edge strip (top j=0 <-> bottom j=0)
    quad(r0, r0 + n, r1 + n, r1);
    // trailing edge strip (top j=n-1 <-> bottom j=n-1)
    const t0 = r0 + n - 1, b0 = r0 + 2 * n - 1, t1 = r1 + n - 1, b1 = r1 + 2 * n - 1;
    quad(t0, b0, b1, t1);
  }
  // tip cap
  const tip = spanwise * rowStride;
  for (let j = 0; j < n - 1; j++) quad(tip + j, tip + j + 1, tip + n + j + 1, tip + n + j);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Trailing-edge device (flap / aileron / elevator / rudder) built from a
// surface definition: spans x0..x1, hinge at hingeFrac of chord, device
// extends from slightly ahead of hinge to chordFrac past the TE.
// Returned geometry is in pivot-local coords: origin at hinge line midpoint,
// span along x (centered), chord along +z.
function buildTEDevice(def, x0, x1, hingeFrac, chordFrac, thickScale = 0.55) {
  const secs = airfoilSections(10);
  const n = secs.length;
  const spanPts = 6;
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= spanPts; i++) {
    const x = x0 + (x1 - x0) * (i / spanPts);
    const sec = sectionAt(def, x);
    const zHinge = sec.zLE + hingeFrac * sec.chord;
    const zStart = zHinge - 0.06 * sec.chord;
    const zEnd = sec.zLE + sec.chord + chordFrac * sec.chord;
    const devChord = zEnd - zStart;
    for (let side = 0; side < 2; side++) {
      for (let j = 0; j < n; j++) {
        const [xc, yt, yb] = secs[j];
        const ya = side === 0 ? yt : yb;
        const lx = x - (x0 + x1) / 2;
        positions.push(lx, sec.y + ya * sec.thick * thickScale * devChord, zStart + xc * devChord - (sec.zLE + hingeFrac * sec.chord));
        uvs.push(xc, i / spanPts);
      }
    }
  }
  const rowStride = 2 * n;
  const quad = (a, b, c, d) => indices.push(a, b, d, b, c, d);
  for (let i = 0; i < spanPts; i++) {
    const r0 = i * rowStride, r1 = (i + 1) * rowStride;
    for (let j = 0; j < n - 1; j++) {
      quad(r0 + j, r1 + j, r1 + j + 1, r0 + j + 1);
      quad(r0 + n + j, r0 + n + j + 1, r1 + n + j + 1, r1 + n + j);
    }
    quad(r0, r0 + n, r1 + n, r1);
    const t0 = r0 + n - 1, b0 = r0 + 2 * n - 1, t1 = r1 + n - 1, b1 = r1 + 2 * n - 1;
    quad(t0, b0, b1, t1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo };
}

// ============================================================ buildBoeing737
export function buildBoeing737() {
  const group = new THREE.Group();
  group.name = 'B737-800';
  const parts = { group };
  const detail = new THREE.Group();       // toggled by setExteriorDetail
  group.add(detail);

  // ------------------------------------------------------------ materials
  const fuselageTex = makeFuselageTexture();
  const tailTex = makeTailTexture();
  const matFuselage = new THREE.MeshStandardMaterial({
    map: fuselageTex, metalness: 0.35, roughness: 0.38,
  });
  const matWing = new THREE.MeshStandardMaterial({
    color: 0xb9bdc4, metalness: 0.35, roughness: 0.5, side: THREE.DoubleSide,
  });
  const matTail = new THREE.MeshStandardMaterial({
    map: tailTex, metalness: 0.3, roughness: 0.45, side: THREE.DoubleSide,
  });
  const matEngine = new THREE.MeshStandardMaterial({
    color: 0xd8dce1, metalness: 0.45, roughness: 0.35, side: THREE.DoubleSide,
  });
  const matIntakeLip = new THREE.MeshStandardMaterial({
    color: 0x8f959d, metalness: 0.9, roughness: 0.25,
  });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.9 });
  const matGlass = new THREE.MeshStandardMaterial({
    color: 0x11161d, metalness: 0.85, roughness: 0.06,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
  });
  const matFrame = new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.6, metalness: 0.3 });
  const matChrome = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.12 });
  const matStrut = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.6, roughness: 0.35 });
  const matTire = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.95 });
  const matHub = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.7, roughness: 0.35 });
  const matInterior = new THREE.MeshStandardMaterial({ color: 0x1e2126, roughness: 0.92 });
  const matSeat = new THREE.MeshStandardMaterial({ color: 0x1d3a6e, roughness: 0.85 }); // southwest blue seats

  // ------------------------------------------------------------ fuselage
  const profileCtrl = [
    [0.03, NOSE_Z], [0.42, -19.45], [0.85, -18.9], [1.20, -18.25],
    [1.48, -17.5], [1.68, -16.6], [1.80, -15.4], [1.86, -13.5],
    [1.88, -10.0], [1.88, 4.0], [1.86, 7.0], [1.78, 10.0],
    [1.62, 13.0], [1.38, 15.5], [1.05, 17.5], [0.68, 18.8],
    [0.34, 19.5], [0.16, TAIL_Z],
  ].map(([r, z]) => new THREE.Vector2(r, z));
  const spline = new THREE.SplineCurve(profileCtrl);
  const profilePts = spline.getPoints(90);
  const fuseGeo = new THREE.LatheGeometry(profilePts, 56);
  fuseGeo.rotateX(Math.PI / 2);            // lathe axis -> z, nose at -z
  fuseGeo.translate(0, FUSE_Y, 0);
  // upswept tail cone
  {
    const p = fuseGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z > 8) {
        const t = smoothstep01((z - 8) / (TAIL_Z - 8));
        p.setY(i, p.getY(i) + 1.35 * Math.pow(t, 1.4));
      }
    }
    fuseGeo.computeVertexNormals();
  }
  const fuselage = new THREE.Mesh(fuseGeo, matFuselage);
  fuselage.name = 'fuselage';
  group.add(fuselage);

  // APU exhaust at tail tip
  const apu = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 12), matDark);
  apu.rotation.x = Math.PI / 2 - 0.25;
  apu.position.set(0.3, FUSE_Y + 1.28, TAIL_Z - 0.15);
  group.add(apu);
  parts.apuExhaust = new THREE.Object3D();
  parts.apuExhaust.position.set(0, FUSE_Y + 1.35, TAIL_Z + 0.1);
  group.add(parts.apuExhaust);

  // antennas + pitot probes (small details)
  const antennaGeo = new THREE.BoxGeometry(0.07, 0.4, 0.55);
  for (const [x, y, z] of [[0, 5.92, -6], [0, 5.86, 6], [0, 1.92, -2]]) {
    const a = new THREE.Mesh(antennaGeo, matFrame);
    a.position.set(x, y, z); a.rotation.x = -0.25;
    detail.add(a);
  }
  for (const sx of [-1, 1]) {
    const pitot = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 8), matStrut);
    pitot.rotation.x = Math.PI / 2;
    pitot.position.set(sx * 0.95, 3.55, -19.15);
    detail.add(pitot);
  }

  // ------------------------------------------------------------ wings
  const WING = {
    span: 17.895 - 1.55, rootChord: 6.08, tipChord: 1.32,
    sweepTan: Math.tan(28 * DEG), dihedralTan: Math.tan(6 * DEG),
    thickRoot: 0.12, thickTip: 0.10,
  };
  const WING_ROOT = new THREE.Vector3(1.55, 2.45, -3.2); // group origin (root LE)
  const wingGeo = buildLiftingSurface(WING, 16, 18);

  const wingGroupR = new THREE.Group();
  wingGroupR.position.copy(WING_ROOT);
  const wingMeshR = new THREE.Mesh(wingGeo, matWing);
  wingMeshR.name = 'wingR';
  wingGroupR.add(wingMeshR);
  const wingGroupL = new THREE.Group();
  wingGroupL.position.set(-WING_ROOT.x, WING_ROOT.y, WING_ROOT.z);
  wingGroupL.scale.x = -1;
  const wingMeshL = new THREE.Mesh(wingGeo, matWing);
  wingMeshL.name = 'wingL';
  wingGroupL.add(wingMeshL);
  group.add(wingGroupR, wingGroupL);
  parts.wingGroupR = wingGroupR; parts.wingGroupL = wingGroupL;

  // blended winglets (children of wing groups, at tip)
  const WINGLET = {
    span: 2.35, rootChord: 1.32, tipChord: 0.55,
    sweepTan: Math.tan(42 * DEG), dihedralTan: 0, thickRoot: 0.09, thickTip: 0.08,
  };
  const wingletGeo = buildLiftingSurface(WINGLET, 10, 6);
  for (const [wg, tipX] of [[wingGroupR, WING.span], [wingGroupL, WING.span]]) {
    const wl = new THREE.Mesh(wingletGeo, matWing);
    const tip = sectionAt(WING, WING.span);
    wl.position.set(tipX - 0.05, tip.y - 0.1, tip.zLE + 0.1);
    wl.rotation.z = -0.28;                    // cant outward slightly
    wl.rotation.y = 0.12;
    wg.add(wl);
  }

  // wing root fairing
  for (const sx of [-1, 1]) {
    const fair = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.55, 7.2), matWing);
    fair.position.set(sx * 1.7, 2.62, 0.1);
    fair.rotation.y = sx * 0.06;
    group.add(fair);
  }

  // ---- control surfaces: pivots are children of wing groups (flex with wing)
  const flapPivots = [], slatPivots = [], spoilerPanels = [];
  let aileronR, aileronL;
  const FLAP_SEGS = [[1.95, 6.8], [6.8, 10.6]];
  for (const [wg, mirror] of [[wingGroupR, 1], [wingGroupL, -1]]) {
    // flaps: 2 segments per wing
    for (const [x0, x1] of FLAP_SEGS) {
      const { geo } = buildTEDevice(WING, x0 - 1.55, x1 - 1.55, 0.68, 0.18);
      const xMid = (x0 + x1) / 2 - 1.55;
      const sec = sectionAt(WING, xMid);
      const pivot = new THREE.Group();
      pivot.position.set(xMid, sec.y - 0.04, sec.zLE + 0.68 * sec.chord);
      const mesh = new THREE.Mesh(geo, matWing);
      pivot.add(mesh);
      pivot.userData.base = pivot.position.clone();
      wg.add(pivot);
      flapPivots.push(pivot);
    }
    // aileron (outboard TE)
    {
      const { geo } = buildTEDevice(WING, 11.2 - 1.55, 16.2 - 1.55, 0.75, 0.10);
      const xMid = (11.2 + 16.2) / 2 - 1.55;
      const sec = sectionAt(WING, xMid);
      const pivot = new THREE.Group();
      pivot.position.set(xMid, sec.y - 0.02, sec.zLE + 0.75 * sec.chord);
      pivot.add(new THREE.Mesh(geo, matWing));
      wg.add(pivot);
      if (mirror === 1) aileronR = pivot; else aileronL = pivot;
    }
    // spoilers: 4 panels per wing on upper surface
    for (let k = 0; k < 4; k++) {
      const x0 = 3.4 + k * 1.95, x1 = x0 + 1.55;
      const xMid = (x0 + x1) / 2 - 1.55;
      const sec = sectionAt(WING, xMid);
      const panelChord = 0.26 * sec.chord;
      const geo = new THREE.BoxGeometry(x1 - x0 - 0.12, 0.045, panelChord);
      geo.translate(0, 0, panelChord / 2);    // hinge at front edge
      const pivot = new THREE.Group();
      pivot.position.set(xMid, sec.y + 0.06 * sec.chord + 0.03, sec.zLE + 0.52 * sec.chord);
      const mesh = new THREE.Mesh(geo, matWing);
      pivot.add(mesh);
      wg.add(pivot);
      spoilerPanels.push(pivot);
    }
    // slats: 3 leading-edge segments per wing
    for (const [x0, x1] of [[2.2, 7.0], [7.0, 11.8], [11.8, 16.6]]) {
      const spanPts = 5, n = 8;
      const positions = [], uvs = [], indices = [];
      for (let i = 0; i <= spanPts; i++) {
        const x = (x0 + (x1 - x0) * (i / spanPts)) - 1.55;
        const sec = sectionAt(WING, x);
        for (let j = 0; j <= n; j++) {
          const f = j / n;                    // 0 = bottom-front, 1 = top-aft
          const ang = Math.PI * (0.62 + 0.5 * f);
          const rr = 0.5 * sec.thick * sec.chord;
          const lz = sec.zLE - 0.30 + Math.cos(ang) * rr * 1.6;
          const ly = sec.y + Math.sin(ang) * rr + 0.02;
          positions.push(x - ((x0 + x1) / 2 - 1.55), ly - sec.y, lz - sec.zLE);
          uvs.push(f, i / spanPts);
        }
      }
      const stride = n + 1;
      for (let i = 0; i < spanPts; i++)
        for (let j = 0; j < n; j++) {
          const a = i * stride + j, b = a + stride;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const xMid = (x0 + x1) / 2 - 1.55;
      const sec = sectionAt(WING, xMid);
      const pivot = new THREE.Group();
      pivot.position.set(xMid, sec.y, sec.zLE);
      pivot.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0xb9bdc4, metalness: 0.35, roughness: 0.5, side: THREE.DoubleSide,
      })));
      pivot.userData.base = pivot.position.clone();
      wg.add(pivot);
      slatPivots.push(pivot);
    }
  }

  // ------------------------------------------------------------ empennage
  // horizontal stabilizer
  const STAB = {
    span: 7.175 - 1.1, rootChord: 4.4, tipChord: 1.5,
    sweepTan: Math.tan(32 * DEG), dihedralTan: 0, thickRoot: 0.10, thickTip: 0.09,
  };
  const stabGroup = new THREE.Group();
  stabGroup.position.set(1.1, 4.55, 13.0);
  const stabGeo = buildLiftingSurface(STAB, 12, 10);
  stabGroup.add(new THREE.Mesh(stabGeo, matWing));
  const stabGroupL = new THREE.Group();
  stabGroupL.position.set(-1.1, 4.55, 13.0);
  stabGroupL.scale.x = -1;
  stabGroupL.add(new THREE.Mesh(stabGeo, matWing));
  group.add(stabGroup, stabGroupL);
  parts.stabilizer = stabGroup;

  // elevators (one pivot per side)
  let elevatorR, elevatorL;
  for (const [sg, isR] of [[stabGroup, true], [stabGroupL, false]]) {
    const { geo } = buildTEDevice(STAB, 1.35 - 1.1, 6.9 - 1.1, 0.60, 0.12);
    const xMid = (1.35 + 6.9) / 2 - 1.1;
    const sec = sectionAt(STAB, xMid);
    const pivot = new THREE.Group();
    pivot.position.set(xMid, sec.y - 0.01, sec.zLE + 0.60 * sec.chord);
    pivot.add(new THREE.Mesh(geo, matWing));
    sg.add(pivot);
    if (isR) elevatorR = pivot; else elevatorL = pivot;
  }

  // vertical stabilizer (built as a wing, rotated upright)
  const FIN = {
    span: 7.9, rootChord: 7.2, tipChord: 2.8,
    sweepTan: 0.468, dihedralTan: 0, thickRoot: 0.09, thickTip: 0.08,
  };
  const finGroup = new THREE.Group();
  finGroup.position.set(0, 4.45, 10.8);
  finGroup.rotation.z = Math.PI / 2;          // span +x -> +y
  const finGeo = buildLiftingSurface(FIN, 12, 10);
  const finMesh = new THREE.Mesh(finGeo, matTail);
  finGroup.add(finMesh);
  group.add(finGroup);
  // rudder
  const { geo: rudderGeo } = buildTEDevice(FIN, 0.7, 7.4, 0.65, 0.12);
  const rudderPivot = new THREE.Group();
  {
    const xMid = (0.7 + 7.4) / 2;
    const sec = sectionAt(FIN, xMid);
    rudderPivot.position.set(xMid, sec.y, sec.zLE + 0.65 * sec.chord);
    const rm = new THREE.Mesh(rudderGeo, matTail);
    rudderPivot.add(rm);
    finGroup.add(rudderPivot);
  }
  parts.rudder = rudderPivot;

  // ------------------------------------------------------------ engines
  const ENG_X = 5.4, ENG_Y = 2.0, ENG_Z_FRONT = -4.6, ENG_LEN = 4.6;
  function buildEngine(side) {               // side: +1 right, -1 left
    const g = new THREE.Group();
    g.position.set(side * ENG_X, ENG_Y, ENG_Z_FRONT);
    g.rotation.y = side * -0.035;            // slight toe-out

    // nacelle (lathe), flattened "hamster pouch" bottom like the CFM56-7B
    const prof = [
      [0.80, 0], [0.92, 0.18], [1.00, 0.55], [1.02, 1.1],
      [1.02, 2.4], [0.96, 3.3], [0.89, 4.1], [0.84, ENG_LEN],
    ].map(([r, z]) => new THREE.Vector2(r, z));
    const nacGeo = new THREE.LatheGeometry(prof, 40);
    nacGeo.rotateX(Math.PI / 2);
    {
      const p = nacGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) < -0.2 && p.getZ(i) < 1.6) p.setY(i, p.getY(i) * 0.93);
      }
      nacGeo.computeVertexNormals();
    }
    g.add(new THREE.Mesh(nacGeo, matEngine));

    // intake lip (torus)
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.10, 12, 32), matIntakeLip);
    lip.position.z = 0.12;
    g.add(lip);

    // dark intake interior
    const dark = new THREE.Mesh(new THREE.CircleGeometry(0.80, 24), matDark);
    dark.position.z = 1.15;
    g.add(dark);

    // FAN: spinner cone + 18 individual blades (spins with N1)
    const fan = new THREE.Group();
    fan.position.z = 0.55;
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.6, 20), matIntakeLip);
    spinner.rotation.x = -Math.PI / 2;       // point forward (-z)
    spinner.position.z = -0.15;
    fan.add(spinner);
    const bladeGeo = new THREE.BoxGeometry(0.26, 0.62, 0.03);
    bladeGeo.translate(0, 0.31, 0);          // root at hub
    const matBlade = new THREE.MeshStandardMaterial({
      color: 0xd6dade, metalness: 0.85, roughness: 0.25, side: THREE.DoubleSide,
    });
    for (let i = 0; i < 18; i++) {
      const holder = new THREE.Group();
      holder.rotation.z = (i / 18) * Math.PI * 2;
      const blade = new THREE.Mesh(bladeGeo, matBlade);
      blade.position.y = 0.24;
      blade.rotation.y = 0.55;               // blade pitch
      holder.add(blade);
      fan.add(holder);
    }
    // fan disc backing
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.80, 24), matDark);
    disc.position.z = 0.28;
    fan.add(disc);
    g.add(fan);

    // exhaust plug + nozzle
    const plug = new THREE.Mesh(new THREE.ConeGeometry(0.30, 0.9, 16), matIntakeLip);
    plug.rotation.x = Math.PI / 2;
    plug.position.z = ENG_LEN + 0.1;
    g.add(plug);

    // thrust reverser: translating sleeve + cascade band revealed when deployed
    const cascade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.94, 0.94, 0.62, 32, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.7, side: THREE.DoubleSide })
    );
    cascade.rotation.x = Math.PI / 2;
    cascade.position.z = 2.95;
    g.add(cascade);
    const sleeveGeo = new THREE.CylinderGeometry(1.03, 1.0, 1.35, 40, 1, true);
    sleeveGeo.rotateX(Math.PI / 2);
    const sleeve = new THREE.Mesh(sleeveGeo, matEngine);
    sleeve.position.z = 2.95;
    g.add(sleeve);

    // pylon to wing underside
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 2.6), matEngine);
    pylon.position.set(0, 1.15, 2.2);
    pylon.rotation.x = 0.08;
    g.add(pylon);

    group.add(g);
    return { group: g, fan, sleeve, sleeveBaseZ: 2.95 };
  }
  const engR = buildEngine(1), engL = buildEngine(-1);
  parts.fanR = engR.fan; parts.fanL = engL.fan;

  // ------------------------------------------------------------ landing gear
  function makeWheel(r, width, spokes) {
    const w = new THREE.Group();
    const tireGeo = new THREE.CylinderGeometry(r, r, width, 28);
    tireGeo.rotateZ(Math.PI / 2);            // axle along x
    w.add(new THREE.Mesh(tireGeo, matTire));
    const hubGeo = new THREE.CylinderGeometry(r * 0.52, r * 0.52, width + 0.02, 20);
    hubGeo.rotateZ(Math.PI / 2);
    w.add(new THREE.Mesh(hubGeo, matHub));
    for (let i = 0; i < spokes; i++) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(width + 0.03, r * 0.42, 0.05), matHub);
      const holder = new THREE.Group();
      holder.rotation.x = (i / spokes) * Math.PI * 2;
      sp.position.y = r * 0.26;
      holder.add(sp);
      sp.position.x = 0;
      w.add(holder);
    }
    // hub caps
    for (const sx of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.03, 12), matDark);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = sx * (width / 2 + 0.01);
      w.add(cap);
    }
    return w;
  }

  const wheelsNose = [], wheelsMain = [];

  // nose gear: twin wheel, retracts aft
  const nosePivot = new THREE.Group();
  nosePivot.position.set(0, 2.05, -14.2);
  {
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 1.15, 14), matStrut);
    housing.position.y = -0.575;
    const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.62, 14), matChrome);
    piston.position.y = -1.40;
    nosePivot.add(housing, piston);
    // torque links
    const link = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.08), matStrut);
    link.position.set(0.12, -1.0, 0.1); link.rotation.x = 0.5;
    nosePivot.add(link);
    const axleY = -(2.05 - WHEEL_R_NOSE);    // world y = WHEEL_R_NOSE
    for (const sx of [-1, 1]) {
      const wh = makeWheel(WHEEL_R_NOSE, 0.22, 8);
      wh.position.set(sx * 0.20, axleY, 0);
      nosePivot.add(wh);
      wheelsNose.push(wh);
    }
    // gear doors
    for (const sx of [-1, 1]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.5, 0.62), matFuselage);
      door.position.set(sx * 0.34, -0.85, 0);
      nosePivot.add(door);
    }
  }
  group.add(nosePivot);
  parts.gearNose = nosePivot;

  // main gears: dual wheel each, retract inward/up
  function buildMainGear(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 2.86, 2.75, 1.6);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 1.55, 14), matStrut);
    housing.position.y = -0.775;
    const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.68, 14), matChrome);
    piston.position.y = -1.83;
    pivot.add(housing, piston);
    // side stay (diagonal brace toward wing)
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.9, 0.12), matStrut);
    stay.position.set(side * 0.55, -0.85, 0.25);
    stay.rotation.z = side * -0.55;
    pivot.add(stay);
    const axleY = -(2.75 - WHEEL_R_MAIN);
    for (const sx of [-1, 1]) {
      const wh = makeWheel(WHEEL_R_MAIN, 0.40, 8);
      wh.position.set(sx * 0.32, axleY, 0);
      pivot.add(wh);
      wheelsMain.push(wh);
    }
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.7, 0.05), matFuselage);
    door.position.set(0, -0.9, 0.42);
    pivot.add(door);
    group.add(pivot);
    return pivot;
  }
  const mainPivotR = buildMainGear(1), mainPivotL = buildMainGear(-1);
  parts.gearRight = mainPivotR; parts.gearLeft = mainPivotL;

  // ------------------------------------------------------------ cockpit shell
  const cockpit = new THREE.Group();
  group.add(cockpit);

  // windshield: 6 dark glass panes with frames, placed parametrically on the
  // nose surface. a = azimuth from top (deg, +/- = right/left), z = station.
  const noseR = z => {
    // piecewise-linear radius from the profile control points
    const cp = [
      [-19.74, 0.03], [-19.45, 0.42], [-18.9, 0.85], [-18.25, 1.20],
      [-17.5, 1.48], [-16.6, 1.68], [-15.4, 1.80],
    ];
    for (let i = 0; i < cp.length - 1; i++) {
      const [z0, r0] = cp[i], [z1, r1] = cp[i + 1];
      if (z <= z1) { const t = (z - z0) / (z1 - z0); return r0 + (r1 - r0) * t; }
    }
    return 1.85;
  };
  const paneDefs = [
    // [azimuthDeg, z, w, h]
    [-27, -18.18, 0.72, 0.60], [27, -18.18, 0.72, 0.60],   // front pair
    [-50, -17.80, 0.64, 0.58], [50, -17.80, 0.64, 0.58],   // mid pair
    [-70, -17.05, 0.58, 0.54], [70, -17.05, 0.58, 0.54],   // side pair
  ];
  for (const [az, z, w, h] of paneDefs) {
    const a = az * DEG;
    const r = noseR(z);
    const nx = Math.sin(a), ny = Math.cos(a);
    // nose slopes: tilt the normal slightly forward
    const nv = new THREE.Vector3(nx, ny, -0.38).normalize();
    const px = nx * (r + 0.015), py = FUSE_Y + ny * (r + 0.015);
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.09, h + 0.09), matFrame);
    frame.position.set(px, py, z).addScaledVector(nv, -0.012);
    frame.lookAt(px + nv.x * 2, py + nv.y * 2, z + nv.z * 2);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), matGlass);
    pane.position.set(px, py, z);
    pane.lookAt(px + nv.x * 2, py + nv.y * 2, z + nv.z * 2);
    pane.renderOrder = 5;
    cockpit.add(frame, pane);
  }
  // center post
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.64, 0.07), matFrame);
  post.position.set(0, FUSE_Y + noseR(-18.18) * 0.88, -18.20);
  post.rotation.x = -0.30;
  cockpit.add(post);

  // inner cockpit shell: dark, visible only from inside (BackSide), with
  // alpha-cut window holes aligned to the 6 glass panes. This encloses the
  // pilot's view so no sky shows through the (backface-culled) nose skin.
  {
    const SHELL_Z0 = NOSE_Z, SHELL_Z1 = -16.5;
    const shellProfile = spline.getPoints(140).filter(p => p.y <= SHELL_Z1);
    const vOfZ = z => {
      for (let i = 0; i < shellProfile.length - 1; i++) {
        const z0 = shellProfile[i].y, z1 = shellProfile[i + 1].y;
        if (z >= z0 && z <= z1) {
          const t = (z - z0) / Math.max(1e-6, z1 - z0);
          return (i + t) / (shellProfile.length - 1);
        }
      }
      return 1;
    };
    // [azimuthDeg from top (+ = right), z] matching the glass panes
    const holes = [[27, -18.18], [-27, -18.18], [50, -17.80], [-50, -17.80], [70, -17.05], [-70, -17.05]];
    const shellTex = canvasTexture(512, 512, (ctx, W, H) => {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#000000';
      for (const [az, z] of holes) {
        const u = 0.5 - az / 360, v = vOfZ(z);
        roundedRect(ctx, u * W - 22, (1 - v) * H - 40, 44, 80, 10);
        ctx.fill();
      }
    });
    const shellGeo = new THREE.LatheGeometry(shellProfile, 48);
    shellGeo.rotateX(Math.PI / 2);
    shellGeo.translate(0, FUSE_Y, 0);
    shellGeo.translate(0, -FUSE_Y, 0);
    shellGeo.scale(0.985, 0.985, 1);
    shellGeo.translate(0, FUSE_Y, 0);
    const shell = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({
      color: 0x23262b, roughness: 0.95, side: THREE.BackSide,
      alphaMap: shellTex, transparent: true,
    }));
    shell.renderOrder = 1;
    cockpit.add(shell);
  }

  // interior tub (floor, bulkhead, sidewalls, ceiling) — encloses pilot view.
  // NOTE: every panel is sized to stay inside the nose loft (no poke-through).
  const tub = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 3.8), matInterior);
  floor.position.set(0, 3.32, -17.0);
  const bulkhead = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.2, 0.1), matInterior);
  bulkhead.position.set(0, 4.35, -15.3);
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.08, 1.7), matInterior);
  ceil.position.set(0, 5.28, -16.15);
  tub.add(floor, bulkhead, ceil);
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.9, 1.7), matInterior);
    wall.position.set(sx * 1.24, 4.28, -16.15);
    tub.add(wall);
  }
  // lower nose blocker: seals the view below the instrument panel
  const blocker = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.7),
    new THREE.MeshStandardMaterial({ color: 0x1e2126, roughness: 0.9, side: THREE.DoubleSide }));
  blocker.position.set(0, 3.75, -17.95);
  blocker.rotation.x = 0.55;
  tub.add(blocker);
  cockpit.add(tub);
  detail.add(tub); // hidden at lowest detail level

  // seats (captain + first officer)
  function buildSeat(x) {
    const s = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.55), matSeat);
    base.position.y = 0.07;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.78, 0.15), matSeat);
    back.position.set(0, 0.5, 0.30); back.rotation.x = 0.12;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.22, 0.13), matSeat);
    head.position.set(0, 1.0, 0.34);
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, 0.4), matFrame);
    ped.position.y = -0.2;
    s.add(base, back, head, ped);
    s.position.set(x, 3.62, -16.45);
    return s;
  }
  const seatL = buildSeat(-0.55), seatR = buildSeat(0.55);
  detail.add(seatL, seatR);

  // glareshield + center pedestal
  const glare = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.14, 0.62), matInterior);
  glare.position.set(0, 4.56, -17.34); glare.rotation.x = -0.14;
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.78, 1.35), matInterior);
  pedestal.position.set(0, 3.85, -16.55);
  detail.add(glare, pedestal);

  // empty instrument-panel mounting area (cockpit module attaches its panel here)
  const panelMount = new THREE.Group();
  panelMount.name = 'panelMount';
  panelMount.position.set(0, 4.12, -17.48);
  panelMount.rotation.x = -0.30;             // tilted back, faces pilot
  cockpit.add(panelMount);
  parts.panelMount = panelMount;
  // panel backing plate (dark) so the mount reads as a real panel base
  const panelBase = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.92, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.7 }));
  panelMount.add(panelBase);

  // overhead panel shell
  const overhead = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.9), matInterior);
  overhead.position.set(0, 5.30, -17.55); overhead.rotation.x = 0.55;
  detail.add(overhead);

  // pilot eye position (left seat), measured from this geometry:
  // seat base top y≈3.69 at (-0.55, -16.45); eye ~0.93 above, slightly fwd
  parts.pilotEye = new THREE.Vector3(-0.55, 4.62, -16.35);

  // ------------------------------------------------------------ lights
  const glowTex = canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  });
  function addLightUnit(parent, x, y, z, color, size = 0.35) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: new THREE.Color(color), emissiveIntensity: 2,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), mat);
    bulb.position.set(x, y, z);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    spr.scale.setScalar(size);
    spr.position.set(x, y, z);
    parent.add(bulb, spr);
    return { bulb, spr, mat };
  }
  // nav lights: red left / green right / white tail (steady)
  const tipR = sectionAt(WING, WING.span);
  addLightUnit(wingGroupR, WING.span - 0.1, tipR.y, tipR.zLE + 0.55 * tipR.chord, 0xff2222);
  addLightUnit(wingGroupL, WING.span - 0.1, tipR.y, tipR.zLE + 0.55 * tipR.chord, 0x22ff44);
  addLightUnit(group, 0, FUSE_Y + 1.32, TAIL_Z - 0.25, 0xffffff);
  // red anti-collision beacons (flashing)
  const beaconTop = addLightUnit(group, 0, 5.88, 2.0, 0xff2222, 0.55);
  const beaconBot = addLightUnit(group, 0, 1.94, 2.0, 0xff2222, 0.55);
  // white strobes at wingtips (double-flash)
  const strobeR = addLightUnit(wingGroupR, WING.span - 0.1, tipR.y + 0.12, tipR.zLE + 0.55 * tipR.chord, 0xffffff, 0.6);
  const strobeL = addLightUnit(wingGroupL, WING.span - 0.1, tipR.y + 0.12, tipR.zLE + 0.55 * tipR.chord, 0xffffff, 0.6);
  parts.navLights = { beaconTop, beaconBot, strobeR, strobeL };

  // landing lights: wing roots + nose gear (spotlights, toggleable)
  const landingLights = [];
  for (const sx of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16),
      new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff6d8, emissiveIntensity: 0.15 }));
    lens.position.set(sx * 2.7, 2.62, -3.55);
    lens.rotation.y = Math.PI;               // face forward (-z)
    group.add(lens);
    const spot = new THREE.SpotLight(0xfff2cf, 0, 500, 0.32, 0.45, 1.2);
    spot.position.set(sx * 2.7, 2.62, -3.55);
    spot.target.position.set(sx * 3.2, -1, -70);
    group.add(spot, spot.target);
    landingLights.push({ lens, spot });
  }
  const gearLens = new THREE.Mesh(new THREE.CircleGeometry(0.11, 14),
    landingLights[0].lens.material.clone());
  gearLens.position.set(0, -1.15, -0.35);
  gearLens.rotation.x = -0.5;
  nosePivot.add(gearLens);
  const gearSpot = new THREE.SpotLight(0xfff2cf, 0, 300, 0.4, 0.5, 1.2);
  gearSpot.position.set(0, 2.05 - 1.15, -14.2 - 0.35);
  gearSpot.target.position.set(0, -2, -80);
  group.add(gearSpot, gearSpot.target);
  landingLights.push({ lens: gearLens, spot: gearSpot });

  parts.setLandingLights = on => {
    for (const { lens, spot } of landingLights) {
      spot.intensity = on ? 1500 : 0;
      lens.material.emissiveIntensity = on ? 6 : 0.15;
    }
  };
  parts.setLandingLights(false);

  // ------------------------------------------------------------ parts API
  const anim = {
    gear: 1, gearTarget: 1,
    flapsDeg: 0, flapsTarget: 0,
    spoilers: 0, spoilersTarget: 0,
    reversers: 0, reversersTarget: 0,
    pitch: 0, roll: 0, yaw: 0,
    pitchT: 0, rollT: 0, yawT: 0,
    flex: 0,
  };
  let wheelAngleNose = 0, wheelAngleMain = 0;

  parts.setGear = t => { anim.gearTarget = clamp01(t); };
  parts.setFlaps = deg => { anim.flapsTarget = Math.max(0, Math.min(50, deg)); };
  parts.setSpoilers = t => { anim.spoilersTarget = clamp01(t); };
  parts.setReversers = on => { anim.reversersTarget = on ? 1 : 0; };
  parts.setFlightControls = (pitch, roll, yaw) => {
    anim.pitchT = THREE.MathUtils.clamp(pitch, -1, 1);
    anim.rollT = THREE.MathUtils.clamp(roll, -1, 1);
    anim.yawT = THREE.MathUtils.clamp(yaw, -1, 1);
  };
  parts.setExteriorDetail = level => { detail.visible = level > 0; };

  let simT = 0;
  parts.update = (dt, fstate = {}, controls = {}) => {
    simT += dt;
    const k = (rate) => Math.min(1, dt * rate);

    // --- fans spin with N1: rad/s = 20 + n1 * 160
    const n1L = (fstate.n1 && fstate.n1[0]) || 0;
    const n1R = (fstate.n1 && fstate.n1[1]) || 0;
    parts.fanL.rotation.z -= (20 + n1L * 160) * dt;
    parts.fanR.rotation.z -= (20 + n1R * 160) * dt;

    // --- wheels spin with ground speed (only when deployed & on ground)
    const gs = (fstate.gsKt || 0) * 0.514444;
    if (fstate.onGround && anim.gear > 0.9 && gs > 0.1) {
      wheelAngleNose += (gs / WHEEL_R_NOSE) * dt;
      wheelAngleMain += (gs / WHEEL_R_MAIN) * dt;
    }
    for (const w of wheelsNose) w.rotation.x = wheelAngleNose;
    for (const w of wheelsMain) w.rotation.x = wheelAngleMain;

    // --- gear retract: nose rotates aft, mains swing inward/up
    anim.gear += (anim.gearTarget - anim.gear) * k(2.2);
    if (Math.abs(anim.gearTarget - anim.gear) < 0.001) anim.gear = anim.gearTarget;
    const gUp = 1 - anim.gear;
    nosePivot.rotation.x = -1.88 * gUp;
    mainPivotR.rotation.z = -1.62 * gUp;
    mainPivotL.rotation.z = 1.62 * gUp;

    // --- flaps (Fowler-ish: rotate down + translate aft/down), slats follow
    anim.flapsDeg += (anim.flapsTarget - anim.flapsDeg) * k(1.4);
    const flapRad = anim.flapsDeg * DEG;
    const ext = anim.flapsDeg / 40;
    for (const p of flapPivots) {
      p.rotation.x = flapRad;
      p.position.z = p.userData.base.z + ext * 0.55;
      p.position.y = p.userData.base.y - ext * 0.28;
    }
    const slatExt = clamp01(anim.flapsDeg / 5);
    for (const p of slatPivots) {
      p.rotation.x = -0.20 * slatExt;
      p.position.z = p.userData.base.z - 0.30 * slatExt;
      p.position.y = p.userData.base.y - 0.13 * slatExt;
    }

    // --- spoilers rise
    anim.spoilers += (anim.spoilersTarget - anim.spoilers) * k(6);
    for (const p of spoilerPanels) p.rotation.x = -0.95 * anim.spoilers;

    // --- thrust reverser sleeves translate aft
    anim.reversers += (anim.reversersTarget - anim.reversers) * k(3);
    engR.sleeve.position.z = engR.sleeveBaseZ + anim.reversers * 0.58;
    engL.sleeve.position.z = engL.sleeveBaseZ + anim.reversers * 0.58;

    // --- flight controls (smoothed)
    anim.pitch += (anim.pitchT - anim.pitch) * k(9);
    anim.roll += (anim.rollT - anim.roll) * k(9);
    anim.yaw += (anim.yawT - anim.yaw) * k(9);
    const elev = -anim.pitch * 0.45;
    elevatorR.rotation.x = elev; elevatorL.rotation.x = elev;
    aileronR.rotation.x = -anim.roll * 0.42;
    aileronL.rotation.x = anim.roll * 0.42;   // mirrored wing: opposite sign = differential
    rudderPivot.rotation.y = anim.yaw * 0.5;

    // --- beacons (single red flash ~1.2 s period) & strobes (double flash)
    const beaconOn = (simT % 1.2) < 0.12;
    for (const b of [beaconTop, beaconBot]) {
      b.mat.emissiveIntensity = beaconOn ? 5 : 0.06;
      b.spr.material.opacity = beaconOn ? 0.95 : 0.0;
    }
    const ph = simT % 1.6;
    const strobeOn = ph < 0.07 || (ph > 0.14 && ph < 0.21);
    for (const s of [strobeR, strobeL]) {
      s.mat.emissiveIntensity = strobeOn ? 7 : 0.05;
      s.spr.material.opacity = strobeOn ? 1.0 : 0.0;
    }

    // --- wing flex: subtle bend with lift
    const flexTarget = fstate.onGround ? 0.004
      : 0.028 + Math.min(0.018, Math.abs(fstate.vsFpm || 0) / 6000 * 0.018);
    anim.flex += (flexTarget - anim.flex) * k(1.6);
    wingGroupR.rotation.z = anim.flex;
    wingGroupL.rotation.z = -anim.flex;
  };

  // gear starts deployed
  parts.setGear(1);

  return { group, parts };
}
