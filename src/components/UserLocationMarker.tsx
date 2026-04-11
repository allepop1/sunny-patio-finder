import { useMemo } from "react";
import { Circle, Marker } from "react-leaflet";
import L from "leaflet";

interface UserLocationMarkerProps {
  position: { lat: number; lng: number } | null;
  accuracy?: number; // metres, from geolocation API
}

export function UserLocationMarker({ position, accuracy }: UserLocationMarkerProps) {
  // Stable divIcon — created once, not on every render
  const icon = useMemo(
    () =>
      L.divIcon({
        className: "",
        html: '<div class="user-location-dot"></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
    []
  );

  if (!position) return null;

  const latlng: [number, number] = [position.lat, position.lng];

  return (
    <>
      {/* Accuracy radius — only shown when meaningful (< 10 km) */}
      {accuracy != null && accuracy > 0 && accuracy < 10_000 && (
        <Circle
          center={latlng}
          radius={accuracy}
          pathOptions={{
            fillColor: "#3b82f6",
            fillOpacity: 0.15,
            stroke: false,
          }}
        />
      )}
      {/* Blue pulsing dot */}
      <Marker position={latlng} icon={icon} interactive={false} />
    </>
  );
}
