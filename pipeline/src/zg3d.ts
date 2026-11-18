/**
 * ZG3D 2022: the City of Zagreb's 3D building model (LoD 2.2, from the 2008 aerial survey and the 2019–2022
 * multisensor survey), open data on data.zagreb.hr under the Croatian Open Licence (Otvorena dozvola).
 * One dataset per city district (gradska četvrt); each has an Esri Shapefile of MultiPatch solids
 * (shape type 31) with heights above sea level (HVRS71), in WGS84, except Trešnjevka-sjever, Stenjevec and
 * Podsljeme, which are in HTRS96/TM (EPSG:3765, as their .prj says; so is their entry in index.json).
 *
 *   data/raw/zg3d/<dataset>.zip   the district's Shapefile zip, as published
 *   data/raw/zg3d/index.json      dataset -> bbox [s, w, n, e] (read from each .shp header)
 *   data/raw/zg3d/<dataset>.centres.json  each record's offset, centre and lowest point (one pass, then reused)
 *
 * The GeoJSON downloads and the ArcGIS feature service only carry flat footprints; the Shapefile has the
 * real wall and roof faces. Their winding differs between buildings (most are wound inward, the Esri
 * convention, some outward): each building is turned so that its roofs face up, i.e. every face normal points
 * outward, as in CityGML.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ecefToEnu, llhToEcef } from "./camera.ts";
import { type Lod2Building, hashAlong, triangulate, type V3 } from "./lod2.ts";
import { RAW, readJson } from "./paths.ts";
import { fromTm } from "./utm.ts";

type P2 = [number, number];
type BBox = [number, number, number, number];

const DIR = join(RAW, "zg3d");
const INDEX = join(DIR, "index.json");
const CKAN = "https://data.zagreb.hr/api/3/action/package_search?q=ZG3D&rows=100";
const UA = { "User-Agent": "isometric-world/0.3 (open-data isometric map)" };
/** Per-district datasets (the whole-city dataset has no Shapefile). */
const DISTRICT = /^zg3d-gradska-cetvrt-/;

/** Download every district's Shapefile zip once and index their extents. */
export async function downloadZg3d(): Promise<Record<string, BBox>> {
  mkdirSync(DIR, { recursive: true });
  const index: Record<string, BBox> = existsSync(INDEX) ? readJson(INDEX) : {};
  let datasets: any[];
  try {
    const r = await fetch(CKAN, { headers: UA, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    datasets = (await r.json()).result.results.filter((d: any) => DISTRICT.test(d.name));
  } catch (err) {
    // the portal is flaky: once every district is downloaded, its catalogue is not needed
    const have = Object.keys(index).filter((n) => existsSync(join(DIR, `${n}.zip`)));
    if (have.length < 17) throw new Error(`data.zagreb.hr package_search: ${(err as Error).message}`);
    console.warn(`  zg3d: catalogue unavailable (${(err as Error).message}), using the ${have.length} downloaded districts`);
    return index;
  }
  for (const d of datasets) {
    const zip = join(DIR, `${d.name}.zip`);
    if (!existsSync(zip)) {
      const shp = d.resources.find((x: any) => /^shp$/i.test(x.format ?? ""));
      if (!shp) throw new Error(`zg3d ${d.name}: no Shapefile resource`);
      const res = await fetch(shp.url, { headers: UA, signal: AbortSignal.timeout(900_000) });
      if (!res.ok) throw new Error(`zg3d ${d.name}: ${shp.url}: HTTP ${res.status}`);
      writeFileSync(`${zip}.tmp`, Buffer.from(await res.arrayBuffer()));
      renameSync(`${zip}.tmp`, zip);
      console.log(`  zg3d ${d.name}`);
    }
    if (!index[d.name]) {
      const h = readShp(zip).subarray(0, 100);
      // header box: xmin, ymin, xmax, ymax (lon/lat)
      index[d.name] = [h.readDoubleLE(44), h.readDoubleLE(36), h.readDoubleLE(60), h.readDoubleLE(52)];
    }
  }
  writeFileSync(INDEX, JSON.stringify(index, null, 1));
  return index;
}

function readShp(zip: string): Buffer {
  return execFileSync("unzip", ["-p", zip, "*.shp"], { maxBuffer: 2 ** 31 - 1 });
}

/** HTRS96/TM (central meridian 16.5°, scale 0.9999) easting, northing -> lon, lat; a WGS84 dataset passes as is */
const htrs = (e: number, n: number): [number, number] => { const [lat, lon] = fromTm(e, n, 16.5, 0.9999); return [lon, lat]; };
const projected = (zip: string) => /HTRS96_Croatia_TM/.test(execFileSync("unzip", ["-p", zip, "*.prj"]).toString());
/** index box [s, w, n, e]; projected ones hold [northing, easting] bounds: their corners in lat/lon */
function boxLatLon(b: BBox): BBox {
  if (Math.abs(b[1]) <= 180) return b;
  const cs = [[b[1], b[0]], [b[3], b[0]], [b[1], b[2]], [b[3], b[2]]].map(([e, n]) => htrs(e, n));
  return [Math.min(...cs.map((c) => c[1])), Math.min(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1])), Math.max(...cs.map((c) => c[0]))];
}

