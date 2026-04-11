/**
 * Diagnose why Humble & Frank (Karlbergsvägen 46A) is reported as "shade"
 * at 11:23 on 2026-04-10 when ground truth is "sun".
 *
 * Run:  npx tsx scripts/diagnose-humble-frank.ts
 */
import SunCalc from "suncalc";

const SUPABASE_URL = "https://mskgnaztiiiplddcfewy.supabase.co";
const SUPABASE_KEY = "sb_publishable_PHuY3zdFgh5LGKDsDUGbZw_5gbjpoWg";

const VENUE = { name: "Humble & Frank", lat: 59.3428579, lng: 18.0383058 };
const DATE  = new Date("2026-04-10T11:23:00+02:00");

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversineM(la1: number, ln1: number, la2: number, ln2: number): number {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLn = (ln2 - ln1) * r;
  const a = Math.sin(dLa/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLn/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function polygonAreaSqm(poly: [number,number][]): number {
  const n = poly.length;
  if (n < 3) return 0;
  const cLat = poly.reduce((s,p)=>s+p[0],0)/n;
  const mL = 111320, mG = 111320 * Math.cos(cLat * Math.PI / 180);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i+1)%n;
    area += poly[i][1]*mG * poly[j][0]*mL - poly[j][1]*mG * poly[i][0]*mL;
  }
  return Math.abs(area)/2;
}

interface Building { id: number; lat: number; lng: number; height: number; polygon: [number,number][] }

