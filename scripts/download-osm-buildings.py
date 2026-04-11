"""
Download OSM building footprints with heights for Stockholm.

Splits the bbox into a grid to avoid Overpass timeouts, queries each
cell for ways tagged "building" that have height data (height,
building:height, or building:levels), deduplicates by OSM id, and
writes stockholm-buildings.geojson.

Height resolution order:
  1. building:height (metres, float)
  2. height (metres, float)
  3. building:levels * 3.0 (floor count → approximate metres)
  Features with none of the above are excluded (height = None → skip).
"""

import json
import time
import urllib.request
import urllib.parse

# ── Bounding box ──
MIN_LAT, MAX_LAT = 59.2, 59.5
MIN_LNG, MAX_LNG = 17.8, 18.3

# Split into GRID x GRID sub-boxes to keep each Overpass query fast
GRID = 3
OUT_FILE = "stockholm-buildings.geojson"

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def parse_height(tags: dict):
    """Return height in metres, or None if no height data available."""
    for key in ("building:height", "height"):
        val = tags.get(key, "").strip().replace("m", "").replace(" ", "")
        try:
            h = float(val)
            if h > 0:
                return h
        except ValueError:
            pass
    levels = tags.get("building:levels", "").strip()
    try:
        l = float(levels)
        if l > 0:
            return l * 3.0
    except ValueError:
        pass
    return None


def overpass_query(bbox_str: str) -> list:
    """Fetch all buildings with geometry in bbox. Returns list of elements."""
    query = (
        f"[out:json][timeout:60];"
        f"(way[\"building\"]({bbox_str}););"
        f"out body geom;"
    )
    body = f"data={urllib.parse.quote(query)}"
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    for attempt in range(len(OVERPASS_ENDPOINTS) * 2):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            req = urllib.request.Request(endpoint, data=body.encode(), headers=headers)
            with urllib.request.urlopen(req, timeout=70) as resp:
                data = json.loads(resp.read())
                return data.get("elements", [])
        except Exception as e:
            wait = 15 * (attempt + 1)
            print(f"      attempt {attempt+1} failed ({e}), waiting {wait}s …", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"All Overpass attempts failed for bbox {bbox_str}")


def element_to_feature(el: dict):
    """Convert an Overpass way element to a GeoJSON Feature, or None if no height."""
    tags = el.get("tags") or {}
    height = parse_height(tags)
    if height is None:
        return None

    geom = el.get("geometry")
    if not geom or len(geom) < 3:
        return None

    coords = [[g["lon"], g["lat"]] for g in geom]
    # Ensure ring is closed
    if coords[0] != coords[-1]:
        coords.append(coords[0])

    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [coords]},
        "properties": {
            "osm_id": el["id"],
            "height": height,
            "building": tags.get("building", "yes"),
            "name": tags.get("name", ""),
        },
    }


# ── Build grid cells ──
lat_step = (MAX_LAT - MIN_LAT) / GRID
lng_step = (MAX_LNG - MIN_LNG) / GRID
cells = []
for row in range(GRID):
    for col in range(GRID):
        s = MIN_LAT + row * lat_step
        n = s + lat_step
        w = MIN_LNG + col * lng_step
        e = w + lng_step
        cells.append((s, n, w, e))

print(f"Stockholm bbox split into {len(cells)} cells ({GRID}x{GRID} grid)\n")

seen_ids: set[int] = set()
features: list[dict] = []

for i, (s, n, w, e) in enumerate(cells):
    bbox_str = f"{s:.4f},{w:.4f},{n:.4f},{e:.4f}"
    print(f"[{i+1}/{len(cells)}] bbox={bbox_str} … ", end="", flush=True)

    elements = overpass_query(bbox_str)
    n_new = 0
    for el in elements:
        osm_id = el.get("id")
        if osm_id in seen_ids:
            continue
        feat = element_to_feature(el)
        if feat:
            seen_ids.add(osm_id)
            features.append(feat)
            n_new += 1

    print(f"{len(elements)} ways → {n_new} with height (total so far: {len(features)})")
    if i < len(cells) - 1:
        time.sleep(5)  # be polite between requests

# ── Write output ──
geojson = {"type": "FeatureCollection", "features": features}
with open(OUT_FILE, "w") as f:
    json.dump(geojson, f)

size_kb = sum(len(json.dumps(feat)) for feat in features) / 1024
print(f"\nSaved {len(features)} buildings with heights → {OUT_FILE} ({size_kb:.0f} KB)")

# ── Summary stats ──
heights = [f["properties"]["height"] for f in features]
if heights:
    print(f"Height range: {min(heights):.1f}m – {max(heights):.1f}m")
    buckets = {"1–5m": 0, "6–15m": 0, "16–30m": 0, "31–60m": 0, ">60m": 0}
    for h in heights:
        if h <= 5:    buckets["1–5m"] += 1
        elif h <= 15: buckets["6–15m"] += 1
        elif h <= 30: buckets["16–30m"] += 1
        elif h <= 60: buckets["31–60m"] += 1
        else:         buckets[">60m"] += 1
    for k, v in buckets.items():
        print(f"  {k}: {v}")