const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** The MultiPatch record at byte `o`: polygons (outer ring + holes) and loose triangles, as [lon, lat, h] points. */
function record(shp: Buffer, o: number, tm = false): { id: number; polys: V3[][][]; next: number } {
  const id = shp.readInt32BE(o), len = shp.readInt32BE(o + 4) * 2, b = o + 8, next = b + len;
  if (shp.readInt32LE(b) !== 31) return { id, polys: [], next };
  const nParts = shp.readInt32LE(b + 36), nPts = shp.readInt32LE(b + 40);
  const parts = b + 44, types = parts + 4 * nParts, xy = types + 4 * nParts, zs = xy + 16 * nPts + 16;
  const pt = (i: number): V3 => {
    const x = shp.readDoubleLE(xy + 16 * i), y = shp.readDoubleLE(xy + 16 * i + 8), z = shp.readDoubleLE(zs + 8 * i);
    return tm ? [...htrs(x, y), z] : [x, y, z];
  };
  const polys: V3[][][] = [];
  for (let p = 0; p < nParts; p++) {
    const a = shp.readInt32LE(parts + 4 * p), e = p + 1 < nParts ? shp.readInt32LE(parts + 4 * (p + 1)) : nPts;
    const type = shp.readInt32LE(types + 4 * p), pts: V3[] = [];
    for (let i = a; i < e; i++) pts.push(pt(i));
    if (type === 0) for (let i = 2; i < pts.length; i++) polys.push([i % 2 ? [pts[i - 1], pts[i - 2], pts[i]] : [pts[i - 2], pts[i - 1], pts[i]]]);
    else if (type === 1) for (let i = 2; i < pts.length; i++) polys.push([[pts[0], pts[i - 1], pts[i]]]);
    else if (type === 2 || type === 4) polys.push([pts]); // outer / first ring: a new face
    else if (polys.length) polys[polys.length - 1].push(pts); // inner / ring: a hole in the current face
  }
  return { id, polys, next };
}

/** One district's records: [byte offset, centre lat, centre lon, lowest point], from its cache or one full pass. */
interface Centres { zipMtime: number; tm: boolean; recs: Array<[number, number, number, number]> }
function centres(name: string): Centres {
  const zip = join(DIR, `${name}.zip`), cache = join(DIR, `${name}.centres.json`), zipMtime = statSync(zip).mtimeMs;
  if (existsSync(cache)) {
    const c: Centres = readJson(cache);
    if (c.zipMtime === zipMtime) return c;
  }
  const tm = projected(zip), shp = readShp(zip), recs: Centres["recs"] = [];
  for (let o = 100; o + 8 <= shp.length;) {
    const rec = record(shp, o, tm);
    let lon = 0, lat = 0, n = 0, z = Infinity;
    for (const poly of rec.polys) for (const p of poly[0]) { lon += p[0]; lat += p[1]; n++; z = Math.min(z, p[2]); }
    if (n) recs.push([o, lat / n, lon / n, z]);
    o = rec.next;
  }
  const c = { zipMtime, tm, recs };
  writeFileSync(`${cache}.tmp`, JSON.stringify(c));
  renameSync(`${cache}.tmp`, cache);
  return c;
}

