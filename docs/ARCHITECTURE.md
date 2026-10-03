# Flight Simulator — Architecture

Browser-based 3D flight simulator (Three.js, ES modules, no build step).
Single flyable aircraft: Southwest Boeing 737-800. Region: NYC metro (KJFK, KLGA, KEWR, KTEB).

## Coordinate frame

- Local tangent plane, ENU: **x = east, y = up, z = south** (north = −z). 1 unit = 1 meter.
- Origin: lat 40.7000, lon −74.0000 (near KJFK). See `js/core/geo.js`.
- All physics in double precision (JS numbers). Rendering only is float32.

## Module contracts

Each module is an ES module exporting a factory. `js/core/main.js` wires everything.

### `js/core/geo.js`
- `latLonToWorld(lat, lon, out: THREE.Vector3) -> {x, y, z}` (y=0)
- `worldToLatLon(x, z) -> {lat, lon}`
- `headingToVector(headingDeg) -> THREE.Vector3` (0=N, 90=E)
- `ORIGIN = { lat, lon }`, `EARTH_R = 6371000`
- `magneticDeclination(lat, lon)` — constant approx −13° for NYC metro (WMM approx)

### `js/core/config.js`
- `AIRPORTS`: filled by scenery research (see BUILD_SPEC). Shape per airport:
  `{ icao, name, lat, lon, elevationFt, runways: [{ id:'04L', headingTrue, lengthFt, widthFt, thresholdLat, thresholdLon, ils: bool }], towerFreq, groundFreq, atisFreq }`
- `AIRCRAFT`: 737-800 key numbers (weights, speeds, dimensions)
- `FEATURES`: flags (traffic on/off, atc voice on/off, etc.)

### `js/scenery/scenery.js` — `export function createScenery(scene)`
- Builds: terrain mesh (baked elevation + satellite texture), ocean/water, sky dome,
  airport ground detail (runways, taxiways, markings as geometry), terminals/towers (procedural),
  instanced 3D trees, Manhattan skyline boxes, runway/taxiway lights, approach light systems.
- `getGroundElevation(lat, lon) -> meters` (used by physics)
- `getAirport(icao)`, `update(dt, env)` (lighting, windsocks, beacons)
- Must not block first frame: heavy assets stream in with progress callback.

### `js/aircraft/boeing737.js` — `export function buildBoeing737()`
- Returns `{ group, parts }` where parts exposes animated nodes:
  `fanL, fanR` (rotate with N1), `gearNose, gearLeft, gearRight` (`setGear(0..1)` deploy),
  `wheelSpin` handled internally by ground speed, `flaps` (`setFlaps(deg)`),
  `spoilers`, `rudder`, `elevator`, `ailerons`, `thrustReverser`, `navLights`,
  `apuExhaust` particle hook, `wingFlex` subtle.
- Full Southwest livery (canvas-generated textures: canyon blue fuselage, red/orange/yellow tail motif).
- Detailed cockpit shell: glareshield, seats, sidewalls, windows with frames.
- `setExteriorDetail(level)` for perf scaling.

### `js/physics/flightModel.js` — `export function createFlightModel()`
- `state`: `{ pos: Vector3 (world m), vel: Vector3 (m/s), quat, massKg, fuelKg, n1: [0..1]x2, ... }`
- `step(state, controls, env, dt)` with fixed dt (called at 120 Hz):
  `controls = { pitch, roll, yaw (rates −1..1), throttle: [0..1]x2, flaps (0..1), gearDown: bool, brakes: 0..1, spoilers: 0..1, reversers: bool }`
  `env = { wind: Vector3, airDensity, groundElevM, runwayFriction }`
- Implements: lift/drag with flap+gear+spoiler+ground-effect, CFM56 thrust curves,
  stall with buffet + wing drop, ground roll steering/friction, touchdown detection,
  fuel burn. Emits `events` array per step: `['touchdown', ...]`, `['stall', ...]`, `['liftoff', ...]`.

### `js/cockpit/cockpit.js` — `export function buildCockpit(scene, camera)`
- Canvas-texture instrument panel: PFD (attitude, airspeed, altitude, HDG, VSI),
  ND (moving map w/ airports+runways), EICAS (N1, EGT, fuel, flaps, gear),
  standby instruments, MCP (HDG/ALT/VS/IAS selectors — functional autopilot-lite),
  throttle quadrant (drag), flap lever, gear lever, parking brake, yoke (moves with input).
