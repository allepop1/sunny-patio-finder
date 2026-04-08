import { Venue } from "@/services/SunService";
import { supabase } from "@/integrations/supabase/client";

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

/**
 * Spatial dedup: if two permit points are within 20 m of each other, keep
 * only the first (the import already deduped by address string, this catches
 * variant suffixes like "20" vs "20A" at the same physical location).
 */
function spatialDedup(rows: UteRow[]): UteRow[] {
  const kept: UteRow[] = [];
  for (const row of rows) {
    const tooClose = kept.some((k) => distM(k.lat, k.lng, row.lat, row.lng) < 20);
    if (!tooClose) kept.push(row);
  }
  return kept;
}

export async function fetchVenuesFromGooglePlaces(
  lat: number,
  lng: number,
  radiusMeters: number = 1500,
  zoom: number = 14
): Promise<Venue[]> {

  // ── 1. Supabase uteserveringar (primary) ──
  console.log(`[uteserveringar] RPC (lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)}, radius=${radiusMeters}m)`);
  const supabasePromise = supabase
    .rpc("get_uteserveringar_near", { center_lat: lat, center_lng: lng, radius_m: radiusMeters })
    .then((r) => {
      if (r.error) { console.error("[uteserveringar] RPC error:", r.error); return null; }
      const rows = r.data as UteRow[] | null;
      console.log(`[uteserveringar] RPC returned ${rows?.length ?? 0} rows`);
      return rows;
    });

  // ── 2. Google Places nearby (name + rating enrichment) ──
  // Places returns max 60 results regardless of radius. Smaller radius at
  // high zoom = denser, more relevant results = better name matching.
  const placesRadius = zoom >= 16 ? 300 : zoom >= 15 ? 600 : 1500;
  console.log(`[places] search radius ${placesRadius}m (zoom ${zoom})`);
  const placesPromise = supabase.functions
    .invoke("places-proxy", { body: { lat, lng, radius: placesRadius } })
    .then((r) => {
      if (r.error) { console.warn("[places] proxy error:", r.error); return [] as any[]; }
      const results: any[] = r.data?.results ?? [];
      console.log(`[places] ${results.length} results returned`);
      if (results.length > 0) {
        console.log("[places] 5 sample vicinity/formatted_address:");
        results.slice(0, 5).forEach((p: any) => {
          console.log(`  "${p.name}" → vicinity="${p.vicinity}" formatted_address="${p.formatted_address ?? "(none)"}"`);
        });
      }
      return results;
    })
    .catch((e) => { console.warn("[places] fetch threw:", e); return [] as any[]; });

  const [rawRows, places] = await Promise.all([supabasePromise, placesPromise]);

  if (!rawRows || rawRows.length === 0) {
    console.warn("[uteserveringar] no rows — falling back to Google Places");
    return placesToVenues(places).length > 0 ? placesToVenues(places) : FALLBACK;
  }

  // ── 3. Spatial dedup ──
  const rows = spatialDedup(rawRows);
  console.log(`[uteserveringar] ${rawRows.length} → ${rows.length} after spatial dedup (20m)`);

  // ── 4. Match each uteservering to a Google Place ──
  // Parse street name and house number from an address string.
  // "Karlbergsvägen 52" → { street: "karlbergsvägen", num: 52 }
  // "Karlbergsvägen 46A" → { street: "karlbergsvägen", num: 46 }
  function parseAddr(s: string): { street: string; num: number } | null {
    const m = s.match(/^(.+?)\s+(\d+)/);
    if (!m) return null;
    return { street: m[1].toLowerCase().trim(), num: parseInt(m[2], 10) };
  }

  let matched = 0;

  const venues: Venue[] = rows.map((row) => {
    const rowAddr = parseAddr(row.address);

    let bestPlace: any = null;
    let bestDist = 150; // metres cap

    for (const p of places) {
      const pLat = p.geometry?.location?.lat;
      const pLng = p.geometry?.location?.lng;
      if (pLat == null || pLng == null) continue;
      const d = distM(row.lat, row.lng, pLat, pLng);
      if (d >= bestDist) continue;

      // Try vicinity first, then formatted_address
      const addrStr: string = p.vicinity ?? p.formatted_address ?? "";
      const placeAddr = parseAddr(addrStr);

      if (rowAddr && placeAddr) {
        // Require same street name and house numbers within 4
        if (placeAddr.street !== rowAddr.street) continue;
        if (Math.abs(placeAddr.num - rowAddr.num) > 4) continue;
      } else if (rowAddr) {
        // Place has no parseable address — skip (don't risk wrong match)
        continue;
      }

      bestDist = d;
      bestPlace = p;
    }

    if (bestPlace) matched++;
    return {
      id: String(row.id),
      name: bestPlace?.name ?? row.address,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      rating: bestPlace?.rating,
    };
  });

  console.log(`[places] matched ${matched}/${rows.length} (same street ±4 house numbers)`);
  return venues;
}

function placesToVenues(places: any[]): Venue[] {
  return places.map((p, i) => ({
    id: p.place_id ?? String(i),
    name: p.name ?? "Unknown",
    address: p.vicinity ?? "",
    lat: p.geometry?.location?.lat ?? 0,
    lng: p.geometry?.location?.lng ?? 0,
    rating: p.rating,
  }));
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
    return (data.results ?? []).map((p: any, i: number) => ({
      id: p.place_id ?? String(i),
      name: p.name ?? "Unknown",
      address: p.vicinity ?? p.formatted_address ?? "",
      lat: p.geometry?.location?.lat ?? lat,
      lng: p.geometry?.location?.lng ?? lng,
      rating: p.rating,
    }));
  } catch {
    return [];
  }
}
