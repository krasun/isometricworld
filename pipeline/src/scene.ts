/**
 * Build the 3D scene for an area from open data, in the camera's ENU frame.
 * Buildings and tree crowns; the ground comes from ground.ts.
 *
 *   npm -w pipeline run scene -- tlv-core
 *
 * Sources per region (places.ts `sources`): Tel Aviv-Yafo municipal buildings + canopy ("tlv"),
 * LGL LoD2 buildings + nDOM1 tree crowns ("lgl"), else OSM buildings + trees. Regions with look
 * "styled" also take roof/facade looks, tall towers and landmarks from OSM, and get tunnel portals
 * and bridge models.
 *
 * Output: data/derived/<area>/scene/<tx>_<ty>.json — objects visible in each render tile:
 *   b: buildings  [ring (ENU x,y pairs, CCW), height above ground, style, groundHint]
 *   m: LoD2 meshes [style, roof kind, roof xyz[], wall xyz+facade[], footprint ring, height, seed]
 *   t: tree crowns [x, y, radius, crown height above ground]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArea } from "./areas.ts";
import { CAMERA, ecefToEnu, enuToLlh, enuToPixel, llhToEcef } from "./camera.ts";
import { isBridge } from "./bridges.ts";
import { crowns } from "./canopy.ts";
import { ARCADES, arcade, LOOKS, PLACED, type Piece, type Rings, STRUCTURES, type Structure, TOPS, TOWERS } from "./landmarks.ts";
import { groupEnds, portal, tunnelEnds } from "./portals.ts";
import { BRIDGES } from "./bridgemodels.ts";
import { deckHeight } from "./bridges.ts";
import { fromPuwg, gugikBuildings, gugikNdom, toPuwg } from "./gugik.ts";
import { lod2Files, rasterSampler } from "./lgl.ts";
import { alkisKind, type Lod2Building, parseLod2 } from "./lod2.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { REGIONS } from "./places.ts";
import { fromUtm, toUtm } from "./utm.ts";

type P2 = [number, number];
const T = CAMERA.tile;
const FLOOR = 3.2;

const toEnu = (lon: number, lat: number, h = 0): [number, number, number] => ecefToEnu(llhToEcef(lat, lon, h));

function area2(r: P2[]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 = CCW
}

/** Douglas-Peucker on a closed ring. */
function simplify(r: P2[], tol: number): P2[] {
  if (r.length <= 4) return r;
  const keep = new Uint8Array(r.length);
  keep[0] = keep[r.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, r.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bi = -1;
    const [ax, ay] = r[a], [bx, by] = r[b];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - r[i][1]) - (ax - r[i][0]) * (by - ay)) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return r.filter((_, i) => keep[i]);
}

