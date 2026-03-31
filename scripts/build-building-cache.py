"""
Convert stockholm-buildings-all.geojson → public/data/stockholm-buildings.json

Compact format: {"b": [[height, [[lat, lng], ...]], ...]}
- GeoJSON uses [lng, lat]; we flip to [lat, lng] to match the app's Building interface
- Coordinates rounded to 5 decimal places (~1 m precision, enough for shadow calc)
- No property names per building to minimise size
- Closing duplicate vertex stripped (OSM polygons include it, app doesn't need it)
"""

import json, os, sys

INPUT  = os.path.expanduser("~/Downloads/stockholm-buildings-all.geojson")
OUTPUT = os.path.join(os.path.dirname(__file__), "../public/data/stockholm-buildings.json")
OUTPUT = os.path.normpath(OUTPUT)

os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

print(f"Reading {INPUT} …", flush=True)
with open(INPUT) as f:
    fc = json.load(f)

features = fc["features"]
print(f"  {len(features):,} features")

out_buildings = []
for feat in features:
    h = feat["properties"]["height"]
    ring = feat["geometry"]["coordinates"][0]  # outer ring, [lng, lat]

    # Convert to [lat, lng], round to 5 dp
    poly = [[round(lat, 5), round(lng, 5)] for lng, lat in ring]

    # Strip duplicate closing vertex
    if len(poly) > 1 and poly[0] == poly[-1]:
        poly = poly[:-1]

    if len(poly) < 3:
        continue

    out_buildings.append([h, poly])

print(f"  {len(out_buildings):,} buildings after cleaning")

payload = {"b": out_buildings}

print(f"Writing {OUTPUT} …", flush=True)
with open(OUTPUT, "w") as f:
    # No whitespace — minimise file size
    json.dump(payload, f, separators=(",", ":"))

size_mb = os.path.getsize(OUTPUT) / 1e6
print(f"Done — {size_mb:.1f} MB (uncompressed); CDN/Vite will gzip-serve this ~6x smaller")