- `update(dt, state, controls)` redraws at ≤20 Hz. Click/drag via raycast.
- Autopilot-lite: HDG hold, ALT hold, VS, autothrottle (speed hold).

### `js/systems/atc.js` — `export function createATC(ui, audio)`
- Scripted FAA phraseology state machine: ATIS → Clearance/Ground → Tower → Departure → Approach → Tower → Ground.
- `request(optionId)`; UI shows context-appropriate options; ATC speaks via TTS + text log.
- Tracks flight phase; issues instructions (taxiway, runway, squawk, vectors, altitudes).
- Simple compliance checking (e.g., warns if taking off without clearance).

### `js/systems/traffic.js` — `export function createTraffic(scene, scenery)`
- Scripted AI aircraft (simple procedural airliners) flying patterns/approaches at the 4 airports.
- `update(dt)`; TCAS-lite proximity callouts to UI.

### `js/systems/weather.js` — `export function createWeather()`
- Fetches live METAR (aviationweather.gov) for KJFK/KLGA/KEWR; parses wind/vis/ceiling/temp/altimeter.
- `getWindAt(pos)`, `getVisibilityM()`, `getConditions()`; graceful fallback to default VFR.
- `applyToScene(scene, dt)` — fog, cloud layers (procedural sprite puffs at reported ceiling), windsock.

### `js/systems/audio.js` — `export function createAudio()`
- Web Audio synthesized: CFM56 (N1-driven fan whine + rumble), wind, touchdown thud,
  gear/flap servos, GPWS-ish callouts ("FIFTY... THIRTY..."), stall warning, ATC TTS routing.
- `update(dt, state)`, master mute.

### `js/systems/input.js` — `export function createInput(canvas, ui)`
- Keyboard (arrows/WASD pitch-roll, throttle PgUp/PgDn, gear G, flaps F, brakes B, views V, ATC menu A),
  gamepad (standard mapping), touch (virtual yoke left, throttle slider right, buttons).
- `getControls()` → controls object for physics. Exposes `onAction(name)` events.

### `js/systems/ui.js` — `export function createUI()`
- Owns DOM: loading screen, main menu (airport/runway/weather/time select), HUD,
  ATC dialog panel + message log, pause menu, help overlay, mobile controls, FPS/perf toggle.
- `showMenu()`, `startFlight(config)`, `logATC(speaker, text)`, `toast(msg)`, `setLoading(pct, label)`.

### `js/core/main.js`
- Boot: loading → menu → flight loop. Fixed-step physics accumulator, render loop,
  camera director (cockpit / chase / tower / flyby), pause, resize, error overlay.

## Performance budget
- Target 60 fps on desktop, 30 on mobile. Instancing for trees/lights/buildings.
- Shadow: single directional, cockpit-only shadow camera, off on mobile.
- Pixel ratio capped at 2 (1.5 mobile).

## Shared flight state (`fstate`) and controls

Physics owns `fstate`. All angles in degrees, speeds as noted. `heading` is TRUE degrees.

```js
fstate = {
  pos: THREE.Vector3,      // world meters (x=east, y=up, z=south)
  vel: THREE.Vector3,      // m/s, world frame
  quat: THREE.Quaternion,  // body attitude
  heading, pitch, roll,    // deg, derived by physics each step (heading true)
  massKg, fuelKg,
  n1: [0..1, 0..1],        // fan speed per engine
  egtC: [c, c],            // exhaust gas temp per engine
  fuelFlowKgH: [x, x],
  flapDetent: 0..8,        // index into AIRCRAFT.flapDetents
  flapAngleDeg,
  gearDown: bool, gearPos: 0..1,   // gearPos animates toward gearDown
  spoilers: 0..1, speedbrakeArmed: bool, reversersDeployed: bool,
  brakes: 0..1, parkingBrake: bool,
  onGround: bool, aglM, iasKt, gsKt, altFtMSL, vsFpm,
  aoaDeg, stallWarn: bool, overspeed: bool,
  ap: { hdgSel: deg|null, altSelFt: ft|null, vsSelFpm, spdSelKt: kt|null,
        atArmed: bool, apEngaged: bool, fdOn: bool },
}
controls = {
  pitch: -1..1, roll: -1..1, yaw: -1..1,   // pilot stick/rudder
  throttle: [0..1, 0..1],
  flaps: 0..8,               // detent index
  gearDown: bool, brakes: 0..1, parkingBrake: bool,
  spoilers: 0..1, armSpoilers: bool, reversers: bool,
}
```
`input.getControls()` returns a fresh `controls` object each frame.
`cockpit.applyAutopilot(controls, fstate, dt)` mutates `controls` when AP/A-T engaged
(main.js calls it between input and physics).
`flightModel.step(state, controls, env, dt)` mutates state, returns events array:
`[{type:'touchdown', vs}, {type:'liftoff'}, {type:'stall'}, {type:'overspeed'}, {type:'gearWarn'}]`.
`env = { wind: THREE.Vector3 (m/s, world), airDensity, groundElevM, oatC }`.

