import { Venue } from "@/services/SunService";
import { supabase } from "@/integrations/supabase/client";

interface GooglePlaceResult {
  place_id?: string;
  name?: string;
  vicinity?: string;
  formatted_address?: string;
  types?: string[];
  rating?: number;
  geometry?: { location?: { lat?: number; lng?: number } };
}

// Haversine distance in metres
function distM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fallback for when both sources fail
const FALLBACK: Venue[] = [
  { id: "f1", name: "Mälarpaviljongen",       address: "Norr Mälarstrand 64",   lat: 59.3248, lng: 18.0530, rating: 4.3 },
  { id: "f2", name: "Strandvägskajen",         address: "Strandvägen 2",         lat: 59.3310, lng: 18.0795, rating: 4.1 },
  { id: "f3", name: "Trädgården",              address: "Hammarby Slussväg 2",   lat: 59.3060, lng: 18.0777, rating: 4.0 },
  { id: "f4", name: "Under Kastanjen",         address: "Kindstugatan 1",        lat: 59.3235, lng: 18.0710, rating: 4.4 },
  { id: "f5", name: "Rosendals Trädgårdskafé", address: "Rosendalsterrassen 12", lat: 59.3265, lng: 18.1115, rating: 4.6 },
];

type UteRow = { id: number; lat: number; lng: number; address: string; kategorityp: string };

type CacheRow = {
  address: string;
  name: string | null;
  venue_type: string | null;
  rating: number | null;
};

const CACHE_TTL_DAYS = 30;

/** Extract normalised street name from an address string (drops house number). */
function extractStreetName(address: string): string {
  const m = address.match(/^(.+?)\s+\d+/);
  return m ? m[1].toLowerCase().trim() : address.toLowerCase().trim();
}

interface PermitCluster {
  rows: UteRow[];
  isCorner: boolean; // true when multiple distinct street names in the cluster
}

/**
 * Clusters nearby permits:
 * - same street + within 20 m → same venue (dedup)
 * - different street + within 12 m → corner venue (multi-point terrace)
 * Uses union-find so transitive neighbours are merged correctly.
 */
function clusterVenues(rows: UteRow[]): PermitCluster[] {
  const n = rows.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = distM(rows[i].lat, rows[i].lng, rows[j].lat, rows[j].lng);
      const sameStreet =
        extractStreetName(rows[i].address) === extractStreetName(rows[j].address);
      if ((sameStreet && d < 20) || (!sameStreet && d < 12)) {
        parent[find(i)] = find(j);
      }
    }
  }

  const map = new Map<number, UteRow[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!map.has(root)) map.set(root, []);
    map.get(root)!.push(rows[i]);
  }

  return Array.from(map.values()).map((clusterRows) => {
    const streets = new Set(clusterRows.map((r) => extractStreetName(r.address)));
    return { rows: clusterRows, isCorner: streets.size > 1 };
  });
}

// Parse street name and house number from an address string.
// "Karlbergsvägen 52" → { street: "karlbergsvägen", num: 52 }
// "Karlbergsvägen 46A" → { street: "karlbergsvägen", num: 46 }
function parseAddr(s: string): { street: string; num: number } | null {
  const m = s.match(/^(.+?)\s+(\d+)/);
  if (!m) return null;
  return { street: m[1].toLowerCase().trim(), num: parseInt(m[2], 10) };
}

// Priority order for type detection from Google Places types array
const TYPE_PRIORITY = ["bar", "cafe", "bakery", "restaurant"] as const;

function venueTypeFromPlaces(types: string[] | undefined): string {
  if (!types) return "default";
  for (const t of TYPE_PRIORITY) {
    if (types.includes(t)) return t;
  }
  return "default";
}

function venueTypeFromKategorityp(k: string): string {
  const lower = k.toLowerCase();
  if (lower.includes("bar") || lower.includes("pub")) return "bar";
  if (lower.includes("café") || lower.includes("cafe") || lower.includes("kafé")) return "cafe";
  if (lower.includes("bageri") || lower.includes("konditori")) return "bakery";
  if (lower.includes("restaurang") || lower.includes("restaurant")) return "restaurant";
  return "default";
}

