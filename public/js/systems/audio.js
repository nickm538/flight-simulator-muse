// Web Audio synthesized sound: CFM56 engine loops, wind, touchdown, servos,
// warnings, GPWS callouts, and ATC/pilot TTS routing. No audio assets.
import { CONFIG } from '../core/config.js';

const VIEW_ENGINE_GAIN = { cockpit: 0.32, chase: 1.0, tower: 0.85, flyby: 1.0 };
const VIEW_WIND_GAIN = { cockpit: 1.0, chase: 0.7, tower: 0.5, flyby: 0.7 };

export function createAudio() {
  let ctx = null;
  let master = null;
  let engineMaster = null;   // scaled by camera view
  let windGain = null;
  let windFilter = null;
  let windSrc = null;
  const engines = [null, null]; // per engine: { fanOsc, fanGain, rumbleSrc, rumbleFilter, rumbleGain }
  let noiseBuf = null;       // white noise (reused)
  let brownBuf = null;       // brown noise (reused)
  let stallOsc = null, stallGain = null, stallTimer = 0, stallOn = false;
  let ovspdOsc = null, ovspdGain = null, ovspdTimer = 0, ovspdHigh = false;
  let unlocked = false;
  let muted = false;
  let viewMode = 'cockpit';

  // Gear/flap servo one-shot tracking
  let prevGearPos = 1, prevFlapDetent = 0, lastServoAt = -10;

  // GPWS callout state
  const GPWS = [
    { ft: 50, word: 'fifty' },
    { ft: 30, word: 'thirty' },
    { ft: 20, word: 'twenty' },
    { ft: 10, word: 'ten' },
  ];
  const gpwsFired = new Set();

  // TTS queue
  const speechQ = [];
  let speaking = false;
  let speakTimes = [];

  function makeNoiseBuffer(brown) {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    return buf;
  }

  // Create the whole graph lazily on first unlock() / use.
  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
    } catch (e) { ctx = null; return false; }

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);

    noiseBuf = makeNoiseBuffer(false);
    brownBuf = makeNoiseBuffer(true);

    engineMaster = ctx.createGain();
    engineMaster.gain.value = VIEW_ENGINE_GAIN[viewMode] ?? 1.0;
    engineMaster.connect(master);

    for (let i = 0; i < 2; i++) {
      // Fan whine: sawtooth, freq follows N1
      const fanOsc = ctx.createOscillator();
      fanOsc.type = 'sawtooth';
      fanOsc.frequency.value = 60;
      const fanFilter = ctx.createBiquadFilter();
      fanFilter.type = 'lowpass';
      fanFilter.frequency.value = 2400;
      const fanGain = ctx.createGain();
      fanGain.gain.value = 0;
      fanOsc.connect(fanFilter); fanFilter.connect(fanGain); fanGain.connect(engineMaster);
      fanOsc.start();
      // Core rumble: looped brown noise through N1-driven lowpass
      const rumbleSrc = ctx.createBufferSource();
      rumbleSrc.buffer = brownBuf; rumbleSrc.loop = true;
      const rumbleFilter = ctx.createBiquadFilter();
      rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 120;
      const rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0;
      rumbleSrc.connect(rumbleFilter); rumbleFilter.connect(rumbleGain); rumbleGain.connect(engineMaster);
      rumbleSrc.start();
      engines[i] = { fanOsc, fanGain, rumbleFilter, rumbleGain };
    }

    // Wind: white noise -> bandpass, gain driven by IAS^2
    windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuf; windSrc.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass'; windFilter.frequency.value = 500; windFilter.Q.value = 0.6;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windFilter); windFilter.connect(windGain); windGain.connect(master);
    windSrc.start();

    // Stall warning: 800 Hz square, gated by timer in update()
    stallOsc = ctx.createOscillator(); stallOsc.type = 'square'; stallOsc.frequency.value = 800;
    stallGain = ctx.createGain(); stallGain.gain.value = 0;
    stallOsc.connect(stallGain); stallGain.connect(master); stallOsc.start();

    // Overspeed: single osc, freq alternated 900/700 Hz in update()
    ovspdOsc = ctx.createOscillator(); ovspdOsc.type = 'square'; ovspdOsc.frequency.value = 900;
    ovspdGain = ctx.createGain(); ovspdGain.gain.value = 0;
    ovspdOsc.connect(ovspdGain); ovspdGain.connect(master); ovspdOsc.start();

    return true;
  }

  function ramp(param, v, tau = 0.08) {
    try { param.setTargetAtTime(v, ctx.currentTime, tau); } catch (e) { /* ignore */ }
  }

  function unlock() {
    if (!ensure()) return;
    unlocked = true;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // One-time gesture listeners so the first tap/click/keypress unlocks audio.
  if (typeof window !== 'undefined') {
    const auto = () => { unlock(); };
    window.addEventListener('pointerdown', auto, { once: true, passive: true });
    window.addEventListener('keydown', auto, { once: true });
    window.addEventListener('touchstart', auto, { once: true, passive: true });
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }
  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }

  function setMuted(b) {
    muted = !!b;
    if (ctx && master) ramp(master.gain, muted ? 0 : 1, 0.05);
  }

  function setView(v) {
    viewMode = v || 'cockpit';
    if (ctx && engineMaster) {
      ramp(engineMaster.gain, VIEW_ENGINE_GAIN[viewMode] ?? 1.0, 0.3);
    }
  }

  // ---- One-shots -----------------------------------------------------------

  function touchdown(vsFpm) {
    if (!unlocked || !ensure()) return;
    const t = ctx.currentTime;
    const intensity = Math.min(1, Math.max(0.15, Math.abs(vsFpm || 0) / 800));
    // Noise burst
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55 * intensity, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(lp); lp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 0.5);
    // 70 Hz gear thump
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 70;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5 * intensity, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(og); og.connect(master);
    osc.start(t); osc.stop(t + 0.4);
  }

  // 2 s filtered servo sweep: gear = low growl, flap = higher whir.
  function servoSweep(kind) {
    if (!unlocked || !ensure()) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
    const g = ctx.createGain();
    if (kind === 'gear') { osc.frequency.setValueAtTime(170, t); osc.frequency.exponentialRampToValueAtTime(85, t + 2); bp.frequency.value = 300; }
    else { osc.frequency.setValueAtTime(620, t); osc.frequency.exponentialRampToValueAtTime(280, t + 2); bp.frequency.value = 900; }
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.15);
    g.gain.setValueAtTime(0.12, t + 1.7);
    g.gain.linearRampToValueAtTime(0.0, t + 2.0);
    osc.connect(bp); bp.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + 2.05);
  }

  // AP disconnect: two-tone "cavalry charge" (880 -> 660 Hz).
  function apDisconnect() {
    if (!unlocked || !ensure()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = 880;
      const g = ctx.createGain();
      const s = t + i * 0.28;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.25, s + 0.03);
      g.gain.setValueAtTime(0.25, s + 0.22);
      g.gain.linearRampToValueAtTime(0, s + 0.26);
      osc.connect(g); g.connect(master);
      osc.start(s); osc.stop(s + 0.3);
    }
  }

  // ---- TTS -----------------------------------------------------------------

  function pickVoice() {
    try {
      const vs = window.speechSynthesis.getVoices();
      if (vs && vs.length) {
        const en = vs.find(v => /^en/i.test(v.lang)) || vs[0];
        return en;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function pumpSpeech() {
    if (speaking || !speechQ.length) return;
    if (!('speechSynthesis' in window)) { speechQ.length = 0; return; }
    speaking = true;
    const { text, voice } = speechQ.shift();
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.pitch = voice === 'atc' ? 0.7 : 1.0;
      u.rate = voice === 'atc' ? 1.05 : 1.0;
      u.onend = u.onerror = () => { speaking = false; pumpSpeech(); };
      window.speechSynthesis.speak(u);
      // Safety: if onend never fires, recover after 20 s.
      setTimeout(() => { if (speaking) { speaking = false; pumpSpeech(); } }, 20000);
    } catch (e) { speaking = false; pumpSpeech(); }
  }

  function speak(text, voice) {
    if (!CONFIG.features.atcVoice) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (!text) return;
    const now = Date.now();
    speakTimes = speakTimes.filter(t => now - t < 3000);
    speakTimes.push(now);
    if (speakTimes.length > 6) {
      // Spam: cancel everything, keep only the latest message.
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      speechQ.length = 0;
      speaking = false;
      speakTimes = [now];
    }
    if (speechQ.length >= 8) speechQ.shift(); // drop oldest
    speechQ.push({ text, voice: voice === 'atc' ? 'atc' : 'pilot' });
    pumpSpeech();
  }

  // ---- Per-frame loops -----------------------------------------------------

  function update(dt, fstate, controls, env) {
    if (!unlocked || !ctx) return;
    if (!fstate) return;
    const t = Math.min(Math.max(dt || 0.016, 0), 0.1);

    // Engine loops: fan whine + core rumble follow N1 per engine.
    for (let i = 0; i < 2; i++) {
      const e = engines[i];
      if (!e) continue;
      const n1 = Math.min(1, Math.max(0, (fstate.n1 && fstate.n1[i]) || 0));
      ramp(e.fanOsc.frequency, 60 + n1 * 380, 0.06);
      ramp(e.fanGain.gain, 0.012 + n1 * 0.085, 0.06);
      ramp(e.rumbleFilter.frequency, 120 + n1 * 400, 0.1);
      ramp(e.rumbleGain.gain, 0.02 + n1 * 0.11, 0.08);
    }

    // Wind: gain ∝ IAS², silent below 60 kt.
    const ias = fstate.iasKt || 0;
    const wg = ias < 60 ? 0 : Math.pow((ias - 60) / 220, 2);
    ramp(windGain.gain, Math.min(1, wg) * 0.45 * (VIEW_WIND_GAIN[viewMode] ?? 1), 0.15);
    ramp(windFilter.frequency, 350 + ias * 3.2, 0.15);

    // Stall warning: repeating 800 Hz square beep (~2.5 Hz gate).
    if (fstate.stallWarn) {
      stallTimer += t;
      if (stallTimer > 0.2) { stallTimer = 0; stallOn = !stallOn; ramp(stallGain.gain, stallOn ? 0.22 : 0, 0.01); }
    } else if (stallOn || stallGain.gain.value > 0.001) {
      stallOn = false; stallTimer = 0; ramp(stallGain.gain, 0, 0.02);
    }

    // Overspeed: alternating 900/700 Hz clacker.
    if (fstate.overspeed) {
      ovspdTimer += t;
      if (ovspdTimer > 0.25) {
        ovspdTimer = 0; ovspdHigh = !ovspdHigh;
        ramp(ovspdOsc.frequency, ovspdHigh ? 900 : 700, 0.01);
        ramp(ovspdGain.gain, 0.16, 0.01);
      }
    } else if (ovspdGain.gain.value > 0.001) {
      ovspdTimer = 0; ramp(ovspdGain.gain, 0, 0.05);
    }

    // Gear / flap servo sweeps: trigger when gearPos or flapDetent changes.
    const gp = fstate.gearPos ?? 1;
    const fd = fstate.flapDetent ?? 0;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const gearMoved = Math.abs(gp - prevGearPos) > 0.002;
    const flapMoved = fd !== prevFlapDetent;
    if ((gearMoved || flapMoved) && now - lastServoAt > 2.2) {
      lastServoAt = now;
      servoSweep(gearMoved ? 'gear' : 'flap');
    }
    prevGearPos = gp; prevFlapDetent = fd;

    // GPWS altitude callouts: 50/30/20/10 ft RA, descending, gear down, airborne.
    const aglM = fstate.aglM ?? 0;
    const raFt = aglM * 3.28084;
    if (raFt > 220 || (fstate.vsFpm || 0) > 100) gpwsFired.clear();
    if (!fstate.onGround && fstate.gearDown && (fstate.vsFpm || 0) < -50) {
      for (const c of GPWS) {
        if (raFt <= c.ft && !gpwsFired.has(c.ft)) {
          gpwsFired.add(c.ft);
          speak(c.word, 'pilot');
        }
      }
    }
  }

  return { unlock, suspend, resume, setMuted, setView, update, touchdown, speak, apDisconnect };
}
