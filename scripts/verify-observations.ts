/**
 * Offline verification: compare field observations against the app's
 * shadow algorithm.  Run with:  npx tsx scripts/verify-observations.ts
 *
 * Self-contained — uses suncalc directly and hits the Supabase REST API
 * via plain fetch so no Vite/browser globals are needed.
 */
import SunCalc from "suncalc";

// ── Configuration ─────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://mskgnaztiiiplddcfewy.supabase.co";
const SUPABASE_KEY = "sb_publishable_PHuY3zdFgh5LGKDsDUGbZw_5gbjpoWg";

const OBSERVATIONS = [
  { name: "Humble & Frank",      address: "Karlbergsvägen 46A",  lat: 59.3428579, lng: 18.0383058, time: "11:23", observed: "sun",  extraPoints: [] },
  { name: "Systrarna Andersson", address: "Karlbergsvägen 45",   lat: 59.3423168, lng: 18.0364239, time: "11:03", observed: "shade", extraPoints: [] },
  { name: "Mellqvist Matbar",    address: "Rörstrandsgatan 6",   lat: 59.3398587, lng: 18.0352033, time: "11:05", observed: "sun",  extraPoints: [] },
  { name: "Tranan",              address: "Karlbergsvägen 14",   lat: 59.3431687, lng: 18.0490372, time: "11:18", observed: "sun",  extraPoints: [] },
  { name: "Café Pascal",         address: "Norrtullsgatan 4",    lat: 59.3422917, lng: 18.0518628, time: "11:11", observed: "shade", extraPoints: [] },
  // Corner venue: id=877 Dalagatan 58 + id=578 Karlbergsvägen 30 (7.8m apart)
  { name: "Caffé L'Antico",      address: "Dalagatan 58",        lat: 59.343023,  lng: 18.04447,  time: "11:21", observed: "half",
    extraPoints: [{ lat: 59.342982, lng: 18.044583 }] /* Karlbergsvägen 30, actual permit coord */ },
  { name: "Bistro Casper",       address: "Dalagatan 44",        lat: 59.3410510, lng: 18.0464410, time: "11:08", observed: "shade", extraPoints: [] },
  { name: "Cliff Barnes",        address: "Norrtullsgatan 45",   lat: 59.3459415, lng: 18.0474412, time: "11:15", observed: "half",
    extraPoints: [] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse "HH:MM" on 2026-04-10 in Europe/Stockholm (CEST = UTC+2). */
function parseSwedishTime(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(`2026-04-10T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00+02:00`);
}

interface Building {
  height: number;
  polygon: [number, number][];
}

/** Fetch buildings within radiusM metres of (lat, lng) from Supabase. */
async function fetchBuildings(lat: number, lng: number, radiusM = 200): Promise<Building[]> {
  const url = `${SUPABASE_URL}/rest/v1/rpc/get_buildings_near`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ center_lat: lat, center_lng: lng, radius_m: radiusM }),
  });
  if (!res.ok) return [];
  const rows = await res.json() as Array<{ height: number; polygon: [number, number][] }>;
  return rows.map(r => ({ height: r.height, polygon: r.polygon }));
}

function shadowLength(height: number, altitudeDeg: number): number {
  if (altitudeDeg <= 0) return Infinity;
  return height / Math.tan((altitudeDeg * Math.PI) / 180);
}

