import { useState, useEffect } from "react";
import { Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Sun, Cloud, Loader2, MapPin } from "lucide-react";
import { calculateSunStatus, SunStatus } from "@/services/SunService";

const clickIcon = L.divIcon({
  className: "click-marker",
  html: `<div style="width:28px;height:28px;border-radius:50%;background:hsl(210,60%,50%);border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
  </div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -18],
});

interface ClickedPoint {
  lat: number;
  lng: number;
  sunStatus: SunStatus | null;
  loading: boolean;
}

interface MapClickHandlerProps {
  date: Date;
}

export function MapClickHandler({ date }: MapClickHandlerProps) {
  const [point, setPoint] = useState<ClickedPoint | null>(null);

  useMapEvents({
    click: async (e) => {
      const { lat, lng } = e.latlng;
      setPoint({ lat, lng, sunStatus: null, loading: true });

      try {
        const status = await calculateSunStatus(lat, lng, date);
        setPoint({ lat, lng, sunStatus: status, loading: false });
      } catch {
        setPoint({ lat, lng, sunStatus: null, loading: false });
      }
    },
  });

  // Recalculate when date changes
  useEffect(() => {
    if (!point || point.loading) return;
    const { lat, lng } = point;
    setPoint((prev) => prev ? { ...prev, loading: true } : null);

    calculateSunStatus(lat, lng, date)
      .then((status) => setPoint({ lat, lng, sunStatus: status, loading: false }))
      .catch(() => setPoint((prev) => prev ? { ...prev, loading: false } : null));
  }, [date]);

  if (!point) return null;

  const s = point.sunStatus;

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
                  {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
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
                  <div className="text-shady-foreground font-medium">
                    Byggnadsskugga
                  </div>
                )}
                {s.confidence !== "high" && (
                  <div className="italic">Uppskattning (låg data)</div>
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
