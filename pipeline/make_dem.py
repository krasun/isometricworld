#!/usr/bin/env python3
"""
Create a Copernicus-format DEM GeoTIFF for a 1°×1° tile.
Samples elevation from the Open-Meteo API at a coarse grid, then interpolates.

Usage: python make_dem.py <lat> <lon> <output.tif>
"""
import json
import sys
import time
import urllib.request
import numpy as np
import tifffile

LAT = int(sys.argv[1])
LON = int(sys.argv[2])
OUT = sys.argv[3]

ROWS = 3600
COLS = 3600

print(f"Building DEM tile N{LAT:02d}_E{LON:03d} ({ROWS}×{COLS})...")

# Sample at a very coarse grid (every 120th cell = 30×30 = 900 points)
# Then use scipy to upscale. 900 points at 100/batch = 9 requests, well within rate limits.
STEP = 120
sample_rows = ROWS // STEP  # 30
sample_cols = COLS // STEP  # 30

lats = []
lons = []
for r in range(sample_rows):
    for c in range(sample_cols):
        lat = LAT + 1.0 - (r * STEP + STEP / 2) / ROWS
        lon = LON + (c * STEP + STEP / 2) / COLS
        lats.append(round(lat, 6))
        lons.append(round(lon, 6))

print(f"  Fetching {len(lats)} elevation samples...")

BATCH = 100
elevations = []
for i in range(0, len(lats), BATCH):
    lat_batch = lats[i:i + BATCH]
    lon_batch = lons[i:i + BATCH]
    lat_str = ",".join(str(x) for x in lat_batch)
    lon_str = ",".join(str(x) for x in lon_batch)
    url = f"https://api.open-meteo.com/v1/elevation?latitude={lat_str}&longitude={lon_str}"

    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "isometric-world/0.3"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            elevations.extend(data["elevation"])
            break
        except Exception as e:
            if attempt == 7:
                raise
            wait = min(60, 5 * (attempt + 1))
            print(f"    retry {attempt + 1} (wait {wait}s): {e}")
            time.sleep(wait)

    done = min(i + BATCH, len(lats))
    print(f"  Fetched {done}/{len(lats)} samples")
    if i + BATCH < len(lats):
        time.sleep(1.5)

coarse = np.array(elevations, dtype=np.float32).reshape(sample_rows, sample_cols)
print(f"  Coarse grid: {coarse.shape}, range {coarse.min():.1f} - {coarse.max():.1f} m")

# Upscale with scipy zoom (bilinear)
from scipy.ndimage import zoom as ndzoom
full = ndzoom(coarse, (STEP, STEP), order=1).astype(np.float32)
full = full[:ROWS, :COLS]
print(f"  Full grid: {full.shape}, range {full.min():.1f} - {full.max():.1f} m")

tifffile.imwrite(OUT, full, photometric='minisblack')
print(f"  Written to {OUT}")
