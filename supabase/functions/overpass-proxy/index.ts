import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { query } = await req.json();
    if (!query) {
      return new Response(JSON.stringify({ error: "Missing query" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = `data=${encodeURIComponent(query)}`;
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };

    for (const url of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(url, { method: "POST", body, headers });
        if (response.ok) {
          const data = await response.json();
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (!RETRYABLE_STATUSES.has(response.status)) {
          break;
        }
      } catch {
        continue;
      }
    }

    return new Response(JSON.stringify({ elements: [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