export async function fetchVenuesFromGooglePlaces(
  lat: number,
  lng: number,
  radiusMeters: number = 1500,
  zoom: number = 14
): Promise<Venue[]> {

  // ── 1. Supabase uteserveringar ──
  console.log(`[uteserveringar] RPC (lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)}, radius=${radiusMeters}m)`);
  const { error: rpcError, data: rawData } = await supabase
    .rpc("get_uteserveringar_near", { center_lat: lat, center_lng: lng, radius_m: radiusMeters });

  if (rpcError) console.error("[uteserveringar] RPC error:", rpcError);
  const rawRows = rawData as UteRow[] | null;
  console.log(`[uteserveringar] RPC returned ${rawRows?.length ?? 0} rows`);

  if (!rawRows || rawRows.length === 0) {
    // No permit data — attempt a direct Places search as fallback
    const { data: fbData } = await supabase.functions.invoke("places-proxy", {
      body: { lat, lng, radius: 1500 },
    });
    const fbPlaces: GooglePlaceResult[] = fbData?.results ?? [];
    return placesToVenues(fbPlaces).length > 0 ? placesToVenues(fbPlaces) : FALLBACK;
  }

  // ── 2. Cluster permits (dedup same-street duplicates + group corner venues) ──
  const clusters = clusterVenues(rawRows);
  const cornerCount = clusters.filter((c) => c.isCorner).length;
  console.log(
    `[uteserveringar] ${rawRows.length} permits → ${clusters.length} venues ` +
    `(${cornerCount} corner clusters)`
  );
  // Use the first permit in each cluster as the representative row for
  // cache + Places lookups; other rows in the cluster supply extra points.
  const rows = clusters.map((c) => c.rows[0]);

  // ── 3. Cache lookup ──
  // Fetch all address entries that are still fresh (< 30 days old).
  // Cached name=null means we already tried and found no Places match — still a hit,
  // so we don't re-query Google for unmatched venues on every map view.
  const addresses = rows.map((r) => r.address);
  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: cacheData, error: cacheErr } = await supabase
    .from("places_cache")
    .select("address, name, venue_type, rating")
    .in("address", addresses)
    .gt("cached_at", cutoff);

  if (cacheErr) console.warn("[cache] lookup error:", cacheErr.message);

  const cacheMap = new Map<string, CacheRow>(
    (cacheData ?? []).map((c) => [c.address, c])
  );

  const cachedCount  = addresses.filter((a) => cacheMap.has(a)).length;
  const missingCount = addresses.length - cachedCount;
  console.log(`[cache] ${cachedCount}/${addresses.length} addresses hit (${missingCount} need Google)`);

  // ── 4. Google Places — only when there are uncached addresses ──
  let places: GooglePlaceResult[] = [];

  if (missingCount > 0) {
    const placesRadius = zoom >= 16 ? 300 : zoom >= 15 ? 600 : 1500;
    console.log(`[places] fetching (radius=${placesRadius}m, zoom=${zoom})…`);
    const { data: placesData, error: placesErr } = await supabase.functions.invoke(
      "places-proxy",
      { body: { lat, lng, radius: placesRadius } }
    );
    if (placesErr) console.warn("[places] proxy error:", placesErr);
    places = placesData?.results ?? [];
    console.log(`[places] ${places.length} results`);
  } else {
    console.log("[places] all addresses cached — skipping Google API call ✓");
  }

  // ── 5. Match + build venues ──
  const newCacheEntries: CacheRow[] = [];
  let matched = 0;

  // Build a map from representative row id → cluster for attaching extra points.
  const clusterByRepId = new Map<number, PermitCluster>(
    clusters.map((c) => [c.rows[0].id, c])
  );

  const venues: Venue[] = rows.map((row) => {
    const cluster = clusterByRepId.get(row.id)!;

    // ── Cache hit: use stored result ──
    if (cacheMap.has(row.address)) {
      const cached = cacheMap.get(row.address)!;
      const venueType = cached.venue_type ?? venueTypeFromKategorityp(row.kategorityp);
      const venue: Venue = {
        id:        String(row.id),
        name:      cached.name ?? row.address,
        address:   row.address,
        lat:       row.lat,
        lng:       row.lng,
        rating:    cached.rating ?? undefined,
        venueType,
      };
      if (cluster.isCorner && cluster.rows.length > 1) {
        venue.points      = cluster.rows.map((r) => ({ lat: r.lat, lng: r.lng }));
        venue.allAddresses = cluster.rows.map((r) => r.address);
      }
      return venue;
    }

    // ── Cache miss: match against fresh Places results ──
    const rowAddr = parseAddr(row.address);
    let bestPlace: GooglePlaceResult | null = null;
    let bestDist = 150;

    for (const p of places) {
      const pLat = p.geometry?.location?.lat;
      const pLng = p.geometry?.location?.lng;
      if (pLat == null || pLng == null) continue;
      const d = distM(row.lat, row.lng, pLat, pLng);
      if (d >= bestDist) continue;

      const addrStr: string = p.vicinity ?? p.formatted_address ?? "";
      const placeAddr = parseAddr(addrStr);

      if (rowAddr && placeAddr) {
        if (placeAddr.street !== rowAddr.street) continue;
        if (placeAddr.num !== rowAddr.num) continue;      // exact house number
      } else if (rowAddr) {
        continue;
      }

      bestDist  = d;
      bestPlace = p;
    }

    if (bestPlace) matched++;

    // Write result to cache — including misses (name: null) so we don't
    // re-query Google for this address until the cache entry expires.
    newCacheEntries.push({
      address:    row.address,
      name:       bestPlace?.name ?? null,
      venue_type: bestPlace ? venueTypeFromPlaces(bestPlace.types) : null,
      rating:     bestPlace?.rating ?? null,
    });

    const venueType = bestPlace
      ? venueTypeFromPlaces(bestPlace.types)
      : venueTypeFromKategorityp(row.kategorityp);

    const venue: Venue = {
      id:        String(row.id),
      name:      bestPlace?.name ?? row.address,
      address:   row.address,
      lat:       row.lat,
      lng:       row.lng,
      rating:    bestPlace?.rating,
      venueType,
    };
    if (cluster.isCorner && cluster.rows.length > 1) {
      venue.points      = cluster.rows.map((r) => ({ lat: r.lat, lng: r.lng }));
      venue.allAddresses = cluster.rows.map((r) => r.address);
    }
    return venue;
  });

  if (missingCount > 0) {
    console.log(`[places] matched ${matched}/${missingCount} uncached addresses`);
  }

  // ── 6. Write new cache entries (fire-and-forget) ──
  if (newCacheEntries.length > 0) {
    supabase
      .from("places_cache")
      .upsert(newCacheEntries, { onConflict: "address" })
      .then(({ error }) => {
        if (error) console.warn("[cache] write error:", error.message);
        else console.log(`[cache] wrote ${newCacheEntries.length} entries`);
      });
  }

  return venues;
}