/**
 * Surveyed ground under every ZG3D building in `bbox`: [lat, lon, lowest point above sea level]. ZG3D walls
 * stand on one base level (the lowest ground at the building), so this samples the bare earth densely
 * wherever the city is built up: ground.ts fits the 30 m Copernicus terrain to it.
 */
export function zg3dBases(bbox: BBox, index: Record<string, BBox>): Array<[number, number, number]> {
  const [S, W, N, E] = bbox, out: Array<[number, number, number]> = [];
  for (const [name, box] of Object.entries(index)) {
    if (!overlaps(boxLatLon(box), bbox)) continue;
    for (const [, lat, lon, z] of centres(name).recs) if (lat >= S && lat <= N && lon >= W && lon <= E) out.push([lat, lon, z]);
  }
  return out;
}

/** Newell normal of a ring (unnormalised). */
function newell(r: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

const area2 = (r: P2[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };

/**
 * Outline of a set of faces seen from above: the edges only one face uses, chained into loops; the
 * largest loop, counter-clockwise. Faces of one surface share their vertices, so this is exact.
 */
function outline(faces: V3[][]): P2[] | null {
  const key = (p: V3) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const pts = new Map<string, P2>(), count = new Map<string, number>();
  for (const f of faces) for (let i = 0; i < f.length; i++) {
    const a = key(f[i]), b = key(f[(i + 1) % f.length]);
    if (a === b) continue;
    pts.set(a, [f[i][0], f[i][1]]);
    const e = a < b ? `${a}|${b}` : `${b}|${a}`;
    count.set(e, (count.get(e) ?? 0) + 1);
  }
  const next = new Map<string, string[]>();
  for (const [e, c] of count) {
    if (c !== 1) continue;
    const [a, b] = e.split("|");
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    (next.get(b) ?? next.set(b, []).get(b)!).push(a);
  }
  let best: P2[] | null = null, bestA = 0;
  const used = new Set<string>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: P2[] = [];
    let prev = "", cur = start;
    while (!used.has(cur)) {
      used.add(cur); loop.push(pts.get(cur)!);
      const n = (next.get(cur) ?? []).find((x) => x !== prev && !used.has(x));
      if (!n) break;
      prev = cur; cur = n;
    }
    const A = Math.abs(area2(loop));
    if (loop.length >= 3 && A > bestA) { best = loop; bestA = A; }
  }
  if (!best || bestA < 4) return null;
  return area2(best) < 0 ? best.reverse() : best;
}

/** Convex hull (monotone chain), counter-clockwise: the footprint of last resort. */
function hull(points: P2[]): P2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], up: P2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

/** |normal z| below this: a wall. */
const WALL_NZ = 0.2;

/**
 * Every ZG3D building whose centre lies in `bbox` ([s, w, n, e]), as LoD2 meshes in the camera's ENU frame.
 * `geoid` turns heights above sea level into ellipsoid heights.
 */
export function zg3dBuildings(bbox: BBox, geoid: number, index: Record<string, BBox>): Lod2Building[] {
  const [S, W, N, E] = bbox, out: Lod2Building[] = [];
  for (const [name, box] of Object.entries(index)) {
    if (!overlaps(boxLatLon(box), bbox)) continue;
    // only districts with a building centred in the box are unzipped, and only those records parsed
    const c = centres(name), inside = c.recs.filter(([, lat, lon]) => lat >= S && lat <= N && lon >= W && lon <= E);
    if (!inside.length) continue;
    const shp = readShp(join(DIR, `${name}.zip`));
    for (const [o, lat, lon] of inside) {
      const rec = record(shp, o, c.tm);
      const b = building(`${name}/${rec.id}`, rec.polys, [lat, lon], geoid);
      if (b) out.push(b);
    }
  }
  return out;
}

