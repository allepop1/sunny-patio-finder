import { forwardRef } from "react";
import { Venue, SunWindow } from "@/services/SunService";
import { Sun, Cloud, MapPin, Star, Clock } from "lucide-react";
import { motion } from "framer-motion";

interface VenueCardProps {
  venue: Venue;
  compact?: boolean;
  onClick?: () => void;
}

/**
 * Strip leading category labels that Google Places sometimes prepends to
 * the vicinity string, e.g. "Mall, Kungsgatan 5" → "Kungsgatan 5".
 * Only drops the first segment when it contains no digits and the next
 * segment does (i.e. the first segment is a name/category, not an address).
 */
function cleanAddress(address: string): string {
  if (!address) return address;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && !/\d/.test(parts[0]) && /\d/.test(parts[1])) {
    return parts.slice(1).join(", ");
  }
  return address;
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
  if (w.type === "sunny_until") {
    return `Sol till ${fmtTime(w.end)} ${dayLabel(w.end)}`;
  }
  if (w.start) {
    return `Sol ${fmtTime(w.start)}–${fmtTime(w.end)} ${dayLabel(w.start)}`;
  }
  return null;
}

export const VenueCard = forwardRef<HTMLDivElement, VenueCardProps>(function VenueCard({ venue, compact = false, onClick }, ref) {
  const hasStatus = venue.sunStatus !== undefined;
  const isSunny = venue.sunStatus?.isSunny ?? false;
  // Only show sun window when building data was actually available (confidence === "high").
  // When buildings=0 the window is computed from solar geometry alone and is identical
  // for every venue in the city — misleading rather than useful.
  const windowLabel = venue.sunStatus?.confidence === "high"
    ? (sunWindowLabel(venue.sunStatus.sunWindow) ??
        (!isSunny && venue.sunStatus.sunWindow === null ? "Ingen sol de närmaste 48h" : null))
    : null;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      onClick={onClick}
      className={`rounded-lg border border-border bg-card cursor-pointer transition-shadow hover:shadow-md ${
        compact ? "p-3" : "p-4"
      }`}
    >
      {/* Sun Status */}
      <div className="flex items-center gap-3 mb-3">
        <div
          className={`flex items-center justify-center rounded-full p-2.5 ${
            !hasStatus
              ? "bg-muted"
              : isSunny
              ? "bg-sunny/20 animate-sun-pulse"
              : "bg-shady/20"
          }`}
        >
          {!hasStatus ? (
            <Sun className="h-6 w-6 text-muted-foreground" strokeWidth={2} />
          ) : isSunny ? (
            <Sun className="h-6 w-6 text-sunny" strokeWidth={2.5} />
          ) : (
            <Cloud className="h-6 w-6 text-shady" strokeWidth={2} />
          )}
        </div>
        <div>
          <div
            className={`text-lg font-display font-semibold leading-tight ${
              !hasStatus
                ? "text-muted-foreground"
                : isSunny
                ? "text-sunny-foreground"
                : "text-shady-foreground"
            }`}
          >
            {!hasStatus ? "Okänd status" : isSunny ? "I solen ☀️" : "I skuggan"}
          </div>
          {windowLabel && (
            <div className="text-xs text-muted-foreground mt-0.5">{windowLabel}</div>
          )}
        </div>
      </div>

      {/* Venue Info */}
      <h3 className="font-display font-semibold text-base text-foreground mb-1">
        {venue.name}
      </h3>

      <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-2">
        <MapPin className="h-3.5 w-3.5 shrink-0" />
        <span>{cleanAddress(venue.address)}</span>
      </div>

      {!compact && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          {venue.rating && (
            <div className="flex items-center gap-1">
              <Star className="h-3.5 w-3.5 text-sunny" fill="hsl(var(--sunny))" />
              <span>{venue.rating}</span>
            </div>
          )}
          {venue.openingHours && (
            <div className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              <span>{venue.openingHours}</span>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
});
