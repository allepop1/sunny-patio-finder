import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { MapView } from "@/components/MapView";
import { SearchBar } from "@/components/SearchBar";
import { TimeSlider } from "@/components/TimeSlider";
import { SunList } from "@/components/SunList";
import { searchVenuesByText } from "@/data/stockholmVenues";
import { calculateSunStatus, getNightInfo, SunStatus, Venue } from "@/services/SunService";
import { NightBanner } from "@/components/NightBanner";
import { Sun, Loader2, Map as MapIcon, List as ListIcon } from "lucide-react";

const STOCKHOLM_CENTER: [number, number] = [59.329, 18.069];

const Index = () => {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [center, setCenter] = useState<[number, number]>(STOCKHOLM_CENTER);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [locationDenied, setLocationDenied] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedVenue, setSelectedVenue] = useState<Venue | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());

  // Refs so callbacks always see the latest values without stale closures.
  const baseVenuesRef = useRef<Venue[]>([]);
  const selectedDateRef = useRef<Date>(selectedDate);
  const statusCache = useRef<Map<string, SunStatus>>(new Map());
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { selectedDateRef.current = selectedDate; }, [selectedDate]);

  // Clear cache when time changes so re-opened popups re-fetch.
  useEffect(() => { statusCache.current.clear(); }, [selectedDate]);

  // Auto-fetch position when list view opens and we don't have a location yet.
  useEffect(() => {
    if (viewMode !== "list" || userLocation || !("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setUserLocation({ lat, lng, accuracy: accuracy ?? undefined });
        setLocationDenied(false);
      },
      (err) => {
        console.warn("[SunList] Could not get location:", err);
        setLocationDenied(true);
      }
    );
  }, [viewMode, userLocation]);

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
    // For corner venues pass all points after the first as extra check locations.
    const extraPoints = venue.points && venue.points.length > 1
      ? venue.points.slice(1)
      : undefined;
    const status = await calculateSunStatus(venue.lat, venue.lng, selectedDateRef.current, extraPoints);
    statusCache.current.set(venue.id, status);
    return status;
  }, []);

  const handleLocateMe = () => {
    if (!navigator.geolocation) return;
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setCenter([lat, lng]);
        setUserLocation({ lat, lng, accuracy: accuracy ?? undefined });
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
        const { lat, lng } = results[0];
        setCenter([lat, lng]);
        // Open the first result's popup after the map has panned (~500 ms).
        // Cancel any previous pending open so rapid searches don't stack.
        if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
        popupTimerRef.current = setTimeout(() => {
          setSelectedVenueId(results[0].id);
        }, 500);
      } else {
        setSearchError("Inga resultat hittades. Prova ett annat sökord.");
      }
    } catch {
      setSearchError("Sökningen misslyckades. Kontrollera din internetanslutning.");
    } finally {
      setIsSearching(false);
    }
  }, [center]);

  const handleListVenueClick = useCallback((venue: Venue) => {
    setViewMode("map");
    setCenter([venue.lat, venue.lng]);
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    popupTimerRef.current = setTimeout(() => {
      setSelectedVenueId(venue.id);
    }, 500);
  }, []);

  const isNight = useMemo(
    () => getNightInfo(selectedDate, center[0], center[1]).isNight,
    [selectedDate, center]
  );

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

      {/* Search + view toggle */}
      <div className="px-4 py-3 bg-card border-b border-border space-y-2">
        <SearchBar
          onSearch={handleSearch}
          onLocateMe={handleLocateMe}
          isLocating={isLocating}
          isSearching={isSearching}
        />
        {searchError && (
          <p className="text-xs text-destructive">{searchError}</p>
        )}
        <div className="flex items-center">
          <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 gap-0.5">
            <button
              onClick={() => setViewMode("map")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors font-body ${
                viewMode === "map"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <MapIcon className="h-4 w-4" />
              Karta
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors font-body ${
                viewMode === "list"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ListIcon className="h-4 w-4" />
              Lista
            </button>
          </div>
        </div>
      </div>

      {/* Time Slider */}
      <TimeSlider onChange={handleTimeChange} isLoading={false} />

      {/* Night Banner — only visible when sun is below horizon */}
      <NightBanner date={selectedDate} lat={center[0]} lng={center[1]} />

      {/* Main Content */}
      <div className="flex-1 overflow-hidden relative">
        {viewMode === "map" ? (
          <MapView
            venues={venues}
            center={center}
            onVenueSelect={setSelectedVenue}
            selectedVenue={selectedVenue}
            selectedDate={selectedDate}
            onVenuesLoaded={handleVenuesLoaded}
            getVenueStatus={getVenueStatus}
            isNight={isNight}
            userLocation={userLocation}
            selectedVenueId={selectedVenueId}
          />
        ) : (
          <SunList
            venues={venues}
            selectedDate={selectedDate}
            userLocation={userLocation}
            mapCenter={center}
            getVenueStatus={getVenueStatus}
            onVenueClick={handleListVenueClick}
            isFetchingLocation={!userLocation && !locationDenied}
            locationDenied={locationDenied}
          />
        )}
      </div>
    </div>
  );
};

export default Index;