function building(id: string, polys: V3[][][], center: [number, number], geoid: number): Lod2Building | null {
  const enu = (p: V3): V3 => ecefToEnu(llhToEcef(p[1], p[0], p[2] + geoid));
  let faces = polys.map((rings) => rings.map((r) => {
    const q = r.map(enu);
    if (q.length > 1 && Math.hypot(q[0][0] - q.at(-1)![0], q[0][1] - q.at(-1)![1], q[0][2] - q.at(-1)![2]) < 1e-3) q.pop();
    return q;
  })).filter((rings) => rings[0].length >= 3);
  if (!faces.length) return null;

  let zmin = Infinity, zmax = -Infinity;
  for (const f of faces) for (const v of f[0]) { zmin = Math.min(zmin, v[2]); zmax = Math.max(zmax, v[2]); }
  // orientation: area-weighted vote of the non-vertical faces above the base (roofs, mostly) on facing up
  let vote = 0;
  for (const f of faces) {
    const nn = newell(f[0]), L = Math.hypot(...nn);
    if (L < 1e-6 || Math.abs(nn[2] / L) < WALL_NZ) continue;
    if (f[0].reduce((a, v) => a + v[2], 0) / f[0].length - zmin >= 0.3) vote += nn[2];
  }
  if (vote < 0) faces = faces.map((rings) => rings.map((r) => [...r].reverse()));
  const walls: V3[][][] = [], roofs: V3[][][] = [], grounds: V3[][][] = [];
  for (const f of faces) {
    const nn = newell(f[0]), L = Math.hypot(...nn);
    if (L < 1e-6) continue;
    const nz = nn[2] / L, meanZ = f[0].reduce((a, v) => a + v[2], 0) / f[0].length;
    if (Math.abs(nz) < WALL_NZ) walls.push(f);
    else if (nz < 0 || meanZ - zmin < 0.3) grounds.push(f); // facing down, or flat at the base
    else roofs.push(f);
  }
  const base = walls.length ? Math.min(...walls.flatMap((f) => f[0].map((v) => v[2]))) : zmin;

  const roof: number[] = [], wall: number[] = [];
  let flat = true;
  for (const f of roofs) {
    const tris = triangulate(f);
    if (!tris) continue;
    if (tris.normal[2] < 0.97) flat = false;
    for (const v of tris.flat()) roof.push(...v);
  }
  for (const f of walls) {
    const tris = triangulate(f);
    if (!tris) continue;
    // facade coordinates: metres along the wall's horizontal direction, metres above the building's base
    const nrm = tris.normal, hx = -nrm[1], hy = nrm[0], hl = Math.hypot(hx, hy) || 1, o = f[0][0];
    for (const v of tris.flat()) wall.push(v[0], v[1], v[2], ((v[0] - o[0]) * hx + (v[1] - o[1]) * hy) / hl + hashAlong(o), v[2] - base);
  }
  if (!roof.length && !wall.length) return null;

  // footprint: the building's outline from its ground faces or, seen from above, its roofs; where faces don't
  // share vertices a loop is only a piece of it, so take the candidate closest to the roofs' covered area
  const flat2 = (f: V3[]) => f.map((v) => [v[0], v[1]] as P2);
  const roofArea = roofs.reduce((a, f) => a + Math.abs(area2(flat2(f[0]))), 0);
  const all = faces.flatMap((f) => flat2(f[0]));
  const candidates = [outline(grounds.map((f) => f[0])), outline(roofs.map((f) => f[0])), all.length >= 3 ? hull(all) : null]
    .filter((c): c is P2[] => !!c && c.length >= 3);
  if (!candidates.length) return null;
  const misfit = (c: P2[]) => roofArea > 1 ? Math.abs(Math.log(Math.abs(area2(c)) / roofArea)) : -c.length;
  const footprint = candidates.reduce((best, c) => misfit(c) < misfit(best) ? c : best);
  return { id, fn: "zg3d", roofType: flat ? "1000" : "3100", height: zmax - base, base, roof, wall, footprint, center, utm: [] };
}
