import { Moon } from "lucide-react";
import { getNightInfo } from "@/services/SunService";

interface NightBannerProps {
  date: Date;
  lat: number;
  lng: number;
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return "strax";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m} min`;
}

export function NightBanner({ date, lat, lng }: NightBannerProps) {
  const info = getNightInfo(date, lat, lng);
  if (!info.isNight) return null;

  const sunriseTime = info.sunrise.toLocaleTimeString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="px-4 py-3 bg-slate-900 border-b border-slate-700 flex items-center gap-3">
      <Moon className="h-4 w-4 text-indigo-300 shrink-0" />
      <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
        <span className="text-sm font-display font-semibold text-slate-100 whitespace-nowrap">
          Solen är nere
        </span>
        <span className="text-sm text-slate-400 whitespace-nowrap">
          Går upp {sunriseTime}
        </span>
        <span className="text-xs text-slate-500 whitespace-nowrap">
          (om {formatDuration(info.minutesUntilNextEvent)})
        </span>
      </div>
    </div>
  );
}
