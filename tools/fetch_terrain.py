#!/usr/bin/env python3
"""Bake terrain assets for the flight sim at build time.

Outputs (in public/assets/):
  heightmap.png   1024x1024 RGB-encoded elevation, bbox 40.3-41.1N x 73.5-74.5W
                  decode: v=(R<<16)|(G<<8)|B ; elev_m = v/100 - 100
  ground.jpg      2048x2048 Esri World Imagery composite of the bbox
  airport_KJFK.jpg / _KLGA / _KEWR / _KTEB   1024x1024 high-res per airport
  meta.json       bbox + airport centers/spans

Sources:
  Elevation: AWS Terrain Tiles (Terrarium PNG, public S3, no key)
             https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
             elev = R*256 + G + B/256 - 32768
  Imagery: Esri World Imagery (free for public apps with attribution)
             https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
             NOTE: Esri order is z/y/x (row/col swapped vs standard).
Attribution (shown in-app): "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community. Terrain: USGS 3DEP/GMTED2010/SRTM."
"""
import io, json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import requests
from PIL import Image
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'public', 'assets')
os.makedirs(ASSETS, exist_ok=True)

BBOX = dict(lat_min=40.3, lat_max=41.1, lon_min=-74.5, lon_max=-73.5)
AIRPORTS = {
    'KJFK': (40.6413, -73.7781),
    'KLGA': (40.7769, -73.8740),
    'KEWR': (40.6895, -74.1745),
    'KTEB': (40.8501, -74.0608),
}
UA = {'User-Agent': 'muse-flight-sim/1.0 (build-time tile bake; contact: personal project)'}
SESS = requests.Session()
SESS.headers.update(UA)

TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

def deg2tile(lat, lon, z):
    n = 2 ** z
    xt = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    yt = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return xt, yt

def tile_range(lat_min, lat_max, lon_min, lon_max, z):
    x0, y1 = deg2tile(lat_min, lon_min, z)
    x1, y0 = deg2tile(lat_max, lon_max, z)
    return range(math.floor(x0), math.floor(x1) + 1), range(math.floor(y0), math.floor(y1) + 1)

def fetch(url, tries=4):
    for i in range(tries):
        try:
            r = SESS.get(url, timeout=25)
            if r.status_code == 200 and len(r.content) > 100:
                return Image.open(io.BytesIO(r.content)).convert('RGB')
        except Exception as e:
            if i == tries - 1:
                print(f'  FAIL {url}: {e}', flush=True)
        time.sleep(0.4 * (i + 1))
    return None

def composite(url_fn, xs, ys, out_w, out_h, label):
    """Fetch tiles over xs x ys grid, mosaic, resize to out_w x out_h."""
    xs, ys = list(xs), list(ys)
    nx, ny = len(xs), len(ys)
    print(f'{label}: fetching {nx}x{ny}={nx*ny} tiles…', flush=True)
    mosaic = Image.new('RGB', (nx * 256, ny * 256))
    jobs = [(ix, iy, x, y) for iy, y in enumerate(ys) for ix, x in enumerate(xs)]
    done = [0]
    def work(job):
        ix, iy, x, y = job
        img = fetch(url_fn(x, y))
        if img is not None:
            mosaic.paste(img.resize((256, 256)), (ix * 256, iy * 256))
        done[0] += 1
        if done[0] % 25 == 0:
            print(f'  {label}: {done[0]}/{len(jobs)}', flush=True)
        return img is not None
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(work, jobs))
    ok = sum(results)
    print(f'{label}: {ok}/{len(jobs)} tiles OK', flush=True)
    if out_w and out_h:
        return mosaic.resize((out_w, out_h), Image.LANCZOS)
    return mosaic  # native resolution; caller resamples after decoding

def bake_heightmap():
    z = 11
    xs, ys = tile_range(BBOX['lat_min'], BBOX['lat_max'], BBOX['lon_min'], BBOX['lon_max'], z)
    def url_fn(x, y):
        return TERRARIUM.format(z=z, x=x, y=y)
    mosaic = composite(url_fn, xs, ys, None, None, 'heightmap')
    # NOTE: mosaic pixels are Terrarium ENCODED values — decode to float FIRST,
    # then resample the float grid (resampling encoded RGB corrupts the data).
    arr = np.asarray(mosaic).astype(np.float64)
    elev = arr[:, :, 0] * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0
    elev[elev < -500] = -5.0  # Terrarium nodata (e.g. ocean) -> -5 m
    elev_img = Image.fromarray(elev.astype(np.float32), mode='F')
    if elev_img.size != (1024, 1024):
        elev_img = elev_img.resize((1024, 1024), Image.BILINEAR)
    elev = np.asarray(elev_img, dtype=np.float64)
    # encode: v = round((elev+100)*100), RGB 24-bit
    v = np.clip(np.round((elev + 100.0) * 100.0), 0, 2**24 - 1).astype(np.uint32)
    rgb = np.zeros((1024, 1024, 3), dtype=np.uint8)
    rgb[:, :, 0] = (v >> 16) & 255
    rgb[:, :, 1] = (v >> 8) & 255
    rgb[:, :, 2] = v & 255
    Image.fromarray(rgb, 'RGB').save(os.path.join(ASSETS, 'heightmap.png'))
    print(f'heightmap.png saved (elev range {elev.min():.1f}..{elev.max():.1f} m)', flush=True)

def bake_ground():
    z = 12
    xs, ys = tile_range(BBOX['lat_min'], BBOX['lat_max'], BBOX['lon_min'], BBOX['lon_max'], z)
    def url_fn(x, y):
        return ESRI.format(z=z, y=y, x=x)  # Esri: z/y/x
    mosaic = composite(url_fn, xs, ys, 2048, 2048, 'ground')
    mosaic.save(os.path.join(ASSETS, 'ground.jpg'), quality=88)
    print('ground.jpg saved', flush=True)

def bake_airports():
    z = 16
    for icao, (lat, lon) in AIRPORTS.items():
        span = 0.020  # degrees each direction
        xs, ys = tile_range(lat - span, lat + span, lon - span, lon + span, z)
        def url_fn(x, y, _z=z):
            return ESRI.format(z=_z, y=y, x=x)
        mosaic = composite(url_fn, xs, ys, 1024, 1024, f'airport_{icao}')
        mosaic.save(os.path.join(ASSETS, f'airport_{icao}.jpg'), quality=90)
        print(f'airport_{icao}.jpg saved', flush=True)

def bake_meta():
    meta = {
        'bbox': BBOX,
        'attribution': 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community. Terrain: USGS 3DEP/GMTED2010/SRTM via AWS Terrain Tiles.',
        'airports': {icao: {'lat': lat, 'lon': lon, 'spanDeg': 0.020} for icao, (lat, lon) in AIRPORTS.items()},
    }
    with open(os.path.join(ASSETS, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    print('meta.json saved', flush=True)

if __name__ == '__main__':
    t0 = time.time()
    which = sys.argv[1:] or ['heightmap', 'ground', 'airports', 'meta']
    if 'heightmap' in which: bake_heightmap()
    if 'ground' in which: bake_ground()
    if 'airports' in which: bake_airports()
    if 'meta' in which: bake_meta()
    print(f'done in {time.time()-t0:.0f}s', flush=True)
