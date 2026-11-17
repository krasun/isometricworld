/**
 * Build the ground an area stands on, from open data only:
 *   terrain  Copernicus GLO-30 (a surface model: buildings are removed with a morphological
 *            opening + blur, which is plenty for flat Gush Dan), sea/lakes flattened from OSM;
 *            regions with sources "lgl": LGL DGM1 (1 m bare earth, sampled on a 3 m grid, no
 *            filtering; Copernicus only where DGM1 has no data), rivers left at their surveyed level
 *   surface  OSM roads at real widths, pavements, landuse, parks, beach, water, rail; regions with
 *            look "styled" keep meadows, vineyards, allotments and orchards as their own kinds
 *
 *   npm -w pipeline run ground -- tlv-core
 *
 * Output: data/derived/<area>/ground/meta.json     grid origin/step/size (ENU meters)
 *         data/derived/<area>/ground/height.bin    Float32 ENU "up" of the ground per grid node
 *         data/derived/<area>/ground/features.json drawable features in ENU (see Feature)
 */
import { bridgeEnds, carried, isBridge, type GraphWay } from "./bridges.ts";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { ecefToEnu, enuToLlh, llhToEcef } from "./camera.ts";
import { fromPuwg, gugikTerrain, orthoChunks, toPuwg } from "./gugik.ts";
import { lawns } from "./greenery.ts";
import { playLayout } from "./playgrounds.ts";
import { rasterSampler, toUtm } from "./lgl.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { REGIONS } from "./places.ts";
import { ROAD, isOneway, roadWidth } from "./roadspec.ts";
import { styleOf } from "./styles.ts";

type P2 = [number, number];
const MARGIN = 0.02;
const R_EARTH = 6371000;

/**
 * k: kind (drawn by page/renderer.ts), r: polygon rings (even-odd) or l: polyline,
 * w: line width (m), o: one-way, n: lanes, y: layer (bridges above)
 */
/** s: the street's pavements (bit 1 left, 2 right of its direction; unset both), u: the surface (surfaceOf), both
 *  only with the preset's `streetDetail` */
export interface Feature { k: string; r?: P2[][]; l?: P2[]; w?: number; o?: 1; n?: number; y?: number; j?: number[][]; v?: number; b?: 1; e?: number[]; s?: number; u?: string }

const name = process.argv[2] ?? "tlv-core";
const area = openArea(name);
const region = REGIONS[area.region];
/** 1 m bare-earth terrain (LGL DGM1, GUGiK NMT): a finer grid, no filtering, rivers at their surveyed level. */
const DGM = region.sources === "lgl" || region.sources === "gugik";
/** Styled look (places.ts `look`): meadows, vineyards, allotments and orchards drawn as their own kinds. */
const STYLED = region.look === "styled";
/** Preset `streetDetail`: pavements where OSM maps them, separately mapped ones drawn as such, OSM surfaces. */
const DETAIL = STYLED && styleOf(region.style).streetDetail;
/** Preset `greenery`: lawns where the orthophoto is green (greenery.ts; GUGiK's orthophoto). */
const GREENERY = STYLED && styleOf(region.style).greenery && region.sources === "gugik";
/** Preset `waterDetail`: watercourses as lines, treatment basins murky (page/ground.ts draws the water's depth). */
const WATER_DETAIL = STYLED && styleOf(region.style).waterDetail;
/** Preset `playgrounds`: rubber safety pads and sandpits of the playgrounds (playgrounds.ts). */
const PLAYGROUNDS = STYLED && styleOf(region.style).playgrounds;
/** Preset `bridgeDetail`: bridge decks carried on to their abutments (below). */
const BRIDGE_DETAIL = STYLED && styleOf(region.style).bridgeDetail;
/** Geoid undulation: orthometric (MSL) + this = ellipsoid height (= sea level). */
const GEOID = region.geoidM;
/** Terrain grid posting (m) and how far past the area it reaches (deg; the render footprint of an edge tile). */
const STEP = DGM ? 3 : 10, TMARGIN = DGM ? 0.008 : MARGIN;
const [S, W, N, E] = area.bbox;
const bb = [S - MARGIN, W - MARGIN, N + MARGIN, E + MARGIN];
const out = join(DERIVED, name, "ground");
mkdirSync(out, { recursive: true });

