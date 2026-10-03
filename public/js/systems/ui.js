// DOM ownership: loading screen, main menu, HUD, ATC panel/log, pause menu,
// help overlay, mobile touch visibility, toast banner, error overlay.
// All lookups are null-safe; every method works even if an element is missing.

const FLAP_LABELS = ['0', '1', '2', '5', '10', '15', '25', '30', '40'];

export function createUI() {
  const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
  const el = {
    loading: $('loading'), loadbar: $('loadbar'), loadlabel: $('loadlabel'),
    menu: $('menu'), menuAirport: $('menu-airport'), menuStart: $('menu-start'),
    menuTime: $('menu-time'), menuWeather: $('menu-weather'), flyBtn: $('fly-btn'),
    hud: $('hud'), hudIas: $('hud-ias'), hudAlt: $('hud-alt'), hudHdg: $('hud-hdg'),
    hudVs: $('hud-vs'), hudN1: $('hud-n1'), hudFlap: $('hud-flap'),
    hudGear: $('hud-gear'), hudFuel: $('hud-fuel'), hudWarn: $('hud-warn'),
    atc: $('atc'), atcLog: $('atc-log'), atcOptionsEl: $('atc-options'), atcToggle: $('atc-toggle'),
    pause: $('pause'), resumeBtn: $('resume-btn'), quitBtn: $('quit-btn'), helpBtn2: $('help-btn2'),
    help: $('help'), helpClose: $('help-close'),
    touch: $('touch'), toastEl: $('toast'), err: $('err'),
  };

  let flyCb = null, pauseToggleCb = null, quitCb = null, atcOptionCb = null;
  let lastHudT = 0;
  const toastQ = [];
  let toastBusy = false;
  let pausedShown = false;

  function show(elm) { if (elm) elm.classList.remove('hidden'); }
  function hide(elm) { if (elm) elm.classList.add('hidden'); }

  // ---- Loading ---------------------------------------------------------------
  function setLoading(p, label) {
    const pct = Math.min(100, Math.max(0, Math.round(p)));
    if (el.loadbar) el.loadbar.style.width = pct + '%';
    if (el.loadlabel) el.loadlabel.textContent = label || '';
    if (pct >= 100) setTimeout(() => hide(el.loading), 300);
  }

  // ---- Menu ------------------------------------------------------------------
  function showMenu() { show(el.menu); hide(el.loading); hide(el.hud); hide(el.pause); }
  function hideMenu() { hide(el.menu); }
  function onFly(cb) { flyCb = cb; }
  if (el.flyBtn) {
    el.flyBtn.addEventListener('click', () => {
      if (!flyCb) return;
      flyCb({
        airport: el.menuAirport ? el.menuAirport.value : 'KJFK',
        start: el.menuStart ? el.menuStart.value : 'gate',
        time: el.menuTime ? el.menuTime.value : 'day',
        weather: el.menuWeather ? el.menuWeather.value : 'live',
      });
    });
  }

  // ---- HUD -------------------------------------------------------------------
  function showHUD() { show(el.hud); }
  function hideHUD() { hide(el.hud); }

  function gearLabel(f) {
    const target = f.gearDown ? 1 : 0;
    const pos = f.gearPos ?? target;
    if (Math.abs(pos - target) > 0.03) return 'TRANSIT';
    return f.gearDown ? 'DN' : 'UP';
  }

  function pad3(n) { return String(Math.abs(Math.round(n)) % 360).padStart(3, '0'); }

  function updateHUD(fstate, controls) {
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    if (now - lastHudT < 100) return;   // throttle to 10 Hz
    lastHudT = now;
    if (!fstate) return;
    const set = (elm, v) => { if (elm) elm.textContent = v; };
    set(el.hudIas, Math.round(fstate.iasKt || 0));
    set(el.hudAlt, Math.round(fstate.altFtMSL || 0).toLocaleString('en-US'));
    set(el.hudHdg, pad3(fstate.heading || 0));
    const vs = Math.round(fstate.vsFpm || 0);
    set(el.hudVs, (vs > 0 ? '+' : '') + vs.toLocaleString('en-US'));
    const n1a = fstate.n1 ? (fstate.n1[0] + fstate.n1[1]) / 2 : 0;
    set(el.hudN1, Math.round(n1a * 100));
    const di = (fstate.flapDetent != null ? fstate.flapDetent : (controls ? controls.flaps : 0)) || 0;
    set(el.hudFlap, FLAP_LABELS[Math.min(8, Math.max(0, di))] || '0');
    set(el.hudGear, gearLabel(fstate));
    set(el.hudFuel, Math.round(fstate.fuelKg || 0).toLocaleString('en-US'));
  }

  function warn(text) {
    if (!el.hudWarn) return;
    el.hudWarn.textContent = text || '';
    el.hudWarn.classList.toggle('hidden', !text);
  }

  // ---- Toast -----------------------------------------------------------------
  function toast(msg) {
    if (!msg) return;
    toastQ.push(msg);
    if (!toastBusy) nextToast();
  }
  function nextToast() {
    const msg = toastQ.shift();
    if (!msg || !el.toastEl) { toastBusy = false; return; }
    toastBusy = true;
    el.toastEl.textContent = msg;
    el.toastEl.classList.add('show');
    setTimeout(() => {
      if (el.toastEl) el.toastEl.classList.remove('show');
      setTimeout(nextToast, 250);
    }, 2500);
  }

  // ---- ATC -------------------------------------------------------------------
  function showATC() { show(el.atc); }
  function hideATC() { hide(el.atc); }
  function toggleATC() { if (el.atc) el.atc.classList.toggle('hidden'); }
  if (el.atcToggle) el.atcToggle.addEventListener('click', toggleATC);

  function logATC(speaker, text) {
    if (!el.atcLog || !text) return;
    const s = speaker === 'tower' ? 'tower' : speaker === 'pilot' ? 'pilot' : 'sys';
    const div = document.createElement('div');
    div.className = 'atc-' + s;
    div.textContent = (s === 'tower' ? 'ATC: ' : s === 'pilot' ? 'YOU: ' : '') + text;
    el.atcLog.appendChild(div);
    while (el.atcLog.children.length > 60) el.atcLog.removeChild(el.atcLog.firstChild);
    el.atcLog.scrollTop = el.atcLog.scrollHeight;
  }

  function atcOptions(options) {
    if (!el.atcOptionsEl) return;
    el.atcOptionsEl.innerHTML = '';
    if (!options || !options.length) { hide(el.atcOptionsEl); return; }
    show(el.atcOptionsEl);
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      b.addEventListener('click', () => { if (atcOptionCb) atcOptionCb(o.id); });
      el.atcOptionsEl.appendChild(b);
    }
  }
  function onATCOption(cb) { atcOptionCb = cb; }

  // ---- Pause -----------------------------------------------------------------
  function showPause(b) {
    pausedShown = !!b;
    if (b) show(el.pause); else hide(el.pause);
  }
  function togglePause() {
    showPause(!pausedShown);
    if (pauseToggleCb) pauseToggleCb(pausedShown);
  }
  function onPauseToggle(cb) { pauseToggleCb = cb; }
  function onQuitToMenu(cb) { quitCb = cb; }
  if (el.resumeBtn) el.resumeBtn.addEventListener('click', togglePause);
  if (el.quitBtn) el.quitBtn.addEventListener('click', () => { showPause(false); if (quitCb) quitCb(); });

  // ---- Help ------------------------------------------------------------------
  function toggleHelp() { if (el.help) el.help.classList.toggle('hidden'); }
  if (el.helpClose) el.helpClose.addEventListener('click', () => hide(el.help));
  if (el.helpBtn2) el.helpBtn2.addEventListener('click', () => { showPause(false); show(el.help); });

  // ---- Touch visibility (input.js owns the wiring, ui owns visibility) -------
  function showTouch(b) { if (b) show(el.touch); else hide(el.touch); }

  // ---- Error overlay -----------------------------------------------------------
  function error(msg) {
    if (!el.err) return;
    el.err.textContent = msg;
    el.err.classList.remove('hidden');
  }

  return {
    setLoading, showMenu, hideMenu, onFly,
    showHUD, hideHUD, updateHUD, warn, toast,
    showATC, hideATC, toggleATC, logATC, atcOptions, onATCOption,
    showPause, togglePause, onPauseToggle, onQuitToMenu, toggleHelp,
    showTouch, error,
  };
}
