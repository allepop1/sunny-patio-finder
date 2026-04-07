import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import type { Marker as LeafletMarker } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Venue, SunStatus, SunWindow, quickSunStatus } from "@/services/SunService";
import { fetchVenuesFromGooglePlaces } from "@/data/stockholmVenues";
import { ShadowLayer } from "./ShadowLayer";
import { MapClickHandler } from "./MapClickHandler";
import { Sun, Cloud } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";

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

function VenuePopup({ venue, status, loading }: { venue: Venue; status: SunStatus | null; loading: boolean }) {
  const s = status ?? quickSunStatus(venue.lat, venue.lng, new Date());
  const sunny = s.isSunny;
  const windowText = s.confidence === "high" ? sunWindowText(s.sunWindow) : null;

  return (
    <div style={{ minWidth: 220, fontFamily: "inherit" }}>
      {/* Icon + status */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
          background: sunny ? "rgba(250,200,40,0.18)" : "rgba(140,140,160,0.15)",
        }}>
          {sunny
            ? <Sun size={26} color="hsl(45,90%,42%)" strokeWidth={2.5} />
            : <Cloud size={26} color="hsl(220,10%,52%)" strokeWidth={2} />}
        </div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.2, color: sunny ? "hsl(38,90%,35%)" : "hsl(220,10%,35%)" }}>
            {sunny ? "I solen ☀️" : "I skuggan"}
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
      {/* Address */}
      <div style={{ fontSize: 12, color: "hsl(220,10%,55%)", marginTop: 2 }}>
        {cleanAddress(venue.address)}
      </div>
    </div>
  );
}

// Fix leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;

function makeDot(color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:10px;height:10px;border-radius:50%;
      background:${color};
      border:2px solid white;
      box-shadow:0 1px 4px rgba(0,0,0,0.35);
    "></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
    popupAnchor: [0, -10],
  });
}

/** Yellow dot — sun likely above horizon with no known obstructions. */
const sunnyDotIcon = makeDot("hsl(45,90%,52%)");
/** Grey dot — sun below horizon or angle too low. */
const shadyDotIcon = makeDot("hsl(220,10%,55%)");

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
    const venues = await fetchVenuesFromGooglePlaces(lat, lng, radius);
    onVenuesLoaded(venues);
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
 */
function VenueMarker({
  venue,
  selectedDate,
  getVenueStatus,
  onSelect,
}: {
  venue: Venue;
  selectedDate: Date;
  getVenueStatus: (venue: Venue) => Promise<SunStatus>;
  onSelect?: (venue: Venue) => void;
}) {
  const [status, setStatus] = useState<SunStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const markerRef = useRef<LeafletMarker>(null);

  const quick = quickSunStatus(venue.lat, venue.lng, selectedDate);
  const isSunny = (status ?? quick).isSunny;

  // Imperatively update the Leaflet marker icon whenever sunny-state changes.
  // react-leaflet's prop reconciliation skips setIcon while a popup is open,
  // so we bypass it and call the Leaflet API directly.
  useEffect(() => {
    markerRef.current?.setIcon(isSunny ? sunnyDotIcon : shadyDotIcon);
  }, [isSunny]);

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

  return (
    <Marker
      ref={markerRef}
      position={[venue.lat, venue.lng]}
      icon={isSunny ? sunnyDotIcon : shadyDotIcon}
      eventHandlers={{ popupopen: handlePopupOpen }}
    >
      <Popup className="venue-popup" maxWidth={280} minWidth={220}>
        <VenuePopup venue={venue} status={status} loading={loading} />
      </Popup>
    </Marker>
  );
}

interface MapViewProps {
  venues: Venue[];
  center: [number, number];
  selectedDate?: Date;
  onVenueSelect?: (venue: Venue) => void;
  selectedVenue?: Venue | null;
  onVenuesLoaded?: (venues: Venue[]) => void;
  getVenueStatus?: (venue: Venue) => Promise<SunStatus>;
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
}: MapViewProps) {
  return (
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
      {venues.map((venue) => (
        <VenueMarker
          key={venue.id}
          venue={venue}
          selectedDate={selectedDate}
          getVenueStatus={getVenueStatus!}
          onSelect={onVenueSelect}
        />
      ))}
    </MapContainer>
  );
}
