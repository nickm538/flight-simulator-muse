# ✈ Muse Flight Simulator

A browser-based 3D flight simulator: fly a **Southwest Boeing 737-800** around the
**New York City metro area** (KJFK, KLGA, KEWR, KTEB) with real runway data,
scripted FAA-style ATC, live METAR weather, and a full cockpit.

## Play

- **Live:** hosted on Railway (link in repo description once deployed)
- **Local:** serve `public/` over HTTP (ES modules require it):
  `cd public && python3 -m http.server 8080` → http://localhost:8080

No build step. Three.js r160 is vendored in `public/vendor/`.

## Controls

| Action | Keys |
|---|---|
| Pitch / Roll | ↑ ↓ ← → or W A S D |
| Rudder | Q / E |
| Throttle | PgUp / PgDn |
| Flaps | F extend · Shift+F retract |
| Gear | G |
| Brakes | B (hold) |
| Spoilers | / (Shift+/ arm) |
| Views | V (cockpit / chase / tower / flyby) |
| ATC radio menu | A |
| Autopilot | 1 engage · 2 HDG · 3 ALT · 4 A/T |
| Pause / Help | P or Esc / H |

Gamepad (standard mapping) and touch controls (virtual stick + throttle) are supported.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module contracts and the
shared flight-state model. Research backing the sim lives in `docs/research/`.

- `public/js/core/` — bootstrap, geo math, config (FAA runway data)
- `public/js/scenery/` — NYC terrain, airports, sky, lighting
- `public/js/aircraft/` — procedural Southwest 737-800
- `public/js/physics/` — flight model (lift/drag/thrust/ground effect/stall)
- `public/js/cockpit/` — PFD/ND/EICAS, MCP, throttle quadrant, AP-lite
- `public/js/systems/` — ATC, AI traffic, weather, audio, input, UI
- `tools/fetch_terrain.py` — build-time terrain/imagery bake

## Data & attribution

- Terrain: USGS 3DEP/GMTED2010/SRTM via AWS Terrain Tiles (public dataset)
- Imagery: Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community
- Runways: FAA 5010 via airnav.com · ATC phraseology per FAA JO 7110.65
- Weather: NWS api.weather.gov observations (no key required)

## Deploy (Railway)

`Dockerfile` serves `public/` with nginx on port 8080. Push to `main` and
Railway auto-deploys. No secret keys required — weather uses the keyless NWS API.
