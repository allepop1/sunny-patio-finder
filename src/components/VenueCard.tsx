import { forwardRef } from "react";
import { Venue } from "@/services/SunService";
import { Sun, Cloud, MapPin, Star, Clock, Thermometer, Droplets, Wind } from "lucide-react";
import { motion } from "framer-motion";

interface VenueCardProps {
  venue: Venue;
  compact?: boolean;
  onClick?: () => void;
}

export const VenueCard = forwardRef<HTMLDivElement, VenueCardProps>(function VenueCard({ venue, compact = false, onClick }, ref) {
  const isSunny = venue.sunStatus?.isSunny ?? true;
  const confidence = venue.sunStatus?.confidence ?? "low";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      onClick={onClick}
      className={`rounded-lg border border-border bg-card p-4 cursor-pointer transition-shadow hover:shadow-md ${
        compact ? "p-3" : ""
      }`}
    >
      {/* Sun Status – Hero Element */}
      <div className="flex items-center gap-3 mb-3">
        <div
          className={`flex items-center justify-center rounded-full p-2.5 ${
            isSunny
              ? "bg-sunny/20 animate-sun-pulse"
              : "bg-shady/20"
          }`}
        >
          {isSunny ? (
            <Sun className="h-6 w-6 text-sunny" strokeWidth={2.5} />
          ) : (
            <Cloud className="h-6 w-6 text-shady" strokeWidth={2} />
          )}
        </div>
        <div>
          <span
            className={`text-lg font-display font-semibold ${
              isSunny ? "text-sunny-foreground" : "text-shady-foreground"
            }`}
          >
            {isSunny ? "I solen ☀️" : "I skuggan"}
          </span>
          {confidence !== "high" && (
            <span className="ml-2 text-xs text-muted-foreground">(uppskattning)</span>
          )}
        </div>
      </div>

      {/* Venue Info */}
      <h3 className="font-display font-semibold text-base text-foreground mb-1">
        {venue.name}
      </h3>

      <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-2">
        <MapPin className="h-3.5 w-3.5" />
        <span>{venue.address}</span>
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

      {/* Weather + Solar info */}
      {!compact && venue.sunStatus && (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          {venue.sunStatus.weather && (
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <Thermometer className="h-3.5 w-3.5" />
                <span>{Math.round(venue.sunStatus.weather.temperature)}°C</span>
              </div>
              <div className="flex items-center gap-1">
                <Cloud className="h-3.5 w-3.5" />
                <span>{venue.sunStatus.weather.cloudCover}% moln</span>
              </div>
              <div className="flex items-center gap-1">
                <Wind className="h-3.5 w-3.5" />
                <span>{venue.sunStatus.weather.windSpeed} m/s</span>
              </div>
            </div>
          )}
          {/* Forecast preview */}
          {venue.sunStatus.weather?.forecast && venue.sunStatus.weather.forecast.length > 0 && (
            <div className="flex gap-2 overflow-x-auto py-1">
              {venue.sunStatus.weather.forecast.slice(0, 4).map((f, i) => (
                <div key={i} className="flex flex-col items-center text-xs text-muted-foreground min-w-[48px]">
                  <span>{new Date(f.time).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className={f.cloudCover < 70 ? "text-sunny-foreground font-medium" : ""}>
                    {f.cloudCover < 30 ? "☀️" : f.cloudCover < 70 ? "⛅" : "☁️"}
                  </span>
                  <span>{Math.round(f.temperature)}°</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Solhöjd: {venue.sunStatus.solarAltitude.toFixed(1)}°</span>
            {venue.sunStatus.buildingShadow && (
              <span className="text-shady-foreground">Byggnadsskugga</span>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