const toEnu = (lon: number, lat: number): P2 => { const p = ecefToEnu(llhToEcef(lat, lon, 0)); return [p[0], p[1]]; };
const r1 = (v: number) => Math.round(v * 10) / 10;

// ---- geometry helpers --------------------------------------------------------------------------
function simplifyLine(r: P2[], tol: number): P2[] {
  if (r.length <= 2) return r;
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
  return r.filter((_, i) => keep[i]).map(([x, y]) => [r1(x), r1(y)]);
}

/** Douglas-Peucker on a closed ring: split at the vertex farthest from the start (a zero chord keeps nothing). */
function simplifyRing(r: P2[], tol: number): P2[] {
  let far = 0;
  r.forEach((p, i) => { if (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = i; });
  if (far === 0) return [];
  return [...simplifyLine(r.slice(0, far + 1), tol).slice(0, -1), ...simplifyLine([...r.slice(far), r[0]], tol)];
}

/** Join way pieces sharing endpoints into chains (closed rings where they close). */
function joinWays(pieces: P2[][]): P2[][] {
  const key = (p: P2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const left = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const out: P2[][] = [];
  while (left.length) {
    let chain = left.pop()!;
    for (let grown = true; grown && key(chain[0]) !== key(chain.at(-1)!);) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], a = key(p[0]), b = key(p.at(-1)!);
        if (a === key(chain.at(-1)!)) chain = [...chain, ...p.slice(1)];
        else if (b === key(chain.at(-1)!)) chain = [...chain, ...p.slice(0, -1).reverse()];
        else if (b === key(chain[0])) chain = [...p, ...chain.slice(1)];
        else if (a === key(chain[0])) chain = [...p.slice(1).reverse(), ...chain];
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(chain);
  }
  return out;
}
const closed = (c: P2[]) => c.length > 3 && c[0][0] === c.at(-1)![0] && c[0][1] === c.at(-1)![1];

/** Scanline fill of even-odd polygon rings over the grid: cb(ix, iy) for nodes inside. */
function fillGrid(rings: P2[][], g: Grid, cb: (i: number) => void) {
  let y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const iy0 = Math.max(0, Math.ceil((y0 - g.y0) / STEP)), iy1 = Math.min(g.ny - 1, Math.floor((y1 - g.y0) / STEP));
  for (let iy = iy0; iy <= iy1; iy++) {
    const y = g.y0 + iy * STEP, xs: number[] = [];
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil((xs[k] - g.x0) / STEP)), b = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / STEP));
      for (let ix = a; ix <= b; ix++) cb(iy * g.nx + ix);
    }
  }
}

// ---- OSM features --------------------------------------------------------------------------
const PATH: Record<string, number> = { pedestrian: 5, footway: 2.2, path: 1.6, cycleway: 2, steps: 2.5, bridleway: 2, corridor: 2 };

const GRASS = /^(grass|dirt|ground|earth|unpaved)$/;

/** A street's pavements from OSM `sidewalk*` tags: bit 1 left, 2 right of its direction ("separate": drawn as its
 *  own way, "no": none); undefined where OSM says nothing (then both). */
function sidewalkSides(t: Record<string, string>): number | undefined {
  const side = (v?: string) => (v === undefined ? undefined : v === "yes");
  let left = side(t["sidewalk:left"] ?? t["sidewalk:both"]), right = side(t["sidewalk:right"] ?? t["sidewalk:both"]);
  const s = t.sidewalk;
  if (s === "both" || s === "yes") { left ??= true; right ??= true; }
  else if (s === "left") { left ??= true; right ??= false; }
  else if (s === "right") { left ??= false; right ??= true; }
  else if (s) { left ??= false; right ??= false; } // no, none, separate
  if (left === undefined && right === undefined) return undefined;
  return ((left ?? true) ? 1 : 0) | ((right ?? true) ? 2 : 0);
}

