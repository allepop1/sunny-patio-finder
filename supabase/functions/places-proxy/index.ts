import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface PlaceResult {
  place_id?: string;
  name?: string;
  vicinity?: string;
  formatted_address?: string;
  types?: string[];
  rating?: number;
  geometry?: { location?: { lat?: number; lng?: number } };
  [key: string]: unknown;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TYPES = ["restaurant", "bar", "cafe", "food"];
const MAX_RESULTS = 60;
const PAGE_DELAY_MS = 2000; // Google requires a pause before using next_page_token

async function fetchPage(url: string): Promise<{ results?: PlaceResult[]; next_page_token?: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Places returned ${res.status}`);
  return res.json();
}

/**
 * Fetch one type, up to maxPages pages.
 * Returns all results and the final page's next_page_token (if any).
 */
async function fetchType(
  apiKey: string,
  lat: number,
  lng: number,
  radius: number,
  type: string,
  maxPages: number
): Promise<PlaceResult[]> {
  const base = new URL(
    "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
  );
  base.searchParams.set("location", `${lat},${lng}`);
  base.searchParams.set("radius", String(radius));
  base.searchParams.set("type", type);
  base.searchParams.set("key", apiKey);

  const results: PlaceResult[] = [];
  let data = await fetchPage(base.toString());
  results.push(...(data.results ?? []));

  let token: string | undefined = data.next_page_token;
  let page = 1;

  while (token && page < maxPages) {
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    const pageUrl = new URL(
      "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
    );
    pageUrl.searchParams.set("pagetoken", token);
    pageUrl.searchParams.set("key", apiKey);
    data = await fetchPage(pageUrl.toString());
    results.push(...(data.results ?? []));
    token = data.next_page_token;
    page++;
  }

  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const parsed = await req.json().catch(() => null);
    const { lat, lng, radius, query } = parsed ?? {};

    if (lat == null || lng == null) {
      return new Response(
        JSON.stringify({ error: "lat and lng are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "GOOGLE_PLACES_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const searchRadius = radius ?? 1500;

    let merged: PlaceResult[];

    if (query) {
      // Text Search — find venues by name/description near a location.
      // Uses formatted_address instead of vicinity.
      const textUrl = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
      textUrl.searchParams.set("query", query);
      textUrl.searchParams.set("location", `${lat},${lng}`);
      textUrl.searchParams.set("radius", String(searchRadius));
      textUrl.searchParams.set("key", apiKey);

      const res = await fetch(textUrl.toString());
      if (!res.ok) throw new Error(`Google Places Text Search returned ${res.status}`);
      const data = await res.json();
      merged = data.results ?? [];

      // Normalise: text search returns formatted_address, nearby search returns vicinity.
      // Map formatted_address → vicinity so the client parser stays unchanged.
      merged = merged.map((p: PlaceResult) => ({
        ...p,
        vicinity: p.vicinity ?? p.formatted_address ?? "",
      }));
    } else {
      // Nearby Search — fetch all types concurrently with pagination.
      const allResults = await Promise.all(
        TYPES.map((type) => fetchType(apiKey, lat, lng, searchRadius, type, 3))
      );

      // Deduplicate by place_id, cap at MAX_RESULTS.
      const seen = new Set<string>();
      merged = [];
      for (const batch of allResults) {
        for (const place of batch) {
          const id = place.place_id;
          if (id && !seen.has(id)) {
            seen.add(id);
            merged.push(place);
            if (merged.length >= MAX_RESULTS) break;
          }
        }
        if (merged.length >= MAX_RESULTS) break;
      }
    }

    return new Response(
      JSON.stringify({ status: merged.length > 0 ? "OK" : "ZERO_RESULTS", results: merged }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Places proxy error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
