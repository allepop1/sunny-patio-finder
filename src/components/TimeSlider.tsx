import { useState, useMemo } from "react";
import { Clock, Sun, Moon } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { motion } from "framer-motion";

interface TimeSliderProps {
  onChange: (date: Date) => void;
  isLoading?: boolean;
}

export function TimeSlider({ onChange, isLoading }: TimeSliderProps) {
  const [offsetMinutes, setOffsetMinutes] = useState(0);

  const now = useMemo(() => new Date(), []);

  // Generate time labels: every hour for 6 hours
  const labels = useMemo(() => {
    const result: { minutes: number; label: string }[] = [];
    for (let h = 0; h <= 6; h++) {
      const d = new Date(now.getTime() + h * 60 * 60_000);
      result.push({
        minutes: h * 60,
        label: d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }),
      });
    }
    return result;
  }, [now]);

  const selectedTime = useMemo(() => {
    return new Date(now.getTime() + offsetMinutes * 60_000);
  }, [now, offsetMinutes]);

  const selectedHour = selectedTime.getHours();
  const isDaytime = selectedHour >= 6 && selectedHour < 21;

  const handleChange = (value: number[]) => {
    const mins = value[0];
    setOffsetMinutes(mins);
    onChange(new Date(now.getTime() + mins * 60_000));
  };

  return (
    <div className="px-4 py-3 pb-4 bg-card border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isDaytime ? (
            <Sun className="h-4 w-4 text-sunny" />
          ) : (
            <Moon className="h-4 w-4 text-shady" />
          )}
          <span className="text-sm font-display font-semibold text-foreground">
            Solprognos
          </span>
        </div>
        <motion.div
          key={offsetMinutes}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="flex items-center gap-1.5"
        >
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground tabular-nums">
            {selectedTime.toLocaleTimeString("sv-SE", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {offsetMinutes === 0 && (
            <span className="text-xs text-muted-foreground ml-1">Nu</span>
          )}
          {offsetMinutes > 0 && (
            <span className="text-xs text-muted-foreground ml-1">
              +{Math.round(offsetMinutes / 60)}h
            </span>
          )}
          {isLoading && (
            <span className="inline-block h-3 w-3 rounded-full border-2 border-sunny border-t-transparent animate-spin ml-1" />
          )}
        </motion.div>
      </div>

      <Slider
        defaultValue={[0]}
        value={[offsetMinutes]}
        onValueChange={handleChange}
        max={360}
        step={30}
        className="w-full"
      />

      {/* Hour tick labels */}
      <div className="flex justify-between mt-1.5">
        {labels.map((l) => (
          <span
            key={l.minutes}
            className={`text-[10px] tabular-nums ${
              Math.abs(offsetMinutes - l.minutes) < 15
                ? "text-foreground font-medium"
                : "text-muted-foreground"
            }`}
          >
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
