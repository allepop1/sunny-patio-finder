import { useState, useEffect, useRef } from "react";
import { Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Sun, Cloud, Loader2, MapPin, Building2 } from "lucide-react";
import { getSolarPosition, fetchBuildingsFromOSM, isPointInBuildingShadow } from "@/services/SunService";
import { fetchWeather } from "@/services/WeatherService";

const clickIcon = L.divIcon({
  className: "click-marker",
  html: `<div style="width:28px;height:28px;border-radius:50%;background:hsl(210,60%,50%);border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
  </div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -18],
});

interface SunResult {
  isSunny: boolean;
  solarAltitude: number;
  cloudCover: number;
  confidence: "high" | "medium" | "low";
  buildingShadow: boolean;
}

interface ClickedPoint {
  lat: number;
  lng: number;
  sunResult: SunResult | null;
  loading: boolean;
  address: string | null;
  refining: boolean; // building data loading in background
}

interface MapClickHandlerProps {
  date: Date;
}

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&zoom=18`,
      { headers: { "Accept-Language": "sv" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const a = data.address;
    if (!a) return data.display_name || null;
    const road = a.road || a.pedestrian || a.path || "";
    const number = a.house_number || "";
    const district = a.suburb || a.neighbourhood || a.city_district || "";
    const parts = [road && number ? `${road} ${number}` : road, district].filter(Boolean);
    return parts.join(", ") || data.display_name || null;
  } catch {
    return null;
  }
}

/** Phase 1: Fast sun check (solar position + weather, no buildings) */
async function quickSunCheck(lat: number, lng: number, date: Date): Promise<SunResult> {
  const solar = getSolarPosition(date, lat, lng);

  if (solar.altitude <= 0) {
    return { isSunny: false, solarAltitude: solar.altitude, cloudCover: 0, confidence: "high", buildingShadow: false };
  }

  const weather = await fetchWeather(lat, lng);
  const cloudCover = weather?.cloudCover ?? 0;

  return {
    isSunny: cloudCover < 70 && solar.altitude > 0,
    solarAltitude: solar.altitude,
    cloudCover,
    confidence: "low",
    buildingShadow: false,
  };
}

/** Phase 2: Refine with building shadow data */
async function refineSunCheck(lat: number, lng: number, date: Date, base: SunResult): Promise<SunResult> {
  const solar = getSolarPosition(date, lat, lng);
  if (solar.altitude <= 0) return { ...base, confidence: "high" };

  try {
    const buildings = await fetchBuildingsFromOSM(lat, lng, 200);
    let buildingShadow = false;

    for (const building of buildings) {
      if (isPointInBuildingShadow(lat, lng, building, solar.azimuth, solar.altitude)) {
        buildingShadow = true;
        break;
      }
    }

    const confidence = buildings.length > 0 ? "high" : "low";
    const isSunny = !buildingShadow && base.cloudCover < 70;

    return { ...base, isSunny, buildingShadow, confidence };
  } catch {
    return base; // keep quick result on failure
  }
}

export function MapClickHandler({ date }: MapClickHandlerProps) {
  const [point, setPoint] = useState<ClickedPoint | null>(null);
  const clickIdRef = useRef(0);

  useMapEvents({
    click: async (e) => {
      const { lat, lng } = e.latlng;
      const id = ++clickIdRef.current;
      setPoint({ lat, lng, sunResult: null, loading: true, address: null, refining: false });

      // Phase 1: quick result + geocode
      const [result, address] = await Promise.all([
        quickSunCheck(lat, lng, date),
        reverseGeocode(lat, lng),
      ]);

      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: result, loading: false, address, refining: true });

      // Phase 2: refine with building data in background
      const refined = await refineSunCheck(lat, lng, date, result);
      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: refined, loading: false, address, refining: false });
    },
  });

  // Recalculate when date changes
  useEffect(() => {
    if (!point || point.loading) return;
    const { lat, lng, address } = point;
    const id = ++clickIdRef.current;
    setPoint((prev) => prev ? { ...prev, loading: true, refining: false } : null);

    (async () => {
      const result = await quickSunCheck(lat, lng, date);
      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: result, loading: false, address, refining: true });

      const refined = await refineSunCheck(lat, lng, date, result);
      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: refined, loading: false, address, refining: false });
    })();
  }, [date]);

  if (!point) return null;

  const s = point.sunResult;

  return (
    <Marker position={[point.lat, point.lng]} icon={clickIcon}>
      <Popup className="venue-popup" maxWidth={280} minWidth={240} autoPan>
        <div className="p-1">
          {point.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Kollar solläget…</span>
            </div>
          ) : s ? (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div
                  className={`flex items-center justify-center rounded-full p-2 ${
                    s.isSunny ? "bg-sunny/20" : "bg-shady/20"
                  }`}
                >
                  {s.isSunny ? (
                    <Sun className="h-5 w-5 text-sunny" strokeWidth={2.5} />
                  ) : (
                    <Cloud className="h-5 w-5 text-shady" strokeWidth={2} />
                  )}
                </div>
                <span
                  className={`text-base font-semibold ${
                    s.isSunny ? "text-sunny-foreground" : "text-shady-foreground"
                  }`}
                >
                  {s.isSunny ? "I solen ☀️" : "I skuggan"}
                </span>
              </div>

              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-2">
                <MapPin className="h-3 w-3" />
                <span>
                  {point.address || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`}
                </span>
              </div>

              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between">
                  <span>Solhöjd</span>
                  <span>{s.solarAltitude.toFixed(1)}°</span>
                </div>
                <div className="flex justify-between">
                  <span>Moln</span>
                  <span>{s.cloudCover}%</span>
                </div>
                {s.buildingShadow && (
                  <div className="flex items-center gap-1 text-shady-foreground">
                    <Building2 className="h-3 w-3" />
                    <span>Byggnadsskugga</span>
                  </div>
                )}
                {point.refining ? (
                  <div className="flex items-center gap-1 italic">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Hämtar byggnadsdata…</span>
                  </div>
                ) : s.confidence === "high" ? (
                  <div className="flex items-center gap-1 text-sunny-foreground">
                    <Building2 className="h-3 w-3" />
                    <span>Med byggnadsdata</span>
                  </div>
                ) : (
                  <div className="italic">Uppskattning (utan byggnadsdata)</div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground py-2">
              Kunde inte kontrollera solläget
            </div>
          )}
        </div>
      </Popup>
    </Marker>
  );
}
