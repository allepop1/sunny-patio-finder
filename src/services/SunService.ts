import SunCalc from "suncalc";
import { fetchWeather, type WeatherData, type ForecastItem } from "./WeatherService";

export interface SunWindow {
  /** "sunny_until" = currently sunny, will end at `end` */
  type: "sunny_until" | "sunny_from";
  start?: Date; // only set for "sunny_from"
  end: Date;
}

export interface SunStatus {
  isSunny: boolean;
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
 * Check if a point is in the shadow of a building.
 * Uses simplified ray casting: projects shadow from building centroid
 * in the direction opposite to the sun's azimuth.
 */
export function isPointInBuildingShadow(
  pointLat: number,
  pointLng: number,
  building: Building,
  solarAzimuthDeg: number,
  solarAltitudeDeg: number
): boolean {
  if (solarAltitudeDeg <= 0) return true; // nighttime = shadow

  const sLen = Math.min(shadowLength(building.height, solarAltitudeDeg), 200);
  if (sLen <= 0) return false;

  // Building centroid
  const centroidLat =
    building.polygon.reduce((s, p) => s + p[0], 0) / building.polygon.length;
  const centroidLng =
    building.polygon.reduce((s, p) => s + p[1], 0) / building.polygon.length;

  // Shadow direction: opposite of sun azimuth
  const shadowAzimuthRad = ((solarAzimuthDeg + 180) % 360) * (Math.PI / 180);

  // Shadow tip position (approximate meters -> degrees)
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos((centroidLat * Math.PI) / 180);

  const shadowTipLat =
    centroidLat + (sLen * Math.cos(shadowAzimuthRad)) / metersPerDegreeLat;
  const shadowTipLng =
    centroidLng + (sLen * Math.sin(shadowAzimuthRad)) / metersPerDegreeLng;

  // Check if point is within the shadow "cone"
  // Simplified: check if point is within a rectangle from building to shadow tip
  // with some width tolerance based on building footprint size
  const buildingRadius = estimateBuildingRadius(building);
  const toleranceMeters = buildingRadius + 5; // 5m margin

  // Project point onto shadow line
  const dx = pointLng - centroidLng;
  const dy = pointLat - centroidLat;

  const shadowDx = shadowTipLng - centroidLng;
  const shadowDy = shadowTipLat - centroidLat;

  const shadowLen2 = shadowDx * shadowDx + shadowDy * shadowDy;
  if (shadowLen2 === 0) return false;

  // t = projection scalar
  const t = (dx * shadowDx + dy * shadowDy) / shadowLen2;
  if (t < -0.1 || t > 1.1) return false; // point not along shadow

  // Perpendicular distance
  const projX = centroidLng + t * shadowDx;
  const projY = centroidLat + t * shadowDy;

  const perpDx = (pointLng - projX) * metersPerDegreeLng;
  const perpDy = (pointLat - projY) * metersPerDegreeLat;
  const perpDist = Math.sqrt(perpDx * perpDx + perpDy * perpDy);

  return perpDist < toleranceMeters;
}

function estimateBuildingRadius(building: Building): number {
  const centroidLat =
    building.polygon.reduce((s, p) => s + p[0], 0) / building.polygon.length;
  const centroidLng =
    building.polygon.reduce((s, p) => s + p[1], 0) / building.polygon.length;

  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos((centroidLat * Math.PI) / 180);

  let maxDist = 0;
  for (const [lat, lng] of building.polygon) {
    const dLat = (lat - centroidLat) * metersPerDegreeLat;
    const dLng = (lng - centroidLng) * metersPerDegreeLng;
    const dist = Math.sqrt(dLat * dLat + dLng * dLng);
    if (dist > maxDist) maxDist = dist;
  }
  return maxDist;
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
const OVERPASS_MIN_INTERVAL_MS = 2000;

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
 * POST to Overpass with a 15-second browser timeout.
 * Retries across two public mirrors with exponential backoff on
 * rate-limit (429) or server errors (5xx). Throws on total failure.
 */
async function overpassFetch(query: string): Promise<any> {
  const body = `data=${encodeURIComponent(query)}`;
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const maxAttempts = OVERPASS_ENDPOINTS.length * 2; // try each endpoint twice

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(endpoint, { method: "POST", headers, body, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 429 || response.status >= 500) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) throw new Error(`Overpass returned ${response.status}`);

      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt < maxAttempts - 1) {
        const delay = Math.pow(2, Math.min(attempt, 2)) * 500;
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
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusMeters}`;
  const now = Date.now();

  // Exact-key cache hit
  const cached = osmCache.get(cacheKey);
  if (cached && now - cached.timestamp < OSM_CACHE_TTL) {
    return cached.buildings;
  }

  // Covering-area cache hit: check whether any existing cache entry's circle
  // fully contains the requested area. This lets ShadowLayer's large-radius
  // fetch (r=500m around map centre) satisfy subsequent venue queries (r=200m)
  // without a separate Overpass request, and vice-versa.
  for (const [key, entry] of osmCache) {
    if (now - entry.timestamp > OSM_CACHE_TTL) continue;
    const parts = key.split(",");
    const cLat = parseFloat(parts[0]);
    const cLng = parseFloat(parts[1]);
    const cRadius = parseFloat(parts[2]);
    const dist = distMeters(lat, lng, cLat, cLng);
    if (dist + radiusMeters <= cRadius + 50) {
      return entry.buildings;
    }
  }

  // Overpass query timeout matches the fetch AbortController timeout.
  // Enqueue so at most one request is in-flight at a time.
  const query = `[out:json][timeout:14];(way["building"](around:${radiusMeters},${lat},${lng}););out body geom;`;

  try {
    const data = await enqueueOverpass(() => overpassFetch(query));
    const buildings: Building[] = (data.elements || [])
      .filter((el: any) => el.geometry && el.geometry.length > 0)
      .map((el: any) => ({
        lat: el.geometry[0].lat,
        lng: el.geometry[0].lon,
        height: parseFloat(el.tags?.["building:height"] || el.tags?.["height"] || "8"),
        polygon: el.geometry.map((g: any) => [g.lat, g.lon] as [number, number]),
      }));

    osmCache.set(cacheKey, { buildings, timestamp: Date.now() });
    return buildings;
  } catch (error) {
    console.warn("[fetchBuildingsFromOSM] all retries failed:", error);
    return [];
  }
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
  if (solar.altitude <= 5) return false;
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
    isSunny: solar.altitude > 5,
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
  date: Date = new Date()
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

  // Sun below horizon — no shadow check needed, but pass buildings so the
  // window calculation can account for them in future daytime steps.
  if (solar.altitude <= 0) {
    const sunWindow = calculateSunWindow(venueLat, venueLng, buildings, weather, date);
    return {
      isSunny: false,
      buildingShadow: false,
      cloudCover,
      solarAltitude: solar.altitude,
      solarAzimuth: solar.azimuth,
      confidence,
      weather,
      sunWindow,
    };
  }

  let buildingShadow = false;

  for (const building of buildings) {
    if (isPointInBuildingShadow(venueLat, venueLng, building, solar.azimuth, solar.altitude)) {
      buildingShadow = true;
      break;
    }
  }

  const isSunny = !buildingShadow && cloudCover < 70;
  const sunWindow = calculateSunWindow(venueLat, venueLng, buildings, weather, date);

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
