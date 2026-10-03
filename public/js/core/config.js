// Global configuration.
// Runway data: FAA 5010 via airnav.com (eff. 22 Jan 2026), verified 2026-10-03.
// Headings below are TRUE degrees. Magnetic ≈ true + 13 (VAR 13W metro-wide).

export const CONFIG = {
  appName: 'Muse Flight Simulator',
  version: '1.0.0',
  physicsHz: 120,
  startAirport: 'KJFK',
  features: {
    traffic: true,
    atcVoice: true,
    shadows: true,
    clouds: true,
  },
};

// 737-800 reference (Boeing ACAP D6-58325-7, FAA TCDS A16WE)
export const AIRCRAFT = {
  type: 'Boeing 737-800',
  operator: 'Southwest Airlines',
  lengthM: 39.47,
  wingspanM: 35.79,
  heightM: 12.55,
  fuselageDiameterM: 3.76,
  wingAreaM2: 124.6,
  mtowKg: 79015,
  mlwKg: 66360,
  oewKg: 41413,
  maxFuelKg: 46060 * 0.453592, // 46,060 lb -> kg
  engines: [
    { name: 'CFM56-7B27', maxThrustN: 121400 },
    { name: 'CFM56-7B27', maxThrustN: 121400 },
  ],
  speeds: {
    vmo: 340, mmo: 0.82,
    flapLimits: { 1: 250, 2: 250, 5: 250, 10: 210, 15: 200, 25: 190, 30: 175, 40: 162 },
  },
  flapDetents: [0, 1, 2, 5, 10, 15, 25, 30, 40],
};

