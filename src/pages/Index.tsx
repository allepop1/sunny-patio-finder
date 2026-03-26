import { useState, useEffect, useCallback, useRef } from "react";
import { MapView } from "@/components/MapView";
import { SearchBar } from "@/components/SearchBar";
import { TimeSlider } from "@/components/TimeSlider";
import { stockholmVenuesFallback, searchVenuesByText } from "@/data/stockholmVenues";
import { calculateSunStatus, SunStatus, Venue } from "@/services/SunService";
import { Sun, Loader2 } from "lucide-react";

const STOCKHOLM_CENTER: [number, number] = [59.329, 18.069];

const Index = () => {
  const [venues, setVenues] = useState<Venue[]>(stockholmVenuesFallback);
  const [center, setCenter] = useState<[number, number]>(STOCKHOLM_CENTER);
  const [isLocating, setIsLocating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedVenue, setSelectedVenue] = useState<Venue | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());

  // Refs so callbacks always see the latest values without stale closures.
  const baseVenuesRef = useRef<Venue[]>(stockholmVenuesFallback);
  const selectedDateRef = useRef<Date>(selectedDate);
  const statusCache = useRef<Map<string, SunStatus>>(new Map());

  useEffect(() => { selectedDateRef.current = selectedDate; }, [selectedDate]);

  // Clear cache when time changes so re-opened popups re-fetch.
  useEffect(() => { statusCache.current.clear(); }, [selectedDate]);

  // Called by MapVenueLoader whenever the map is panned/zoomed.
  const handleVenuesLoaded = useCallback((fetched: Venue[]) => {
    baseVenuesRef.current = fetched;
    setVenues(fetched);
  }, []);

  const handleTimeChange = useCallback((date: Date) => {
    setSelectedDate(date);
  }, []);

  // On-demand sun status fetch — called by VenueMarker on popup open.
  const getVenueStatus = useCallback(async (venue: Venue): Promise<SunStatus> => {
    const cached = statusCache.current.get(venue.id);
    if (cached) return cached;
    const status = await calculateSunStatus(venue.lat, venue.lng, selectedDateRef.current);
    statusCache.current.set(venue.id, status);
    return status;
  }, []);

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

  const handleSearch = useCallback(async (query: string) => {
    setIsSearching(true);
    setSearchError(null);
    statusCache.current.clear();
    try {
      const [searchLat, searchLng] = center;
      const results = await searchVenuesByText(query, searchLat, searchLng);
      if (results.length > 0) {
        baseVenuesRef.current = results;
        setVenues(results);
        setCenter([results[0].lat, results[0].lng]);
      } else {
        setSearchError("Inga resultat hittades. Prova ett annat sökord.");
      }
    } catch {
      setSearchError("Sökningen misslyckades. Kontrollera din internetanslutning.");
    } finally {
      setIsSearching(false);
    }
  }, [center]);

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
        <div className="flex items-center gap-2 text-sm text-muted-foreground font-body">
          {isSearching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>Stockholm · {currentTime}</span>
        </div>
      </header>

      {/* Search */}
      <div className="px-4 py-3 bg-card border-b border-border">
        <SearchBar
          onSearch={handleSearch}
          onLocateMe={handleLocateMe}
          isLocating={isLocating}
          isSearching={isSearching}
        />
        {searchError && (
          <p className="mt-2 text-xs text-destructive">{searchError}</p>
        )}
      </div>

      {/* Time Slider */}
      <TimeSlider onChange={handleTimeChange} isLoading={false} />

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        <MapView
          venues={venues}
          center={center}
          onVenueSelect={setSelectedVenue}
          selectedVenue={selectedVenue}
          selectedDate={selectedDate}
          onVenuesLoaded={handleVenuesLoaded}
          getVenueStatus={getVenueStatus}
        />
      </div>
    </div>
  );
};

export default Index;