function ringFromLonLat(coords: number[][]): P2[] | null {
  let r: P2[] = coords.map(([lon, lat]) => { const p = toEnu(lon, lat); return [p[0], p[1]] as P2; });
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  // closed ring: split at the vertex farthest from r[0] so both halves have a real chord
  let far = 0;
  r.forEach((p, i) => { if (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = i; });
  if (far > 0) r = [...simplify(r.slice(0, far + 1), 0.35).slice(0, -1), ...simplify([...r.slice(far), r[0]], 0.35).slice(0, -1)];
  if (r.length < 3) return null;
  if (area2(r) < 0) r.reverse();
  return Math.abs(area2(r)) >= 6 ? r : null;
}

function inside([x, y]: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const centre = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
const hash = (n: number) => { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; return (Math.imul(x, 0xc2b2ae35) >>> 0) / 2 ** 32; };

/**
 * Visual style index used by the renderer (palette + facade pattern):
 * 0 Bauhaus/International (pre-1950, white, ribbon windows) · 1 1950–90s residential (cream, balcony bands)
 * 2 public (stone) · 3 tower (glass curtain wall) · 4 shed · 5 modern mid-rise (light grey, big windows)
 */
function style(height: number, kind: string, id: number, year?: number | null) {
  if (height >= 55) return 3;
  if (kind === "public") return 2;
  if (kind === "temporary") return 4;
  if (year && year < 1950 && height < 25) return 0;
  if (year && year >= 1995) return 5;
  if (!year) return hash(id) < 0.3 ? 0 : hash(id) < 0.8 ? 1 : 5;
  return hash(id) < 0.25 ? 0 : 1;
}

/**
 * LoD2 building -> [facade style, roof kinds] from its ALKIS building function (31001_<code>), AdV roof type
 * and height. Facade styles: 0 old plaster, 1 post-war plaster, 2 public/sandstone, 3 tower, 4 shed, 5 office.
 * Roof kinds: 0 red tile, 1 brown tile, 2 slate, 3 gravel, 4 copper, 5 dark membrane, 6 green roof;
 * encoded pitched * 10 + flat, since roofs of mixed form (AdV 5000) have both and the renderer picks per plane.
 */
/** Muted roof colours for OSM roof:colour names and roof:material (the house palette, not CSS red). */
const ROOF_NAMED: Record<string, number[]> = {
  red: [0.74, 0.36, 0.25], darkred: [0.58, 0.28, 0.22], brown: [0.56, 0.38, 0.28], orange: [0.80, 0.48, 0.30],
  grey: [0.52, 0.53, 0.56], gray: [0.52, 0.53, 0.56], darkgrey: [0.38, 0.39, 0.42], darkgray: [0.38, 0.39, 0.42],
  lightgrey: [0.70, 0.70, 0.70], lightgray: [0.70, 0.70, 0.70], silver: [0.70, 0.71, 0.73], black: [0.28, 0.28, 0.30],
  white: [0.86, 0.85, 0.82], green: [0.45, 0.66, 0.56], beige: [0.80, 0.74, 0.62], blue: [0.42, 0.50, 0.62],
};
const ROOF_MATERIAL: Record<string, number[]> = {
  roof_tiles: ROOF_NAMED.red, tiles: ROOF_NAMED.red, slate: [0.44, 0.46, 0.50], metal: [0.62, 0.64, 0.66],
  zinc: [0.60, 0.62, 0.64], tin: [0.62, 0.64, 0.66], copper: [0.45, 0.70, 0.60], concrete: [0.74, 0.74, 0.72],
  gravel: [0.86, 0.84, 0.79], tar_paper: [0.40, 0.40, 0.42], asphalt: [0.40, 0.40, 0.42], glass: [0.58, 0.68, 0.74],
  grass: [0.56, 0.68, 0.40], plants: [0.56, 0.68, 0.40],
};
function roofRgb(t: Record<string, string>): number[] | null {
  const c = (t["roof:colour"] ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(c)?.[1];
  let rgb: number[] | null = null;
  if (hex) {
    const h = hex.length === 3 ? [...hex].map((d) => d + d).join("") : hex;
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const m = (rgb[0] + rgb[1] + rgb[2]) / 3; // mapped colours tend to the vivid: pull 25 % towards their grey
    rgb = rgb.map((v) => v * 0.75 + m * 0.25);
  } else rgb = ROOF_NAMED[c] ?? ROOF_MATERIAL[t["roof:material"] ?? ""] ?? null;
  return rgb && rgb.map((v) => Math.round(v * 100) / 100);
}

/** Facade style (see style()) and wall colour from OSM building:material / building:colour. */
const WALL_NAMED: Record<string, number[]> = {
  grey: [0.80, 0.79, 0.76], gray: [0.80, 0.79, 0.76], lightgrey: [0.86, 0.86, 0.84], lightgray: [0.86, 0.86, 0.84],
  darkgrey: [0.62, 0.62, 0.62], darkgray: [0.62, 0.62, 0.62], white: [0.96, 0.95, 0.92], beige: [0.92, 0.86, 0.72],
  yellow: [0.96, 0.89, 0.66], cream: [0.95, 0.91, 0.81], red: [0.78, 0.48, 0.40], brown: [0.66, 0.52, 0.42],
  orange: [0.92, 0.70, 0.50], pink: [0.94, 0.82, 0.78], blue: [0.72, 0.80, 0.88], green: [0.76, 0.84, 0.74],
};
function wallLook(t: Record<string, string>): { style: number | null; wall: number[] | null } {
  const m = t["building:material"] ?? "";
  const style = /stone|sandstone|limestone|marble|granite/.test(m) ? 2 : /glass/.test(m) ? 3 : /concrete|metal|steel/.test(m) ? 5 : null;
  const c = (t["building:colour"] ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(c)?.[1];
  let wall: number[] | null = WALL_NAMED[c] ?? null;
  if (hex) {
    const h = hex.length === 3 ? [...hex].map((d) => d + d).join("") : hex;
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255), mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
    wall = rgb.map((v) => Math.min(1, (v * 0.6 + mean * 0.4) * 0.5 + 0.48)); // walls stay light in the house style
  }
  return { style, wall: wall && wall.map((v) => Math.round(v * 100) / 100) };
}

function lod2Style(b: Lod2Building): [number, number] {
  const kind = b.kind ?? alkisKind(b.fn), flatOnly = b.roofType === "1000";
  const r = hash(Math.round(b.center[0] * 1e6) ^ Math.round(b.center[1] * 1e6));
  const r2 = hash(Math.round(b.center[1] * 1e6) * 7 + 3);
  const tile = r < 0.55 ? 0 : r < 0.82 ? 1 : 2;
  const flat = r2 < 0.55 ? 3 : r2 < 0.85 ? 5 : 6;
  const k = (pitched: number, f: number) => pitched * 10 + f;
  if (kind === "structure") return [4, k(2, 5)];                                 // canopies, other structures
  if (kind === "small" || b.height < 3.5) return [4, k(tile, 5)];
  if (kind === "church") return [2, k(r < 0.3 ? 4 : 2, 3)];                     // churches: slate, some copper
  if (b.height >= 45) return [3, k(2, 5)];
  if (kind === "public") return [2, k(r < 0.15 ? 4 : tile, flat)];             // public: sandstone
  if ((kind === "commercial" || kind === "industrial") && (flatOnly || b.height > 18)) return [r2 < 0.5 ? 5 : 1, k(tile, flat)]; // offices, shops: ribbon or punched windows
  if (kind === "industrial") return [4, k(tile, 5)];                            // production, storage
  return [flatOnly ? 1 : 0, k(tile, flat)];
}

const name = process.argv[2] ?? "tlv-core";
const area = openArea(name);
const bbox = area.bbox;
const region = REGIONS[area.region];
/** Styled look (places.ts `look`): OSM looks and landmarks on the LoD2 meshes, tunnel portals, bridge models. */
const STYLED = region.look === "styled";
/** Buildings are LoD2 meshes and tree crowns come from a surface model (LGL, GUGiK), not from OSM. */
const LOD2 = region.sources === "lgl" || region.sources === "gugik";
/** Geoid undulation: orthometric (MSL) + this = ellipsoid height. */
const GEOID = region.geoidM;
const raw = join(RAW, name);
if (!existsSync(join(DERIVED, name, "ground", "meta.json"))) throw new Error(`run: npm run ground -- ${name}`);
// terrain from ground.ts: objects are binned by where they really stand
const gmeta = readJson(join(DERIVED, name, "ground", "meta.json"));
const gbuf = readFileSync(join(DERIVED, name, "ground", "height.bin"));
const gh = new Float32Array(gbuf.buffer, gbuf.byteOffset, gbuf.length / 4);
function groundAt(x: number, y: number) {
  const ix = Math.min(gmeta.nx - 1, Math.max(0, Math.round((x - gmeta.x0) / gmeta.step)));
  const iy = Math.min(gmeta.ny - 1, Math.max(0, Math.round((y - gmeta.y0) / gmeta.step)));
  return gh[iy * gmeta.nx + ix];
}
const out = join(DERIVED, name, "scene");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

type Building = { ring: P2[]; h: number; s: number; g: number | null };
const buildings: Building[] = [];
const tlvCover: P2[][] = [];
/** municipal footprints with their holes, for the OSM 3D swap (1a) */
const tlvRecs: Array<{ b: Building; holes: P2[][]; id: number }> = [];

const trees: Array<[number, number, number, number]> = [];
const meshes: Lod2Building[] = [];

// 1. Tel Aviv-Yafo municipal buildings: surveyed heights.
const tlv = region.sources === "tlv" ? readJson(join(raw, "tlv_buildings.geojson")) : { features: [] };
for (const f of tlv.features) {
  const p = f.properties, g = f.geometry;
  if (!g) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const kind = ({ "מבנה ציבור": "public", "מבנה ארעי": "temporary", "תחנת אוטובוס": "shelter" } as Record<string, string>)[p.t_sug_mivne] ?? "regular";
  let h = p.gova_simplex_2019 || (p.ms_komot ? p.ms_komot * FLOOR + 1 : 0) || 4;
  if (kind === "shelter") h = 3;
  for (const poly of polys) {
    const ring = ringFromLonLat(poly[0]);
    if (!ring) continue;
    const b = { ring, h: Math.max(3, h), s: style(h, kind, p.id_binyan ?? buildings.length, p.year), g: p.min_height ? p.min_height + GEOID : null };
    buildings.push(b);
    tlvCover.push(ring);
    tlvRecs.push({ b, holes: poly.slice(1).map((r: number[][]) => ringFromLonLat(r)).filter(Boolean) as P2[][], id: p.id_binyan });
  }
}
if (region.sources === "tlv") console.log(`  tlv buildings: ${buildings.length}`);
const osm = readJson(join(raw, "osm.json"));

// 1a. OSM 3D shapes (Simple 3D Buildings) for the municipal buildings they change most. The municipal layer
// has one height per footprint: a podium can carry its tower's height (Azrieli Center: the mall at 187 m)
// and a tower on a podium is one block. OSM buildings and building:parts give the shape. Only the top N
// (--parts N, default 10) are swapped, so the rest of the render still matches the paintings; the swapped
// buildings go to data/derived/<area>/osm-parts.json for `paint --parts`.
const PARTS_N = Number(process.argv.find((a, i) => process.argv[i - 1] === "--parts") ?? process.argv.find((a) => a.startsWith("--parts="))?.slice(8) ?? 10);
const swapped: Array<{ id: number; name: string; lat: number; lon: number; was: number; now: number; px: number[] }> = [];
if (region.sources === "tlv" && existsSync(join(raw, "osm_parts.json")) && PARTS_N > 0) {
  const num = (v?: string) => { const x = parseFloat((v ?? "").replace(",", ".")); return Number.isFinite(x) ? x : 0; };
  type Shape = { ring: P2[]; top: number; c: P2; a: number; part: boolean; outline?: boolean; id: string; name: string };
  const shapes: Shape[] = [], seen = new Set<string>();
  for (const el of [...readJson(join(raw, "osm_parts.json")).elements, ...osm.elements]) {
    const t = el.tags ?? {}, id = `${el.type}${el.id}`;
    if (seen.has(id) || !(t.building || t["building:part"]) || el.type === "node") continue;
    seen.add(id);
    if (t.building === "roof" || t["building:part"] === "roof" || t.location === "underground") continue;
    const coords = el.type === "way" ? el.geometry?.map((q: any) => [q.lon, q.lat])
      : el.members?.find((m: any) => m.role === "outer" && m.geometry)?.geometry.map((q: any) => [q.lon, q.lat]);
    const ring = coords?.length >= 4 ? ringFromLonLat(coords) : null;
    const levels = num(t["building:levels"]), top = num(t.height) || (levels ? levels * FLOOR + 1 : 0);
    if (!ring || !top) continue;
    shapes.push({ ring, top, c: centre(ring), a: Math.abs(area2(ring)), part: !!t["building:part"] && !t.building, id, name: t["name:en"] ?? t.name ?? "" });
  }
  const grid = <V>(items: V[], at: (v: V) => P2) => {
    const g = new Map<string, V[]>();
    for (const v of items) { const [x, y] = at(v), k = `${Math.floor(x / 60)}_${Math.floor(y / 60)}`; (g.get(k) ?? g.set(k, []).get(k)!).push(v); }
    return (p: P2, r: number) => {
      const out: V[] = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push(...(g.get(`${Math.floor(p[0] / 60) + dx}_${Math.floor(p[1] / 60) + dy}`) ?? []));
      return out;
    };
  };
  const samples = (ring: P2[], n: number) => {
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), st = Math.max(1, Math.sqrt(Math.abs(area2(ring))) / n), out: P2[] = [];
    for (let x = Math.min(...xs) + st / 2; x < Math.max(...xs); x += st)
      for (let y = Math.min(...ys) + st / 2; y < Math.max(...ys); y += st) if (inside([x, y], ring)) out.push([x, y]);
    return { pts: out, cell: st * st };
  };
  // an outline whose parts cover it is not drawn (S3DB); one only partly split into parts (the Azrieli mall)
  // still stands under them at its own height
  const partsNear = grid(shapes.filter((s) => s.part), (s) => s.c);
  for (const s of shapes) if (!s.part) {
    const mine = partsNear(s.c, Math.ceil(Math.sqrt(s.a) / 60) + 1).filter((p) => inside(p.c, s.ring));
    if (!mine.length) continue;
    const { pts } = samples(s.ring, 20);
    s.outline = pts.filter((q) => mine.some((p) => inside(q, p.ring))).length >= 0.85 * pts.length;
  }
  const drawn = shapes.filter((s) => !s.outline);
  const shapesNear = grid(drawn, (s) => s.c), recsNear = grid(tlvRecs, (r) => centre(r.b.ring));
  const inRec = (p: P2, r: (typeof tlvRecs)[number]) => inside(p, r.b.ring) && !r.holes.some((h) => inside(p, h));
  type Cand = { rec: (typeof tlvRecs)[number]; own: Shape[]; change: number; now: number };
  const cands: Cand[] = [];
  for (const rec of tlvRecs) {
    const m = rec.b, A = Math.abs(area2(m.ring));
    if (A < 150 || m.h < 25) continue;
    const R = Math.ceil(Math.max(...m.ring.map((p) => Math.hypot(p[0] - centre(m.ring)[0], p[1] - centre(m.ring)[1]))) / 60) + 2;
    // OSM shapes mostly (≥ 50 %) inside this footprint
    const own = shapesNear(centre(m.ring), R).filter((s) => { const { pts } = samples(s.ring, 12); return pts.length > 0 && pts.filter((p) => inRec(p, rec)).length / pts.length >= 0.5; });
    if (!own.length) continue;
    const others = recsNear(centre(m.ring), R).filter((o) => o !== rec && Math.abs(area2(o.b.ring)) < A);
    const { pts, cell } = samples(m.ring, 40);
    let n = 0, cov = 0, change = 0;
    for (const p of pts) {
      if (!inRec(p, rec)) continue;
      n++;
      if (others.some((o) => inRec(p, o))) { cov++; continue; } // a tower mapped on its own in the municipal layer
      const tops = own.filter((s) => inside(p, s.ring)).map((s) => s.top);
      if (tops.length) { cov++; change += Math.abs(Math.max(...tops) - m.h) * cell; }
    }
    const now = Math.max(...own.map((s) => s.top));
    const touching = others.filter((o) => inRec(centre(o.b.ring), rec) || o.b.ring.some((q) => inRec(q, rec)));
    // trust OSM when it agrees on the top, or when a tower in the footprint explains the municipal height
    const agrees = now >= 0.8 * m.h && now <= 1.25 * m.h, podium = touching.some((o) => o.b.h >= 0.8 * m.h);
    if (n && cov / n >= 0.85 && (agrees || podium)) cands.push({ rec, own, change, now });
  }
  cands.sort((a, b) => b.change - a.change);
  const used = new Map<string, (typeof swapped)[number]>(), gone = new Set<Building>();
  for (const c of cands) {
    if (swapped.length >= PARTS_N) break;
    if (gone.has(c.rec.b)) continue; // a duplicate footprint of one already swapped
    const m = c.rec.b, add = c.own.filter((s) => !used.has(s.id));
    const pxBox = (r: P2[], lo: number, hi: number) => r.flatMap(([x, y]) => [enuToPixel([x, y, lo]), enuToPixel([x, y, hi])]);
    const g0 = Math.min(...m.ring.map(([x, y]) => groundAt(x, y))) - 3;
    const bounds = (px: P2[]) => [Math.min(...px.map((p) => p[0])), Math.min(...px.map((p) => p[1])), Math.max(...px.map((p) => p[0])), Math.max(...px.map((p) => p[1]))].map(Math.round);
    if (!add.length) { // its OSM shapes went to a building already swapped: a second municipal copy of it, dropped too
      const owner = used.get(c.own[0].id)!, b = bounds(pxBox(m.ring, g0, g0 + 6 + m.h));
      owner.px = [Math.min(owner.px[0], b[0]), Math.min(owner.px[1], b[1]), Math.max(owner.px[2], b[2]), Math.max(owner.px[3], b[3])];
      gone.add(m); buildings.splice(buildings.indexOf(m), 1);
      console.log(`  osm 3D: #${c.rec.id} is a copy of #${owner.id}, dropped`);
      continue;
    }
    // municipal duplicates of this footprint (Azrieli Sarona is mapped twice) go with it
    const dups = recsNear(centre(m.ring), 3).filter((o) => o !== c.rec && !gone.has(o.b) && Math.abs(area2(o.b.ring)) > 0.7 * Math.abs(area2(m.ring)) && Math.abs(area2(o.b.ring)) < 1.4 * Math.abs(area2(m.ring)) && (() => { const { pts } = samples(o.b.ring, 12); return pts.length > 0 && pts.filter((p) => inRec(p, c.rec)).length / pts.length >= 0.5; })());
    const px = [...pxBox(m.ring, g0, g0 + 6 + m.h), ...dups.flatMap((o) => pxBox(o.b.ring, g0, g0 + 6 + o.b.h)), ...add.flatMap((s) => pxBox(s.ring, g0, g0 + 6 + s.top))];
    for (const b of [m, ...dups.map((o) => o.b)]) { gone.add(b); buildings.splice(buildings.indexOf(b), 1); }
    for (const s of add) buildings.push({ ring: s.ring, h: s.top, s: style(s.top, m.s === 2 ? "public" : "regular", c.rec.id), g: m.g });
    const [lat, lon] = enuToLlh([...centre(m.ring), 0]);
    const nm = [...new Set(c.own.map((s) => s.name).filter(Boolean))].join(" / ");
    const entry = { id: c.rec.id, name: nm, lat, lon, was: m.h, now: c.now, px: bounds(px) };
    swapped.push(entry);
    for (const s of add) used.set(s.id, entry);
    console.log(`  osm 3D: #${c.rec.id} ${nm || "(unnamed)"} ${Math.round(m.h)} m -> ${add.length} OSM shape(s) up to ${Math.round(c.now)} m${dups.length ? `, ${dups.length} duplicate(s) dropped` : ""}`);
  }
  console.log(`  osm 3D: ${swapped.length} of ${cands.length} candidate buildings swapped (--parts ${PARTS_N})`);
}

// 1b. LoD2 buildings (real roofs) and tree crowns from a surface model: LGL (LoD2, nDOM1) or GUGiK
// (LoD2 + LoD1 2024, NMPT − NMT).
if (LOD2) {
  const m = 0.002; // buildings whose centre is just outside still reach into edge tiles
  const box = [bbox[0] - m, bbox[1] - m, bbox[2] + m, bbox[3] + m];
  let ndom: (x: number, y: number) => number, toXy = toUtm, fromXy = fromUtm;
  if (region.sources === "lgl") {
    for (const f of lod2Files(box)) {
      const bs = parseLod2(f.xml, box, GEOID);
      meshes.push(...bs);
      process.stdout.write(`\r  lod2: ${meshes.length} buildings (${f.name.split("/").pop()})        `);
    }
    process.stdout.write("\n");
    ndom = (await rasterSampler("ndom1", box)).px;
  } else {
    meshes.push(...await gugikBuildings(region.teryt ?? [], box, GEOID));
    ndom = gugikNdom(box);
    toXy = toPuwg; fromXy = fromPuwg;
  }
  const cs = crowns(ndom, box, meshes.flatMap((b) => b.xy), toXy);
  // On rail land and building sites the surface model is mostly masts, trains, cranes and containers:
  // keep only crowns that are clearly trees there (wide and tall).
  const noTrees: Array<{ r: P2[]; b: number[] }> = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    if (!/^(railway|construction)$/.test(el.tags?.landuse ?? "")) continue;
    const rings = el.type === "way" ? [el.geometry] : (el.members ?? []).filter((m: any) => m.role === "outer" && m.geometry).map((m: any) => m.geometry);
    for (const g of rings) {
      const r = g && g.length >= 4 ? ringFromLonLat(g.map((q: any) => [q.lon, q.lat])) : null;
      if (r) noTrees.push({ r, b: [Math.min(...r.map((q) => q[0])), Math.min(...r.map((q) => q[1])), Math.max(...r.map((q) => q[0])), Math.max(...r.map((q) => q[1]))] });
    }
  }
  // Bridges: the surface model holds the deck above the bare-earth gap, read as crowns. Drop crowns on
  // the deck (a tree under it is hidden by it anyway).
  const decks: P2[][] = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    if (el.type !== "way" || !isBridge(el.tags ?? {}) || !(el.tags.highway || el.tags.railway) || !(el.geometry?.length >= 2)) continue;
    decks.push(el.geometry.map((q: any) => { const e = toEnu(q.lon, q.lat); return [e[0], e[1]] as P2; }));
  }
  const segDist = (p: P2, a: P2, b: P2) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  };
  const onDeck = (p: P2) => decks.some((l) => l.some((a, i) => i > 0 && segDist(p, l[i - 1], a) < 4));
  // ... and inside bridge outlines (a bridge whose tracks OSM has not opened yet has no way), and on water,
  // where the surface model is noise and boats
  const over: Array<{ r: P2[][]; b: number[] }> = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    const t = el.tags ?? {};
    if (t.man_made !== "bridge" && !(t.natural === "water" || t.waterway === "riverbank")) continue;
    const rings = (el.type === "way" ? [el.geometry] : (el.members ?? []).filter((m: any) => m.geometry).map((m: any) => m.geometry))
      .filter((g: any) => g && g.length >= 4).map((g: any) => ringFromLonLat(g.map((q: any) => [q.lon, q.lat]))).filter(Boolean) as P2[][];
    if (!rings.length) continue;
    const all = rings.flat();
    over.push({ r: rings, b: [Math.min(...all.map((q) => q[0])), Math.min(...all.map((q) => q[1])), Math.max(...all.map((q) => q[0])), Math.max(...all.map((q) => q[1]))] });
  }
  const overWater = (p: P2) => over.some(({ r, b }) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && r.filter((q) => inside(p, q)).length % 2 === 1);
  let masked = 0, bridged = 0;
  for (const c of cs) {
    const [lat, lon] = fromXy(c.e, c.n), p = toEnu(lon, lat);
    if (onDeck([p[0], p[1]]) || overWater([p[0], p[1]])) { bridged++; continue; }
    if ((c.r < 4 || c.h < 8) && noTrees.some(({ r, b }) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && inside([p[0], p[1]], r))) { masked++; continue; }
    trees.push([p[0], p[1], c.r, Math.max(c.r * 0.6 + 1, c.h - c.r * 0.85)]);
  }
  console.log(`  ${region.sources === "lgl" ? "ndom1" : "nmpt − nmt"} tree crowns: ${cs.length - masked - bridged} (${masked} dropped on rail land / building sites, ${bridged} on bridges or water)`);
}

