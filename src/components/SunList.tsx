import { useState, useEffect } from "react";
import { Sun } from "lucide-react";
import { Venue, SunStatus } from "@/services/SunService";
import { fetchVenuesFromGooglePlaces } from "@/data/stockholmVenues";

interface SunListProps {
  venues: Venue[];
  selectedDate: Date;
  userLocation: { lat: number; lng: number } | null;
  mapCenter: [number, number];
  getVenueStatus: (venue: Venue) => Promise<SunStatus>;
  onVenueClick: (venue: Venue) => void;
  isFetchingLocation?: boolean;
  locationDenied?: boolean;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function sunStatusText(status: SunStatus, selectedDate: Date): string {
  if (status.isPartial) return "Sol på en sida";
  const w = status.sunWindow;
  if (!w || w.type !== "sunny_until" || status.confidence !== "high") return "I sol";
  const mins = Math.round((w.end.getTime() - selectedDate.getTime()) / 60000);
  if (mins <= 0) return "I sol";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `I sol i ${m} min till`;
  if (m === 0) return `I sol i ${h}h till`;
  return `I sol i ${h}h ${m} min till`;
}

interface SunnyVenueRow {
  venue: Venue;
  status: SunStatus;
  distM: number;
}

const MAX_STATUS_BATCH = 30;
const MAX_LIST = 10;

export function SunList({
  venues,
  selectedDate,
  userLocation,
  mapCenter,
  getVenueStatus,
  onVenueClick,
  isFetchingLocation = false,
  locationDenied = false,
}: SunListProps) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<SunnyVenueRow[]>([]);

  useEffect(() => {
    if (isFetchingLocation) return; // wait until we know the position (or denial)

    let cancelled = false;
    setLoading(true);
    setRows([]);

    const refLat = userLocation?.lat ?? mapCenter[0];
    const refLng = userLocation?.lng ?? mapCenter[1];

    async function run() {
      // If we have the user's position, fetch venues around them directly so
      // the list isn't limited to whatever the map is currently showing.
      const source: Venue[] = userLocation
        ? await fetchVenuesFromGooglePlaces(refLat, refLng, 1500, 15)
        : venues;

      if (cancelled) return;

      // Sort by distance, cap at MAX_STATUS_BATCH to avoid hammering Supabase.
      const withDist = source.map((v) => ({
        venue: v,
        distM: haversineM(refLat, refLng, v.lat, v.lng),
      }));
      withDist.sort((a, b) => a.distM - b.distM);
      const batch = withDist.slice(0, MAX_STATUS_BATCH);

      const results = await Promise.all(
        batch.map(async ({ venue, distM }) => {
          const status = await getVenueStatus(venue);
          return { venue, status, distM };
        })
      );

      if (cancelled) return;
      const sunny = results
        .filter((r) => r.status.isSunny || r.status.isPartial)
        .sort((a, b) => a.distM - b.distM)
        .slice(0, MAX_LIST);
      setRows(sunny);
      setLoading(false);
    }

    run();
    return () => { cancelled = true; };
  }, [venues, selectedDate, userLocation, mapCenter, getVenueStatus, isFetchingLocation]);

  if (isFetchingLocation) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center space-y-2">
          <Sun className="h-8 w-8 mx-auto text-sunny animate-[sun-pulse_2s_ease-in-out_infinite]" />
          <p className="text-sm font-body">Hämtar din position...</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center space-y-2">
          <Sun className="h-8 w-8 mx-auto text-sunny animate-[sun-pulse_2s_ease-in-out_infinite]" />
          <p className="text-sm font-body">Beräknar solstatus...</p>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full px-8">
        <p className="text-center text-sm text-muted-foreground font-body leading-relaxed">
          Inga uteserveringar i sol just nu i det här området.
          Prova att panorera kartan eller dra tidslidern framåt.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full bg-background">
      {locationDenied && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 font-body">
          Visar avstånd från kartans centrum. Aktivera platstjänster för bättre resultat.
        </div>
      )}
      <div className="divide-y divide-border">
        {rows.map(({ venue, status, distM }) => (
          <button
            key={venue.id}
            onClick={() => onVenueClick(venue)}
            className="w-full text-left px-4 py-3 hover:bg-slate-50 active:bg-slate-100 transition-colors"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-base text-foreground truncate leading-snug">
                {venue.name}
              </span>
              <span className="text-sm text-slate-500 shrink-0">{fmtDist(distM)}</span>
            </div>
            <div className="text-sm text-slate-500 truncate mt-0.5 font-body">
              {venue.address}
            </div>
            <div className={`flex items-center gap-1 mt-1 text-sm font-body ${status.isPartial ? "text-orange-500" : "text-amber-600"}`}>
              <Sun className="h-3.5 w-3.5 shrink-0" />
              <span>{sunStatusText(status, selectedDate)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
