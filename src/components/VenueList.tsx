import { Venue } from "@/services/SunService";
import { VenueCard } from "./VenueCard";
import { Sun, Cloud } from "lucide-react";
import { motion } from "framer-motion";

interface VenueListProps {
  venues: Venue[];
  isLoading?: boolean;
  onVenueClick?: (venue: Venue) => void;
}

export function VenueList({ venues, isLoading, onVenueClick }: VenueListProps) {
  const checkedVenues = venues.filter((v) => v.sunStatus !== undefined);
  const sunnyCount = checkedVenues.filter((v) => v.sunStatus!.isSunny).length;
  const shadyCount = checkedVenues.length - sunnyCount;

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-28 rounded-lg bg-muted animate-pulse"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>{venues.length} uteserveringar</span>
        {checkedVenues.length > 0 && (
          <>
            <div className="flex items-center gap-1.5">
              <Sun className="h-4 w-4 text-sunny" />
              <span>{sunnyCount} i solen</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Cloud className="h-4 w-4 text-shady" />
              <span>{shadyCount} i skuggan</span>
            </div>
          </>
        )}
      </div>

      {/* Venue Cards */}
      <motion.div
        className="space-y-3"
        initial="hidden"
        animate="visible"
        variants={{
          visible: { transition: { staggerChildren: 0.05 } },
        }}
      >
        {venues
          .sort((a, b) => {
            // Sunny venues first
            const aS = a.sunStatus?.isSunny ? 0 : 1;
            const bS = b.sunStatus?.isSunny ? 0 : 1;
            return aS - bS;
          })
          .map((venue) => (
            <VenueCard
              key={venue.id}
              venue={venue}
              onClick={() => onVenueClick?.(venue)}
            />
          ))}
      </motion.div>
    </div>
  );
}