/** An OSM surface as drawn (asphalt and unknown: undefined, the default). */
function surfaceOf(s?: string): string | undefined {
  if (!s) return undefined;
  if (/^(paving_stones|paving_stones:.*|bricks|interlock|concrete:plates|concrete_slabs)$/.test(s)) return "paving";
  if (/^(sett|cobblestone|unhewn_cobblestone)$/.test(s)) return "sett";
  if (/^(gravel|fine_gravel|compacted|pebblestone)$/.test(s)) return "gravel";
  if (/^(ground|dirt|earth|mud|sand|unpaved)$/.test(s)) return "dirt";
  if (/^(grass|grass_paver)$/.test(s)) return "grass";
  if (/^(concrete|concrete:lanes)$/.test(s)) return "concrete";
  return undefined;
}
/**
 * Fields are not all one colour: a shade per field, from its crop where mapped (index into the ground page's
 * FIELD palette: 0 wheat/cereal, 1 maize, 2 grass/hay, 3 vegetables, 4 rapeseed), else from the OSM id (5+).
 */
function fieldShade(t: Record<string, string>, id: number): number {
  const c = t.crop ?? "";
  if (/wheat|barley|cereal|rye|oat|spelt|triticale/.test(c)) return 0;
  if (/corn|maize/.test(c)) return 1;
  if (/grass|hay|forage|clover/.test(c)) return 2;
  if (/vegetable|strawberr|potato|beet|cabbage/.test(c)) return 3;
  if (/rape/.test(c)) return 4;
  return 5 + ((Math.imul(id, 2654435761) >>> 0) % 7);
}

function areaKind(t: Record<string, string>): string | null {
  const lu = t.landuse, le = t.leisure, na = t.natural, am = t.amenity;
  if (WATER_DETAIL && t.water === "wastewater") return "wastewater";
  if (na === "water" || t.water || t.waterway === "riverbank" || lu === "basin" || lu === "reservoir") return "water";
  if (le === "swimming_pool") return "pool";
  // golf courses: bunkers, greens and tees, fairways (over the course's lawn)
  if (t.golf === "bunker") return "bunker";
  if (t.golf === "green" || t.golf === "tee") return "green";
  if (t.golf === "fairway" || t.golf === "driving_range") return "fairway";
  if (t.golf === "rough") return "park";
  // airfields: runways, taxiways, aprons drawn as areas by surface (EDTQ: asphalt and grass side by side)
  if (/^(runway|taxiway|apron|helipad)$/.test(t.aeroway ?? "")) return GRASS.test(t.surface ?? "") ? "airgrass" : "tarmac";
  if (na === "beach" || na === "sand") return "sand";
  if (le === "pitch" || le === "stadium") return "pitch";
  if (le === "track") return "track";
  if (le === "playground") return "playground";
  if (na === "wood" || lu === "forest") return "wood";
  if (["scrub", "grassland", "heath", "wetland", "bare_rock"].includes(na)) return "scrub";
  if (lu === "cemetery" || am === "grave_yard") return "cemetery";
  if (STYLED && lu === "meadow") return "meadow";
  if (lu === "flowerbed") return "flowerbed";
  if (["park", "garden", "dog_park", "golf_course", "recreation_ground", "nature_reserve"].includes(le)
    || ["grass", "meadow", "village_green", "recreation_ground"].includes(lu)) return "park";
  if (STYLED && ["vineyard", "allotments", "orchard"].includes(lu)) return lu; // the Kessel's slopes: own colours and rows
  if (["farmland", "orchard", "allotments", "plant_nursery", "greenhouse_horticulture", "vineyard"].includes(lu)) return "farm";
  if (["construction", "brownfield", "greenfield", "landfill"].includes(lu)) return "dirt";
  if (am === "parking") return "parking";
  if (t["area:highway"] || t.place === "square" || (t.highway === "pedestrian" && t.area === "yes")
    || ["pier", "breakwater", "groyne"].includes(t.man_made))
    return /^(fine_gravel|gravel|compacted|pebblestone)$/.test(t.surface ?? "") ? "gravel" : "paving";
  if (["school", "university", "college", "hospital"].includes(am)) return "campus";
  if (t.aeroway === "aerodrome") return "park"; // a small airfield's grass (EDTQ Pattonville is also tagged landuse=military)
  if (["industrial", "railway", "port", "military", "depot", "garages"].includes(lu)) return "industrial";
  if (["commercial", "retail"].includes(lu)) return "commercial";
  if (lu === "residential") return "residential";
  return null;
}