function placesToVenues(places: GooglePlaceResult[]): Venue[] {
  return places.map((p, i) => {
    const types: string[] = p.types ?? [];
    let venueType = "default";
    for (const t of ["bar", "cafe", "bakery", "restaurant"] as const) {
      if (types.includes(t)) { venueType = t; break; }
    }
    return {
      id:        p.place_id ?? String(i),
      name:      p.name ?? "Unknown",
      address:   p.vicinity ?? "",
      lat:       p.geometry?.location?.lat ?? 0,
      lng:       p.geometry?.location?.lng ?? 0,
      rating:    p.rating,
      venueType,
    };
  });
}

export async function searchVenuesByText(
  query: string,
  lat: number,
  lng: number
): Promise<Venue[]> {
  try {
    const { data, error } = await supabase.functions.invoke("places-proxy", {
      body: { query, lat, lng, radius: 5000 },
    });
    if (error) throw error;
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") throw new Error(data.status);
    return ((data.results ?? []) as GooglePlaceResult[]).map((p, i) => ({
      id:      p.place_id ?? String(i),
      name:    p.name ?? "Unknown",
      address: p.vicinity ?? p.formatted_address ?? "",
      lat:     p.geometry?.location?.lat ?? lat,
      lng:     p.geometry?.location?.lng ?? lng,
      rating:  p.rating,
    }));
  } catch {
    return [];
  }
}
