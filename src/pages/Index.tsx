import { useState, useEffect, useCallback, useRef } from "react";
import { MapView } from "@/components/MapView";
import { SearchBar } from "@/components/SearchBar";
import { VenueList } from "@/components/VenueList";
import { TimeSlider } from "@/components/TimeSlider";
import {
  stockholmVenuesFallback,
  fetchVenuesFromGooglePlaces,
} from "@/data/stockholmVenues";
import { calculateSunStatusForVenues, Venue } from "@/services/SunService";
import { Sun, List, Map as MapIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const STOCKHOLM_CENTER: [number, number] = [59.329, 18.069];

const Index = () => {
  const [venues, setVenues] = useState<Venue[]>(stockholmVenuesFallback);
  const [center, setCenter] = useState<[number, number]>(STOCKHOLM_CENTER);
  const [isLoading, setIsLoading] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [view, setView] = useState<"map" | "list">("map");
  const [selectedVenue, setSelectedVenue] = useState<Venue | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Keep a ref so loadSunStatus always sees the latest venue list without
  // needing to be recreated every time baseVenues changes.
  const baseVenuesRef = useRef<Venue[]>(stockholmVenuesFallback);

  // Fetch venues from Google Places whenever the map center changes
  // (e.g. after the user presses "Locate Me").
  useEffect(() => {
    let cancelled = false;
    fetchVenuesFromGooglePlaces(center[0], center[1]).then((fetched) => {
      if (cancelled) return;
      baseVenuesRef.current = fetched;
      setVenues(fetched); // show new venues immediately while sun status loads
    });
    return () => {
      cancelled = true;
    };
  }, [center]);

  const loadSunStatus = useCallback(async (date: Date = new Date()) => {
    setIsLoading(true);
    const currentVenues = baseVenuesRef.current;
    try {
      const updated = await calculateSunStatusForVenues(currentVenues, date);
      setVenues(updated);
    } catch (err) {
      console.error("Failed to calculate sun status:", err);
      setVenues(
        currentVenues.map((v, i) => ({
          ...v,
          sunStatus: {
            isSunny: i % 3 !== 0,
            buildingShadow: i % 3 === 0,
            cloudCover: 0,
            solarAltitude: 35,
            solarAzimuth: 180,
            confidence: "low" as const,
          },
        }))
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleTimeChange = useCallback((date: Date) => {
    setSelectedDate(date);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadSunStatus(date);
    }, 400);
  }, [loadSunStatus]);

  useEffect(() => {
    loadSunStatus(selectedDate);
    const interval = setInterval(() => loadSunStatus(selectedDate), 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadSunStatus, selectedDate]);

  const handleLocateMe = () => {
    if (!navigator.geolocation) return;
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCenter([pos.coords.latitude, pos.coords.longitude]);
        setIsLocating(false);
      },
      () => setIsLocating(false),
      { enableHighAccuracy: true }
    );
  };

  const handleSearch = (query: string) => {
    // Filter venues by name or address
    const filtered = baseVenuesRef.current.filter(
      (v) =>
        v.name.toLowerCase().includes(query.toLowerCase()) ||
        v.address.toLowerCase().includes(query.toLowerCase())
    );
    if (filtered.length > 0) {
      setCenter([filtered[0].lat, filtered[0].lng]);
    }
  };

  const currentTime = new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <Sun className="h-6 w-6 text-sunny" strokeWidth={2.5} />
          <h1 className="text-xl font-display font-bold text-foreground tracking-tight">
            Solsidan
          </h1>
        </div>
        <div className="text-sm text-muted-foreground font-body">
          Stockholm · {currentTime}
        </div>
      </header>

      {/* Search */}
      <div className="px-4 py-3 bg-card border-b border-border">
        <SearchBar
          onSearch={handleSearch}
          onLocateMe={handleLocateMe}
          isLocating={isLocating}
        />
      </div>

      {/* Time Slider */}
      <TimeSlider onChange={handleTimeChange} isLoading={isLoading} />

      {/* View Toggle (mobile) */}
      <div className="flex items-center gap-1 px-4 py-2 bg-background sm:hidden">
        <button
          onClick={() => setView("map")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            view === "map"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          <MapIcon className="h-4 w-4" />
          Karta
        </button>
        <button
          onClick={() => setView("list")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            view === "list"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          <List className="h-4 w-4" />
          Lista
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Map – always visible on desktop, toggled on mobile */}
        <div
          className={`flex-1 ${
            view === "map" ? "block" : "hidden sm:block"
          }`}
        >
          <MapView
            venues={venues}
            center={center}
            onVenueSelect={setSelectedVenue}
            selectedVenue={selectedVenue}
            selectedDate={selectedDate}
          />
        </div>

        {/* Venue List Sidebar */}
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className={`w-full sm:w-96 sm:border-l border-border overflow-y-auto bg-background p-4 ${
              view === "list" ? "block" : "hidden sm:block"
            }`}
          >
            <h2 className="font-display text-lg font-semibold text-foreground mb-3">
              Uteserveringar
            </h2>
            <VenueList
              venues={venues}
              isLoading={isLoading}
              onVenueClick={(venue) => {
                setSelectedVenue(venue);
                setCenter([venue.lat, venue.lng]);
                setView("map");
              }}
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

export default Index;
