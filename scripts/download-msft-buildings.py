"""
Download Microsoft Global ML Building Footprints for Stockholm.

Source: https://github.com/microsoft/GlobalMLBuildingFootprints
Tiles are indexed by QuadKey. We find all Sweden tiles that intersect
the Stockholm bounding box, download each one, filter to the bbox and
to features that have a height > 0, then write stockholm-buildings.geojson.
"""

import csv
import gzip
import io
import json
import math
import sys
import urllib.request

# ── Stockholm bounding box ──
MIN_LAT, MAX_LAT = 59.2, 59.5
MIN_LNG, MAX_LNG = 17.8, 18.3

DATASET_CSV = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
OUT_FILE = "stockholm-buildings.geojson"


# ── QuadKey helpers (zoom 9 is the tile granularity MS uses) ──

def tile_to_bbox(tx, ty, zoom):
    """Return (min_lat, max_lat, min_lng, max_lng) for a Web Mercator tile."""
    n = 2 ** zoom
    min_lng = tx / n * 360 - 180
    max_lng = (tx + 1) / n * 360 - 180
    max_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    min_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + 1) / n))))
    return min_lat, max_lat, min_lng, max_lng


def quadkey_to_tile(qk):
    tx, ty, zoom = 0, 0, len(qk)
    for i, ch in enumerate(qk):
        bit = zoom - i - 1
        if ch == "1":
            tx |= 1 << bit
        elif ch == "2":
            ty |= 1 << bit
        elif ch == "3":
            tx |= 1 << bit
            ty |= 1 << bit
    return tx, ty, zoom


def tile_intersects_bbox(tx, ty, zoom):
    tmin_lat, tmax_lat, tmin_lng, tmax_lng = tile_to_bbox(tx, ty, zoom)
    return (tmax_lat > MIN_LAT and tmin_lat < MAX_LAT and
            tmax_lng > MIN_LNG and tmin_lng < MAX_LNG)


def bbox_filter(feature):
    coords = feature["geometry"]["coordinates"]
    # Flatten all rings to get all lng/lat pairs
    def flatten(c):
        if isinstance(c[0], list):
            for sub in c:
                yield from flatten(sub)
        else:
            yield c
    pts = list(flatten(coords))
    lngs = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    return (max(lats) > MIN_LAT and min(lats) < MAX_LAT and
            max(lngs) > MIN_LNG and min(lngs) < MAX_LNG)


def has_height(feature):
    h = feature.get("properties") or {}
    val = h.get("height") or h.get("HEIGHT") or h.get("Height")
    try:
        return float(val) > 0
    except (TypeError, ValueError):
        return False


# ── 1. Fetch tile index ──
print(f"Fetching tile index from {DATASET_CSV} ...", flush=True)
with urllib.request.urlopen(DATASET_CSV) as resp:
    reader = csv.DictReader(io.TextIOWrapper(resp, encoding="utf-8"))
    rows = list(reader)

print(f"  {len(rows)} total tiles in index")

# Filter to Sweden tiles that intersect Stockholm bbox
sweden_tiles = [r for r in rows if r.get("Location", "").strip() == "Sweden"]
print(f"  {len(sweden_tiles)} Sweden tiles")

matching = []
for row in sweden_tiles:
    qk = row.get("QuadKey", "").strip()
    if not qk:
        continue
    tx, ty, zoom = quadkey_to_tile(qk)
    if tile_intersects_bbox(tx, ty, zoom):
        matching.append(row)

print(f"  {len(matching)} tiles intersect Stockholm bbox\n")

if not matching:
    print("No matching tiles found — check bbox or dataset structure.")
    sys.exit(1)

# ── 2. Download and filter each tile ──
features = []
for i, row in enumerate(matching):
    url = row.get("Url", "").strip()
    qk = row.get("QuadKey", "").strip()
    size_str = str(row.get("Size", "0")).replace("MB","").replace("KB","").replace("GB","").strip()
    size_mb = float(size_str or 0)
    print(f"[{i+1}/{len(matching)}] QuadKey={qk} ({size_mb:.1f} MB) ...", end=" ", flush=True)

    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            raw = resp.read()

        # Files may be gzip-compressed or plain .geojsonl
        if url.endswith(".gz") or raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)

        n_total = 0
        n_bbox = 0
        n_height = 0
        for line in raw.decode("utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            n_total += 1
            feat = json.loads(line)
            if not bbox_filter(feat):
                continue
            n_bbox += 1
            if has_height(feat):
                n_height += 1
                features.append(feat)

        print(f"{n_total} features, {n_bbox} in bbox, {n_height} with height>0")

    except Exception as e:
        print(f"FAILED: {e}")

# ── 3. Write output ──
print(f"\nTotal features with height>0 in Stockholm bbox: {len(features)}")

if not features:
    print("No features with height found. Writing all bbox features instead (height may be absent in this dataset).")
    # Re-run without height filter for diagnostic output
    features_all = []
    for i, row in enumerate(matching):
        url = row.get("Url", "").strip()
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                raw = resp.read()
            if url.endswith(".gz") or raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            for line in raw.decode("utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                feat = json.loads(line)
                if bbox_filter(feat):
                    features_all.append(feat)
        except Exception:
            pass
    print(f"Total bbox features (no height filter): {len(features_all)}")
    sample = features_all[0] if features_all else {}
    print(f"Sample properties: {sample.get('properties')}")
    features = features_all

geojson = {
    "type": "FeatureCollection",
    "features": features
}

with open(OUT_FILE, "w") as f:
    json.dump(geojson, f)

size_kb = len(json.dumps(geojson)) / 1024
print(f"\nSaved {len(features)} features → {OUT_FILE} ({size_kb:.0f} KB)")
