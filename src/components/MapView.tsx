import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import type { Marker as LeafletMarker } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Venue, SunStatus, SunWindow, quickSunStatus } from "@/services/SunService";
import { fetchVenuesFromGooglePlaces } from "@/data/stockholmVenues";
import { ShadowLayer } from "./ShadowLayer";
import { MapClickHandler } from "./MapClickHandler";
import { UserLocationMarker } from "./UserLocationMarker";
import { Sun, Cloud } from "lucide-react";
import { useEffect, useState, useCallback, useRef, memo } from "react";

// ── Popup helpers ──

function fmtTime(d: Date) {
  return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}
function dayLabel(d: Date) {
  const today = new Date();
  return d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
    ? "idag"
    : "imorgon";
}
function sunWindowText(w: SunWindow | null | undefined): string | null {
  if (!w) return null;
  if (w.type === "sunny_until") return `Sol till ${fmtTime(w.end)} ${dayLabel(w.end)}`;
  if (w.start) return `Sol ${fmtTime(w.start)}–${fmtTime(w.end)} ${dayLabel(w.start)}`;
  return null;
}
function cleanAddress(addr: string): string {
  if (!addr) return addr;
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && !/\d/.test(parts[0]) && /\d/.test(parts[1])) {
    return parts.slice(1).join(", ");
  }
  return addr;
}

const VENUE_TYPE_LABEL: Record<string, string> = {
  restaurant: "Restaurang",
  bar: "Bar / pub",
  cafe: "Café",
  bakery: "Bageri / konditori",
  default: "Uteservering",
};

function VenuePopup({ venue, status, loading }: { venue: Venue; status: SunStatus | null; loading: boolean }) {
  const s = status ?? quickSunStatus(venue.lat, venue.lng, new Date());
  const sunny = s.isSunny;
  const partial = s.isPartial ?? false;
  const windowText = s.confidence === "high" ? sunWindowText(s.sunWindow) : null;
  const emoji = getVenueEmoji(venue.venueType);
  const typeLabel = VENUE_TYPE_LABEL[venue.venueType ?? "default"] ?? VENUE_TYPE_LABEL.default;

  // Status colour and text
  const statusColor = partial
    ? "#f97316"
    : sunny
    ? "hsl(38,90%,35%)"
    : "hsl(220,10%,35%)";
  const statusText = partial
    ? "Sol på en sida ⛅"
    : sunny
    ? "I solen ☀️"
    : "I skuggan";
  const iconBg = partial
    ? "rgba(249,115,22,0.15)"
    : sunny
    ? "rgba(250,200,40,0.18)"
    : "rgba(140,140,160,0.15)";

  // For corner venues show "Addr1 / Addr2"
  const addressLine = venue.allAddresses && venue.allAddresses.length > 1
    ? venue.allAddresses.map(cleanAddress).join(" / ")
    : cleanAddress(venue.address);

  return (
    <div style={{ minWidth: 220, fontFamily: "inherit" }}>
      {/* Icon + status */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
          background: iconBg,
        }}>
          {sunny || partial
            ? <Sun size={26} color={partial ? "#f97316" : "hsl(45,90%,42%)"} strokeWidth={2.5} />
            : <Cloud size={26} color="hsl(220,10%,52%)" strokeWidth={2} />}
        </div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.2, color: statusColor }}>
            {statusText}
          </div>
          {/* Sun window — shown prominently when available */}
          {windowText && (
            <div style={{ fontSize: 13, fontWeight: 600, color: "hsl(220,15%,40%)", marginTop: 2 }}>
              {windowText}
            </div>
          )}
          {loading && !windowText && (
            <div style={{ fontSize: 12, color: "hsl(220,10%,60%)", marginTop: 2 }}>Hämtar…</div>
          )}
        </div>
      </div>
      {/* Name + address */}
      {venue.name !== venue.address && (
        <div style={{ fontSize: 14, fontWeight: 700, color: "hsl(220,15%,20%)", marginTop: 4 }}>
          {venue.name}
        </div>
      )}
      <div style={{ fontSize: 12, color: "hsl(220,10%,55%)", marginTop: 2 }}>
        {addressLine}
      </div>
      {/* Venue type */}
      <div style={{ fontSize: 11, color: "hsl(220,10%,65%)", marginTop: 4 }}>
        {emoji} {typeLabel}
      </div>
    </div>
  );
}

