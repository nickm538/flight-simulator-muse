// Scripted FAA-style ATC state machine for the NYC metro flight sim.
// Callsign: Southwest 1472 (telephony "Southwest"), shortened to "Southwest 72"
// after initial contact on each frequency. Follows docs phraseology research:
// ATIS -> Clearance Delivery -> Ground -> Tower -> Departure -> Approach ->
// Tower -> Ground, with readback gates, compliance checks and go-arounds.
import * as THREE from 'three';
import { AIRPORTS } from '../core/config.js';
import { latLonToWorld, headingToVector } from '../core/geo.js';
import { FT_TO_M, NM_TO_M } from '../core/geo.js';

const DEG = Math.PI / 180;
const ACTIVE_RWY = { KJFK: '13L', KLGA: '4', KEWR: '4R', KTEB: '19' };
const FAC_NAME = { KJFK: 'Kennedy', KLGA: 'LaGuardia', KEWR: 'Newark', KTEB: 'Teterboro' };
const SQUAWK = { KJFK: '4521', KLGA: '3215', KEWR: '2143', KTEB: '5672' };
const GATE = { KJFK: 'B12', KLGA: 'C7', KEWR: 'A14', KTEB: 'A1' };
const MAG_VAR = 13; // VAR 13W metro-wide: magnetic = true + 13

// Expand digits for TTS so "1472" is read as individual digits.
function toSpoken(t) {
  return String(t)
    .replace(/\./g, ' point ')
    .replace(/(\d)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}
function zulu() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCHours()) + p(d.getUTCMinutes());
}
const trimNum = (v) => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const magDeg = (trueDeg) => Math.round((trueDeg + MAG_VAR) % 360);

