import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// WMO Weather Interpretation Codes → Swedish description + icon key
function describeWMO(code: number): { description: string; icon: string } {
  if (code === 0) return { description: "Klart", icon: "01d" };
  if (code <= 2) return { description: "Delvis molnigt", icon: "02d" };
  if (code === 3) return { description: "Mulet", icon: "04d" };
  if (code <= 48) return { description: "Dimma", icon: "50d" };
  if (code <= 57) return { description: "Duggregn", icon: "09d" };
  if (code <= 67) return { description: "Regn", icon: "10d" };
  if (code <= 77) return { description: "Snö", icon: "13d" };
  if (code <= 82) return { description: "Regnskurar", icon: "09d" };
  if (code <= 86) return { description: "Snöskurar", icon: "13d" };
  return { description: "Åska", icon: "11d" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const parsed = await req.json().catch(() => null);
    const { lat, lng } = parsed ?? {};

    if (lat == null || lng == null) {
      return new Response(JSON.stringify({ error: "lat and lng are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Open-Meteo — free, no API key required.
    // timeformat=unixtime returns all timestamps as Unix seconds (UTC), avoiding
    // the ambiguity of local datetime strings (Deno runs in UTC but Open-Meteo
    // returns local times when timezone=auto — they'd be misread as UTC).
    // forecast_days=2 gives 48 hourly entries for the 30-hour sun-window lookahead.
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,weather_code` +
      `&hourly=temperature_2m,cloud_cover,weather_code` +
      `&forecast_days=2&timezone=auto&timeformat=unixtime`;

    // Retry once on transient Open-Meteo failures (5xx / network error)
    let res = await fetch(url);
    if (!res.ok && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetch(url);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Open-Meteo failed [${res.status}]: ${body}`);
    }

    const data = await res.json();
    const current = data.current ?? {};
    const hourly = data.hourly ?? {};

    const { description, icon } = describeWMO(current.weather_code ?? 0);

    // hourly.time is now an array of Unix timestamps (seconds) — multiply by 1000 for ms.
    const times: number[] = hourly.time ?? [];
    const forecast = times.map((t: number, i: number) => {
      const { description: fd, icon: fi } = describeWMO(hourly.weather_code?.[i] ?? 0);
      return {
        time: t * 1000,
        cloudCover: hourly.cloud_cover?.[i] ?? 0,
        temperature: hourly.temperature_2m?.[i] ?? 0,
        weatherDescription: fd,
        weatherIcon: fi,
      };
    });

    const result = {
      cloudCover: current.cloud_cover ?? 0,
      temperature: current.temperature_2m ?? 0,
      weatherDescription: description,
      weatherIcon: icon,
      humidity: current.relative_humidity_2m ?? 0,
      windSpeed: current.wind_speed_10m ?? 0,
      forecast,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Weather API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
