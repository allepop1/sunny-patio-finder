import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Venue } from "@/services/SunService";
import { VenueCard } from "./VenueCard";
import { useEffect } from "react";

// Fix leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;

const sunnyIcon = L.divIcon({
  className: "sunny-marker",
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -20],
});

const shadyIcon = L.divIcon({
  className: "shady-marker",
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -20],
});

interface MapViewProps {
  venues: Venue[];
  center: [number, number];
  onVenueSelect?: (venue: Venue) => void;
  selectedVenue?: Venue | null;
}

function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom());
  }, [center, map]);
  return null;
}

export function MapView({ venues, center, onVenueSelect, selectedVenue }: MapViewProps) {
  return (
    <MapContainer
      center={center}
      zoom={14}
      scrollWheelZoom={true}
      className="h-full w-full rounded-lg"
      zoomControl={false}
    >
      <MapUpdater center={center} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
      />
      {venues.map((venue) => (
        <Marker
          key={venue.id}
          position={[venue.lat, venue.lng]}
          icon={venue.sunStatus?.isSunny ? sunnyIcon : shadyIcon}
          eventHandlers={{
            click: () => onVenueSelect?.(venue),
          }}
        >
          <Popup className="venue-popup" maxWidth={300} minWidth={280}>
            <VenueCard venue={venue} compact />
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
