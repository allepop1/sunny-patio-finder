import SunCalc from "suncalc";

interface OverpassNode { lat: number; lon: number }
interface OverpassElement {
  geometry?: OverpassNode[];
  tags?: Record<string, string>;
}
interface OverpassResponse { elements: OverpassElement[] }
import { fetchWeather, type WeatherData, type ForecastItem } from "./WeatherService";
import { supabase } from "@/integrations/supabase/client";

// Stockholm coverage bbox — same as the Supabase buildings table extent
const STOCKHOLM_BBOX = {
  minLat: 59.20, maxLat: 59.45,
  minLng: 17.85, maxLng: 18.25,
};

function isInStockholmBbox(lat: number, lng: number): boolean {
  return (
    lat >= STOCKHOLM_BBOX.minLat && lat <= STOCKHOLM_BBOX.maxLat &&
    lng >= STOCKHOLM_BBOX.minLng && lng <= STOCKHOLM_BBOX.maxLng
  );
}

export interface SunWindow {
  /** "sunny_until" = currently sunny, will end at `end` */
  type: "sunny_until" | "sunny_from";
  start?: Date; // only set for "sunny_from"
  end: Date;
}

export interface SunStatus {
  isSunny: boolean;
  isPartial?: boolean; // true when at least one terrace side is sunny and at least one is not
  buildingShadow: boolean;
  cloudCover: number; // 0-100
  solarAltitude: number;
  solarAzimuth: number;
  confidence: "high" | "medium" | "low";
  weather?: WeatherData | null;
  sunWindow?: SunWindow | null;
}

export interface Building {
  lat: number;
  lng: number;
  height: number;
  polygon: [number, number][]; // lat, lng pairs
}

export interface Venue {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  openingHours?: string;
  sunStatus?: SunStatus;
  venueType?: string; // "restaurant" | "bar" | "cafe" | "bakery" | "default"
  /** For corner venues: all terrace coordinates (first entry = primary / lat+lng above). */
  points?: Array<{ lat: number; lng: number }>;
  /** For corner venues: all permit addresses. */
  allAddresses?: string[];
}

// ── Solar Position (pure math via suncalc) ──

export function getSolarPosition(
  date: Date,
  lat: number,
  lng: number
): { azimuth: number; altitude: number } {
  const pos = SunCalc.getPosition(date, lat, lng);
  // suncalc returns azimuth from south, clockwise. Convert to from north.
  const azimuthDeg = ((pos.azimuth * 180) / Math.PI + 180) % 360;
  const altitudeDeg = (pos.altitude * 180) / Math.PI;
  return { azimuth: azimuthDeg, altitude: altitudeDeg };
}

// ── Night Info ──

export interface NightInfo {
  isNight: boolean;
  sunrise: Date;
  sunset: Date;
  nextEvent: "sunrise" | "sunset";
  nextEventTime: Date;
  minutesUntilNextEvent: number;
}

/**
 * Returns night/day state and next sun event for a given time and location.
 *
 * "sunrise" and "sunset" are the NEXT occurrence of each after `date`:
 *   - Before sunrise  → sunrise=today,    sunset=today
 *   - Daytime         → sunrise=tomorrow, sunset=today
 *   - After sunset    → sunrise=tomorrow, sunset=tomorrow
 *
 * Edge case (polar night / midnight sun): SunCalc returns Invalid Date when
 * there is no sunrise or sunset.  In that case we fall back gracefully so the
 * UI never shows NaN times.
 */
export function getNightInfo(date: Date, lat: number, lng: number): NightInfo {
  const solar = getSolarPosition(date, lat, lng);
  const isNight = solar.altitude < 0;

  const todayTimes = SunCalc.getTimes(date, lat, lng);
  const tomorrowDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowTimes = SunCalc.getTimes(tomorrowDate, lat, lng);

  const isValid = (d: Date) => d instanceof Date && !isNaN(d.getTime());

  // Next sunrise: today's if still in the future, otherwise tomorrow's
  const sunrise =
    isValid(todayTimes.sunrise) && date < todayTimes.sunrise
      ? todayTimes.sunrise
      : isValid(tomorrowTimes.sunrise)
      ? tomorrowTimes.sunrise
      : new Date(date.getTime() + 12 * 60 * 60 * 1000); // fallback +12 h

  // Next sunset: today's if still in the future, otherwise tomorrow's
  const sunset =
    isValid(todayTimes.sunset) && date < todayTimes.sunset
      ? todayTimes.sunset
      : isValid(tomorrowTimes.sunset)
      ? tomorrowTimes.sunset
      : new Date(date.getTime() + 12 * 60 * 60 * 1000); // fallback +12 h

  // Whichever comes first is the next event
  const nextEvent: "sunrise" | "sunset" = sunrise <= sunset ? "sunrise" : "sunset";
  const nextEventTime = nextEvent === "sunrise" ? sunrise : sunset;
  const minutesUntilNextEvent = Math.max(
    0,
    Math.round((nextEventTime.getTime() - date.getTime()) / 60_000)
  );

  return { isNight, sunrise, sunset, nextEvent, nextEventTime, minutesUntilNextEvent };
}

