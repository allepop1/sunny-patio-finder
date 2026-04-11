import { useEffect, useState } from "react";
import { useMap, Polygon } from "react-leaflet";
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
  if (solarAltitudeDeg <= 6) return null;

  const sLen = Math.min(shadowLength(building.height, solarAltitudeDeg), 500);
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
  let signedArea = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    signedArea += ring[i][1] * ring[j][0] - ring[j][1] * ring[i][0];
  }
  const isCCW = signedArea > 0;

  const sunAzRad = (solarAzimuthDeg * Math.PI) / 180;
  const sunDirX = Math.sin(sunAzRad);
  const sunDirY = Math.cos(sunAzRad);

  const isShadowEdge: boolean[] = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const edgeLng = ring[j][1] - ring[i][1];
    const edgeLat = ring[j][0] - ring[i][0];
    const normalX = isCCW ? edgeLat : -edgeLat;
    const normalY = isCCW ? -edgeLng : edgeLng;
    isShadowEdge.push(normalX * sunDirX + normalY * sunDirY < 0);
  }

  const poly: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    const prevShadow = isShadowEdge[(i - 1 + m) % m];
    const currShadow = isShadowEdge[i];
    if (!prevShadow && currShadow) {
      poly.push(ring[i]);
      poly.push(projected[i]);
    } else if (prevShadow && !currShadow) {
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

/**
 * Renders all building shadows as a single react-leaflet Polygon so that
 * overlapping shadows from multiple buildings always show the same flat colour.
 *
 * All shadow polygon rings are passed as the `positions` array of ONE Polygon
 * component, which Leaflet renders as a single SVG <path> element.  Because
 * there is only one element, fillOpacity is applied exactly once — areas
 * covered by multiple building shadows are not darker than areas covered by one.
 *
 * fillRule="nonzero" ensures overlapping rings are all filled (evenodd would
 * punch transparent holes through areas where two shadow polygons intersect).
 *
 * The Polygon lives in Leaflet's overlayPane (z-index 400), above tiles but
 * below markers — exactly where building shadows should appear.
 */
export function ShadowLayer({ date }: ShadowLayerProps) {
  const map = useMap();
  const [shadows, setShadows] = useState<[number, number][][]>([]);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout>;

    async function loadShadows() {
      const center = map.getCenter();
      const zoom   = map.getZoom();
      const solar  = getSolarPosition(date, center.lat, center.lng);

      if (zoom < SHADOW_MIN_ZOOM || solar.altitude <= 6) {
        console.log(
          `[ShadowLayer] suppressed: zoom=${zoom} (min=${SHADOW_MIN_ZOOM})` +
          ` alt=${solar.altitude.toFixed(1)}°`
        );
        setShadows([]);
        return;
      }

      // Compute a fetch radius that covers the entire visible viewport plus a
      // shadow-buffer so buildings just outside the frame can still cast shadows
      // into it.  The Supabase RPC takes a circle, so we use the haversine
      // distance from center to the NE corner (the viewport's diagonal half-length).
      const ne = map.getBounds().getNorthEast();
      const R = 6371000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(ne.lat - center.lat);
      const dLng = toRad(ne.lng - center.lng);
      const aHav =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(center.lat)) * Math.cos(toRad(ne.lat)) * Math.sin(dLng / 2) ** 2;
      const viewportRadius = R * 2 * Math.atan2(Math.sqrt(aHav), Math.sqrt(1 - aHav));

      // Buildings up to ~500 m outside the viewport can cast shadows into it at
      // low solar altitudes.  Cap total radius at 2 000 m to keep query fast.
      const shadowBuffer = Math.min(500, shadowLength(30, solar.altitude));
      const fetchRadius = Math.min(2000, Math.round(viewportRadius + shadowBuffer));

      const buildings = await fetchBuildingsFromOSM(center.lat, center.lng, fetchRadius);
      if (cancelled) return;

      const polys: [number, number][][] = [];
      for (const b of buildings) {
        const poly = computeShadowPolygon(b, solar.azimuth, solar.altitude);
        if (poly) polys.push(poly);
      }

      console.log(
        `[ShadowLayer] ${polys.length}/${buildings.length} shadow polys` +
        ` | zoom=${zoom} r=${fetchRadius}m alt=${solar.altitude.toFixed(1)}° az=${solar.azimuth.toFixed(1)}°`
      );

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

  if (shadows.length === 0) return null;

  // All shadow rings in one Polygon → one SVG <path> element → one fillOpacity.
  // fillRule="nonzero": overlapping shadow areas stay filled (not punched out).
  return (
    <Polygon
      positions={shadows}
      pathOptions={{
        fillColor: "rgb(100, 120, 160)",
        fillOpacity: 0.25,
        stroke: false,
        fillRule: "nonzero",
      }}
      interactive={false}
    />
  );
}