const osm = readJson(join(RAW, name, "ground.json"));
const features: Feature[] = [];
const water: P2[][][] = [];
const coast: P2[][] = [];
/** road node id -> how many road ways use it (2+ = junction), widest road there */
const nodeUse = new Map<number, { n: number; w: number; foot: boolean; y: number; k: string; p?: boolean }>();
const footNodes = new Set<number>();
const nodePos = new Map<number, [P2, P2, number]>(); // position, a neighbour along the road, road width
const geom = (g: Array<{ lat: number; lon: number }>) => g.map((q) => toEnu(q.lon, q.lat));
/** highways and railways as a node graph, for bridge joints (bridges.ts bridgeEnds); bridge features by OSM id */
const graph: GraphWay[] = [];
const deckFeatures = new Map<number, Feature>();

for (const el of osm.elements) {
  const t: Record<string, string> = el.tags ?? {};
  if (t.natural === "coastline" && el.geometry) { coast.push(geom(el.geometry)); continue; }
  let rings: P2[][] | null = null;
  if (el.type === "way" && el.geometry) {
    const g = geom(el.geometry);
    if (closed(g) && !(t.highway && t.area !== "yes") && !t.railway) rings = [g];
    else if (t.highway || t.railway || ["breakwater", "groyne", "pier"].includes(t.man_made) || /^(runway|taxiway)$/.test(t.aeroway ?? "")) {
      const l = simplifyLine(g, 0.3);
      if (t.aeroway) { // runway / taxiway centre lines at their width (OSM width, else 30 m / 10 m)
        const w = Number(String(t.width).replace(",", ".")) || (t.aeroway === "runway" ? 30 : 10);
        features.push({ k: GRASS.test(t.surface ?? "") ? "grassway" : t.aeroway, l, w: r1(w) });
        continue;
      }
      const layer = Number(t.layer) || (t.bridge && t.bridge !== "no" ? 1 : 0);
      const deck = isBridge(t) ? { b: 1 as const } : {}; // own deck in the render (bridges.ts)
      if (el.nodes?.length === g.length) graph.push({ id: el.id, nodes: el.nodes, l: g, kind: t.railway ? "rail" : ROAD[t.highway] ? "road" : "path", bridge: isBridge(t) });
      if (t.railway) {
        const f: Feature = { k: "rail", l, ...(layer > 0 ? { y: layer } : {}), ...deck };
        features.push(f);
        if (deck.b) deckFeatures.set(el.id, f);
        continue;
      }
      if (t.man_made) { features.push({ k: "pier", l, w: Number(t.width) || 4 }); continue; }
      const road = ROAD[t.highway], path = PATH[t.highway];
      if (!road && !path) continue;
      const oneway = isOneway(t);
      const lanes = Number(t.lanes) || 0;
      const w = road ? roadWidth(t) : Number(String(t.width).replace(",", ".")) || path;
      const kind = road ? (road[1] ? "street" : t.highway.startsWith("motorway") || t.highway.startsWith("trunk") ? "highway" : t.highway === "track" ? "dirtroad" : "lane") : t.highway === "cycleway" ? "cycle" : t.highway === "pedestrian" ? "plaza"
        : DETAIL && t.footway === "sidewalk" ? "sidewalk" : "path";
      const sides = DETAIL && kind === "street" ? sidewalkSides(t) : undefined;
      if (road && el.nodes) for (const id of el.nodes) {
        const nd = nodeUse.get(id) ?? { n: 0, w: 0, foot: false, y: 0, k: kind };
        nd.n++; nd.y = Math.max(nd.y, layer);
        if (w > nd.w) { nd.w = w; nd.k = kind; }
        if (DETAIL && kind === "street" && sides !== 0) nd.p = true; // pavements round this corner
        nodeUse.set(id, nd);
      } else if (path && el.nodes && t.highway !== "steps") for (const id of el.nodes) footNodes.add(id);
      if (road && el.nodes) el.geometry.forEach((q: any, k: number) => nodePos.set(el.nodes[k], [toEnu(q.lon, q.lat), k > 0 ? toEnu(el.geometry[k - 1].lon, el.geometry[k - 1].lat) : toEnu(el.geometry[k + 1].lon, el.geometry[k + 1].lat), w]));
      const f: Feature = { k: kind, l, w: r1(w) };
      if (sides !== undefined) f.s = sides;
      const surface = DETAIL ? surfaceOf(t.surface) : undefined;
      if (surface) f.u = surface;
      if (oneway) f.o = 1;
      if (lanes) f.n = lanes;
      if (layer > 0) f.y = layer;
      Object.assign(f, deck);
      features.push(f);
      if (deck.b) deckFeatures.set(el.id, f);
      continue;
    }
  } else if (el.type === "relation" && el.members) {
    const outer = joinWays(el.members.filter((m: any) => m.type === "way" && m.geometry && m.role !== "inner").map((m: any) => geom(m.geometry)));
    const inner = joinWays(el.members.filter((m: any) => m.type === "way" && m.geometry && m.role === "inner").map((m: any) => geom(m.geometry)));
    rings = [...outer, ...inner].filter(closed);
    if (!rings.length) rings = null;
  }
  if (!rings) continue;
  const k = areaKind(t);
  if (!k) continue;
  const r = rings.map((q) => simplifyRing(q, 0.3)).filter((q) => q.length >= 4);
  if (!r.length) continue;
  features.push(k === "farm" || k === "meadow" ? { k, r, v: fieldShade(t, el.id) } : { k, r });
  if (k === "water" || k === "wastewater") water.push(r);
}