## UI <-> ATC contract

`createUI()` returns:
- `setLoading(pct, label)`, `showMenu()`, `hideMenu()`, `showHUD()`, `hideHUD()`
- `showATC()`, `hideATC()`, `toggleATC()`, `showPause(bool)`, `togglePause()`, `toggleHelp()`
- `onFly(cb)` — cb receives `{airport, start, time, weather}`
- `onPauseToggle(cb)`, `onQuitToMenu(cb)`
- `updateHUD(fstate, controls)` — updates readouts; shows STALL/OVERSPEED via `warn(text)` (empty clears)
- `toast(msg)` — transient banner; `warn(text)` — big red center text
- `logATC(speaker, text)` — speaker in {'tower','pilot','sys'}; appends to ATC log
- `atcOptions(options)` — options = `[{id, label}]`; renders clickable buttons; empty array hides
- `onATCOption(cb)` — cb receives option id when user clicks

`createATC(ui, audio)` returns:
- `setAirport(icao, startMode)` — resets state machine for a new flight
- `update(dt, fstate)` — phase detection, timeouts, compliance checks
- internally calls `ui.logATC`, `ui.atcOptions`, `ui.onATCOption`, and `audio.speak(text, voice)`
- `audio.speak(text, voice)` — voice in {'atc','pilot'}; no-op if voice disabled

`createWeather()` returns:
- `refresh()` — async; fetches NWS observations for KJFK/KLGA/KEWR/KTEB (CORS-open), stores per-station
- `setMode(mode)` — 'live' | 'vfr' | 'windy' | 'ifr'
- `getEnv(pos)` — `{ wind: Vector3, airDensity, oatC }` (wind varies with altitude: surface -> 2x at 3000ft, backs 20deg)
- `getMetar(icao)` — parsed `{ windDirDeg, windKt, gustKt, visSM, ceilingFt, tempC, dewpC, altimInHg, fltCat, raw }`
- `applyToScene(scene, dt)` — fog/visibility, cloud layer sprites at ceiling, windsock handled by scenery

`createAudio()` returns:
- `unlock()` (user-gesture), `suspend()`, `resume()`
- `update(dt, fstate, controls, env)` — engine/wind loops
- `touchdown(vsFps)`, `speak(text, voice)` — TTS via speechSynthesis, queued
- `setMuted(bool)`

`createInput(canvas, ui)` returns:
- `getControls()` — merged keyboard+gamepad+touch
- `onAction(name, cb)` — names: 'view','atcPanel','pause','help','gear','flapsUp','flapsDown','brakesToggle'

`createTraffic(scene, scenery)` returns:
- `setHomeAirport(icao)`, `update(dt, playerState)` — scripted AI aircraft; TCAS callouts via ui.toast

## Baked terrain assets (`public/assets/`, produced by `tools/fetch_terrain.py`)

- `heightmap.png` — 1024×1024 RGB-encoded elevation. Decode: `v = (R<<16)|(G<<8)|B; elevM = v/100 - 100`. Covers bbox lat 40.3–41.1, lon −74.5–−73.5 (pixel (0,0) = NW corner 41.1N,−74.5W).
- `ground.jpg` — 2048×2048 Esri World Imagery composite of the same bbox. Attribution required (see README).
- `airport_KJFK.jpg` etc. — 1024×1024 high-res imagery per airport, centered on airport lat/lon, spanning ±0.018° lat/lon.
- `meta.json` — `{ bbox, airports: { KJFK: {lat, lon, spanDeg} } }` (written by the bake script).
