// Geographic utilities: WGS84 <-> local ENU world frame.
// World frame: x = east, y = up, z = south (north = -z). 1 unit = 1 meter.

export const EARTH_R = 6371000; // meters
export const ORIGIN = { lat: 40.7000, lon: -74.0000 }; // near KJFK

const DEG = Math.PI / 180;

export function latLonToWorld(lat, lon, out) {
  const dLat = (lat - ORIGIN.lat) * DEG;
  const dLon = (lon - ORIGIN.lon) * DEG;
  const north = dLat * EARTH_R;
  const east = dLon * EARTH_R * Math.cos(ORIGIN.lat * DEG);
  out.set(east, 0, -north);
  return out;
}

export function worldToLatLon(x, z) {
  const north = -z;
  const east = x;
  const lat = ORIGIN.lat + (north / EARTH_R) / DEG;
  const lon = ORIGIN.lon + (east / (EARTH_R * Math.cos(ORIGIN.lat * DEG))) / DEG;
  return { lat, lon };
}

// Magnetic heading (deg, 0=N) -> unit vector in world frame
export function headingToVector(headingDeg, out) {
  const h = headingDeg * DEG;
  out.set(Math.sin(h), 0, -Math.cos(h));
  return out;
}

// Vector -> magnetic heading deg
export function vectorToHeading(x, z) {
  return (Math.atan2(x, -z) / DEG + 360) % 360;
}

// Approximate magnetic declination for NYC metro (WMM2025 ~ -12.9 deg).
// Positive = east. True heading = magnetic + declination... careful with sign:
// declination -13 means magnetic north is 13 deg WEST of true north,
// so trueHeading = magHeading - 13 (i.e., magHeading + declination).
export function magneticDeclination() { return -13.0; }
export function magToTrue(magDeg) { return (magDeg + magneticDeclination() + 360) % 360; }
export function trueToMag(trueDeg) { return (trueDeg - magneticDeclination() + 360) % 360; }

export const FT_TO_M = 0.3048;
export const M_TO_FT = 1 / FT_TO_M;
export const KT_TO_MS = 0.514444;
export const MS_TO_KT = 1 / KT_TO_MS;
export const NM_TO_M = 1852;