/** junction entry: [x, y, radius (half width + 3 m), layer, kind of the widest road, (streetDetail) 1 if a street
 *  with pavements meets there] */
const JUNCTION_KIND = ["dirtroad", "lane", "street", "highway"];
// Junctions (markings stop there) and zebra crossings (footpath meets a street mid-block).
const junctions: number[][] = [], zebras: number[][] = [];
for (const [id, u] of nodeUse) {
  const pos = nodePos.get(id);
  if (!pos) continue;
  const [[x, y], [nx, ny], w] = pos;
  if (u.n >= 2) junctions.push([r1(x), r1(y), r1(u.w / 2 + 3), u.y, JUNCTION_KIND.indexOf(u.k), ...(DETAIL ? [u.p ? 1 : 0] : [])]);
  else if (footNodes.has(id) && w >= 5) {
    const L = Math.hypot(nx - x, ny - y) || 1;
    zebras.push([r1(x), r1(y), Math.round(((nx - x) / L) * 1000) / 1000, Math.round(((ny - y) / L) * 1000) / 1000, r1(w)]);
  }
}
features.push({ k: "junctions", j: junctions } as Feature, { k: "zebras", j: zebras } as Feature);
console.log(`  ${junctions.length} junctions, ${zebras.length} zebra crossings`);