// Fix leaflet default icon issue
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;

const VENUE_EMOJI: Record<string, string> = {
  restaurant: "🍽️",
  bar: "🍺",
  cafe: "☕",
  bakery: "🥐",
  default: "🌿",
};

function makeEmojiPin(emoji: string, sunny: boolean) {
  const bg = sunny ? "hsl(45,90%,52%)" : "hsl(220,10%,55%)";
  return L.divIcon({
    className: "",
    html: `<div style="
      display:flex;align-items:center;justify-content:center;
      width:24px;height:24px;border-radius:50%;
      background:${bg};
      border:2px solid white;
      box-shadow:0 1px 4px rgba(0,0,0,0.35);
      font-size:12px;line-height:1;
    ">${emoji}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  });
}

function getVenueEmoji(venueType?: string): string {
  return VENUE_EMOJI[venueType ?? "default"] ?? VENUE_EMOJI.default;
}

/** Sunny emoji pin */
function makeSunnyPin(venueType?: string) { return makeEmojiPin(getVenueEmoji(venueType), true); }
/** Shady emoji pin */
function makeShadyPin(venueType?: string) { return makeEmojiPin(getVenueEmoji(venueType), false); }
/** Partial-sun pin — orange background, same emoji */
function makePartialPin(venueType?: string) {
  const emoji = getVenueEmoji(venueType);
  return L.divIcon({
    className: "",
    html: `<div style="
      display:flex;align-items:center;justify-content:center;
      width:24px;height:24px;border-radius:50%;
      background:#f97316;
      border:2px solid white;
      box-shadow:0 1px 4px rgba(0,0,0,0.35);
      font-size:12px;line-height:1;
    ">${emoji}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  });
}
/** Night pin — slate-400 background, moon emoji regardless of venue type */
function makeNightPin() {
  return L.divIcon({
    className: "",
    html: `<div style="
      display:flex;align-items:center;justify-content:center;
      width:24px;height:24px;border-radius:50%;
      background:#94a3b8;
      border:2px solid white;
      box-shadow:0 1px 4px rgba(0,0,0,0.35);
      font-size:12px;line-height:1;
    ">🌙</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  });
}

/** Search radius in metres based on Leaflet zoom level. */
function radiusForZoom(zoom: number): number {
  if (zoom >= 16) return 750;
  if (zoom >= 15) return 1000;
  if (zoom >= 14) return 1500;
  if (zoom >= 13) return 2000;
  if (zoom >= 12) return 3500;
  if (zoom >= 11) return 5500;
  return 8000;
}

/**
 * Lives inside MapContainer; listens to moveend/zoomend and fetches venues
 * for the current map view, debounced 800 ms after the user stops moving.
 */
/** Haversine distance in metres between two lat/lng points. */
function distanceMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MIN_MOVE_METERS = 300;
const DEBOUNCE_MS = 1500;

function MapVenueLoader({
  onVenuesLoaded,
}: {
  onVenuesLoaded: (venues: Venue[]) => void;
}) {
  const map = useMap();
  const lastFetchPos = useRef<{ lat: number; lng: number } | null>(null);

  const load = useCallback(async (force = false) => {
    const { lat, lng } = map.getCenter();
    const zoom = map.getZoom();

    if (
      !force &&
      lastFetchPos.current &&
      distanceMeters(lat, lng, lastFetchPos.current.lat, lastFetchPos.current.lng) < MIN_MOVE_METERS
    ) {
      return;
    }

    lastFetchPos.current = { lat, lng };
    const radius = radiusForZoom(zoom);
    try {
      const venues = await fetchVenuesFromGooglePlaces(lat, lng, radius, zoom);
      onVenuesLoaded(venues);
    } catch (error) {
      console.error("[MapVenueLoader] Failed to load venues:", error);
      onVenuesLoaded([]);
    }
  }, [map, onVenuesLoaded]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const onMoveEnd = () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(false), DEBOUNCE_MS);
    };

    load(true); // initial load — always fetch regardless of distance

    map.on("moveend", onMoveEnd);
    map.on("zoomend", onMoveEnd);

    return () => {
      clearTimeout(timer);
      map.off("moveend", onMoveEnd);
      map.off("zoomend", onMoveEnd);
    };
  }, [map, load]);

  return null;
}

/**
 * A single venue marker.
 *
 * Step 1 (immediate): pin colour comes from a synchronous solar-position
 *   estimate — no network calls, shown instantly for every venue.
 * Step 2 (on popup open): fetches real weather + OSM buildings and replaces
 *   the popup content with accurate status. Result is cached so re-opening
 *   the popup is instant.
 *
 * Wrapped in React.memo with a custom comparator so the component only
 * re-renders when its own props change — not when sibling venues are added
 * or removed (which would otherwise close the open popup).
 */
const VenueMarker = memo(
  function VenueMarker({
    venue,
    selectedDate,
    getVenueStatus,
    onSelect,
    onMarkerMount,
    isNight = false,
    selectedVenueId = null,
  }: {
    venue: Venue;
    selectedDate: Date;
    getVenueStatus: (venue: Venue) => Promise<SunStatus>;
    onSelect?: (venue: Venue) => void;
    onMarkerMount?: (venueId: string, marker: LeafletMarker) => void;
    isNight?: boolean;
    selectedVenueId?: string | null;
  }) {
    const [status, setStatus] = useState<SunStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const markerRef = useRef<LeafletMarker>(null);

    const quick = quickSunStatus(venue.lat, venue.lng, selectedDate);
    // When it's night, no venue can be "in sun" — override to false.
    const currentStatus = status ?? quick;
    const isSunny = isNight ? false : currentStatus.isSunny;
    const isPartial = !isNight && (currentStatus.isPartial ?? false);


    // Register this Leaflet marker in MapView's registry so the parent can
    // programmatically open its popup (e.g. after a search).
    useEffect(() => {
      if (markerRef.current) onMarkerMount?.(venue.id, markerRef.current);
    // onMarkerMount is a stable callback — intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [venue.id]);

    // B) Re-open guard: if this venue is the selected one and the popup has
    // been closed by a re-render, reopen it.  Runs after every render of this
    // component so it catches any accidental close immediately.
    useEffect(() => {
      if (venue.id !== selectedVenueId) return;
      const m = markerRef.current;
      if (!m) return;
      if (!m.isPopupOpen()) m.openPopup();
    });

    // Imperatively update the Leaflet marker icon whenever sunny-state or night-mode changes.
    // react-leaflet's prop reconciliation skips setIcon while a popup is open,
    // so we bypass it and call the Leaflet API directly.
    useEffect(() => {
      const icon = isNight
        ? makeNightPin()
        : isPartial
        ? makePartialPin(venue.venueType)
        : isSunny
        ? makeSunnyPin(venue.venueType)
        : makeShadyPin(venue.venueType);
      markerRef.current?.setIcon(icon);
    }, [isNight, isSunny, isPartial, venue.venueType]);

    // When the selected time changes, invalidate the cached status.
    useEffect(() => {
      setStatus(null);
    }, [selectedDate]);

    const handlePopupOpen = useCallback(async () => {
      onSelect?.(venue);
      if (status) return;
      setLoading(true);
      try {
        const s = await getVenueStatus(venue);
        setStatus(s);
      } catch {
        // Leave status null — popup keeps showing quick estimate
      } finally {
        setLoading(false);
      }
    }, [venue, status, getVenueStatus, onSelect]);

    const currentIcon = isNight
      ? makeNightPin()
      : isPartial
      ? makePartialPin(venue.venueType)
      : isSunny
      ? makeSunnyPin(venue.venueType)
      : makeShadyPin(venue.venueType);

    return (
      <Marker
        ref={markerRef}
        position={[venue.lat, venue.lng]}
        icon={currentIcon}
        eventHandlers={{ popupopen: handlePopupOpen }}
      >
        <Popup className="venue-popup" maxWidth={280} minWidth={220}>
          <VenuePopup venue={venue} status={status} loading={loading} />
        </Popup>
      </Marker>
    );
  },
  // A) Custom comparator: only re-render when props that visually matter change.
  // Stable callbacks (getVenueStatus, onSelect, onMarkerMount) are excluded.
  (prev, next) =>
    prev.venue.id === next.venue.id &&
    prev.selectedDate.getTime() === next.selectedDate.getTime() &&
    prev.isNight === next.isNight &&
    prev.selectedVenueId === next.selectedVenueId,
);

interface MapViewProps {
  venues: Venue[];
  center: [number, number];
  selectedDate?: Date;
  onVenueSelect?: (venue: Venue) => void;
  selectedVenue?: Venue | null;
  onVenuesLoaded?: (venues: Venue[]) => void;
  getVenueStatus?: (venue: Venue) => Promise<SunStatus>;
  isNight?: boolean;
  userLocation?: { lat: number; lng: number; accuracy?: number } | null;
  selectedVenueId?: string | null;
}

function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom());
  }, [center, map]);
  return null;
}

export function MapView({
  venues,
  center,
  selectedDate = new Date(),
  onVenueSelect,
  selectedVenue,
  onVenuesLoaded,
  getVenueStatus,
  isNight = false,
  userLocation = null,
  selectedVenueId = null,
}: MapViewProps) {
  // Registry: venue.id → Leaflet marker instance, rebuilt on each new venue set.
  const markerRegistry = useRef<Map<string, LeafletMarker>>(new Map());

  const handleMarkerMount = useCallback((venueId: string, marker: LeafletMarker) => {
    markerRegistry.current.set(venueId, marker);
  }, []);

  // Open the popup for selectedVenueId.
  // Listens to BOTH selectedVenueId AND venues so it retries after new
  // venues load.  Children's register-effects always run before this parent
  // effect, so the registry is populated by the time this fires.
  useEffect(() => {
    if (!selectedVenueId) return;
    const marker = markerRegistry.current.get(selectedVenueId);
    if (marker) {
      console.log(`[popup] opening for venueId=${selectedVenueId}`);
      marker.openPopup();
    }
  }, [selectedVenueId, venues]);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={center}
        zoom={14}
        scrollWheelZoom={true}
        className="h-full w-full rounded-lg"
        zoomControl={false}
      >
        <MapUpdater center={center} />
        {onVenuesLoaded && <MapVenueLoader onVenuesLoaded={onVenuesLoaded} />}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />
        <ShadowLayer date={selectedDate} />
        <MapClickHandler date={selectedDate} />
        <UserLocationMarker position={userLocation} accuracy={userLocation?.accuracy} />
        {venues.map((venue) => (
          <VenueMarker
            key={venue.id}
            venue={venue}
            selectedDate={selectedDate}
            getVenueStatus={getVenueStatus!}
            onSelect={onVenueSelect}
            onMarkerMount={handleMarkerMount}
            isNight={isNight}
            selectedVenueId={selectedVenueId}
          />
        ))}
      </MapContainer>
      {isNight && (
        <div
          className="absolute inset-0 rounded-lg bg-slate-900/30 pointer-events-none"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
