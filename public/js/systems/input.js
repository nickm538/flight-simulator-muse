// Unified input: keyboard + gamepad + touch controls -> physics controls object.
// Stick convention (flight-sim standard, like a real yoke):
//   pitch +1 = pull back / nose UP (ArrowDown or S, stick pulled toward you)
//   pitch -1 = push forward / nose DOWN (ArrowUp or W)
//   roll  +1 = right wing down (ArrowRight / D), roll -1 = left (ArrowLeft / A)
//   yaw   +1 = right rudder (E), yaw -1 = left rudder (Q)
// Keyboard AP keys: 1 = AP engage, 2 = HDG hold, 3 = ALT hold, 4 = autothrottle.
//   (The pause-menu help grid lists an older binding; the cockpit MCP buttons are
//   the authoritative AP interface and these keys just fire onAction events.)
// Throttle: PgUp/PgDn adjust BOTH engines (Shift = faster); per-engine trim is
//   available on the cockpit throttle quadrant via drag.

export function createInput(canvas, ui) {
  const keys = new Set();
  let pitch = 0, roll = 0, yaw = 0;          // smoothed, returned by getControls
  const throttle = [0, 0];                   // persistent per-engine 0..1
  let flapsIdx = 0;                          // 0..8 detent index
  let gearDown = true;
  let brakesHeld = 0;                        // 0..1 while B held
  let parkingBrake = false;
  let spoilersT = 0;                         // 0 stowed, 1 deployed
  let armSpoilers = false;
  const actions = {};                        // name -> [cb]
  let lastT = (typeof performance !== 'undefined' ? performance.now() : 0);

  // Touch state
  let isTouchFlag = false;
  const stick = { engaged: false, x: 0, y: 0 };
  let touchBrake = 0;
  let prevGpButtons = [];

  function fire(name, arg) {
    const list = actions[name];
    if (list) for (const cb of list) { try { cb(arg); } catch (e) { /* ignore */ } }
  }

  function onAction(name, cb) {
    if (!actions[name]) actions[name] = [];
    actions[name].push(cb);
  }

  // ---- Keyboard ------------------------------------------------------------
  const HANDLED = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyG', 'KeyF', 'KeyB',
    'KeyV', 'KeyP', 'KeyH', 'KeyA', 'Slash', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
    'Escape',
  ]);

  function flapStep(dir) {
    flapsIdx = Math.min(8, Math.max(0, flapsIdx + dir));
  }

  function keydown(e) {
    const c = e.code;
    if (HANDLED.has(c)) e.preventDefault();
    if (e.repeat) {
      // Discrete toggles ignore auto-repeat; analog keys are polled via `keys`.
      keys.add(c);
      return;
    }
    keys.add(c);
    const shift = e.shiftKey;
    switch (c) {
      case 'KeyG': gearDown = !gearDown; fire('gear', gearDown); reflectTouch(); break;
      case 'KeyF': flapStep(shift ? -1 : 1); fire(shift ? 'flapsDown' : 'flapsUp', flapsIdx); reflectTouch(); break;
      case 'KeyB':
        if (shift) { parkingBrake = !parkingBrake; fire('brakesToggle', parkingBrake); }
        else brakesHeld = 1;
        break;
      case 'Slash':
        if (shift) armSpoilers = !armSpoilers;
        else spoilersT = spoilersT > 0.5 ? 0 : 1;
        break;
      case 'KeyV': fire('view'); break;
      case 'KeyA': fire('atcPanel'); break;
      case 'KeyP': case 'Escape': fire('pause'); break;
      case 'KeyH': fire('help'); break;
      case 'Digit1': fire('apEngage'); break;
      case 'Digit2': fire('apHdg'); break;
      case 'Digit3': fire('apAlt'); break;
      case 'Digit4': fire('apAT'); break;
    }
  }
  function keyup(e) {
    keys.delete(e.code);
    if (e.code === 'KeyB') brakesHeld = 0;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
  }

  // ---- Gamepad -------------------------------------------------------------
  function deadzone(v) { return Math.abs(v) < 0.08 ? 0 : v; }

  function pollGamepad(dt) {
    let gp = null;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) if (p && p.connected) { gp = p; break; }
    } catch (e) { /* ignore */ }
    if (!gp) { prevGpButtons = []; return null; }
    const ax = (i) => deadzone(gp.axes[i] || 0);
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const edge = (i) => btn(i) && !prevGpButtons[i];

    const out = {
      pitch: -ax(1),          // stick pull (axis up = negative) -> nose up
      roll: ax(0),
      yaw: 0,
    };
    // Triggers adjust both throttles while held.
    if (btn(7)) { throttle[0] = Math.min(1, throttle[0] + dt * 0.6); throttle[1] = Math.min(1, throttle[1] + dt * 0.6); }
    if (btn(6)) { throttle[0] = Math.max(0, throttle[0] - dt * 0.6); throttle[1] = Math.max(0, throttle[1] - dt * 0.6); }
    if (edge(5)) { flapStep(1); fire('flapsUp', flapsIdx); }
    if (edge(4)) { flapStep(-1); fire('flapsDown', flapsIdx); }
    if (edge(2)) { gearDown = !gearDown; fire('gear', gearDown); reflectTouch(); }
    if (edge(3)) fire('view');
    if (edge(9)) fire('pause');
    out.brakes = btn(0) ? 1 : 0;
    prevGpButtons = gp.buttons.map(b => b.pressed);
    return out;
  }

  // ---- Touch ---------------------------------------------------------------
  function reflectTouch() {
    if (typeof document === 'undefined') return;
    const gearBtn = document.querySelector('#touch-btns [data-act="gear"]');
    if (gearBtn) gearBtn.classList.toggle('on', gearDown);
  }

  function initTouch() {
    const coarse = (typeof window !== 'undefined' && window.matchMedia)
      ? window.matchMedia('(pointer: coarse)').matches : false;
    const hasTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    if (!coarse && !hasTouch) return;
    isTouchFlag = true;
    if (ui && ui.showTouch) ui.showTouch(true);
    reflectTouch();

    const zone = document.getElementById('stick-zone');
    const base = document.getElementById('stick-base');
    const knob = document.getElementById('stick');
    const track = document.getElementById('thr-track');
    const handle = document.getElementById('thr-handle');
    let stickId = null, thrId = null;

    function stickFromEvent(e) {
      const r = base.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2);
      let dy = (e.clientY - cy) / (r.height / 2);
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      stick.x = dx; stick.y = dy;
      if (knob) knob.style.transform = `translate(${dx * r.width * 0.32}px, ${dy * r.height * 0.32}px)`;
    }

    if (zone) {
      zone.addEventListener('pointerdown', (e) => {
        stickId = e.pointerId; stick.engaged = true;
        zone.setPointerCapture(e.pointerId);
        stickFromEvent(e); e.preventDefault();
      });
      zone.addEventListener('pointermove', (e) => {
        if (e.pointerId === stickId) stickFromEvent(e);
      });
      const end = (e) => {
        if (e.pointerId !== stickId) return;
        stickId = null; stick.engaged = false; stick.x = 0; stick.y = 0;
        if (knob) knob.style.transform = 'translate(0px, 0px)';
      };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
    }

    function thrFromEvent(e) {
      const r = track.getBoundingClientRect();
      let v = 1 - (e.clientY - r.top) / r.height; // top = full
      v = Math.min(1, Math.max(0, v));
      throttle[0] = v; throttle[1] = v;
      if (handle) handle.style.bottom = `${v * 100}%`;
    }
    if (track) {
      track.addEventListener('pointerdown', (e) => {
        thrId = e.pointerId; track.setPointerCapture(e.pointerId);
        thrFromEvent(e); e.preventDefault();
      });
      track.addEventListener('pointermove', (e) => { if (e.pointerId === thrId) thrFromEvent(e); });
      const end = (e) => { if (e.pointerId === thrId) thrId = null; };
      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
    }

    const btns = document.querySelectorAll('#touch-btns [data-act]');
    btns.forEach((b) => {
      const act = b.getAttribute('data-act');
      if (act === 'brake') {
        b.addEventListener('pointerdown', (e) => { touchBrake = 1; b.classList.add('on'); e.preventDefault(); });
        const up = () => { touchBrake = 0; b.classList.remove('on'); };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        b.addEventListener('pointerleave', up);
        return;
      }
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (act === 'gear') { gearDown = !gearDown; fire('gear', gearDown); reflectTouch(); }
        else if (act === 'flaps+') { flapStep(1); fire('flapsUp', flapsIdx); }
        else if (act === 'flaps-') { flapStep(-1); fire('flapsDown', flapsIdx); }
        else if (act === 'atc') fire('atcPanel');
        else if (act === 'view') fire('view');
      });
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTouch);
    else initTouch();
  }

  // ---- Main merge ------------------------------------------------------------
  function getControls() {
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (!(dt > 0) || dt > 0.1) dt = 0.016;

    // Keyboard targets (smooth: approach at 6/s).
    const kPitch = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0)
                 + (keys.has('ArrowUp') || keys.has('KeyW') ? -1 : 0);
    const kRoll = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0)
                + (keys.has('ArrowLeft') || keys.has('KeyA') ? -1 : 0);
    const kYaw = (keys.has('KeyE') ? 1 : 0) + (keys.has('KeyQ') ? -1 : 0);

    // Keyboard throttle: PgUp/PgDn -> both engines (Shift = faster).
    const thrRate = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 0.9 : 0.45;
    if (keys.has('PageUp')) { throttle[0] = Math.min(1, throttle[0] + dt * thrRate); throttle[1] = Math.min(1, throttle[1] + dt * thrRate); }
    if (keys.has('PageDown')) { throttle[0] = Math.max(0, throttle[0] - dt * thrRate); throttle[1] = Math.max(0, throttle[1] - dt * thrRate); }

    const gp = (typeof navigator !== 'undefined') ? pollGamepad(dt) : null;
    const gpActive = !!gp && (Math.abs(gp.pitch) > 0.001 || Math.abs(gp.roll) > 0.001 || gp.brakes > 0);

    // Merge: touch > gamepad > keyboard for axes.
    let tPitch, tRoll, tYaw;
    if (stick.engaged) {
      tPitch = -stick.y;   // drag up (negative y) -> nose up
      tRoll = stick.x;
      tYaw = kYaw;
      pitch = tPitch; roll = tRoll; yaw = tYaw; // stick follows finger 1:1
    } else if (gpActive) {
      tPitch = gp.pitch; tRoll = gp.roll; tYaw = kYaw;
      pitch = tPitch; roll = tRoll; yaw = tYaw;
    } else {
      tPitch = kPitch; tRoll = kRoll; tYaw = kYaw;
      const rate = 6 * dt;
      pitch += Math.min(rate, Math.abs(tPitch - pitch)) * Math.sign(tPitch - pitch);
      roll += Math.min(rate, Math.abs(tRoll - roll)) * Math.sign(tRoll - roll);
      yaw += Math.min(rate, Math.abs(tYaw - yaw)) * Math.sign(tYaw - yaw);
    }

    const brakes = Math.max(brakesHeld, parkingBrake ? 1 : 0, touchBrake, gp ? gp.brakes : 0);
    const thrAvg = (throttle[0] + throttle[1]) / 2;
    const reversers = brakesHeld > 0.5 && thrAvg < 0.05;

    return {
      pitch, roll, yaw,
      throttle: [throttle[0], throttle[1]],
      flaps: flapsIdx,
      gearDown,
      brakes,
      parkingBrake,
      spoilers: spoilersT,
      armSpoilers,
      reversers,
    };
  }

  return {
    getControls,
    onAction,
    get isTouch() { return isTouchFlag; },
    // Escape hatch for main.js / cockpit to sync discrete state if needed.
    _debug: { get throttle() { return throttle; } },
  };
}