// Sea: the coastline has land on its left. Join it, close the open chain far offshore (west).
const chains = joinWays(coast);
const main = chains.filter((c) => !closed(c)).sort((a, b) => b.length - a.length)[0];
let sea: P2[][] = [];
if (main) {
  const off = 30000;
  const ring: P2[] = [...main, [main.at(-1)![0] - off, main.at(-1)![1]], [main[0][0] - off, main[0][1]]];
  sea = [simplifyLine(ring, 0.3), ...chains.filter(closed).map((c) => simplifyRing(c, 0.3))]; // closed = islands/breakwaters
  features.unshift({ k: "sea", r: sea });
  features.push({ k: "shore", l: simplifyLine(main, 0.3) });
}
console.log(`  features: ${features.length} (${chains.length} coastline chains)`);

// ---- terrain grid ------------------------------------------------------------------------------
interface Grid { x0: number; y0: number; nx: number; ny: number }
const tb = [S - TMARGIN, W - TMARGIN, N + TMARGIN, E + TMARGIN];
const corners = [[tb[0], tb[1]], [tb[0], tb[3]], [tb[2], tb[1]], [tb[2], tb[3]]].map(([la, lo]) => toEnu(lo, la));
const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / STEP) * STEP, x1 = Math.max(...corners.map((c) => c[0]));
const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) / STEP) * STEP, y1 = Math.max(...corners.map((c) => c[1]));
const grid: Grid = { x0, y0, nx: Math.ceil((x1 - x0) / STEP) + 1, ny: Math.ceil((y1 - y0) / STEP) + 1 };

/**
 * Copernicus tiles: float32, 3600 rows, pixel centres at whole arc-seconds from the tile's SW-NW corner;
 * 3600 columns below 50° latitude, fewer further north (2400 at 50–60°: 1.5″ in longitude).
 */
async function loadDem() {
  const dir = join(RAW, "dem"), tiles = new Map<string, { t: Float32Array; w: number }>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tif"))) {
    const m = f.match(/N(\d+)_00_E(\d+)_00/)!;
    const { data, info } = await sharp(join(dir, f)).extractChannel(0).raw({ depth: "float" }).toBuffer({ resolveWithObject: true });
    if (info.height !== 3600 || ![3600, 2400, 1800, 1200, 720, 360].includes(info.width)) throw new Error(`${f}: unexpected size ${info.width}×${info.height}`);
    tiles.set(`${Number(m[1])}_${Number(m[2])}`, { t: new Float32Array(data.buffer, data.byteOffset, data.length / 4), w: info.width });
  }
  return (lat: number, lon: number) => {
    const tile = tiles.get(`${Math.floor(lat)}_${Math.floor(lon)}`);
    if (!tile) return 0;
    const { t, w } = tile;
    const fx = (lon - Math.floor(lon)) * w, fy = (Math.floor(lat) + 1 - lat) * 3600;
    const ix = Math.min(w - 2, Math.floor(fx)), iy = Math.min(3598, Math.floor(fy)), ax = fx - ix, ay = fy - iy;
    const v = (x: number, y: number) => t[y * w + x];
    return (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
  };
}

const dem = await loadDem();
/** 1 m bare earth at (lat, lon), NaN where it has no data */
const bare = region.sources === "lgl" ? await rasterSampler("dgm1", tb).then((s) => (lat: number, lon: number) => s.at(...toUtm(lat, lon)))
  : region.sources === "gugik" ? gugikTerrain(tb).atLatLon : null;
