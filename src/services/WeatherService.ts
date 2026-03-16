import { supabase } from "@/integrations/supabase/client";

export interface WeatherData {
  cloudCover: number; // 0-100
  temperature: number;
  weatherDescription: string;
  weatherIcon: string;
  humidity: number;
  windSpeed: number;
  forecast: ForecastItem[];
}

export interface ForecastItem {
  time: number;
  cloudCover: number;
  temperature: number;
  weatherDescription: string;
  weatherIcon: string;
}

// Cache to avoid repeated calls for same area
const weatherCache = new Map<string, { data: WeatherData; timestamp: number }>();
const pendingWeatherRequests = new Map<string, Promise<WeatherData | null>>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function cacheKey(lat: number, lng: number): string {
  // Round to ~1km grid
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

export async function fetchWeather(lat: number, lng: number): Promise<WeatherData | null> {
  const key = cacheKey(lat, lng);
  const cached = weatherCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const pendingRequest = pendingWeatherRequests.get(key);
  if (pendingRequest) {
    return pendingRequest;
  }

  const request = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke("get-weather", {
        body: { lat, lng },
      });

      if (error) {
        console.warn("Weather fetch failed:", error);
        return null;
      }

      const weatherData = data as WeatherData;
      weatherCache.set(key, { data: weatherData, timestamp: Date.now() });
      return weatherData;
    } catch (err) {
      console.warn("Weather service error:", err);
      return null;
    } finally {
      pendingWeatherRequests.delete(key);
    }
  })();

  pendingWeatherRequests.set(key, request);
  return request;
}
