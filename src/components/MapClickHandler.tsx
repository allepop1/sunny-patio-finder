import { useState, useEffect, useRef } from "react";
import { Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Sun, Cloud, Loader2, MapPin } from "lucide-react";
import {
  getSolarPosition,
  fetchBuildingsFromOSM,
  isPointInBuildingShadow,
  calculateSunWindow,
  type SunWindow,
} from "@/services/SunService";
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
  sunWindow: SunWindow | null;
  confidence: "high" | "low";
}

interface ClickedPoint {
  lat: number;
  lng: number;
  sunResult: SunResult | null;
  loading: boolean;
  address: string | null;
  refining: boolean;
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

/** Phase 1: solar position + weather only, no buildings. */
async function quickSunCheck(lat: number, lng: number, date: Date): Promise<SunResult> {
  const solar = getSolarPosition(date, lat, lng);
  const weather = await fetchWeather(lat, lng);
  const cloudCover = weather?.cloudCover ?? 0;
  const isSunny = solar.altitude > 0 && cloudCover < 70;
  const sunWindow = calculateSunWindow(lat, lng, [], weather, date);
  return { isSunny, sunWindow, confidence: "low" };
}

/** Phase 2: refine with OSM building shadows. Weather is already cached. */
async function refineSunCheck(lat: number, lng: number, date: Date): Promise<SunResult> {
  const solar = getSolarPosition(date, lat, lng);
  const [buildings, weather] = await Promise.all([
    fetchBuildingsFromOSM(lat, lng, 200),
    fetchWeather(lat, lng), // returns from cache
  ]);
  const confidence = buildings.length > 0 ? "high" : "low";

  if (solar.altitude <= 0) {
    const sunWindow = calculateSunWindow(lat, lng, buildings, weather, date);
    return { isSunny: false, sunWindow, confidence };
  }

  let buildingShadow = false;
  for (const building of buildings) {
    if (isPointInBuildingShadow(lat, lng, building, solar.azimuth, solar.altitude)) {
      buildingShadow = true;
      break;
    }
  }

  const cloudCover = weather?.cloudCover ?? 0;
  const isSunny = !buildingShadow && cloudCover < 70;
  const sunWindow = calculateSunWindow(lat, lng, buildings, weather, date);
  return { isSunny, sunWindow, confidence };
}

function fmtTime(date: Date): string {
  return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(date: Date): "idag" | "imorgon" {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()) return "idag";
  if (date.getFullYear() === tomorrow.getFullYear() &&
      date.getMonth() === tomorrow.getMonth() &&
      date.getDate() === tomorrow.getDate()) return "imorgon";
  return "imorgon"; // within 30h lookahead this can only ever be today or tomorrow
}

function sunWindowLabel(w: SunWindow | null | undefined): string | null {
  if (!w) return null;
  if (w.type === "sunny_until") return `Sol till ${fmtTime(w.end)} ${dayLabel(w.end)}`;
  if (w.start) return `Sol ${fmtTime(w.start)}–${fmtTime(w.end)} ${dayLabel(w.start)}`;
  return null;
}

export function MapClickHandler({ date }: MapClickHandlerProps) {
  const [point, setPoint] = useState<ClickedPoint | null>(null);
  const clickIdRef = useRef(0);

  useMapEvents({
    click: async (e) => {
      const { lat, lng } = e.latlng;
      const id = ++clickIdRef.current;
      setPoint({ lat, lng, sunResult: null, loading: true, address: null, refining: false });

      const [result, address] = await Promise.all([
        quickSunCheck(lat, lng, date),
        reverseGeocode(lat, lng),
      ]);

      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: result, loading: false, address, refining: true });

      const refined = await refineSunCheck(lat, lng, date);
      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: refined, loading: false, address, refining: false });
    },
  });

  useEffect(() => {
    if (!point || point.loading) return;
    const { lat, lng, address } = point;
    const id = ++clickIdRef.current;
    setPoint((prev) => prev ? { ...prev, loading: true, refining: false } : null);

    (async () => {
      const result = await quickSunCheck(lat, lng, date);
      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: result, loading: false, address, refining: true });

      const refined = await refineSunCheck(lat, lng, date);
      if (id !== clickIdRef.current) return;
      setPoint({ lat, lng, sunResult: refined, loading: false, address, refining: false });
    })();
  }, [date]);

  if (!point) return null;

  const s = point.sunResult;
  const windowLabel = s?.confidence === "high"
    ? (sunWindowLabel(s.sunWindow) ??
        (!s.isSunny && s.sunWindow === null ? "Ingen sol de närmaste 48h" : null))
    : null;

  return (
    <Marker position={[point.lat, point.lng]} icon={clickIcon}>
      <Popup className="venue-popup" maxWidth={280} minWidth={220} autoPan>
        <div className="p-1">
          {point.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Kollar solläget…</span>
            </div>
          ) : s ? (
            <div>
              {/* Status */}
              <div className="flex items-center gap-2.5 mb-2.5">
                <div
                  className={`flex items-center justify-center rounded-full p-2 ${
                    s.isSunny ? "bg-sunny/20 animate-sun-pulse" : "bg-shady/20"
                  }`}
                >
                  {s.isSunny ? (
                    <Sun className="h-5 w-5 text-sunny" strokeWidth={2.5} />
                  ) : (
                    <Cloud className="h-5 w-5 text-shady" strokeWidth={2} />
                  )}
                </div>
                <div>
                  <div
                    className={`text-base font-semibold leading-tight ${
                      s.isSunny ? "text-sunny-foreground" : "text-shady-foreground"
                    }`}
                  >
                    {s.isSunny ? "I solen ☀️" : "I skuggan"}
                  </div>
                  {windowLabel && (
                    <div className="text-xs text-muted-foreground mt-0.5">{windowLabel}</div>
                  )}
                </div>
              </div>

              {/* Address */}
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                <span>{point.address || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`}</span>
              </div>

              {/* Subtle refining indicator */}
              {point.refining && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2 border-t border-border pt-2">
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  <span>Hämtar exakt status…</span>
                </div>
              )}
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