const n = grid.nx * grid.ny;
let h = new Float32Array(n);
const fine = new Uint8Array(n); // 1: bare-earth DGM1 (no filtering needed)
for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
  const x = grid.x0 + ix * STEP, y = grid.y0 + iy * STEP, i = iy * grid.nx + ix;
  const [lat, lon] = enuToLlh([x, y, 0]);
  const v = bare ? bare(lat, lon) : NaN;
  if (Number.isFinite(v)) { h[i] = v; fine[i] = 1; } else h[i] = dem(lat, lon);
}
const fineShare = fine.reduce((a, b) => a + b, 0) / n;
if (DGM) console.log(`  terrain: ${region.sources === "lgl" ? "DGM1" : "NMT"} on ${(fineShare * 100).toFixed(1)}% of the grid, Copernicus elsewhere`);
/** Separable min / max / box filter with radius r grid cells. */
function filter(a: Float32Array, r: number, op: "min" | "max" | "mean") {
  const pass = (src: Float32Array, horiz: boolean) => {
    const dst = new Float32Array(n);
    for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
      let acc = op === "min" ? Infinity : op === "max" ? -Infinity : 0, cnt = 0;
      for (let d = -r; d <= r; d++) {
        const x = horiz ? ix + d : ix, y = horiz ? iy : iy + d;
        if (x < 0 || y < 0 || x >= grid.nx || y >= grid.ny) continue;
        const v = src[y * grid.nx + x];
        acc = op === "min" ? Math.min(acc, v) : op === "max" ? Math.max(acc, v) : acc + v;
        cnt++;
      }
      dst[iy * grid.nx + ix] = op === "mean" ? acc / cnt : acc;
    }
    return dst;
  };
  return pass(pass(a, true), false);
}
// bare earth: opening removes blocks up to ~200 m across, then smooth twice (≈ gaussian); DGM1 is bare already
if (fineShare < 1) {
  const r = Math.round(100 / STEP), s = Math.round(40 / STEP);
  const smooth = filter(filter(filter(filter(h, r, "min"), r, "max"), s, "mean"), s, "mean");
  for (let i = 0; i < n; i++) if (!fine[i]) h[i] = smooth[i];
}

// water: sea at 0 m; lakes/rivers at their lowest surrounding ground; land kept above the sea
const isWater = new Uint8Array(n);
if (sea.length) fillGrid(sea, grid, (i) => { isWater[i] = 1; h[i] = -0.4; });
for (const w of DGM ? [] : water) { // DGM1 already holds each river's surveyed level (and the Neckar's weirs)
  const idx: number[] = [];
  fillGrid(w, grid, (i) => idx.push(i));
  if (!idx.length) continue;
  const level = Math.max(0, Math.min(...idx.map((i) => h[i])) - 0.3);
  for (const i of idx) { if (!isWater[i]) h[i] = level; isWater[i] = 2; }
}
for (let i = 0; i < n; i++) if (!isWater[i]) h[i] = Math.max(h[i], 0.8);

// orthometric -> ellipsoid -> ENU up (Earth curvature drops the ellipsoid below the tangent plane)
for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
  const x = grid.x0 + ix * STEP, y = grid.y0 + iy * STEP, i = iy * grid.nx + ix;
  h[i] = h[i] + GEOID - (x * x + y * y) / (2 * R_EARTH);
}