function pointInPolygon(lat: number, lng: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const intersect =
      (lngI > lng) !== (lngJ > lng) &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Mirror of isPointInBuildingShadow from SunService.ts. */
function isInShadow(
  pointLat: number, pointLng: number,
  building: Building,
  solarAzimuthDeg: number, solarAltitudeDeg: number
): boolean {
  if (solarAltitudeDeg <= 0) return true;
  if (pointInPolygon(pointLat, pointLng, building.polygon)) return false;

  const sLen = Math.min(shadowLength(building.height, solarAltitudeDeg), 500);
  if (sLen <= 0) return false;

  const shadowAzRad = ((solarAzimuthDeg + 180) % 360) * (Math.PI / 180);

  let ring = building.polygon;
  const raw = ring.length;
  if (raw > 1 && ring[0][0] === ring[raw-1][0] && ring[0][1] === ring[raw-1][1]) {
    ring = ring.slice(0, raw - 1);
  }
  const m = ring.length;
  if (m < 3) return false;

  const centLat = ring.reduce((s, p) => s + p[0], 0) / m;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((centLat * Math.PI) / 180);

  const dLat = (sLen * Math.cos(shadowAzRad)) / mPerLat;
  const dLng = (sLen * Math.sin(shadowAzRad)) / mPerLng;

  const projected: [number, number][] = ring.map(([la, ln]) => [la + dLat, ln + dLng]);

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
    const prev = isShadowEdge[(i - 1 + m) % m];
    const curr = isShadowEdge[i];
    if (!prev && curr)       { poly.push(ring[i]);      poly.push(projected[i]); }
    else if (prev && !curr)  { poly.push(projected[i]); poly.push(ring[i]); }
    else if (curr)             poly.push(projected[i]);
    else                       poly.push(ring[i]);
  }

  if (poly.length < 3) return false;

  // Ray-casting point-in-polygon
  let inside = false;
  let j = poly.length - 1;
  for (let i = 0; i < poly.length; i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > pointLng) !== (yj > pointLng) &&
        pointLat < ((xj - xi) * (pointLng - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const COL = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m",
};

function pad(s: string, n: number): string { return s.padEnd(n).slice(0, n); }
function rpad(s: string, n: number): string { return s.padStart(n).slice(-n); }

async function main() {
  console.log(`\n${COL.bold}Verifiering: fältobservationer 2026-04-10 mot skugg-algoritmen${COL.reset}\n`);

  const header = `${"#".padEnd(3)} ${"Plats".padEnd(22)} ${"Tid".padEnd(6)} ${"Du sa".padEnd(7)} ${"Appen sa".padEnd(9)} ${"Azimut".padEnd(8)} ${"Altitud".padEnd(9)} Match`;
  console.log(COL.bold + header + COL.reset);
  console.log("─".repeat(header.length));

  let correct = 0, wrong = 0, borderline = 0;

  for (let idx = 0; idx < OBSERVATIONS.length; idx++) {
    const obs = OBSERVATIONS[idx];
    const date = parseSwedishTime(obs.time);

    // Solar position
    const pos = SunCalc.getPosition(date, obs.lat, obs.lng);
    const altDeg = (pos.altitude * 180) / Math.PI;
    const azDeg  = ((pos.azimuth  * 180) / Math.PI + 180 + 360) % 360; // SunCalc: from south, convert to from north

    // Fetch buildings and check shadow
    const buildings = await fetchBuildings(obs.lat, obs.lng, 200);
    const mainInShadow = buildings.some(b => isInShadow(obs.lat, obs.lng, b, azDeg, altDeg));

    // Check extra points for corner venues
    let appPrediction: string;
    if (obs.extraPoints && obs.extraPoints.length > 0) {
      const extraResults = obs.extraPoints.map((p: { lat: number; lng: number }) =>
        buildings.some(b => isInShadow(p.lat, p.lng, b, azDeg, altDeg))
      );
      const anyInSun  = !mainInShadow || extraResults.some((s: boolean) => !s);
      const anyInShade = mainInShadow || extraResults.some((s: boolean) => s);
      appPrediction = anyInSun && anyInShade ? "half" : anyInSun ? "sun" : "shade";
    } else {
      appPrediction = mainInShadow ? "shade" : "sun";
    }

    // Match logic
    let match: string;
    if (obs.observed === appPrediction) {
      match = `${COL.green}✅ Korrekt${COL.reset}`;
      correct++;
    } else if (obs.observed === "half" || appPrediction === "half") {
      match = `${COL.yellow}⚠️  Gränsfall${COL.reset}`;
      borderline++;
    } else {
      match = `${COL.red}❌ Fel${COL.reset}`;
      wrong++;
    }

    const row = [
      rpad(String(idx + 1), 2),
      pad(obs.name, 22),
      pad(obs.time, 6),
      pad(obs.observed, 7),
      pad(appPrediction, 9),
      rpad(azDeg.toFixed(1) + "°", 8),
      rpad(altDeg.toFixed(1) + "°", 9),
      match,
    ].join(" ");
    console.log(row);

    if (buildings.length === 0) {
      console.log(`   ${COL.dim}↳ Inga byggnader hittades (Supabase-fel eller utanför bbox)${COL.reset}`);
    }
  }

  console.log("─".repeat(header.length));

  const total = OBSERVATIONS.length;
  const score = correct + borderline * 0.5;
  const pct = ((score / total) * 100).toFixed(0);

  console.log(`\n${COL.bold}Sammanfattning${COL.reset}`);
  console.log(`  ${COL.green}Korrekta:   ${correct}/${total}${COL.reset}`);
  console.log(`  ${COL.red}Fel:        ${wrong}/${total}${COL.reset}`);
  console.log(`  ${COL.yellow}Gränsfall:  ${borderline}/${total}${COL.reset}`);
  console.log(`  Träffsäkerhet: ${COL.bold}${pct}%${COL.reset} (gränsfall räknas som 0.5)\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