// 2. OSM buildings where the municipal layer has nothing (Ramat Gan, Givatayim, Bnei Brak…).
const coverGrid = new Map<string, P2[][]>(); // 50 m grid of municipal footprints for overlap tests
for (const r of tlvCover) {
  const k = `${Math.floor(r[0][0] / 50)}_${Math.floor(r[0][1] / 50)}`;
  if (!coverGrid.has(k)) coverGrid.set(k, []);
  coverGrid.get(k)!.push(r);
}
const covered = (pt: P2) => {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    if (coverGrid.get(`${Math.floor(pt[0] / 50) + dx}_${Math.floor(pt[1] / 50) + dy}`)?.some((r) => inside(pt, r))) return true;
  return false;
};
let osmCount = 0;
// styled regions: OSM roof:colour / roof:material, building:colour / building:material per footprint or building part
// tall towers (TV towers…): LoD2 has only a stump, OSM often has the whole shape as building:parts with min_height
const tallTowers: Array<{ ring: P2[]; h: number; name?: string }> = [];
const structures: Array<{ rings: Rings; structure: Structure; t: Record<string, string> }> = []; // landmarks.ts STRUCTURES
const tops: Array<{ ring: P2[]; name: string }> = []; // landmarks.ts TOPS
const fountains: Array<{ ring?: P2[]; at?: P2 }> = [];
const arcades: Array<{ ring: P2[]; name: string }> = []; // landmarks.ts ARCADES
const parts: Array<{ ring: P2[]; h: number; min: number; t: Record<string, string> }> = [];
const looks: Array<{ ring: P2[]; area: number; roof: number[] | null; style: number | null; wall: number[] | null; bare?: boolean }> = [];
for (const el of osm.elements) {
  const t = { ...el.tags, ...(LOOKS[el.tags?.name] ?? {}) };
  // structures built on their OSM outline (landmarks.ts STRUCTURES): a graduation tower's brushwood walls
  const structure = STYLED && el.type !== "node" ? STRUCTURES.find((s) => s.match(t)) : undefined;
  if (structure) {
    const rings = osmRings(el);
    if (rings.outer.length) structures.push({ rings, structure, t });
    continue;
  }
  if (t.amenity === "fountain" && LOD2) { // nDOM reads fountain sculptures as tree crowns
    if (el.type === "node") { const q = toEnu(el.lon, el.lat); fountains.push({ at: [q[0], q[1]] }); }
    else if (el.type === "way" && el.geometry?.length >= 4) { const ring = ringFromLonLat(el.geometry.map((q: any) => [q.lon, q.lat])); if (ring) fountains.push({ ring }); }
    if (!t.building) continue;
  }
  if (el.type === "node" && t.natural === "tree") {
    if (LOD2) continue; // the surface model's crowns include them
    const p = toEnu(el.lon, el.lat); trees.push([p[0], p[1], 3, 6]); continue;
  }
  const monument = STYLED && !t.building && !t["building:part"] && el.type === "way" && (t.name ?? "") in TOWERS; // Jubiläumssäule
  const styledLook = STYLED && (!!(t.building || t["building:part"]) || monument);
  if (!styledLook && (!t.building || t.building === "roof" || t.location === "underground")) continue;
  const coords = el.type === "way" ? el.geometry?.map((q: any) => [q.lon, q.lat])
    : el.members?.find((m: any) => m.role === "outer" && m.geometry)?.geometry.map((q: any) => [q.lon, q.lat]);
  if (!coords || coords.length < 4) continue;
  const ring = ringFromLonLat(coords);
  if (!ring) continue;
  if (styledLook) {
    const h = parseFloat(t.height);
    if (monument) { tallTowers.push({ ring, h, name: t.name }); continue; }
    if (/^(tower|communications_tower)$/.test(t.man_made ?? "") && h >= 60) tallTowers.push({ ring, h, name: t.name });
    if (t.name && t.name in TOPS) tops.push({ ring, name: t.name });
    if (t.name && t.name in ARCADES && t.building) arcades.push({ ring, name: t.name });
    if (t["building:part"] && h) parts.push({ ring, h, min: parseFloat(t.min_height) || 0, t });
    looks.push({ ring, area: Math.abs(area2(ring)), roof: roofRgb(t), ...wallLook(t), bare: t.name in LOOKS }); // landmarks: no solar panels etc.
  }
  if (LOD2) continue; // the buildings are LoD2 meshes: OSM footprints only carry their looks
  const c: P2 = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
  if (covered(c)) continue;
  const levels = parseFloat(t["building:levels"]);
  let h = parseFloat(t.height) || (levels ? levels * FLOOR + 1 : 0);
  if (!h) h = Math.abs(area2(ring)) > 1500 ? 14 : ["house", "garage", "shed", "kiosk"].includes(t.building) ? 5 : 13;
  buildings.push({ ring, h, s: style(h, t.amenity || t.building === "school" ? "public" : "regular", el.id), g: null });
  osmCount++;
}
if (fountains.length) {
  const n0 = trees.length;
  for (let i = trees.length - 1; i >= 0; i--) {
    const p: P2 = [trees[i][0], trees[i][1]];
    if (fountains.some((f) => (f.ring ? inside(p, f.ring) : Math.hypot(p[0] - f.at![0], p[1] - f.at![1]) < 3))) trees.splice(i, 1);
  }
  console.log(`  fountains: ${fountains.length}, ${n0 - trees.length} crown(s) on them dropped`);
}
console.log(`  osm buildings (outside municipal layer): ${osmCount}`);
if (looks.length) console.log(`  osm roof/wall looks: ${looks.length}`);
// the smallest OSM footprint (a building:part before its building) holding a LoD2 building's centre, per attribute; 50 m grid
looks.sort((a, b) => a.area - b.area);
const lookGrid = new Map<string, typeof looks>();
for (const r of looks) {
  const xs = r.ring.map((p) => p[0]), ys = r.ring.map((p) => p[1]);
  for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
    for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++) {
      const k = `${gx}_${gy}`;
      if (!lookGrid.has(k)) lookGrid.set(k, []);
      lookGrid.get(k)!.push(r);
    }
}
const lookAt = (pt: P2) => {
  const hits = lookGrid.get(`${Math.floor(pt[0] / 50)}_${Math.floor(pt[1] / 50)}`)?.filter((r) => inside(pt, r.ring)) ?? [];
  return { roof: hits.find((r) => r.roof)?.roof ?? null, style: hits.find((r) => r.style !== null)?.style ?? null, wall: hits.find((r) => r.wall)?.wall ?? null, bare: hits.some((r) => r.bare) };
};

