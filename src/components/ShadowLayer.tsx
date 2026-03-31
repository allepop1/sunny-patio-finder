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

  const sLen = Math.min(shadowLength(building.height, solarAltitudeDeg), 200);
  if (sLen <= 0) return null;

  // Shadow direction: opposite of sun azimuth
  const shadowAzRad = ((solarAzimuthDeg + 180) % 360) * (Math.PI / 180);

  const metersPerDegreeLat = 111320;
  const centroidLat =
    building.polygon.reduce((s, p) => s + p[0], 0) / building.polygon.length;
  const metersPerDegreeLng = 111320 * Math.cos((centroidLat * Math.PI) / 180);

  const dLat = (sLen * Math.cos(shadowAzRad)) / metersPerDegreeLat;
  const dLng = (sLen * Math.sin(shadowAzRad)) / metersPerDegreeLng;

  // Strip duplicate closing vertex that OSM polygons often include
  let ring = building.polygon;
  const n = ring.length;
  if (
    n > 1 &&
    ring[0][0] === ring[n - 1][0] &&
    ring[0][1] === ring[n - 1][1]
  ) {
    ring = ring.slice(0, -1);
  }
  const m = ring.length;
  if (m < 3) return null;

  // Project every vertex by the shadow offset
  const projected = ring.map(
    ([lat, lng]) => [lat + dLat, lng + dLng] as [number, number]
  );

  // Determine polygon winding with the shoelace formula
  // (treating lng as x-axis, lat as y-axis)
  let signedArea = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    signedArea += ring[i][1] * ring[j][0] - ring[j][1] * ring[i][0];
  }
  const isCCW = signedArea > 0;

  // Sun direction vector in (x = lng, y = lat) space
  const sunAzRad = (solarAzimuthDeg * Math.PI) / 180;
  const sunDirX = Math.sin(sunAzRad); // east (lng) component
  const sunDirY = Math.cos(sunAzRad); // north (lat) component

  // For each edge determine whether it faces away from the sun (shadow side).
  // Outward normal for CCW polygon: right-hand = (edgeLat, -edgeLng) in (x,y).
  // Outward normal for CW polygon:  left-hand  = (-edgeLat, edgeLng) in (x,y).
  const isShadowEdge: boolean[] = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const edgeLng = ring[j][1] - ring[i][1];
    const edgeLat = ring[j][0] - ring[i][0];

    const normalX = isCCW ? edgeLat : -edgeLat;
    const normalY = isCCW ? -edgeLng : edgeLng;

    const dot = normalX * sunDirX + normalY * sunDirY;
    isShadowEdge.push(dot < 0);
  }

  // Walk around the polygon and build the shadow outline via silhouette
  // traversal:
  //   – Sun-facing vertex  → use original position (building wall)
  //   – Shadow-facing vertex → use projected position (shadow tip)
  //   – At each sun↔shadow transition include BOTH to close the side walls
  const poly: [number, number][] = [];

  for (let i = 0; i < m; i++) {
    const prevShadow = isShadowEdge[(i - 1 + m) % m];
    const currShadow = isShadowEdge[i];

    if (!prevShadow && currShadow) {
      // Entering shadow side: original vertex then its projection
      poly.push(ring[i]);
      poly.push(projected[i]);
    } else if (prevShadow && !currShadow) {
      // Leaving shadow side: projection then original vertex
      poly.push(projected[i]);
      poly.push(ring[i]);
    } else if (currShadow) {
      poly.push(projected[i]);
    } else {
      poly.push(ring[i]);
    }
  }

  return poly.length >= 3 ? poly : null;
}

const SHADOW_MIN_ZOOM = 15;

export function ShadowLayer({ date }: ShadowLayerProps) {
  const map = useMap();
  const [shadows, setShadows] = useState<[number, number][][]>([]);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout>;

    async function loadShadows() {
      const center = map.getCenter();
      const zoom = map.getZoom();
      const solar = getSolarPosition(date, center.lat, center.lng);

      // Only render shadows at close zoom levels — avoids unnecessary Overpass
      // requests and keeps the visual useful (wide-zoom shadows are meaningless).
      if (zoom < SHADOW_MIN_ZOOM || solar.altitude <= 2) {
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

    loadShadows().catch(() => {});

    const onMapChange = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => loadShadows().catch(() => {}), 800);
    };
    map.on("moveend", onMapChange);
    map.on("zoomend", onMapChange);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      map.off("moveend", onMapChange);
      map.off("zoomend", onMapChange);
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
