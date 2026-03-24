import { Venue } from "@/services/SunService";

const GOOGLE_PLACES_API_KEY = import.meta.env.VITE_GOOGLE_PLACES_API_KEY;

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

function formatOpeningHoursForToday(hours: any): string | undefined {
  const descriptions: string[] | undefined = hours?.weekdayDescriptions;
  if (!descriptions?.length) return undefined;
  // Google's weekdayDescriptions starts on Monday (index 0); JS getDay() is 0=Sunday
  const jsDay = new Date().getDay();
  const googleDay = jsDay === 0 ? 6 : jsDay - 1;
  const desc = descriptions[googleDay];
  if (!desc) return undefined;
  // Strip the day prefix, e.g. "Monday: 11:00 AM – 11:00 PM" → "11:00 AM – 11:00 PM"
  const match = desc.match(/:\s*(.+)$/);
  return match ? match[1] : undefined;
}

/**
 * Fetch outdoor dining venues near a position using the Google Places API
 * (Places API New – Nearby Search). Falls back to the static list when the
 * API key is absent or the request fails.
 *
 * Requires VITE_GOOGLE_PLACES_API_KEY in the environment.
 */
export async function fetchVenuesFromGooglePlaces(
  lat: number,
  lng: number,
  radiusMeters: number = 1000
): Promise<Venue[]> {
  if (!GOOGLE_PLACES_API_KEY) {
    console.warn(
      "VITE_GOOGLE_PLACES_API_KEY is not set – using static venue list"
    );
    return stockholmVenuesFallback;
  }

  try {
    const response = await fetch(
      "https://places.googleapis.com/v1/places:searchNearby",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": [
            "places.id",
            "places.displayName",
            "places.formattedAddress",
            "places.location",
            "places.rating",
            "places.regularOpeningHours",
            "places.outdoorSeating",
          ].join(","),
        },
        body: JSON.stringify({
          includedTypes: ["restaurant", "bar", "cafe"],
          maxResultCount: 20,
          locationRestriction: {
            circle: {
              center: { latitude: lat, longitude: lng },
              radius: radiusMeters,
            },
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Places API returned ${response.status}`);
    }

    const data = await response.json();
    const places: any[] = data.places ?? [];

    // Prefer venues that explicitly advertise outdoor seating; include all
    // restaurants/cafes regardless so the list is useful even without that tag.
    return places.map((place, index) => ({
      id: place.id ?? String(index),
      name: place.displayName?.text ?? "Unknown venue",
      address: place.formattedAddress ?? "",
      lat: place.location?.latitude ?? lat,
      lng: place.location?.longitude ?? lng,
      rating: place.rating,
      openingHours: formatOpeningHoursForToday(place.regularOpeningHours),
    }));
  } catch (error) {
    console.warn("Google Places fetch failed, using static fallback:", error);
    return stockholmVenuesFallback;
  }
}