// Bridges and decks recorded as buildings (Arlozorov / Savidor over the Ayalon): any footprint a
// motorway, trunk road or railway runs through for 20 m+ is not a building. Drop it; the road is drawn.
{
  const lines: P2[] = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || !(/^(motorway|trunk)(_link)?$/.test(t.highway) || /^(rail|light_rail)$/.test(t.railway))) continue;
    const g: P2[] = el.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
    for (let i = 1; i < g.length; i++) {
      const n = Math.ceil(Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]) / 5);
      for (let k = 0; k < n; k++) lines.push([g[i - 1][0] + ((g[i][0] - g[i - 1][0]) * k) / n, g[i - 1][1] + ((g[i][1] - g[i - 1][1]) * k) / n]);
    }
  }
  const grid = new Map<string, P2[]>();
  for (const p of lines) { const k = `${Math.floor(p[0] / 50)}_${Math.floor(p[1] / 50)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
  const before = buildings.length;
  for (let i = buildings.length - 1; i >= 0; i--) {
    const r = buildings[i].ring, xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    let hits = 0;
    for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
      for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++)
        for (const p of grid.get(`${gx}_${gy}`) ?? []) if (inside(p, r)) hits++;
    if (hits >= 4) buildings.splice(i, 1);
  }
  console.log(`  dropped ${before - buildings.length} bridges/decks over motorways and rail`);
}

// 3. Tree crowns from 2024 canopy polygons: one crown per ~6 m cell inside each polygon.
const can = region.sources === "tlv" ? readJson(join(raw, "tlv_canopy.geojson")) : { features: [] };
for (const f of can.features) {
  const g = f.geometry;
  if (!g) continue;
  for (const poly of g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) {
    const ring = ringFromLonLat(poly[0]);
    if (!ring) continue;
    const A = Math.abs(area2(ring));
    if (A < 60) {
      const r = Math.sqrt(A / Math.PI);
      trees.push([ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length, r, 3 + r * 1.4]);
      continue;
    }
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), step = 6;
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
      for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
        if (inside([x, y], ring)) {
          const j = hash(Math.round(x * 7 + y * 13));
          trees.push([x + (j - 0.5) * 2, y + (hash(Math.round(x * 3 - y * 5)) - 0.5) * 2, 3.6 + j * 1.2, 6 + j * 3]);
        }
  }
}
console.log(`  tree crowns: ${trees.length}`);

// 4. Bin objects by the render tiles they can appear on (base … top, + margin).
type Bin = { b: Array<[P2[], number, number, number | null]>; m: unknown[]; t: Array<[number, number, number, number]> };
const bins = new Map<string, Bin>();
const add = (minx: number, miny: number, maxx: number, maxy: number, fn: (bin: Bin) => void) => {
  for (let ty = Math.floor((miny - 8) / T); ty <= Math.floor((maxy + 8) / T); ty++)
    for (let tx = Math.floor((minx - 8) / T); tx <= Math.floor((maxx + 8) / T); tx++) {
      const k = `${tx}_${ty}`;
      if (!bins.has(k)) bins.set(k, { b: [], m: [], t: [] });
      fn(bins.get(k)!);
    }
};
for (const b of buildings) {
  const gs = b.ring.map(([x, y]) => groundAt(x, y)), lo = Math.min(...gs) - 3, hi = Math.max(...gs) + 3 + b.h;
  const pts = b.ring.flatMap(([x, y]) => [enuToPixel([x, y, lo]), enuToPixel([x, y, hi])]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const ring = b.ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as P2);
  add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (bin) => bin.b.push([ring, Math.round(b.h * 10) / 10, b.s, b.g && Math.round(b.g * 10) / 10]));
}
const c2 = (v: number) => Math.round(v * 100) / 100;
// 3b. Tall towers from OSM: replace the LoD2 mesh with the tower's building:parts (or its outline), extruded
// from min_height to height; colours straight from the part's tags.
type Mesh = (typeof meshes)[number] & { look?: { roof: number[] | null; wall: number[] | null; style: number | null; bare?: boolean | 1 | 2 | 3 } };
function prism(ring: P2[], base: number, min: number, h: number, look: Mesh["look"]): Mesh {
  const c = centre(ring), roof: number[] = [], wall: number[] = [];
  let along = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    roof.push(c[0], c[1], base + h, a[0], a[1], base + h, b[0], b[1], base + h);
    const v = (p: P2, s: number, z: number) => wall.push(p[0], p[1], base + z, s, z);
    v(a, along, min); v(b, along + L, min); v(b, along + L, h);
    v(a, along, min); v(b, along + L, h); v(a, along, h);
    along += L;
  }
  return { id: "osm-tower", fn: "osm_tower", roofType: "1000", height: h, base, roof, wall, footprint: ring, center: [0, 0], xy: [], look } as unknown as Mesh;
}
/** A way's or multipolygon's closed rings in ENU (members that are closed ways; others are left out). */
function osmRings(el: any): Rings {
  const ring = (g: any[]) => (g?.length >= 4 ? ringFromLonLat(g.map((q: any) => [q.lon, q.lat])) : null);
  if (el.type === "way") { const r = ring(el.geometry); return { outer: r ? [r] : [], inner: [] }; }
  const of = (role: string) => (el.members ?? []).filter((m: any) => m.role === role).map((m: any) => ring(m.geometry)).filter(Boolean) as P2[][];
  return { outer: of("outer"), inner: of("inner") };
}
const fromPiece = (p: Piece) => ({ id: "landmark", fn: "osm_landmark", roofType: "1000", center: [0, 0], xy: [], ...p }) as unknown as Mesh;
for (const tw of tallTowers) {
  const near = (p: P2) => inside(p, tw.ring) || tw.ring.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 3);
  const stump = meshes.filter((b) => near(centre(b.footprint)));
  const base = stump.length ? Math.min(...stump.map((b) => b.base)) : groundAt(...centre(tw.ring));
  for (const b of stump) meshes.splice(meshes.indexOf(b), 1);
  const model = tw.name ? TOWERS[tw.name] : undefined;
  if (model) {
    meshes.push(...model(centre(tw.ring), base).map(fromPiece));
    const tc = centre(tw.ring); // nDOM reads a slender column as a tree crown
    for (let i = trees.length - 1; i >= 0; i--) if (Math.hypot(trees[i][0] - tc[0], trees[i][1] - tc[1]) < 6) trees.splice(i, 1);
    console.log(`  landmark ${tw.name}: ${stump.length} LoD2 part(s) -> model`);
    continue;
  }
  const mine = parts.filter((p) => near(centre(p.ring)));
  for (const p of mine.length ? mine : [{ ring: tw.ring, h: tw.h, min: 0, t: {} as Record<string, string> }]) {
    const w = wallLook(p.t), glazed = p.t["building:part"] !== "yes" || !!p.t["building:levels"];
    meshes.push(prism(p.ring, base, p.min, p.h, { roof: roofRgb(p.t), wall: w.wall, style: glazed ? 5 : 4 }));
  }
  console.log(`  tall tower ${Math.round(tw.h)} m: ${stump.length} LoD2 part(s) -> ${mine.length || 1} OSM part(s)`);
}
// rooftop landmarks (the Mercedes star on the Bahnhofsturm): on the highest LoD2 roof point inside the OSM outline
for (const tp of tops) {
  let top = -Infinity;
  for (const b of meshes) for (let i = 0; i < b.roof.length; i += 3)
    if (inside([b.roof[i], b.roof[i + 1]], tp.ring)) top = Math.max(top, b.roof[i + 2]);
  if (!Number.isFinite(top)) continue;
  // centre of the top face (a tower's flat roof, a lantern's cap), not of the outline (U-shaped palaces)
  let sx = 0, sy = 0, sn = 0;
  for (const b of meshes) for (let i = 0; i < b.roof.length; i += 3)
    if (b.roof[i + 2] > top - 0.3 && inside([b.roof[i], b.roof[i + 1]], tp.ring)) { sx += b.roof[i]; sy += b.roof[i + 1]; sn++; }
  meshes.push(...TOPS[tp.name]([sx / sn, sy / sn], top, region.headingDeg).map(fromPiece));
  console.log(`  landmark ${tp.name}: on the roof at ${top.toFixed(1)} m`);
}

// colonnades (Königsbau): carved into the LoD2 front wall inside the OSM outline
for (const ac of arcades) {
  for (const b of meshes.filter((m) => inside(centre(m.footprint), ac.ring))) {
    const extra = arcade(b as any, ARCADES[ac.name]);
    meshes.push(...extra.map(fromPiece));
    if (extra.length) console.log(`  landmark ${ac.name}: colonnade carved`);
  }
  // nDOM reads the colonnade overhang as a row of crowns in front of it: drop crowns at the building
  const near = (p: P2) => inside(p, ac.ring) || ac.ring.some((a, i) => {
    const b = ac.ring[(i + 1) % ac.ring.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy) < 5;
  });
  for (let i = trees.length - 1; i >= 0; i--) if (near([trees[i][0], trees[i][1]])) trees.splice(i, 1);
}
// styled look: tunnel portals where roads and tracks go underground (portals.ts)
if (STYLED) {
  const ways = ["roads.json", "rails.json", "ground.json"].filter((f) => existsSync(join(raw, f)))
    .flatMap((f) => readJson(join(raw, f)).elements.filter((e: any) => e.type === "way"));
  const groups = groupEnds(tunnelEnds(ways, (lon, lat) => { const e = toEnu(lon, lat); return [e[0], e[1]]; }));
  for (const g of groups) meshes.push(...portal(g, groundAt).map(fromPiece));
  console.log(`  tunnel portals: ${groups.length}`);
  // named bridges (bridgemodels.ts) on their OSM outline
  const ends = existsSync(join(DERIVED, name, "ground", "bridge-ends.json")) ? readJson(join(DERIVED, name, "ground", "bridge-ends.json")) : {};
  const bridgeWays: Array<{ l: P2[]; dh: ReturnType<typeof deckHeight> }> = [];
  for (const e of ways) {
    const t = e.tags ?? {};
    if (!isBridge(t) || !(t.highway || t.railway) || !(e.geometry?.length >= 2)) continue;
    const l = e.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
    bridgeWays.push({ l, dh: deckHeight(l, groundAt, ends[e.id]) });
  }
  const deckAt = (p: P2) => {
    let best = 12, z: number | null = null;
    for (const { l, dh } of bridgeWays) for (let i = 1; i < l.length; i++) {
      const a = l[i - 1], b = l[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const f = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)), dist = Math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy);
      if (dist < best) { best = dist; z = dh.at(dh.cum[i - 1] + f * Math.sqrt(L2), p[0], p[1]); }
    }
    return z;
  };
  for (const e of ways) {
    const model = BRIDGES[e.tags?.wikidata ?? ""];
    if (!model || e.tags.man_made !== "bridge" || !(e.geometry?.length >= 4)) continue;
    const ring = e.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
    meshes.push(...model(ring, { ground: groundAt, deckAt }).map(fromPiece));
    console.log(`  bridge ${e.tags.name}: model`);
  }
}
// structures on their OSM outline and models at measured points (landmarks.ts); the surface model reads both
// as tree crowns, so crowns on them go
const dropCrowns = (hit: (p: P2) => boolean) => { for (let i = trees.length - 1; i >= 0; i--) if (hit([trees[i][0], trees[i][1]])) trees.splice(i, 1); };
for (const { rings, structure, t } of structures) {
  meshes.push(...structure.model(rings, groundAt, t).map(fromPiece));
  dropCrowns((p) => rings.outer.some((r) => inside(p, r)));
  console.log(`  structure ${t.name ?? t.man_made}: model`);
}
/**
 * Cut the solid LoD2 block within r m of c (a headframe's stand-in) off the building at the height of the roofs
 * around it, and cap the stump level there: roof triangles wholly inside go, walls wholly inside are cut at that
 * height (keeping what is below). The roofs around: the inner corners of roof triangles that reach into the circle.
 */
function cutBlock(c: P2, r: number): { mesh: Mesh; cap: number } | null {
  const near = (b: number[], i: number) => Math.hypot(b[i] - c[0], b[i + 1] - c[1]) < r;
  let mesh: Mesh | null = null, top = -Infinity;
  for (const b of meshes as Mesh[]) for (let i = 0; i < b.roof.length; i += 9)
    if (near(b.roof, i) && near(b.roof, i + 3) && near(b.roof, i + 6)) {
      const z = Math.max(b.roof[i + 2], b.roof[i + 5], b.roof[i + 8]);
      if (z > top) { top = z; mesh = b; }
    }
  if (!mesh) return null;
  const b = mesh;
  let foot = -Infinity;
  for (let i = 0; i < b.roof.length; i += 9) {
    const ins = [0, 3, 6].filter((k) => near(b.roof, i + k));
    if (ins.length && ins.length < 3) for (const k of ins) foot = Math.max(foot, b.roof[i + k + 2]);
  }
  if (!Number.isFinite(foot)) { // a block standing on its own: its lowest wall
    foot = Infinity;
    for (let i = 0; i < b.wall.length; i += 5) if (near(b.wall, i)) foot = Math.min(foot, b.wall[i + 2]);
  }
  const cap = foot + 0.1, roof: number[] = [], wall: number[] = [], rim: P2[] = [];
  for (let i = 0; i < b.roof.length; i += 9) {
    const t = b.roof.slice(i, i + 9);
    if (!(near(t, 0) && near(t, 3) && near(t, 6)) || Math.min(t[2], t[5], t[8]) < cap) roof.push(...t);
  }
  for (let i = 0; i + 14 < b.wall.length; i += 15) {
    const tr = [0, 1, 2].map((k) => b.wall.slice(i + k * 5, i + k * 5 + 5));
    if (!tr.every((v) => Math.hypot(v[0] - c[0], v[1] - c[1]) < r)) { for (const v of tr) wall.push(...v); continue; }
    // the part below the cap (Sutherland–Hodgman on z), fan-triangulated
    const lo: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const p = tr[k], q = tr[(k + 1) % 3], fp = p[2] - cap, fq = q[2] - cap;
      if (fp <= 0) lo.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const f = fp / (fp - fq), x = p.map((v, j) => v + (q[j] - v) * f); lo.push(x); rim.push([x[0], x[1]]); }
      else if (fp === 0) rim.push([p[0], p[1]]);
    }
    for (let k = 1; k + 1 < lo.length; k++) for (const v of [lo[0], lo[k], lo[k + 1]]) wall.push(...v);
  }
  // the cap: the convex hull of where the walls were cut, level
  const hull = convexHull(rim);
  for (let k = 1; k + 1 < hull.length; k++) for (const q of [hull[0], hull[k], hull[k + 1]]) roof.push(q[0], q[1], cap);
  b.roof.splice(0, b.roof.length, ...roof);
  b.wall.splice(0, b.wall.length, ...wall);
  let h = 0;
  for (let i = 2; i < b.roof.length; i += 3) h = Math.max(h, b.roof[i] - b.base);
  b.height = h;
  return { mesh: b, cap };
}
/** Convex hull, counter-clockwise (monotone chain). */
function convexHull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const turn = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [], upper: P2[] = [];
  for (const q of p) { while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
for (const pl of PLACED) {
  const [la, lo] = pl.at;
  if (la < bbox[0] - 0.002 || la > bbox[2] + 0.002 || lo < bbox[1] - 0.002 || lo > bbox[3] + 0.002) continue;
  const e = toEnu(lo, la), c: P2 = [e[0], e[1]];
  let base = groundAt(...c), ground = base, note = "model", under: Mesh | undefined;
  if (pl.cut) {
    const hit = cutBlock(c, pl.cut);
    if (!hit) { console.log(`  landmark ${pl.name}: no LoD2 block within ${pl.cut} m, skipped`); continue; }
    base = hit.cap; ground = hit.mesh.base; note = `LoD2 block cut at ${(hit.cap - ground).toFixed(1)} m -> model`;
    under = hit.mesh;
  } else if (pl.building) under = (meshes as Mesh[]).find((m) => inside(c, m.footprint));
  if (under && pl.building) {
    const look = lookAt(centre(under.footprint));
    under.look = { ...look, wall: pl.building.wall ?? look.wall, roof: pl.building.roof ?? look.roof };
  }
  meshes.push(...pl.model(c, base, ground).map(fromPiece));
  dropCrowns((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < pl.clear);
  console.log(`  landmark ${pl.name}: ${note}`);
}
for (const b of meshes as Mesh[]) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const see = (x: number, y: number, z: number) => {
    const [px, py] = enuToPixel([x, y, z]);
    minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
  };
  for (let i = 0; i < b.roof.length; i += 3) see(b.roof[i], b.roof[i + 1], b.roof[i + 2]);
  for (let i = 0; i < b.wall.length; i += 5) see(b.wall[i], b.wall[i + 1], b.wall[i + 2] - 1);
  const [s, roofKind] = lod2Style(b);
  const fc: P2 = [b.footprint.reduce((a, p) => a + p[0], 0) / b.footprint.length, b.footprint.reduce((a, p) => a + p[1], 0) / b.footprint.length];
  const look = b.look ?? lookAt(fc), roof = look.roof ?? b.roofRgb ?? null; // OSM roof:colour, else the source's measured one
  const entry: unknown[] = [look.style ?? s, roofKind, b.roof.map(c2), b.wall.map(c2), b.footprint.map(([x, y]) => [c2(x), c2(y)]), Math.round(b.height * 10) / 10, Math.floor(hash(b.base * 1000 + b.roof.length) * 1000)];
  if (roof || look.wall || ("bare" in look && look.bare)) entry.push(roof, look.wall);
  if ("bare" in look && look.bare) entry.push(look.bare);
  add(minx, miny, maxx, maxy, (bin) => bin.m.push(entry));
}
for (const t of trees) {
  const g = groundAt(t[0], t[1]);
  const a = enuToPixel([t[0], t[1], g - 3]), c = enuToPixel([t[0], t[1], g + 3 + t[3] + t[2]]);
  const r = t[2] / CAMERA.mpp;
  add(Math.min(a[0], c[0]) - r, Math.min(a[1], c[1]) - r, Math.max(a[0], c[0]) + r, Math.max(a[1], c[1]) + r,
    (bin) => bin.t.push(t.map((v) => Math.round(v * 10) / 10) as [number, number, number, number]));
}
for (const [k, v] of bins) writeFileSync(join(out, `${k}.json`), JSON.stringify(v.m.length ? v : { b: v.b, t: v.t }));
console.log(`  ${bins.size} tile bins -> ${out}`);
if (region.sources === "tlv") writeFileSync(join(DERIVED, name, "osm-parts.json"), JSON.stringify(swapped, null, 1));
if (!existsSync(join(DERIVED, name))) mkdirSync(join(DERIVED, name), { recursive: true });