export function createATC(ui, audio) {
  let S = null;
  let weatherProvider = null;

  function say(text, voice) {
    const speaker = voice === 'atc' ? 'tower' : 'pilot';
    try { ui.logATC(speaker, text); } catch (e) { /* log is best-effort */ }
    try { if (audio && audio.speak) audio.speak(toSpoken(text), voice); } catch (e) { /* tts optional */ }
  }
  function sys(text) { try { ui.logATC('sys', text); } catch (e) {} }
  function setOpts(opts) { try { ui.atcOptions(opts || []); } catch (e) {} }

  // First call-up on a frequency uses the full callsign; afterwards shortened.
  function contact(fac) {
    const first = !S.contacted.has(fac);
    S.contacted.add(fac);
    return first ? S.csFull : S.csShort;
  }

  function metar() {
    try { return weatherProvider ? weatherProvider.getMetar(S.icao) : null; }
    catch (e) { return null; }
  }
  function windPhrase() {
    const m = metar();
    if (m && m.windDirDeg != null && (m.windKt || 0) >= 3) {
      const wd = Math.round(magDeg(m.windDirDeg) / 10) * 10 % 360;
      const wds = wd === 0 ? '360' : String(wd).padStart(3, '0');
      return `wind ${wds} at ${Math.round(m.windKt)}`;
    }
    return 'wind calm';
  }

  function atisText() {
    const m = metar();
    const L = S.atisLetter;
    let body;
    if (m) {
      const wd = m.windDirDeg != null ? String(Math.round(magDeg(m.windDirDeg) / 10) * 10 % 360 || 360).padStart(3, '0') : '000';
      const ws = Math.round(m.windKt || 0);
      const gs = m.gustKt ? `, gust ${Math.round(m.gustKt)}` : '';
      const cig = m.ceilingFt != null ? `Ceiling ${Math.round(m.ceilingFt / 100) * 100} overcast. ` : '';
      const alti = m.altimInHg != null ? String(Math.round(m.altimInHg * 100)) : '2998';
      body = `Wind ${wd} at ${ws}${gs}, visibility ${trimNum(m.visSM != null ? m.visSM : 10)}, ${cig}` +
        `Temperature ${Math.round(m.tempC != null ? m.tempC : 20)}, dewpoint ${Math.round(m.dewpC != null ? m.dewpC : 10)}. Altimeter ${alti}.`;
    } else {
      body = 'Wind calm, visibility 10, sky clear. Temperature 20, dewpoint 8. Altimeter 2998.';
    }
    return `${S.fac} Information ${L}, ${zulu()} Zulu. ${body} ` +
      `ILS Runway ${S.rwy.id} approaches in use, departing Runway ${S.rwy.id}. ` +
      `Advise on initial contact you have Information ${L}.`;
  }

  // ---- runway-relative geometry ----
  const _thr = new THREE.Vector3();
  const _hv = new THREE.Vector3();
  function relToThreshold(pos) {
    latLonToWorld(S.rwy.thresholdLat, S.rwy.thresholdLon, _thr);
    headingToVector(S.rwy.headingTrue, _hv);
    const dx = pos.x - _thr.x, dz = pos.z - _thr.z;
    const along = dx * _hv.x + dz * _hv.z;
    const th = S.rwy.headingTrue * DEG;
    const lat = dx * Math.cos(th) + dz * Math.sin(th); // + right of centerline
    return { along, lat, distM: Math.hypot(dx, dz) };
  }
  function onRunway(pos) {
    const { along, lat } = relToThreshold(pos);
    const lenM = S.rwy.lengthFt * FT_TO_M;
    const halfW = (S.rwy.widthFt * FT_TO_M) / 2 + 12;
    return along > -30 && along < lenM + 30 && Math.abs(lat) < halfW;
  }

  // =====================================================================
  function setAirport(icao, startMode) {
    const ap = AIRPORTS[icao] || AIRPORTS.KJFK;
    const rwyId = ACTIVE_RWY[ap.icao] || ap.icao;
    const rwy = ap.runways.find((r) => r.id === rwyId) || ap.runways[0];
    const fac = FAC_NAME[ap.icao] || ap.icao;
    S = {
      icao: ap.icao, ap, rwy, fac,
      dest: fac,
      csFull: 'Southwest 1472', csShort: 'Southwest 72',
      atisLetter: 'A',
      squawk: SQUAWK[ap.icao] || '4521',
      gate: GATE[ap.icao] || 'B12',
      atisFreq: ap.atisFreq, deliveryFreq: ap.deliveryFreq, groundFreq: ap.groundFreq,
      towerFreq: ap.towerFreq, depFreq: ap.departureFreq, appFreq: ap.approachFreq,
      phase: 'PREFLIGHT',
      contacted: new Set(),
      clearedTakeoff: false, clearedLand: false,
      warned: {},
      parkT: 0, stopT: 0, finalAnnounced: false,
      wasAirborne: startMode === 'air',
    };

    sys(`ATC online — ${ap.name} (${ap.icao}). Active runway ${rwy.id}.`);
    if (startMode === 'runway') {
      S.phase = 'TOWER_REQ';
      sys(`Positioned holding short of Runway ${rwy.id}. Call the tower when ready.`);
      setOpts([{ id: 'req_takeoff', label: `Call tower — ready for departure (${rwy.id})` }]);
    } else if (startMode === 'air') {
      S.phase = 'APPROACH_HANDOFF';
      S.clearedTakeoff = true;
      sys('Airborne, 5,000 ft, 10 nm from the airport. Contact approach for the ILS.');
      setOpts([{ id: 'contact_approach', label: `Contact New York Approach (${S.appFreq})` }]);
    } else {
      S.phase = 'PREFLIGHT';
      sys(`Southwest 1472 at Gate ${S.gate}. Listen to ATIS, then call clearance delivery.`);
      setOpts([
        { id: 'atis', label: `Listen to ATIS (${S.atisFreq})` },
        { id: 'req_clearance', label: 'Request IFR clearance' },
      ]);
    }
  }

  function setWeatherProvider(wp) { weatherProvider = wp || null; }
  function getPhase() { return S ? S.phase : 'IDLE'; }

  // =====================================================================
  // Dialogue
  function handleOption(id) {
    if (!S) return;
    const F = S.fac, R = S.rwy.id;

    switch (id) {
      // ---- PREFLIGHT ----
      case 'atis': {
        sys(`— ATIS ${S.atisFreq} —`);
        say(atisText(), 'atc');
        break;
      }
      case 'req_clearance': {
        const c = contact('delivery');
        say(`${F} Delivery, ${c}, with Information ${S.atisLetter}, request IFR clearance to ${S.dest}.`, 'pilot');
        say(`${c}, ${F} Delivery, cleared to ${S.dest} airport as filed, maintain 3000, ` +
          `expect 5000 one zero minutes after departure, departure frequency ${S.depFreq}, squawk ${S.squawk}.`, 'atc');
        S.phase = 'CLEARANCE_READBACK';
        setOpts([{ id: 'readback_clearance', label: 'Read back clearance' }]);
        break;
      }
      case 'readback_clearance': {
        const c = contact('delivery');
        say(`Cleared to ${S.dest} as filed, maintain 3000, expect 5000, departure ${S.depFreq}, squawk ${S.squawk}, ${c}.`, 'pilot');
        say(`${S.csShort}, readback correct.`, 'atc');
        S.phase = 'GROUND';
        setOpts([{ id: 'req_taxi', label: 'Request taxi' }]);
        break;
      }

      // ---- GROUND ----
      case 'req_taxi': {
        const c = contact('ground');
        say(`${F} Ground, ${c}, ready to taxi, Information ${S.atisLetter}.`, 'pilot');
        say(`${c}, ${F} Ground, taxi to Runway ${R} via Alfa, hold short of Runway ${R}.`, 'atc');
        S.phase = 'TAXI_READBACK';
        setOpts([{ id: 'readback_taxi', label: 'Read back taxi instructions' }]);
        break;
      }
      case 'readback_taxi': {
        const c = contact('ground');
        say(`Taxi to Runway ${R} via Alfa, hold short of Runway ${R}, ${c}.`, 'pilot');
        say(`${S.csShort}, readback correct.`, 'atc');
        S.phase = 'TAXIING';
        setOpts([]);
        sys('Taxi to the runway — hold short until the tower clears you.');
        break;
      }

      // ---- TOWER: takeoff ----
      case 'req_takeoff': {
        const c = contact('tower');
        say(`${F} Tower, ${c}, holding short of Runway ${R}, ready for departure.`, 'pilot');
        say(`${c}, ${F} Tower, Runway ${R}, cleared for takeoff.`, 'atc');
        S.phase = 'TAKEOFF_READBACK';
        setOpts([{ id: 'readback_takeoff', label: 'Read back takeoff clearance' }]);
        break;
      }
      case 'readback_takeoff': {
        const c = contact('tower');
        say(`Runway ${R}, cleared for takeoff, ${c}.`, 'pilot');
        S.clearedTakeoff = true;
        S.phase = 'TAKEOFF_CLEAR';
        setOpts([]);
        sys('Cleared for takeoff — advance the throttles and rotate at Vr.');
        break;
      }

      // ---- DEPARTURE ----
      case 'contact_departure': {
        const c = contact('departure');
        say(`New York Departure on ${S.depFreq}, ${S.csShort}.`, 'pilot');
        const alt = S.lastAltFt != null ? Math.round(S.lastAltFt / 100) * 100 : 1500;
        say(`New York Departure, ${c}, passing ${alt}, climbing 5000.`, 'pilot');
        say(`${c}, New York Departure, radar contact 3 miles southwest of ${F}, ` +
          `fly runway heading, climb and maintain 5000.`, 'atc');
        S.phase = 'DEPARTURE_READBACK';
        setOpts([{ id: 'readback_departure', label: 'Read back climb instruction' }]);
        break;
      }
      case 'readback_departure': {
        const c = contact('departure');
        say(`Runway heading, 5000, ${c}.`, 'pilot');
        say(`${S.csShort}, frequency change approved.`, 'atc');
        S.phase = 'ENROUTE';
        setOpts([
          { id: 'req_descent', label: 'Request descent' },
          { id: 'req_ils', label: 'Request ILS approach' },
        ]);
        break;
      }
      case 'req_descent': {
        const c = contact('departure');
        say(`New York Departure, ${c}, request descent.`, 'pilot');
        say(`${c}, descend and maintain 3000.`, 'atc');
        S.phase = 'ENROUTE_DESCENT';
        setOpts([{ id: 'readback_descent', label: 'Read back descent' }]);
        break;
      }
      case 'readback_descent': {
        const c = contact('departure');
        say(`Down to 3000, ${c}.`, 'pilot');
        S.phase = 'ENROUTE';
        setOpts([
          { id: 'req_descent', label: 'Request descent' },
          { id: 'req_ils', label: 'Request ILS approach' },
        ]);
        break;
      }
      case 'req_ils': {
        const c = contact('departure');
        say(`New York Departure, ${c}, request ILS approach Runway ${R}.`, 'pilot');
        say(`${c}, contact New York Approach on ${S.appFreq}.`, 'atc');
        S.phase = 'APPROACH_HANDOFF';
        setOpts([{ id: 'contact_approach', label: `Contact New York Approach (${S.appFreq})` }]);
        break;
      }

      // ---- APPROACH ----
      case 'contact_approach': {
        const c = contact('approach');
        say(`New York Approach, ${c}, with Information ${S.atisLetter}, request ILS approach Runway ${R}.`, 'pilot');
        say(`${c}, New York Approach, descend and maintain 3000, expect ILS Runway ${R} approach.`, 'atc');
        S.phase = 'APPROACH_READBACK1';
        setOpts([{ id: 'readback_approach1', label: 'Read back' }]);
        break;
      }
      case 'readback_approach1': {
        const c = contact('approach');
        say(`Down to 3000, expect ILS Runway ${R}, ${c}.`, 'pilot');
        const vecHdg = magDeg(S.rwy.headingTrue);
        const vec = vecHdg <= 180 ? vecHdg + 30 : vecHdg - 30;
        const side = vecHdg <= 180 ? 'right' : 'left';
        S.vecHdg = vec;
        say(`${S.csShort}, turn ${side} heading ${vec}, maintain 3000 until established ` +
          `on the localizer, cleared ILS Runway ${R} approach.`, 'atc');
        S.phase = 'APPROACH_READBACK2';
        setOpts([{ id: 'readback_approach2', label: 'Read back approach clearance' }]);
        break;
      }
      case 'readback_approach2': {
        const c = contact('approach');
        say(`${S.vecHdg} heading, 3000 until established, cleared ILS Runway ${R} approach, ${c}.`, 'pilot');
        say(`${S.csShort}, contact ${F} Tower on ${S.towerFreq}.`, 'atc');
        S.phase = 'TOWER_HANDOFF';
        setOpts([{ id: 'contact_tower', label: `Contact ${F} Tower (${S.towerFreq})` }]);
        break;
      }

      // ---- TOWER: landing ----
      case 'contact_tower': {
        const c = contact('tower');
        say(`${F} Tower, ${c}, ILS Runway ${R}.`, 'pilot');
        S.phase = 'TOWER_LAND';
        S.finalAnnounced = false;
        setOpts([{ id: 'report_final', label: 'Report established on final' }]);
        break;
      }
      case 'report_final': {
        doReportFinal();
        break;
      }
      case 'readback_landing': {
        const c = contact('tower');
        say(`Runway ${R}, cleared to land, ${c}.`, 'pilot');
        S.clearedLand = true;
        S.phase = 'CLEARED_TO_LAND';
        setOpts([{ id: 'go_around', label: 'Execute missed approach (go around)' }]);
        break;
      }
      case 'go_around': {
        const c = contact('tower');
        say(`${F} Tower, ${c}, executing missed approach.`, 'pilot');
        missedApproach('pilot');
        break;
      }

      // ---- GROUND: taxi in ----
      case 'contact_ground': {
        const c = contact('ground');
        say(`${F} Ground, ${c}, clear of Runway ${R}, request taxi to the gate.`, 'pilot');
        say(`${c}, ${F} Ground, taxi to Gate ${S.gate} via Alfa.`, 'atc');
        S.phase = 'TAXI_IN_READBACK';
        setOpts([{ id: 'readback_gate', label: 'Read back taxi to gate' }]);
        break;
      }
      case 'readback_gate': {
        const c = contact('ground');
        say(`Taxi to Gate ${S.gate} via Alfa, ${c}.`, 'pilot');
        say(`${S.csShort}, readback correct.`, 'atc');
        S.phase = 'TAXI_IN';
        S.parkT = 0;
        setOpts([]);
        sys(`Taxi to Gate ${S.gate}. Set the parking brake at the gate.`);
        break;
      }

      default:
        break;
    }
  }

  function doReportFinal() {
    if (!S || S.finalAnnounced) return;
    S.finalAnnounced = true;
    const c = contact('tower');
    say(`${S.fac} Tower, ${c}, established ILS Runway ${S.rwy.id}.`, 'pilot');
    say(`${c}, ${S.fac} Tower, ${windPhrase()}, Runway ${S.rwy.id}, cleared to land.`, 'atc');
    S.phase = 'LAND_CLEAR_READBACK';
    setOpts([{ id: 'readback_landing', label: 'Read back landing clearance' }]);
  }

  function missedApproach(initiator) {
    const F = S.fac, R = S.rwy.id;
    if (initiator === 'atc') {
      say(`${S.csFull}, ${F} Tower, go around! You were not cleared to land. ` +
        `Climb and maintain 3000, fly runway heading, contact New York Departure on ${S.depFreq}.`, 'atc');
    } else {
      say(`${S.csFull}, ${F} Tower, climb and maintain 3000, fly runway heading, ` +
        `contact New York Departure on ${S.depFreq}.`, 'atc');
    }
    S.clearedLand = false;
    S.phase = 'ENROUTE';
    setOpts([
      { id: 'req_descent', label: 'Request descent' },
      { id: 'req_ils', label: 'Request ILS approach' },
    ]);
    sys('Missed approach — climb straight ahead to 3000, then re-sequence with approach.');
  }

  function takeoffDeviation() {
    if (S.warned.takeoff) return;
    S.warned.takeoff = true;
    say(`${S.csFull}, hold position! You were not cleared for takeoff.`, 'atc');
    sys('Pilot deviation — takeoff without clearance. (The sim lets you continue.)');
  }

  // =====================================================================
  function update(dt, fstate) {
    if (!S || !fstate || !fstate.pos) return;
    S.lastAltFt = fstate.altFtMSL;
    const gs = fstate.gsKt || 0;
    const onGround = !!fstate.onGround;
    const airborne = !onGround;
    const touchedDown = onGround && S.wasAirborne;
    const { distM } = relToThreshold(fstate.pos);
    const distNm = distM / NM_TO_M;
    const rwy = onRunway(fstate.pos);

    // Takeoff roll without clearance (any pre-takeoff phase).
    if (!S.clearedTakeoff && onGround && rwy && gs > 45 &&
        ['TAXIING', 'TOWER_REQ', 'TAKEOFF_READBACK', 'PREFLIGHT', 'GROUND', 'TAXI_READBACK'].includes(S.phase)) {
      takeoffDeviation();
    }

    switch (S.phase) {
      case 'TAXIING': {
        if (!S.warned.speed && onGround && gs > 25) {
          S.warned.speed = true;
          sys(`${S.csShort}, taxi speed — 25 knots or less.`);
        }
        if (!S.warned.rwy && rwy && gs > 8 && !S.clearedTakeoff) {
          S.warned.rwy = true;
          say(`${S.csFull}, ${S.fac} Tower, hold short of Runway ${S.rwy.id}! You are on an active runway.`, 'atc');
        }
        if (distM < 260 && onGround && !rwy) {
          S.phase = 'TOWER_REQ';
          setOpts([{ id: 'req_takeoff', label: `Call tower — ready for departure (${S.rwy.id})` }]);
          sys(`Holding short of Runway ${S.rwy.id}.`);
        }
        break;
      }

      case 'TOWER_REQ':
      case 'TAKEOFF_READBACK': {
        // Rolled without clearance and lifted off anyway -> hand off with a note.
        if (airborne) {
          sys('Airborne without takeoff clearance — deviation noted.');
          towerHandoffDeparture();
        }
        break;
      }

      case 'TAKEOFF_CLEAR': {
        if (airborne) towerHandoffDeparture();
        break;
      }

      case 'APPROACH_HANDOFF':
      case 'APPROACH_READBACK1':
      case 'APPROACH_READBACK2':
      case 'TOWER_HANDOFF':
      case 'LAND_CLEAR_READBACK':
      case 'TOWER_LAND': {
        if (S.phase === 'TOWER_LAND' && !S.finalAnnounced && distNm < 8) doReportFinal();
        if (onGround && !S.clearedLand) missedApproach('atc'); // touched down with no landing clearance
        break;
      }

      case 'CLEARED_TO_LAND': {
        if (onGround) {
          S.phase = 'LANDING_ROLL';
          setOpts([]);
          sys('Landed — slow to taxi speed, then expect ground.');
        }
        break;
      }

      case 'LANDING_ROLL': {
        if (onGround && gs < 40) {
          say(`${S.csShort}, contact ${S.fac} Ground on ${S.groundFreq}.`, 'atc');
          S.phase = 'GROUND_HANDOFF';
          setOpts([{ id: 'contact_ground', label: `Contact ${S.fac} Ground (${S.groundFreq})` }]);
        }
        break;
      }

      case 'ENROUTE':
      case 'ENROUTE_DESCENT': {
        // Touchdown with no landing clearance (e.g. after a go-around): call it once.
        if (touchedDown && !S.clearedLand && !S.warned.ga2) {
          S.warned.ga2 = true;
          missedApproach('atc');
          break;
        }
        // Landed without any clearance and came to a stop: recover to taxi-in.
        if (onGround && gs < 5) {
          S.stopT += dt;
          if (S.stopT > 5) {
            S.stopT = 0;
            S.phase = 'GROUND_IN';
            sys('Aircraft stopped — contact ground for taxi to the gate.');
            setOpts([{ id: 'contact_ground', label: `Contact ${S.fac} Ground (${S.groundFreq})` }]);
          }
        } else {
          S.stopT = 0;
        }
        break;
      }

      case 'GROUND_IN': {
        // Option reused: pilot reports clear and requests taxi to gate.
        break;
      }

      case 'TAXI_IN': {
        if (onGround && (gs < 3 || fstate.parkingBrake)) {
          S.parkT += dt;
          if (S.parkT > 8) {
            S.phase = 'PARKED';
            setOpts([]);
            say(`${S.csShort}, ${S.fac} Ground. Welcome to ${S.dest} — chocks set, flight complete.`, 'atc');
            sys('Flight complete. Nice work, Captain.');
          }
        } else {
          S.parkT = 0;
        }
        break;
      }

      default:
        break;
    }
    S.wasAirborne = airborne;
  }

  function towerHandoffDeparture() {
    say(`${S.csShort}, contact New York Departure on ${S.depFreq}.`, 'atc');
    S.phase = 'DEPARTURE_HANDOFF';
    setOpts([{ id: 'contact_departure', label: `Contact New York Departure (${S.depFreq})` }]);
  }

  try { ui.onATCOption(handleOption); } catch (e) { /* ui contract */ }

  return { setAirport, setWeatherProvider, update, getPhase };
}
