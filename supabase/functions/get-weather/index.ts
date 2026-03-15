import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { lat, lng } = await req.json();

    if (!lat || !lng) {
      return new Response(JSON.stringify({ error: 'lat and lng are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const apiKey = Deno.env.get('OPENWEATHERMAP_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'OPENWEATHERMAP_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Current weather + cloud cover
    const currentRes = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}&units=metric&lang=sv`
    );

    if (!currentRes.ok) {
      const errBody = await currentRes.text();
      throw new Error(`OpenWeatherMap current weather failed [${currentRes.status}]: ${errBody}`);
    }

    const currentData = await currentRes.json();

    // 5-day/3-hour forecast for hourly cloud cover
    const forecastRes = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&appid=${apiKey}&units=metric&lang=sv&cnt=8`
    );

    let forecastData = null;
    if (forecastRes.ok) {
      forecastData = await forecastRes.json();
    } else {
      await forecastRes.text(); // consume body
    }

    const result = {
      cloudCover: currentData.clouds?.all ?? 0,
      temperature: currentData.main?.temp,
      weatherDescription: currentData.weather?.[0]?.description ?? '',
      weatherIcon: currentData.weather?.[0]?.icon ?? '',
      humidity: currentData.main?.humidity,
      windSpeed: currentData.wind?.speed,
      forecast: forecastData?.list?.map((item: any) => ({
        time: item.dt * 1000,
        cloudCover: item.clouds?.all ?? 0,
        temperature: item.main?.temp,
        weatherDescription: item.weather?.[0]?.description ?? '',
        weatherIcon: item.weather?.[0]?.icon ?? '',
      })) ?? [],
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Weather API error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
