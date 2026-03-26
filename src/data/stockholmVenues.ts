import { Venue } from "@/services/SunService";
import { supabase } from "@/integrations/supabase/client";

// Fallback list used when Google Places API key is not configured
export const stockholmVenuesFallback: Venue[] = [
  {
    id: "1",
    name: "Mälarpaviljongen",
    address: "Norr Mälarstrand 64",
    lat: 59.3248,
    lng: 18.0530,
    rating: 4.3,
    openingHours: "11:00–23:00",
  },
  {
    id: "2",
    name: "Strandvägskajen",
    address: "Strandvägen 2",
    lat: 59.3310,
    lng: 18.0795,
    rating: 4.1,
    openingHours: "11:00–22:00",
  },
  {
    id: "3",
    name: "Trädgården",
    address: "Hammarby Slussväg 2",
    lat: 59.3060,
    lng: 18.0777,
    rating: 4.0,
    openingHours: "16:00–01:00",
  },
  {
    id: "4",
    name: "Under Kastanjen",
    address: "Kindstugatan 1",
    lat: 59.3235,
    lng: 18.0710,
    rating: 4.4,
    openingHours: "11:00–22:00",
  },
  {
    id: "5",
    name: "Djuret",
    address: "Lilla Nygatan 5",
    lat: 59.3230,
    lng: 18.0700,
    rating: 4.5,
    openingHours: "17:00–23:00",
  },
  {
    id: "6",
    name: "Rosendals Trädgårdskafé",
    address: "Rosendalsterrassen 12",
    lat: 59.3265,
    lng: 18.1115,
    rating: 4.6,
    openingHours: "09:00–17:00",
  },
  {
    id: "7",
    name: "Bleck",
    address: "Sankt Eriksgatan 53",
    lat: 59.3370,
    lng: 18.0395,
    rating: 4.2,
    openingHours: "08:00–22:00",
  },
  {
    id: "8",
    name: "Eataly",
    address: "Regeringsgatan 48",
    lat: 59.3350,
    lng: 18.0670,
    rating: 4.1,
    openingHours: "10:00–23:00",
  },
  {
    id: "9",
    name: "Oaxen Slip",
    address: "Beckholmsvägen 26",
    lat: 59.3185,
    lng: 18.0945,
    rating: 4.4,
    openingHours: "11:30–22:00",
  },
  {
    id: "10",
    name: "Café Saturnus",
    address: "Eriksbergsgatan 6",
    lat: 59.3400,
    lng: 18.0715,
    rating: 4.3,
    openingHours: "08:00–20:00",
  },
  {
    id: "11",
    name: "Restaurang Hjerta",
    address: "Sveavägen 46",
    lat: 59.3375,
    lng: 18.0620,
    rating: 4.0,
    openingHours: "11:00–23:00",
  },
  {
    id: "12",
    name: "Gondolen",
    address: "Stadsgården 6",
    lat: 59.3183,
    lng: 18.0728,
    rating: 4.2,
    openingHours: "11:30–01:00",
  },
];

/**
 * Fetch outdoor dining venues near a position via the Supabase places-proxy
 * edge function (which calls Google Places Nearby Search server-side to avoid
 * CORS restrictions). Falls back to the static list on any error.
 */
export async function fetchVenuesFromGooglePlaces(
  lat: number,
  lng: number,
  radiusMeters: number = 1500
): Promise<Venue[]> {
  try {
    const { data, error } = await supabase.functions.invoke("places-proxy", {
      body: { lat, lng, radius: radiusMeters },
    });

    if (error) throw error;

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(`Places API status: ${data.status}`);
    }

    const results: any[] = data.results ?? [];
    return results.map((place, index) => ({
      id: place.place_id ?? String(index),
      name: place.name ?? "Unknown venue",
      address: place.vicinity ?? "",
      lat: place.geometry?.location?.lat ?? lat,
      lng: place.geometry?.location?.lng ?? lng,
      rating: place.rating,
    }));
  } catch (error) {
    console.warn("Google Places fetch failed, using static fallback:", error);
    return stockholmVenuesFallback;
  }
}

/**
 * Text search — finds venues matching a freetext query near a location.
 * Returns an empty array (not the fallback) so callers can distinguish
 * "no results" from "API error".
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
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(`Places API status: ${data.status}`);
    }

    return (data.results ?? []).map((place: any, index: number) => ({
      id: place.place_id ?? String(index),
      name: place.name ?? "Unknown venue",
      address: place.vicinity ?? "",
      lat: place.geometry?.location?.lat ?? lat,
      lng: place.geometry?.location?.lng ?? lng,
      rating: place.rating,
    }));
  } catch (error) {
    console.warn("Places text search failed:", error);
    return [];
  }
}