// ── Shadow Calculation ──

/**
 * Given a building height and solar altitude, returns how far the shadow
 * extends horizontally (in meters).
 */
export function shadowLength(buildingHeight: number, solarAltitudeDeg: number): number {
  if (solarAltitudeDeg <= 0) return Infinity; // sun below horizon
  const altRad = (solarAltitudeDeg * Math.PI) / 180;
  return buildingHeight / Math.tan(altRad);
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true if (lat, lng) is inside the given polygon.
 */
function pointInPolygon(lat: number, lng: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const intersect =
      (lngI > lng) !== (lngJ > lng) &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Check if a point is in the shadow of a building.
 *
 * Uses shadow-polygon projection: the building's ground footprint is
 * translated by the shadow vector (length = building height / tan(altitude),
 * direction = opposite of solar azimuth). The point is in shadow if and only
 * if it falls inside this translated polygon.
 *
 * This replaces the earlier centroid + cone approach, which over-fired on
 * large L-shaped buildings (e.g. a 934 sqm block with a 42 m perpendicular
 * span caused false shadow hits on venues 17 m to the side of the shadow
 * axis — venues that the building cannot physically shadow).
 */
export function isPointInBuildingShadow(
  pointLat: number,
  pointLng: number,
  building: Building,
  solarAzimuthDeg: number,
  solarAltitudeDeg: number
): boolean {
  if (solarAltitudeDeg <= 0) return true; // nighttime = shadow

  // A point inside the building's own footprint cannot be in its shadow —
  // it is part of the building itself (e.g. a venue inside a courtyard whose
  // surrounding block is one OSM polygon). Without this guard the hybrid
  // shadow polygon's sun-facing edges, kept at original position, form a
  // "cage" around the point and produce a false-positive shadow hit.
  if (pointInPolygon(pointLat, pointLng, building.polygon)) return false;

  const sLen = Math.min(shadowLength(building.height, solarAltitudeDeg), 500);
  if (sLen <= 0) return false;

  // Shadow direction: opposite of solar azimuth
  const shadowAzimuthRad = ((solarAzimuthDeg + 180) % 360) * (Math.PI / 180);

  // Strip duplicate closing vertex that OSM polygons often include
  let ring = building.polygon;
  const raw = ring.length;
  if (
    raw > 1 &&
    ring[0][0] === ring[raw - 1][0] &&
    ring[0][1] === ring[raw - 1][1]
  ) {
    ring = ring.slice(0, raw - 1);
  }
  const m = ring.length;
  if (m < 3) return false;

  // Use the centroid's latitude for the lng→metre conversion
  const centroidLat = ring.reduce((s, p) => s + p[0], 0) / m;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((centroidLat * Math.PI) / 180);

  const dLat = (sLen * Math.cos(shadowAzimuthRad)) / mPerLat;
  const dLng = (sLen * Math.sin(shadowAzimuthRad)) / mPerLng;

  // Shadow-tip polygon: each vertex projected by the shadow vector
  const projected: [number, number][] = ring.map(
    ([lat, lng]) => [lat + dLat, lng + dLng]
  );

  // Determine polygon winding (shoelace formula on [lng, lat])
  let signedArea = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    signedArea += ring[i][1] * ring[j][0] - ring[j][1] * ring[i][0];
  }
  const isCCW = signedArea > 0;

  // Solar direction unit vector (east = X, north = Y)
  const sunAzRad = (solarAzimuthDeg * Math.PI) / 180;
  const sunDirX = Math.sin(sunAzRad);
  const sunDirY = Math.cos(sunAzRad);

  // For each edge: is it a shadow edge (outward normal faces away from sun)?
  const isShadowEdge: boolean[] = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const edgeLng = ring[j][1] - ring[i][1];
    const edgeLat = ring[j][0] - ring[i][0];
    const normalX = isCCW ? edgeLat : -edgeLat;
    const normalY = isCCW ? -edgeLng : edgeLng;
    isShadowEdge.push(normalX * sunDirX + normalY * sunDirY < 0);
  }

  // Build the full shadow polygon (original footprint + connecting sides +
  // shadow-tip projection) using the same silhouette algorithm as ShadowLayer.tsx.
  // This correctly covers the corridor shadow between the building and its tip,
  // catching venues that are closer than sLen to the building — which the old
  // "translate-then-PiP" approach missed entirely.
  const poly: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    const prevShadow = isShadowEdge[(i - 1 + m) % m];
    const currShadow = isShadowEdge[i];
    if (!prevShadow && currShadow) {
      poly.push(ring[i]);
      poly.push(projected[i]);
    } else if (prevShadow && !currShadow) {
      poly.push(projected[i]);
      poly.push(ring[i]);
    } else if (currShadow) {
      poly.push(projected[i]);
    } else {
      poly.push(ring[i]);
    }
  }

  if (poly.length < 3) return false;

  // Point-in-polygon (ray-casting) on the full shadow polygon
  let inside = false;
  let j = poly.length - 1;
  for (let i = 0; i < poly.length; i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > pointLng) !== (yj > pointLng) &&
        pointLat < ((xj - xi) * (pointLng - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

// ── Building polygon area helper ──

/**
 * Returns the approximate footprint area of a building polygon in square metres.
 * Uses the shoelace formula with lat/lng converted to a local Cartesian frame.
 */
function polygonAreaSqm(polygon: [number, number][]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  const centLat = polygon.reduce((s, p) => s + p[0], 0) / n;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((centLat * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area +=
      polygon[i][1] * mPerLng * polygon[j][0] * mPerLat -
      polygon[j][1] * mPerLng * polygon[i][0] * mPerLat;
  }
  return Math.abs(area) / 2;
}

/**
 * Returns true for buildings that are likely misclassified open areas (parks,
 * squares, courtyards) imported with a default 12 m height from an OSM snapshot
 * where the polygon carried `building=yes` erroneously.
 *
 * Heuristic: footprint > 5 000 sqm AND height is exactly the default (12 m).
 * Real Stockholm apartment blocks with that footprint always have an explicit
 * height or levels tag; 12 m defaults on multi-thousand-sqm polygons are
 * strongly indicative of misclassified open areas.
 */
function isLikelyOpenArea(building: Building): boolean {
  const DEFAULT_HEIGHT = 12;
  if (building.height !== DEFAULT_HEIGHT) return false;
  return polygonAreaSqm(building.polygon) > 5_000;
}

// ── OSM Overpass API – fetch nearby buildings directly from browser ──

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const osmCache = new Map<string, { buildings: Building[]; timestamp: number }>();
const OSM_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — buildings don't change day-to-day

// ── Global Overpass request queue ──
// Serialises all Overpass network requests so only one is in-flight at a time,
// with at least 2 seconds between successive request starts. This prevents the
// 429 rate-limit errors that occur when ShadowLayer and venue popups fire
// simultaneous requests.

let _overpassTail: Promise<void> = Promise.resolve();
let _lastOverpassStart = 0;
const OVERPASS_MIN_INTERVAL_MS = 10_000; // max 1 request per 10 seconds

function enqueueOverpass<T>(fn: () => Promise<T>): Promise<T> {
  const result = _overpassTail.then(async (): Promise<T> => {
    const wait = OVERPASS_MIN_INTERVAL_MS - (Date.now() - _lastOverpassStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastOverpassStart = Date.now();
    return fn();
  });
  // Advance the tail (swallow errors so the queue never stalls)
  _overpassTail = result.then(() => {}, () => {});
  return result;
}

// Haversine distance in metres between two lat/lng points
function distMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * POST to Overpass with a 25-second browser timeout.
 * Retries across two public mirrors with exponential backoff:
 *   429 / 504 → 10 s, 20 s, 40 s between retries
 *   other 5xx → same schedule
 * Throws on total failure so the caller can fall back gracefully.
 */
async function overpassFetch(query: string): Promise<OverpassResponse> {
  const body = `data=${encodeURIComponent(query)}`;
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const maxAttempts = OVERPASS_ENDPOINTS.length * 2; // try each endpoint twice

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);

    try {
      const response = await fetch(endpoint, { method: "POST", headers, body, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 429 || response.status === 504 || response.status >= 500) {
        // Exponential backoff: 10 s → 20 s → 40 s
        const delay = 10_000 * Math.pow(2, Math.min(attempt, 2));
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) throw new Error(`Overpass ${response.status}`);

      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt < maxAttempts - 1) {
        const delay = 10_000 * Math.pow(2, Math.min(attempt, 2));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error("All Overpass endpoints failed");
}

export async function fetchBuildingsFromOSM(
  lat: number,
  lng: number,
  radiusMeters: number = 200
): Promise<Building[]> {
  // Use the Supabase buildings table for points inside the Stockholm coverage bbox.
  if (isInStockholmBbox(lat, lng)) {
    try {
      const { data, error } = await supabase.rpc("get_buildings_near", {
        center_lat: lat,
        center_lng: lng,
        radius_m: radiusMeters,
      });
      if (!error && data && data.length > 0) {
        const all = (data as Array<{ lat: number; lng: number; height: number; polygon: [number, number][] }>).map((row) => ({
          lat: row.lat as number,
          lng: row.lng as number,
          height: row.height as number,
          polygon: row.polygon as [number, number][],
        }));
        // Filter out polygons that are almost certainly misclassified open areas
        // (parks, squares) imported from an older OSM snapshot with building=yes.
        // These have a very large footprint and no explicit height (default 12 m).
        const filtered = all.filter((b) => !isLikelyOpenArea(b));
        if (filtered.length < all.length) {
          console.log(
            `[buildings] Supabase: dropped ${all.length - filtered.length} likely-open-area polygon(s) ` +
            `(>5000 sqm + default 12 m height) out of ${all.length} near (${lat.toFixed(4)}, ${lng.toFixed(4)})`
          );
        } else {
          console.log(`[buildings] Supabase: ${all.length} buildings near (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
        }
        return filtered;
      }
      console.warn(`[buildings] Supabase returned no data (error: ${error?.message}), falling back to Overpass`);
    } catch (e) {
      console.warn("[buildings] Supabase error, falling back to Overpass:", e);
    }
  }

  // Outside Stockholm (or static file unavailable) — fall back to Overpass.
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusMeters}`;
  const now = Date.now();

  const cached = osmCache.get(cacheKey);
  if (cached && now - cached.timestamp < OSM_CACHE_TTL) {
    return cached.buildings;
  }

  for (const [key, entry] of osmCache) {
    if (now - entry.timestamp > OSM_CACHE_TTL) continue;
    const parts = key.split(",");
    const cLat = parseFloat(parts[0]);
    const cLng = parseFloat(parts[1]);
    const cRadius = parseFloat(parts[2]);
    const dist = distMeters(lat, lng, cLat, cLng);
    if (dist + radiusMeters <= cRadius + 50) return entry.buildings;
  }

  // Exclude elements that carry building=yes but are actually open areas:
  //   - leisure=park/garden/pitch/playground (parks, sports fields)
  //   - landuse=grass/park/recreation_ground/meadow (open green space)
  //   - building=construction (not yet standing)
  // Also apply the same large-footprint + default-height filter used for the
  // Supabase path, in case an unusual OSM snapshot slips through the tag filter.
  const query =
    `[out:json][timeout:14];` +
    `(way["building"]` +
    `["building"!="construction"]` +
    `["leisure"!~"park|garden|pitch|playground|recreation_ground"]` +
    `["landuse"!~"grass|park|recreation_ground|meadow|greenfield"]` +
    `(around:${radiusMeters},${lat},${lng}););out body geom;`;
  try {
    const data = await enqueueOverpass(() => overpassFetch(query));
    const buildings: Building[] = (data.elements || [])
      .filter((el: OverpassElement) => el.geometry && el.geometry.length > 0)
      .map((el: OverpassElement) => ({
        lat: el.geometry![0].lat,
        lng: el.geometry![0].lon,
        height: parseFloat(el.tags?.["building:height"] || el.tags?.["height"] || "12"),
        polygon: el.geometry!.map((g: OverpassNode) => [g.lat, g.lon] as [number, number]),
      }))
      .filter((b: Building) => !isLikelyOpenArea(b));
    osmCache.set(cacheKey, { buildings, timestamp: Date.now() });
    console.log(`[buildings] Overpass: ${buildings.length} buildings near (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
    return buildings;
  } catch {
    return [];
  }
}

// ── Facade point calculation ──

/**
 * Closest point on segment A-B to point P, computed in metric space so
 * the unequal lat/lng degree scales don't distort the result.
 * Returns the point as [lat, lng] degrees.
 */
function closestPointOnSegment(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
  mPerDegLat: number, mPerDegLng: number
): [number, number] {
  // Translate to origin at A, then work in metres
  const bx = (bLng - aLng) * mPerDegLng;
  const by = (bLat - aLat) * mPerDegLat;
  const px = (pLng - aLng) * mPerDegLng;
  const py = (pLat - aLat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return [aLat, aLng];
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return [aLat + t * (bLat - aLat), aLng + t * (bLng - aLng)];
}

/**
 * Find the point 3 m outside the street-facing facade of the closest
 * building polygon to the venue's address coordinates.
 *
 * Address coordinates from Google Places are placed at the street-side of
 * a building (or on the pavement immediately in front of it), so the edge of
 * any nearby building polygon that is closest to those coordinates is the
 * facade facing the street. We step 3 m outward along that edge's normal
 * (away from the building interior, toward the street) so that shadow checks
 * reflect where a terrace patron actually sits rather than the building centroid.
 *
 * Falls back to the original venue coordinates when:
 *  - No buildings were fetched (Overpass unavailable)
 *  - The closest building edge is more than 30 m away (open area / park)
 *
 * Selection criterion (fixed): among all edges whose outward normal faces
 * toward the venue (dot > 0) and that are within MAX_SNAP_M, pick the
 * CLOSEST edge. The previous max-dot strategy let distant buildings with a
 * perfectly-aligned facade (dot ≈ 1.0) beat adjacent buildings whose south
 * wall had a slightly lower score (dot ≈ 0.9), placing the facade check
 * point on the wrong side of the building.
 */
export function getFacadePoint(
  venueLat: number,
  venueLng: number,
  buildings: Building[]
): { lat: number; lng: number } {
  if (buildings.length === 0) return { lat: venueLat, lng: venueLng };

  const FACADE_OFFSET_M = 3;
  const MAX_SNAP_M = 30; // ignore edges further than this
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((venueLat * Math.PI) / 180);

  // Pick the closest edge (within MAX_SNAP_M) whose outward normal faces the
  // venue — i.e. the edge with dot > 0 that is physically nearest to the
  // geocoded address point.
  let bestEdgeDist = Infinity;
  let bestLat = venueLat;
  let bestLng = venueLng;
  let anyNearby = false;

  for (const building of buildings) {
    const ring = building.polygon;
    const n =
      ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1]
        ? ring.length - 1
        : ring.length;
    if (n < 3) continue;

    // Centroid
    let centLat = 0, centLng = 0;
    for (let j = 0; j < n; j++) { centLat += ring[j][0]; centLng += ring[j][1]; }
    centLat /= n; centLng /= n;

    // Unit vector from centroid toward venue (metric space)
    const toVenueX = (venueLng - centLng) * mPerDegLng;
    const toVenueY = (venueLat - centLat) * mPerDegLat;
    const toVenueLen = Math.sqrt(toVenueX * toVenueX + toVenueY * toVenueY);
    if (toVenueLen === 0) continue;
    const toVenueNX = toVenueX / toVenueLen;
    const toVenueNY = toVenueY / toVenueLen;

    for (let i = 0; i < n; i++) {
      const [aLat, aLng] = ring[i];
      const [bLat, bLng] = ring[(i + 1) % n];

      // Outward normal direction: centroid → edge midpoint
      const midLat = (aLat + bLat) / 2;
      const midLng = (aLng + bLng) / 2;
      const normalX = (midLng - centLng) * mPerDegLng;
      const normalY = (midLat - centLat) * mPerDegLat;
      const normalLen = Math.sqrt(normalX * normalX + normalY * normalY);
      if (normalLen === 0) continue;

      // Only consider edges that face toward the venue (outward normal has a
      // positive component in the centroid→venue direction). Edges facing away
      // are the back wall and cannot be street-side terraces.
      const dot = (normalX / normalLen) * toVenueNX + (normalY / normalLen) * toVenueNY;
      if (dot <= 0) continue;

      // Compute distance from venue to this edge and accept if closest so far
      const [cLat, cLng] = closestPointOnSegment(
        venueLat, venueLng, aLat, aLng, bLat, bLng, mPerDegLat, mPerDegLng
      );
      const dLatM = (cLat - venueLat) * mPerDegLat;
      const dLngM = (cLng - venueLng) * mPerDegLng;
      const edgeDistM = Math.sqrt(dLatM * dLatM + dLngM * dLngM);

      if (edgeDistM <= MAX_SNAP_M && edgeDistM < bestEdgeDist) {
        anyNearby = true;
        bestEdgeDist = edgeDistM;
        bestLat = cLat + (normalY / normalLen) * FACADE_OFFSET_M / mPerDegLat;
        bestLng = cLng + (normalX / normalLen) * FACADE_OFFSET_M / mPerDegLng;
      }
    }
  }

  if (!anyNearby) return { lat: venueLat, lng: venueLng };
  return { lat: bestLat, lng: bestLng };
}

// ── Sun time-window calculation ──

const WINDOW_STEP_MS = 15 * 60 * 1000; // 15-minute steps
const WINDOW_LOOKAHEAD_MS = 30 * 60 * 60 * 1000; // look 30 h ahead (today + tomorrow)

/**
 * Look up cloud cover from the hourly forecast for a given moment.
 * Finds the last forecast entry whose timestamp is ≤ the query time
 * (i.e. the most recently known value). Falls back to `fallback` when
 * the forecast array is empty or the time is before all entries.
 */
function getCloudCoverAt(forecast: ForecastItem[], date: Date, fallback: number): number {
  const t = date.getTime();
  let result = fallback;
  for (const f of forecast) {
    if (f.time <= t) result = f.cloudCover;
    else break; // forecast is chronological; no need to scan further
  }
  return result;
}

function isVenueSunnyAt(
  lat: number,
  lng: number,
  buildings: Building[],
  forecast: ForecastItem[],
  fallbackCloudCover: number,
  date: Date
): boolean {
  const solar = getSolarPosition(date, lat, lng);
  if (solar.altitude <= 6) return false;
  if (getCloudCoverAt(forecast, date, fallbackCloudCover) >= 70) return false;
  return !buildings.some((b) =>
    isPointInBuildingShadow(lat, lng, b, solar.azimuth, solar.altitude)
  );
}

/**
 * Stepping forward in 15-minute increments from `fromDate`:
 * - If currently sunny → returns when the sun will disappear.
 * - If currently shaded → returns the next continuous sunny period.
 * Uses per-hour cloud cover from the weather forecast so that tomorrow's
 * sun window is accurate even when it's overcast right now.
 */
export function calculateSunWindow(
  lat: number,
  lng: number,
  buildings: Building[],
  weather: WeatherData | null,
  fromDate: Date
): SunWindow | null {
  const forecast = weather?.forecast ?? [];
  const fallbackCloudCover = weather?.cloudCover ?? 0;
  const limit = fromDate.getTime() + WINDOW_LOOKAHEAD_MS;

  const check = (t: number) =>
    isVenueSunnyAt(lat, lng, buildings, forecast, fallbackCloudCover, new Date(t));

  const currentlySunny = check(fromDate.getTime());

  if (currentlySunny) {
    for (let t = fromDate.getTime() + WINDOW_STEP_MS; t < limit; t += WINDOW_STEP_MS) {
      if (!check(t)) {
        return { type: "sunny_until" as const, end: new Date(t) };
      }
    }
    return null; // sunny for entire lookahead window
  }

  let sunStart: number | null = null;
  for (let t = fromDate.getTime() + WINDOW_STEP_MS; t < limit; t += WINDOW_STEP_MS) {
    const sunny = check(t);
    if (sunny && sunStart === null) {
      sunStart = t;
    } else if (!sunny && sunStart !== null) {
      return { type: "sunny_from" as const, start: new Date(sunStart), end: new Date(t) };
    }
  }
  if (sunStart !== null) {
    return { type: "sunny_from" as const, start: new Date(sunStart), end: new Date(limit) };
  }
  return null;
}

// ── Main SunService ──

/**
 * Fast synchronous estimate using solar position only — no API calls.
 * Sun altitude > 5° is treated as potentially sunny; lower angles and
 * night are treated as not sunny. Confidence is always "low" because
 * clouds and building shadows are not yet considered.
 */
export function quickSunStatus(lat: number, lng: number, date: Date): SunStatus {
  const solar = getSolarPosition(date, lat, lng);
  return {
    isSunny: solar.altitude > 6,
    buildingShadow: false,
    cloudCover: 0,
    solarAltitude: solar.altitude,
    solarAzimuth: solar.azimuth,
    confidence: "low",
  };
}

export async function calculateSunStatus(
  venueLat: number,
  venueLng: number,
  date: Date = new Date(),
  extraPoints?: Array<{ lat: number; lng: number }>
): Promise<SunStatus> {
  const solar = getSolarPosition(date, venueLat, venueLng);

  // Fetch weather and buildings concurrently — both are needed for the
  // sun-window calculation regardless of whether the sun is currently up.
  // Buildings are cached after the first call so subsequent fetches are free.
  const [weather, buildings] = await Promise.all([
    fetchWeather(venueLat, venueLng),
    fetchBuildingsFromOSM(venueLat, venueLng, 200),
  ]);
  const cloudCover = weather?.cloudCover ?? 0;
  const confidence: "high" | "medium" | "low" = buildings.length > 0 ? "high" : "low";

  // Find the street-facing facade point — this is where a terrace patron
  // actually sits, 3 m outside the closest building edge to the address.
  // All shadow and sun-window checks use this point instead of the raw
  // geocoded venue coordinate, which may be inside or behind the building.
  const { lat: checkLat, lng: checkLng } = getFacadePoint(venueLat, venueLng, buildings);

  // Sun below horizon — no shadow check needed, but pass buildings so the
  // window calculation can account for them in future daytime steps.
  // Below 6° the sun is at rooftop level or lower — street-level terraces are
  // in shade regardless of which specific building blocks the sun.
  if (solar.altitude <= 6) {
    const sunWindow = calculateSunWindow(checkLat, checkLng, buildings, weather, date);
    return {
      isSunny: false,
      buildingShadow: true,
      cloudCover,
      solarAltitude: solar.altitude,
      solarAzimuth: solar.azimuth,
      confidence,
      weather,
      sunWindow,
    };
  }

  // Helper: check if a coordinate is in shadow at the current solar position.
  const checkShadow = (lat: number, lng: number): boolean =>
    buildings.some((b) => isPointInBuildingShadow(lat, lng, b, solar.azimuth, solar.altitude));

  let buildingShadow = checkShadow(checkLat, checkLng);
  const mainSunny = !buildingShadow && cloudCover < 70;

  // For corner venues with extra terrace points, check each side.
  let isPartial: boolean | undefined;
  if (extraPoints && extraPoints.length > 0) {
    const extraSunny = extraPoints.map((p) => {
      const fp = getFacadePoint(p.lat, p.lng, buildings);
      return !checkShadow(fp.lat, fp.lng) && cloudCover < 70;
    });
    const anySunny = mainSunny || extraSunny.some(Boolean);
    const anyShady = !mainSunny || extraSunny.some((s) => !s);
    if (anySunny && anyShady) isPartial = true;
    // If partial, treat overall as "sunny" so the venue surfaces in sunny lists.
    const isSunny = anySunny;
    const sunWindow = calculateSunWindow(checkLat, checkLng, buildings, weather, date);
    return {
      isSunny,
      isPartial,
      buildingShadow,
      cloudCover,
      solarAltitude: solar.altitude,
      solarAzimuth: solar.azimuth,
      confidence,
      weather,
      sunWindow,
    };
  }

  const isSunny = mainSunny;
  const sunWindow = calculateSunWindow(checkLat, checkLng, buildings, weather, date);

  return {
    isSunny,
    buildingShadow,
    cloudCover,
    solarAltitude: solar.altitude,
    solarAzimuth: solar.azimuth,
    confidence,
    weather,
    sunWindow,
  };
}

// ── Batch processing ──

const VENUE_PROCESSING_CONCURRENCY = 2;

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

export async function calculateSunStatusForVenues(
  venues: Venue[],
  date: Date = new Date()
): Promise<Venue[]> {
  return mapWithConcurrencyLimit(
    venues,
    VENUE_PROCESSING_CONCURRENCY,
    async (venue) => {
      const sunStatus = await calculateSunStatus(venue.lat, venue.lng, date);
      return { ...venue, sunStatus };
    }
  );
}
