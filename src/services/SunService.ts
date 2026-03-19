import SunCalc from "suncalc";
import { fetchWeather, type WeatherData } from "./WeatherService";

export interface SunStatus {
  isSunny: boolean;
  buildingShadow: boolean;
  cloudCover: number; // 0-100
  solarAltitude: number;
  solarAzimuth: number;
  confidence: "high" | "medium" | "low";
  weather?: WeatherData | null;
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

  const sLen = shadowLength(building.height, solarAltitudeDeg);
  if (sLen > 500) return false; // shadow too long = unreliable, skip

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

// ── OSM Overpass API – fetch nearby buildings with height data ──

const osmCache = new Map<string, { buildings: Building[]; timestamp: number }>();
const OSM_CACHE_TTL = 30 * 60 * 1000; // 30 minutes – buildings don't change often

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelayMs: number = 3000
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;

      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 2000;
        console.info(`Overpass ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw new Error(`Overpass API error: ${response.status}`);
    } catch (error) {
      if (attempt < maxRetries && error instanceof TypeError) {
        // Network error — retry
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 2000;
        console.info(`Overpass network error, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Overpass API: max retries exceeded");
}

export async function fetchBuildingsFromOSM(
  lat: number,
  lng: number,
  radiusMeters: number = 200
): Promise<Building[]> {
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusMeters}`;
  const cached = osmCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < OSM_CACHE_TTL) {
    return cached.buildings;
  }

  const query = `
    [out:json][timeout:10];
    (
      way["building"]["building:height"](around:${radiusMeters},${lat},${lng});
      way["building"]["height"](around:${radiusMeters},${lat},${lng});
    );
    out body geom;
  `;

  try {
    const response = await fetchWithRetry(
      "https://overpass-api.de/api/interpreter",
      {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const data = await response.json();
    const buildings: Building[] = data.elements
      .filter((el: any) => el.geometry && el.geometry.length > 0)
      .map((el: any) => ({
        lat: el.geometry[0].lat,
        lng: el.geometry[0].lon,
        height: parseFloat(
          el.tags["building:height"] || el.tags["height"] || "10"
        ),
        polygon: el.geometry.map((g: any) => [g.lat, g.lon] as [number, number]),
      }));

    osmCache.set(cacheKey, { buildings, timestamp: Date.now() });
    return buildings;
  } catch (error) {
    console.warn("OSM building fetch failed, using estimates:", error);
    return [];
  }
}

// ── Main SunService ──

export async function calculateSunStatus(
  venueLat: number,
  venueLng: number,
  date: Date = new Date()
): Promise<SunStatus> {
  const solar = getSolarPosition(date, venueLat, venueLng);

  // Sun below horizon
  if (solar.altitude <= 0) {
    return {
      isSunny: false,
      buildingShadow: false,
      cloudCover: 0,
      solarAltitude: solar.altitude,
      solarAzimuth: solar.azimuth,
      confidence: "high",
    };
  }

  // Fetch buildings
  const buildings = await fetchBuildingsFromOSM(venueLat, venueLng, 200);

  let buildingShadow = false;
  let confidence: "high" | "medium" | "low" = buildings.length > 0 ? "high" : "low";

  for (const building of buildings) {
    if (
      isPointInBuildingShadow(
        venueLat,
        venueLng,
        building,
        solar.azimuth,
        solar.altitude
      )
    ) {
      buildingShadow = true;
      break;
    }
  }

  // If no buildings found, use low confidence but assume sunny
  if (buildings.length === 0) {
    confidence = "low";
  }

  // Fetch real cloud cover from OpenWeatherMap
  const weather = await fetchWeather(venueLat, venueLng);
  const cloudCover = weather?.cloudCover ?? 0;

  // Combine: sunny only if no building shadow AND not too cloudy
  const isSunny = !buildingShadow && cloudCover < 70;

  return {
    isSunny,
    buildingShadow,
    cloudCover,
    solarAltitude: solar.altitude,
    solarAzimuth: solar.azimuth,
    confidence,
    weather,
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
