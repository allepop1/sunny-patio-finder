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
  { id: "f1", name: "Mälarpaviljongen",      address: "Norr Mälarstrand 64",     lat: 59.3248, lng: 18.0530, rating: 4.3 },
  { id: "f2", name: "Strandvägskajen",        address: "Strandvägen 2",           lat: 59.3310, lng: 18.0795, rating: 4.1 },
  { id: "f3", name: "Trädgården",             address: "Hammarby Slussväg 2",     lat: 59.3060, lng: 18.0777, rating: 4.0 },
  { id: "f4", name: "Under Kastanjen",        address: "Kindstugatan 1",          lat: 59.3235, lng: 18.0710, rating: 4.4 },
  { id: "f5", name: "Rosendals Trädgårdskafé",address: "Rosendalsterrassen 12",   lat: 59.3265, lng: 18.1115, rating: 4.6 },
];

/**
 * Primary venue source: query the uteserveringar Supabase table for all
 * official outdoor-seating permit locations near the map centre.
 * Concurrently fetch Google Places nearby results and match by proximity
 * (≤ 60 m) to enrich name and rating where available.
 */
export async function fetchVenuesFromGooglePlaces(
  lat: number,
  lng: number,
  radiusMeters: number = 1500
): Promise<Venue[]> {
  // ── 1. Supabase uteserveringar (primary) ──
  const supabasePromise = supabase
    .rpc("get_uteserveringar_near", {
      center_lat: lat,
      center_lng: lng,
      radius_m: radiusMeters,
    })
    .then((r) => r.data as { id: number; lat: number; lng: number; address: string; kategorityp: string }[] | null);

  // ── 2. Google Places nearby (for name + rating enrichment) ──
  const placesPromise = supabase.functions
    .invoke("places-proxy", { body: { lat, lng, radius: radiusMeters } })
    .then((r) => (r.error ? [] : (r.data?.results ?? [])) as any[])
    .catch(() => [] as any[]);

  const [rows, places] = await Promise.all([supabasePromise, placesPromise]);

  if (!rows || rows.length === 0) {
    // Supabase failed — fall back to pure Google Places result
    return placesToVenues(places) || FALLBACK;
  }

  // ── 3. Match each uteservering to nearest Google Place (≤ 60 m) ──
  const venues: Venue[] = rows.map((row) => {
    let bestPlace: any = null;
    let bestDist = 60; // metres threshold

    for (const p of places) {
      const pLat = p.geometry?.location?.lat;
      const pLng = p.geometry?.location?.lng;
      if (pLat == null || pLng == null) continue;
      const d = distM(row.lat, row.lng, pLat, pLng);
      if (d < bestDist) { bestDist = d; bestPlace = p; }
    }

    return {
      id: String(row.id),
      name: bestPlace?.name ?? row.address,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      rating: bestPlace?.rating,
    };
  });

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

/**
 * Text search — unchanged, still uses Google Places text search.
 */
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
