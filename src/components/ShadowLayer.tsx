import { useEffect, useState } from "react";
import { Polygon, useMap } from "react-leaflet";
import {
  fetchBuildingsFromOSM,
  getSolarPosition,
  shadowLength,
  Building,
} from "@/services/SunService";

interface ShadowLayerProps {
  date: Date;
}

function computeShadowPolygon(
  building: Building,
  solarAzimuthDeg: number,
  solarAltitudeDeg: number
): [number, number][] | null {
  if (solarAltitudeDeg <= 2) return null;

  const sLen = shadowLength(building.height, solarAltitudeDeg);
  if (sLen > 400 || sLen <= 0) return null;

  const shadowAzimuthRad =
    ((solarAzimuthDeg + 180) % 360) * (Math.PI / 180);

  const metersPerDegreeLat = 111320;
  const centroidLat =
    building.polygon.reduce((s, p) => s + p[0], 0) / building.polygon.length;
  const metersPerDegreeLng =
    111320 * Math.cos((centroidLat * Math.PI) / 180);

  const dLat = (sLen * Math.cos(shadowAzimuthRad)) / metersPerDegreeLat;
  const dLng = (sLen * Math.sin(shadowAzimuthRad)) / metersPerDegreeLng;

  // Shadow polygon = building outline + projected outline (reversed)
  const projected: [number, number][] = building.polygon.map(([lat, lng]) => [
    lat + dLat,
    lng + dLng,
  ]);

  return [...building.polygon, ...projected.reverse()];
}

export function ShadowLayer({ date }: ShadowLayerProps) {
  const map = useMap();
  const [shadows, setShadows] = useState<[number, number][][]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadShadows() {
      const center = map.getCenter();
      const solar = getSolarPosition(date, center.lat, center.lng);
      if (solar.altitude <= 2) {
        setShadows([]);
        return;
      }

      const buildings = await fetchBuildingsFromOSM(center.lat, center.lng, 500);
      if (cancelled) return;

      const polys: [number, number][][] = [];
      for (const b of buildings) {
        const poly = computeShadowPolygon(b, solar.azimuth, solar.altitude);
        if (poly) polys.push(poly);
      }
      setShadows(polys);
    }

    loadShadows();

    const onMoveEnd = () => loadShadows();
    map.on("moveend", onMoveEnd);

    return () => {
      cancelled = true;
      map.off("moveend", onMoveEnd);
    };
  }, [map, date]);

  return (
    <>
      {shadows.map((positions, i) => (
        <Polygon
          key={i}
          positions={positions}
          pathOptions={{
            color: "hsl(220, 10%, 30%)",
            fillColor: "hsl(220, 10%, 30%)",
            fillOpacity: 0.25,
            weight: 0,
          }}
        />
      ))}
    </>
  );
}