async function fetchBuildings(lat: number, lng: number, r = 300): Promise<Building[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_buildings_near`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ center_lat: lat, center_lng: lng, radius_m: r }),
  });
  if (!res.ok) { console.error("Supabase error", res.status); return []; }
  return res.json();
}

/**
 * Detailed shadow check: returns null if no shadow, or a diagnostics object
 * describing exactly how the shadow polygon covers the point.
 */
function shadowDiagnosis(
  pointLat: number, pointLng: number,
  building: Building,
  solarAzDeg: number, solarAltDeg: number
): { inShadow: boolean; shadowLen: number; tipLat: number; tipLng: number; polyVertices: number } | null {
  if (solarAltDeg <= 0) return { inShadow: true, shadowLen: Infinity, tipLat: 0, tipLng: 0, polyVertices: 0 };
  const shadowLen = Math.min(building.height / Math.tan(solarAltDeg * Math.PI / 180), 500);
  if (shadowLen <= 0) return null;

  const shadowAzRad = ((solarAzDeg + 180) % 360) * (Math.PI / 180);

  let ring = building.polygon;
  const raw = ring.length;
  if (raw > 1 && ring[0][0] === ring[raw-1][0] && ring[0][1] === ring[raw-1][1])
    ring = ring.slice(0, raw-1);
  const m = ring.length;
  if (m < 3) return null;

  const centLat = ring.reduce((s,p)=>s+p[0],0)/m;
  const mPerLat = 111320;
  const mPerLng  = 111320 * Math.cos(centLat * Math.PI / 180);

  const dLat = (shadowLen * Math.cos(shadowAzRad)) / mPerLat;
  const dLng  = (shadowLen * Math.sin(shadowAzRad)) / mPerLng;

  // Centroid of building → where the shadow tip centroid lands
  const bCentLat = ring.reduce((s,p)=>s+p[0],0)/m;
  const bCentLng  = ring.reduce((s,p)=>s+p[1],0)/m;
  const tipLat = bCentLat + dLat;
  const tipLng  = bCentLng + dLng;

  const projected: [number,number][] = ring.map(([la,ln]) => [la+dLat, ln+dLng]);

  let signedArea = 0;
  for (let i = 0; i < m; i++) {
    const j = (i+1)%m;
    signedArea += ring[i][1]*ring[j][0] - ring[j][1]*ring[i][0];
  }
  const isCCW = signedArea > 0;

  const sunAzRad = solarAzDeg * Math.PI / 180;
  const sunDirX = Math.sin(sunAzRad), sunDirY = Math.cos(sunAzRad);

  const isShadowEdge: boolean[] = [];
  for (let i = 0; i < m; i++) {
    const j = (i+1)%m;
    const eL = ring[j][1]-ring[i][1], eA = ring[j][0]-ring[i][0];
    const nX = isCCW ? eA : -eA, nY = isCCW ? -eL : eL;
    isShadowEdge.push(nX*sunDirX + nY*sunDirY < 0);
  }

  const poly: [number,number][] = [];
  for (let i = 0; i < m; i++) {
    const prev = isShadowEdge[(i-1+m)%m], curr = isShadowEdge[i];
    if (!prev && curr)      { poly.push(ring[i]);      poly.push(projected[i]); }
    else if (prev && !curr) { poly.push(projected[i]); poly.push(ring[i]); }
    else if (curr)            poly.push(projected[i]);
    else                      poly.push(ring[i]);
  }
  if (poly.length < 3) return null;

  let inside = false, j = poly.length-1;
  for (let i = 0; i < poly.length; i++) {
    const xi=poly[i][0], yi=poly[i][1], xj=poly[j][0], yj=poly[j][1];
    if ((yi>pointLng) !== (yj>pointLng) &&
        pointLat < ((xj-xi)*(pointLng-yi))/(yj-yi)+xi) inside=!inside;
    j=i;
  }

  return { inShadow: inside, shadowLen, tipLat, tipLng, polyVertices: poly.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const C = { reset:"\x1b[0m", bold:"\x1b[1m", red:"\x1b[31m", green:"\x1b[32m", yellow:"\x1b[33m", dim:"\x1b[2m", cyan:"\x1b[36m" };

async function main() {
  const pos = SunCalc.getPosition(DATE, VENUE.lat, VENUE.lng);
  const altDeg = (pos.altitude * 180) / Math.PI;
  // SunCalc azimuth is from south, positive westward — convert to compass (from north, clockwise)
  const azDeg  = ((pos.azimuth  * 180) / Math.PI + 180 + 360) % 360;

  console.log(`\n${C.bold}Diagnostik: ${VENUE.name}${C.reset}`);
  console.log(`  Koordinater: ${VENUE.lat}, ${VENUE.lng}`);
  console.log(`  Tid:         ${DATE.toISOString()} (${DATE.toLocaleTimeString("sv-SE",{timeZone:"Europe/Stockholm"})} lokal)`);
  console.log(`  Sol:         azimut ${azDeg.toFixed(1)}°, altitud ${altDeg.toFixed(1)}°`);
  console.log(`  För att kasta skugga hit krävs: h > dist × tan(${altDeg.toFixed(1)}°) = dist × ${Math.tan(altDeg*Math.PI/180).toFixed(3)}\n`);

  console.log(`  Hämtar byggnader inom 300m från Supabase…`);
  const buildings = await fetchBuildings(VENUE.lat, VENUE.lng, 300);
  console.log(`  ${buildings.length} byggnader hittade.\n`);

  const shadowing: Array<{b: Building; diag: NonNullable<ReturnType<typeof shadowDiagnosis>>; dist: number}> = [];

  for (const b of buildings) {
    const diag = shadowDiagnosis(VENUE.lat, VENUE.lng, b, azDeg, altDeg);
    if (!diag) continue;
    const dist = haversineM(VENUE.lat, VENUE.lng, b.lat, b.lng);

    // Required height to shadow this distance
    const requiredH = dist * Math.tan(altDeg * Math.PI / 180);

    if (diag.inShadow) {
      shadowing.push({ b, diag, dist });
      const area = polygonAreaSqm(b.polygon);
      const tipDist = haversineM(VENUE.lat, VENUE.lng, diag.tipLat, diag.tipLng);

      console.log(`${C.red}${C.bold}❌ SKUGGAR: Byggnad id=${b.id}${C.reset}`);
      console.log(`   Position:       lat=${b.lat}, lng=${b.lng}`);
      console.log(`   Höjd:           ${b.height} m`);
      console.log(`   Avstånd:        ${dist.toFixed(0)} m från Humble & Frank`);
      console.log(`   Yta:            ${area.toFixed(0)} m²  (${b.polygon.length} vertices)`);
      console.log(`   Skugglängd:     ${diag.shadowLen.toFixed(1)} m  (vid altitud ${altDeg.toFixed(1)}°)`);
      console.log(`   Skugg-centroid: lat=${diag.tipLat.toFixed(6)}, lng=${diag.tipLng.toFixed(6)}  (${tipDist.toFixed(0)} m från venue)`);
      console.log(`   Krävd höjd för att nå ${dist.toFixed(0)}m: ${requiredH.toFixed(1)} m  →  Verklig höjd ${b.height} m ${b.height >= requiredH ? C.red+"✘ omotiverat hög?"+C.reset : C.green+"✓ rimlig"+C.reset}`);
      console.log(`   Skugg-polygon:  ${diag.polyVertices} vertices\n`);
    }
  }

  if (shadowing.length === 0) {
    console.log(`${C.green}Ingen byggnad skuggar punkten — appen borde säga "sol". Fel i annan del av kodflödet?${C.reset}\n`);
    return;
  }

  // ── Bearing analysis: is the shadowing building actually south of venue? ──
  console.log(`${C.bold}Riktningsanalys (sol azimut ${azDeg.toFixed(1)}° = från ${azDeg<45||azDeg>315?"N":azDeg<135?"Ö":azDeg<225?"S":"V"})${C.reset}`);
  for (const { b, dist } of shadowing) {
    const dLat = b.lat - VENUE.lat;
    const dLng  = b.lng  - VENUE.lng;
    const bearingToBuilding = ((Math.atan2(dLng, dLat) * 180/Math.PI) + 360) % 360;

    // Shadow falls in direction (azimut+180)%360. Building should be roughly
    // in the direction the sun comes FROM, i.e. ~azimut direction from venue.
    const sunFrom = azDeg;
    const angleDiff = Math.abs(((bearingToBuilding - sunFrom + 540) % 360) - 180);

    console.log(`  Byggnad ${b.id}: riktning från venue = ${bearingToBuilding.toFixed(1)}°, solen kommer från ${sunFrom.toFixed(1)}°`);
    console.log(`  Vinkelskillnad: ${angleDiff.toFixed(1)}°  ${angleDiff < 45 ? C.red+"(byggnad ÄR i solens riktning — skugga möjlig)"+C.reset : C.yellow+"(byggnad är INTE i solens riktning — misstänkt fel)"+C.reset}`);
    console.log(`  Krävd höjd för att kasta skugga ${dist.toFixed(0)} m:  h > ${(dist * Math.tan(altDeg*Math.PI/180)).toFixed(1)} m   faktisk höjd: ${b.height} m`);
  }

  // ── Hypothesis ranking ──
  console.log(`\n${C.bold}Hypotes-rangordning${C.reset}`);
  for (const { b, dist } of shadowing) {
    const requiredH = dist * Math.tan(altDeg * Math.PI / 180);
    const dLat = b.lat - VENUE.lat;
    const dLng  = b.lng  - VENUE.lng;
    const bearing = ((Math.atan2(dLng, dLat) * 180/Math.PI) + 360) % 360;
    const angleDiff = Math.abs(((bearing - azDeg + 540) % 360) - 180);
    const area = polygonAreaSqm(b.polygon);

    const hypotheses: Array<{score: number; label: string; evidence: string}> = [];

    if (b.height === 12 && area < 500) {
      hypotheses.push({ score: 3, label: "c) Default 12m på liten byggnad som borde vara lägre/saknas", evidence: `h=12 (default), yta=${area.toFixed(0)}m² — trolig garageport, cykelförråd e.d.` });
    }
    if (b.height === 12 && area >= 500) {
      hypotheses.push({ score: 2, label: "c) Default 12m utan explicit höjd-tagg i OSM", evidence: `h=12 (default), yta=${area.toFixed(0)}m² — verklig höjd okänd` });
    }
    if (angleDiff > 45) {
      hypotheses.push({ score: 3, label: "b) Felaktig position i databasen", evidence: `Byggnad är ${bearing.toFixed(0)}° från venue men solen är ${azDeg.toFixed(0)}° — ${angleDiff.toFixed(0)}° förskjutning` });
    }
    if (b.height > requiredH * 1.5) {
      hypotheses.push({ score: 2, label: "a) Överskattad höjd i databasen", evidence: `h=${b.height}m, krävs ${requiredH.toFixed(1)}m — ${(b.height/requiredH).toFixed(1)}× för hög` });
    }
    hypotheses.push({ score: 1, label: "d) Polygon-projektion inkorrekt (konkavt hus, inner courtyard)", evidence: `${b.polygon.length} vertices, yta=${area.toFixed(0)}m²` });

    hypotheses.sort((a,b)=>b.score-a.score);
    hypotheses.forEach((h,i) => {
      console.log(`  ${i+1}. ${h.label}`);
      console.log(`     ${C.dim}${h.evidence}${C.reset}`);
    });
  }
  console.log();
}

main().catch(err => { console.error(err); process.exit(1); });