// Threshold lat/lon = landing threshold of the named runway end.
export const AIRPORTS = {
  KJFK: {
    icao: 'KJFK', name: 'New York John F. Kennedy Intl',
    lat: 40.6413, lon: -73.7781, elevationFt: 13,
    atisFreq: '128.725', deliveryFreq: '135.050', groundFreq: '121.900',
    towerFreq: '119.100', departureFreq: '135.900', approachFreq: '125.700',
    runways: [
      { id: '13R', headingTrue: 121, lengthFt: 14511, widthFt: 200, thresholdLat: 40.648361, thresholdLon: -73.816715, ils: null },
      { id: '31L', headingTrue: 301, lengthFt: 14511, widthFt: 200, thresholdLat: 40.627994, thresholdLon: -73.771781, ils: { freq: '111.35', id: 'I-MOH', gs: 3.00, locOnly: true } },
      { id: '4L', headingTrue: 31, lengthFt: 12079, widthFt: 200, thresholdLat: 40.622021, thresholdLon: -73.785584, ils: { freq: '110.90', id: 'I-HIQ', gs: 3.00 } },
      { id: '22R', headingTrue: 211, lengthFt: 12079, widthFt: 200, thresholdLat: 40.650509, thresholdLon: -73.763322, ils: { freq: '109.50', id: 'I-JOC', gs: 3.00 } },
      { id: '13L', headingTrue: 121, lengthFt: 10000, widthFt: 200, thresholdLat: 40.657765, thresholdLon: -73.790239, ils: { freq: '111.50', id: 'I-TLK', gs: 3.00 } },
      { id: '31R', headingTrue: 301, lengthFt: 10000, widthFt: 200, thresholdLat: 40.643725, thresholdLon: -73.759273, ils: { freq: '111.50', id: 'I-RTH', gs: 3.00 } },
      { id: '4R', headingTrue: 31, lengthFt: 8400, widthFt: 200, thresholdLat: 40.625428, thresholdLon: -73.770346, ils: { freq: '109.50', id: 'I-JFK', gs: 3.00 } },
      { id: '22L', headingTrue: 211, lengthFt: 8400, widthFt: 200, thresholdLat: 40.645237, thresholdLon: -73.754862, ils: { freq: '110.90', id: 'I-IWY', gs: 3.00 } },
    ],
  },
  KLGA: {
    icao: 'KLGA', name: 'New York LaGuardia',
    lat: 40.7769, lon: -73.8740, elevationFt: 20.7,
    atisFreq: '125.950', deliveryFreq: '135.875', groundFreq: '121.700',
    towerFreq: '118.700', departureFreq: '124.075', approachFreq: '126.125',
    runways: [
      { id: '4', headingTrue: 32, lengthFt: 7002, widthFt: 150, thresholdLat: 40.769163, thresholdLon: -73.884119, ils: { freq: '110.50', id: 'I-LGA', gs: 3.14 } },
      { id: '22', headingTrue: 212, lengthFt: 7002, widthFt: 150, thresholdLat: 40.785437, thresholdLon: -73.870673, ils: { freq: '110.50', id: 'I-URD', gs: 3.00 } },
      { id: '13', headingTrue: 122, lengthFt: 7002, widthFt: 150, thresholdLat: 40.782296, thresholdLon: -73.878519, ils: { freq: '108.50', id: 'I-GDI', gs: 3.10 } },
      { id: '31', headingTrue: 302, lengthFt: 7002, widthFt: 150, thresholdLat: 40.772072, thresholdLon: -73.857112, ils: null },
    ],
  },
  KEWR: {
    icao: 'KEWR', name: 'Newark Liberty Intl',
    lat: 40.6895, lon: -74.1745, elevationFt: 17.5,
    atisFreq: '115.700', deliveryFreq: '118.850', groundFreq: '121.700',
    towerFreq: '118.300', departureFreq: '119.200', approachFreq: '128.550',
    runways: [
      { id: '4L', headingTrue: 26, lengthFt: 11000, widthFt: 150, thresholdLat: 40.675381, thresholdLon: -74.179449, ils: { freq: '110.75', id: 'I-EWR', gs: 3.10 } },
      { id: '22R', headingTrue: 206, lengthFt: 11000, widthFt: 150, thresholdLat: 40.702560, thresholdLon: -74.162172, ils: { freq: '110.75', id: 'I-JNN', gs: 3.10 } },
      { id: '4R', headingTrue: 26, lengthFt: 9999, widthFt: 150, thresholdLat: 40.677584, thresholdLon: -74.174245, ils: { freq: '108.70', id: 'I-EZA', gs: 2.95 } },
      { id: '22L', headingTrue: 206, lengthFt: 9999, widthFt: 150, thresholdLat: 40.702289, thresholdLon: -74.158538, ils: { freq: '108.70', id: 'I-LSQ', gs: 3.00 } },
      { id: '11', headingTrue: 95, lengthFt: 6725, widthFt: 150, thresholdLat: 40.702804, thresholdLon: -74.180707, ils: { freq: '109.15', id: 'I-GPR', gs: 3.00 } },
      { id: '29', headingTrue: 275, lengthFt: 6725, widthFt: 150, thresholdLat: 40.701199, thresholdLon: -74.156544, ils: null },
    ],
  },
  KTEB: {
    icao: 'KTEB', name: 'Teterboro',
    lat: 40.8501, lon: -74.0608, elevationFt: 8.3,
    atisFreq: '127.250', deliveryFreq: '124.600', groundFreq: '121.700',
    towerFreq: '118.500', departureFreq: '119.200', approachFreq: '128.550',
    runways: [
      { id: '1', headingTrue: 3, lengthFt: 6997, widthFt: 150, thresholdLat: 40.838682, thresholdLon: -74.060371, ils: null },
      { id: '19', headingTrue: 183, lengthFt: 6997, widthFt: 150, thresholdLat: 40.857856, thresholdLon: -74.058956, ils: { freq: '110.15', id: 'I-TJL', gs: 3.00 } },
      { id: '6', headingTrue: 48, lengthFt: 6014, widthFt: 150, thresholdLat: 40.846729, thresholdLon: -74.070292, ils: { freq: '108.90', id: 'I-TEB', gs: 3.00 } },
      { id: '24', headingTrue: 228, lengthFt: 6014, widthFt: 150, thresholdLat: 40.857739, thresholdLon: -74.054096, ils: null },
    ],
  },
};

export const LIVERY = {
  canyonBlue: 0x1a3a6b,
  desertGold: 0xf5a623,
  heartRed: 0xd22630,
  summitSilver: 0xc8ccd2,
  tailBlue: 0x14315e,
};
