import { useEffect, useState } from "react";
import { useMap } from "react-leaflet";
import { getSolarPosition } from "@/services/SunService";
import { Sun, MoonStar } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface SunPositionIndicatorProps {
  date: Date;
}

export function SunPositionIndicator({ date }: SunPositionIndicatorProps) {
  const map = useMap();
  const [position, setPosition] = useState<{
    azimuth: number;
    altitude: number;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    function update() {
      const center = map.getCenter();
      const solar = getSolarPosition(date, center.lat, center.lng);

      // Calculate position on a circle around map center
      const size = map.getSize();
      const cx = size.x / 2;
      const cy = size.y / 2;
      const radius = Math.min(cx, cy) - 36;

      // Azimuth is degrees from north, clockwise. Convert to screen coords.
      // Screen: 0° = up (negative Y), 90° = right (positive X)
      const azRad = (solar.azimuth * Math.PI) / 180;
      const x = cx + radius * Math.sin(azRad);
      const y = cy - radius * Math.cos(azRad);

      setPosition({ azimuth: solar.azimuth, altitude: solar.altitude, x, y });
    }

    update();
    map.on("move", update);
    map.on("resize", update);
    return () => {
      map.off("move", update);
      map.off("resize", update);
    };
  }, [map, date]);

  if (!position) return null;

  const isAboveHorizon = position.altitude > 0;

  return (
    <div
      className="leaflet-top leaflet-left pointer-events-none"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 450,
      }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={isAboveHorizon ? "sun" : "moon"}
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="pointer-events-auto"
          style={{
            position: "absolute",
            left: position.x,
            top: position.y,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div
            className={`flex flex-col items-center gap-0.5 ${
              isAboveHorizon ? "drop-shadow-[0_0_8px_hsl(var(--sunny)/0.5)]" : ""
            }`}
          >
            {/* Direction arrow pointing inward toward center */}
            <div
              style={{
                transform: `rotate(${position.azimuth + 180}deg)`,
              }}
              className="mb-[-4px]"
            >
              <svg
                width="12"
                height="8"
                viewBox="0 0 12 8"
                className={isAboveHorizon ? "text-sunny" : "text-muted-foreground"}
              >
                <path d="M6 0L12 8H0z" fill="currentColor" />
              </svg>
            </div>

            <div
              className={`rounded-full p-1.5 ${
                isAboveHorizon
                  ? "bg-sunny/90 text-sunny-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {isAboveHorizon ? (
                <Sun className="h-5 w-5" strokeWidth={2.5} />
              ) : (
                <MoonStar className="h-5 w-5" strokeWidth={2} />
              )}
            </div>

            <span
              className={`text-[9px] font-semibold tabular-nums leading-none mt-0.5 ${
                isAboveHorizon ? "text-sunny-foreground" : "text-muted-foreground"
              }`}
            >
              {position.altitude.toFixed(0)}°
            </span>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