writeFileSync(join(out, "height.bin"), Buffer.from(h.buffer));
writeFileSync(join(out, "meta.json"), JSON.stringify({ ...grid, step: STEP }));
// bridge decks: heights at both ends, joints between bridge ways interpolated (bridges.ts)
const sample = (x: number, y: number) => {
  const fx = Math.min(grid.nx - 1.001, Math.max(0, (x - grid.x0) / STEP)), fy = Math.min(grid.ny - 1.001, Math.max(0, (y - grid.y0) / STEP));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * grid.nx + ix;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - ay) + (h[i + grid.nx] * (1 - ax) + h[i + grid.nx + 1] * ax) * ay;
};
// preset bridgeDetail: an OSM bridge often ends short of its abutment, over the gap the terrain model leaves under
// the bridge, so the road dips before the deck. Each abutment end (not a joint between bridge ways) runs on along
// its direction to where the embankment tops out: the first point within 0.3 m of the highest terrain in the
// next 15 m, at least 1 m (bridges.ts deckHeight, carried).
if (BRIDGE_DETAIL) {
  const endUse = new Map<number, number>();
  for (const w of graph) if (w.bridge) for (const n of [w.nodes[0], w.nodes.at(-1)!]) endUse.set(n, (endUse.get(n) ?? 0) + 1);
  let n = 0, total = 0;
  for (const w of graph) {
    if (!w.bridge || w.l.length < 2 || w.nodes.length !== w.l.length) continue;
    w.ext = ([0, 1] as const).map((i) => {
      if ((endUse.get(i ? w.nodes.at(-1)! : w.nodes[0]) ?? 0) > 1) return 0;
      const prof = Array.from({ length: 16 }, (_, s) => { const p = carried(w.l, i, s); return sample(p[0], p[1]); });
      const top = Math.max(...prof), s0 = prof.findIndex((v) => v >= top - 0.3);
      n++; total += s0;
      return Math.max(1, s0 + 0.5);
    }) as [number, number];
  }
  console.log(`  bridge ends carried to their abutments: ${n}, ${(total / Math.max(1, n)).toFixed(1)} m on average`);
}
const ends = bridgeEnds(graph, sample);
for (const [id, e] of ends) { const f = deckFeatures.get(id); if (f) f.e = e; }
writeFileSync(join(out, "bridge-ends.json"), JSON.stringify(Object.fromEntries(ends)));
// watercourses: rivers, streams, canals, ditches and drains above ground, at their OSM width or the usual one
if (WATER_DETAIL && existsSync(join(RAW, name, "osm-water.json"))) {
  const WIDTH: Record<string, number> = { river: 6, canal: 5, stream: 2, ditch: 1.2, drain: 1 };
  let n = 0;
  for (const el of readJson(join(RAW, name, "osm-water.json")).elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2 || (t.tunnel && t.tunnel !== "no") || t.location === "underground") continue;
    const w = Number(String(t.width ?? "").replace(",", ".")), l = simplifyLine(geom(el.geometry), 0.3);
    features.push({ k: "stream", l, w: r1(w > 0.3 && w < 60 ? w : WIDTH[t.waterway] ?? 1.5) });
    n++;
  }
  console.log(`  watercourses: ${n}`);
}
// playgrounds: sandpits and the rubber pads under the equipment (the equipment itself: scene.ts)
if (PLAYGROUNDS && existsSync(join(RAW, name, "osm-play.json"))) {
  const { sand, pads } = playLayout(readJson(join(RAW, name, "osm-play.json")), (lon, lat) => toEnu(lon, lat));
  for (const r of sand) features.push({ k: "sandpit", r: [r.map(([x, y]) => [r1(x), r1(y)] as P2)] });
  for (const p of pads) features.push({ k: "playpad", r: [p.r.map(([x, y]) => [r1(x), r1(y)] as P2)], v: p.v });
  console.log(`  playgrounds: ${sand.length} sandpits, ${pads.length} safety pads`);
}
// lawns and gardens where the orthophoto is green, a feature per 128 m block (the area and ~700 m round it)
if (GREENERY) {
  const m = 0.006, box = [S - m, W - m, N + m, E + m], c = [[box[0], box[1]], [box[0], box[3]], [box[2], box[1]], [box[2], box[3]]].map(([la, lo]) => toPuwg(la, lo));
  const pbox = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))];
  const blocks = await lawns(orthoChunks(box), pbox, (e, n) => { const [la, lo] = fromPuwg(e, n), [x, y] = toEnu(lo, la); return [r1(x), r1(y)]; });
  for (const r of blocks) features.push({ k: "lawn", r });
  console.log(`  lawns: ${blocks.length} blocks, ${blocks.reduce((a, b) => a + b.length, 0)} outlines from the orthophoto`);
}
writeFileSync(join(out, "features.json"), JSON.stringify(features));
let lo = Infinity, hi = -Infinity;
for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
console.log(`  terrain ${grid.nx}×${grid.ny} @ ${STEP} m, up ${lo.toFixed(1)}…${hi.toFixed(1)} m -> ${out}`);
