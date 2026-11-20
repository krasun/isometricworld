/**
 * GUGiK open data for Poland (Główny Urząd Geodezji i Kartografii, opendata.geoportal.gov.pl), the
 * inputs of regions with `sources: "gugik"`. All in EPSG:2180 (PUWG 1992); downloads go to data/raw/gugik/.
 *
 *   LoD2 3D buildings   per powiat; roofs from airborne LiDAR (state 2017); heights in Kronsztadt 86
 *   LoD1 3D buildings   per powiat; prisms, LiDAR median height (2024 release); EVRF2007: buildings LoD2 lacks
 *   BDOT10k buildings   per powiat (OT_BUBD_A): what each building is used for, by its BDOT10k id, which is
 *                       the 3D models' buildingId
 *   NMT, NMPT           terrain (1 m) and surface (0.5 m) per 1:5000 map sheet, ASC grids, EVRF2007
 *   orthophoto          aerial photo (WMS, 0.25 m): each roof's real colour
 *
 * Licences (ATTRIBUTION.md): the 3D models CC0 1.0; BDOT10k, NMT, NMPT and the orthophoto CC BY 4.0, with the notice
 * „Wykorzystano/opracowano na podstawie materiałów państwowego zasobu geodezyjnego i kartograficznego”.
 *
 * Based on Piotr Kulpiński's Kraków branch (github.com/piotrkulpinski/isometricworld, feat/krakow-test-patch,
 * gugik.ts and elevation.ts): the PUWG 1992 parameters, the download addresses, finding a sheet through the
 * index WMS, and reading the ASC grids.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { fitBuilding, type Heights } from "./fitroof.ts";
import { type BuildingKind, type Lod2Building, type Lod2Source, meshOf, parseLod2 } from "./lod2.ts";
import { boxTouchesOutline } from "./outline.ts";
import { RAW } from "./paths.ts";
import { fromTm, type Tm, toTm } from "./utm.ts";

type P2 = [number, number];
const DIR = join(RAW, "gugik");
const UA = { "User-Agent": "isometric-world/0.3 (open-data isometric map)" };

// ---- PUWG 1992 (EPSG:2180): Transverse Mercator on GRS80 ------------------------------------------
export const PUWG92: Tm = { k0: 0.9993, lon0: 19, fe: 500000, fn: -5300000 };
export const toPuwg = (lat: number, lon: number) => toTm(lat, lon, PUWG92);
export const fromPuwg = (east: number, north: number) => fromTm(east, north, PUWG92);

/** A lat/lon bbox [s, w, n, e] as PUWG 1992 [e0, n0, e1, n1]. */
function projected([s, w, n, e]: number[]): number[] {
  const c = [[s, w], [s, e], [n, w], [n, e]].map(([la, lo]) => toPuwg(la, lo));
  return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
}
const touches = (a: number[], b: number[]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// ---- downloads --------------------------------------------------------------------------------------
async function download(url: string, file: string, label = url.split("/").pop()) {
  if (existsSync(file)) return;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(900_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(`${file}.tmp`, Buffer.from(await r.arrayBuffer()));
      renameSync(`${file}.tmp`, file);
      console.log(`  gugik: ${label}`);
      return;
    } catch (err) {
      if (attempt === 4) throw new Error(`${url}: ${(err as Error).message}`);
      await new Promise((res) => setTimeout(res, 5000 * attempt));
    }
  }
}

/** Per powiat (TERYT, e.g. "1219"); the voivodeship is its first two digits. */
const POWIAT = {
  lod2: (t: string) => `https://opendata.geoportal.gov.pl/InneDane/Budynki3D/LOD2/${t}_gml.zip`,
  lod1: (t: string) => `https://opendata.geoportal.gov.pl/InneDane/Budynki3D/LOD1/2024/${t.slice(0, 2)}/${t}.zip`,
  bdot10k: (t: string) => `https://opendata.geoportal.gov.pl/bdot10k/schemat2021/${t.slice(0, 2)}/${t}_GML.zip`,
};
type Powiat = keyof typeof POWIAT;
const zipOf = (p: Powiat, t: string) => join(DIR, `${p}-${t}.zip`);

/** Download what an area needs: the powiats' buildings, the NMT / NMPT sheets and the orthophoto around the bbox
 *  (only near the region's outline, if it has one: nothing outside it is rendered). */
export async function fetchGugik(teryt: string[], bbox: number[]) {
  mkdirSync(DIR, { recursive: true });
  for (const t of teryt) for (const p of Object.keys(POWIAT) as Powiat[]) await download(POWIAT[p](t), zipOf(p, t));
  const [s, w, n, e] = bbox, m = 0.005, g = 0.01; // objects just past the edge; terrain as far as ground.ts reads
  await fetchSheets("nmpt", [s - m, w - m, n + m, e + m], (box) => boxTouchesOutline(box, m));
  await fetchSheets("nmt", [s - g, w - g, n + g, e + g], (box) => boxTouchesOutline(box, g));
  await fetchOrtho([s - m, w - m, n + m, e + m], (box) => boxTouchesOutline(box, m));
}

// ---- CityGML sheets inside the powiat zips ------------------------------------------------------------
const members = (zip: string, re: RegExp) => execFileSync("unzip", ["-Z1", zip], { encoding: "latin1" }).split("\n").filter((m) => re.test(m));
const unzipOne = (zip: string, member: string) => execFileSync("unzip", ["-p", zip, member], { maxBuffer: 1 << 30 }).toString("utf8");

/** Every sheet's envelope (PUWG 1992 [e0, n0, e1, n1], null if it has none), read once and cached. */
function sheetIndex(p: "lod1" | "lod2", t: string): Array<{ m: string; b: number[] | null }> {
  const cache = join(DIR, `${p}-${t}.sheets.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const out = members(zipOf(p, t), /\.gml$/i).map((m) => {
    const c = /<gml:lowerCorner>([^<]+)<\/gml:lowerCorner>\s*<gml:upperCorner>([^<]+)</.exec(unzipOne(zipOf(p, t), m).slice(0, 8000));
    if (!c) return { m, b: null };
    const [e0, n0] = c[1].trim().split(/\s+/).map(Number), [e1, n1] = c[2].trim().split(/\s+/).map(Number);
    return { m, b: [e0, n0, e1, n1] };
  });
  writeFileSync(cache, JSON.stringify(out));
  return out;
}

/** CityGML documents of a powiat's LoD1 or LoD2 sheets touching a bbox (lat/lon). */
function* sheets(p: "lod1" | "lod2", t: string, bbox: number[]): Generator<string> {
  const box = projected(bbox);
  for (const { m, b } of sheetIndex(p, t)) if (b && touches(b, box)) yield unzipOne(zipOf(p, t), m);
}

// ---- BDOT10k: what each building is used for ------------------------------------------------------
/** BDOT10k building function (general, main) -> how it is drawn (scene.ts lod2Style). */
function bdotKind(general: string, main: string): BuildingKind {
  if (/^(kościół|kaplica|dzwonnica|klasztor|inny budynek kultu religijnego)$/.test(main)) return "church";
  if (/^(garaż|budynek gospodarczy|toaleta publiczna|domek kempingowy|stacja transformatorowa)$/.test(main)) return "small";
  if (/^(budynki przemysłowe|zbiorniki, silosy i budynki magazynowe|budynki produkcyjne, usługowe i gospodarcze dla rolnictwa)$/.test(general)
    || /^(stacja pomp|stacja gazowa|hangar)$/.test(main)) return "industrial";
  if (/^budynki (oświaty|szpitali)/.test(general) || /straż pożarna|urząd|starostwo|policja|prokuratura|^sąd$|operatora pocztowego|dworzec|zabytek/.test(main)) return "public";
  if (/^budynki (biurowe|handlowo-usługowe)$/.test(general) || /^(hotel|restauracja|pensjonat|motel|zajazd|dom weselny|dom wypoczynkowy)$/.test(main)) return "commercial";
  return "other"; // homes and the rest
}

/** A BDOT10k building: [kind, existence (eksploatowany, w budowie, nieczynny, zniszczony), storeys above ground
 *  (liczbaKondygnacji; 0 unknown), main function (przewazajacaFunkcjaBudynku), all its functions
 *  (funkcjaSzczegolowaBudynku, "|"-joined: a home with a shop), its outline (PUWG 1992 easting, northing pairs,
 *  without the closing vertex; the posList is easting first, checked against the 3D models)]. */
type BdotBuilding = [BuildingKind, string, number, string, string, number[]];
/** BDOT10k id -> BdotBuilding, cached per powiat (a cache from before the outlines is rebuilt). */
function bdotBuildings(t: string): Map<string, BdotBuilding> {
  const cache = join(DIR, `bdot10k-${t}.buildings.json`);
  const old = existsSync(cache) && (Object.values(JSON.parse(readFileSync(cache, "utf8")))[0] as unknown[] | undefined)?.length !== 6;
  if (!existsSync(cache) || old) {
    const zip = zipOf("bdot10k", t), out: Record<string, BdotBuilding> = {};
    for (const m of members(zip, /OT_BUBD_A\.xml$/)) {
      for (const [b] of unzipOne(zip, m).matchAll(/<ot:OT_BUBD_A [\s\S]*?<\/ot:OT_BUBD_A>/g)) {
        const tag = (k: string) => new RegExp(`<ot:${k}>([^<]*)<`).exec(b)?.[1] ?? "";
        const main = tag("przewazajacaFunkcjaBudynku"), all = [...b.matchAll(/<ot:funkcjaSzczegolowaBudynku>([^<]*)</g)].map((m) => m[1]);
        const ring = (/<gml:exterior>[\s\S]*?<gml:posList[^>]*>([^<]+)</.exec(b)?.[1] ?? "").trim().split(/\s+/).map(Number).slice(0, -2);
        out[tag("lokalnyId")] = [bdotKind(tag("funkcjaOgolnaBudynku"), main), tag("kategoriaIstnienia"), parseInt(tag("liczbaKondygnacji")) || 0, main, all.join("|"),
          ring.length >= 6 && ring.every(Number.isFinite) ? ring : []];
      }
    }
    writeFileSync(cache, JSON.stringify(out));
  }
  return new Map(Object.entries(JSON.parse(readFileSync(cache, "utf8"))));
}

// ---- buildings -----------------------------------------------------------------------------------------
/** The 3D models' gml:id is "ID-<teryt>-<BDOT10k id>". */
const bdotId = (b: Lod2Building) => b.id.replace(/^ID-\d+-/, "");
/** Median LoD1 − LoD2 ground height of matching buildings when there are too few (central Wieliczka sheet). */
const KRON86_DEFAULT = 0.26;

/** An OSM building outline ([lat, lon] ring) and its tags: buildings the 3D models and BDOT10k lack. */
export type OsmOutline = { id: string; ring: Array<[number, number]>; tags: Record<string, string> };

/**
 * The buildings of an area: LoD2 meshes, shifted from Kronsztadt 86 onto EVRF2007, plus LoD1 2024 buildings
 * LoD2 does not have (built since); LoD2 buildings that are gone by 2024 are dropped. Each gets its kind from
 * BDOT10k. Buildings neither model has (built after the 2024 release, or never modelled: new estates, garages)
 * come from their BDOT10k outline, else from OSM's (`osm`), where the surface model shows a roof on them; their
 * roofs, and the LoD1 prisms' flat tops, are fitted to the surface model (fitroof.ts). `geoid` turns EVRF2007
 * into ellipsoid heights.
 */
export async function gugikBuildings(teryt: string[], bbox: number[], geoid: number, osm: OsmOutline[] = []): Promise<Lod2Building[]> {
  const lod2: Lod2Building[] = [], lod1: Lod2Building[] = [], bdot = new Map<string, BdotBuilding>(), powiat = new Map<string, string>();
  for (const t of teryt) {
    for (const xml of sheets("lod2", t, bbox)) lod2.push(...parseLod2(xml, bbox, geoid, { toLatLon: fromPuwg }));
    for (const xml of sheets("lod1", t, bbox)) lod1.push(...parseLod2(xml, bbox, geoid, { toLatLon: fromPuwg, lod1: true }));
    for (const [k, v] of bdotBuildings(t)) { bdot.set(k, v); powiat.set(k, t); }
  }
  // Kronsztadt 86 -> EVRF2007: the median difference of the ground under the same building in both models
  const base1 = new Map(lod1.map((b) => [bdotId(b), b.base]));
  const d = lod2.filter((b) => base1.has(bdotId(b))).map((b) => base1.get(bdotId(b))! - b.base).sort((a, b) => a - b);
  const dz = d.length >= 20 ? d[d.length >> 1] : KRON86_DEFAULT;
  for (const b of lod2) {
    b.base += dz;
    for (let i = 2; i < b.roof.length; i += 3) b.roof[i] += dz;
    for (let i = 2; i < b.wall.length; i += 5) b.wall[i] += dz;
  }
  // new since 2017: in LoD1 2024 only; gone: in neither LoD1 2024 nor BDOT10k, destroyed, or replaced by a new one
  const ids2 = new Set(lod2.map(bdotId)), ids1 = new Set(lod1.map(bdotId));
  const fresh = lod1.filter((b) => !ids2.has(bdotId(b)));
  const box = (r: P2[]) => [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))];
  const freshBoxes = fresh.map((b) => ({ b, box: box(b.footprint) }));
  const replaced = (b: Lod2Building) => {
    const bb = box(b.footprint), c = centre(b.footprint);
    return freshBoxes.some((f) => touches(f.box, bb) && (inside(c, f.b.footprint) || inside(centre(f.b.footprint), b.footprint)));
  };
  const kept = lod2.filter((b) => {
    if (ids1.has(bdotId(b))) return true;
    const state = bdot.get(bdotId(b))?.[1];
    return state !== undefined && state !== "zniszczony" && !replaced(b);
  });
  const out = [...kept, ...fresh];
  let known = 0;
  for (const b of out) {
    const k = bdot.get(bdotId(b));
    b.kind = k?.[0] ?? "other";
    if (k?.[2]) b.storeys = k[2];
    if (k?.[3]) b.use = k[3];
    if (k?.[4]) b.uses = k[4].split("|");
    if (k) known++;
  }
  console.log(`  gugik: ${kept.length}/${lod2.length} LoD2 buildings (+${dz.toFixed(2)} m Kronsztadt 86 -> EVRF2007, from ${d.length}), `
    + `${fresh.length} LoD1 2024 only; ${known}/${out.length} with a BDOT10k function`);
  out.push(...missingBuildings(out, fresh, bdot, powiat, osm, bbox, geoid));
  // each roof's colour from the orthophoto, where it has been downloaded (chunk by chunk: sorted by chunk)
  const ortho = new Ortho(), chunkOf = (b: Lod2Building) => b.xy[0]?.[0] ? orthoKey(b.xy[0][0][0], b.xy[0][0][1]) : "";
  let coloured = 0;
  for (const b of [...out].sort((a, c) => chunkOf(a).localeCompare(chunkOf(c)))) {
    if (!b.xy.length) continue;
    await ortho.ensure(b.xy.flat());
    const c = roofColour(b.xy, ortho);
    if (c) { b.roofRgb = c; coloured++; }
  }
  if (ortho.chunks.size) console.log(`  orthophoto roof colours: ${coloured}/${out.length}`);
  return out;
}

// ---- buildings the 3D models lack ------------------------------------------------------------------------
const PUWG_SOURCE: Lod2Source = { toLatLon: fromPuwg };
/** How high a building can plausibly rise above its lowest ground (m): more is a tree over it (fitroof.ts). */
const capOf = (kind: BuildingKind, storeys: number) =>
  storeys ? storeys * 3.4 + 6 : kind === "small" ? 6 : kind === "other" ? 16 : 45;

/** What an OSM building tag says about the building, in BDOT10k's terms (kind, main function: façades). */
function osmKind(t: Record<string, string>): [BuildingKind, string] {
  const b = t.building;
  if (/^(garage|garages)$/.test(b)) return ["small", "garaż"];
  if (/^(shed|hut|cabin|farm_auxiliary|barn|stable|cowshed|sty|outbuilding|allotment_house|service|kiosk|toilets)$/.test(b)) return ["small", "budynek gospodarczy"];
  if (b === "greenhouse") return ["small", ""];
  if (/^(church|chapel|cathedral|religious|shrine|monastery)$/.test(b)) return ["church", ""];
  if (/^(retail|supermarket|commercial|office|hotel)$/.test(b)) return ["commercial", b === "supermarket" ? "hipermarket lub supermarket" : ""];
  if (/^(industrial|warehouse|factory|manufacture|hangar)$/.test(b)) return ["industrial", b === "warehouse" ? "magazyn" : ""];
  if (/^(school|kindergarten|university|college|hospital|public|civic|government|fire_station|train_station|townhall)$/.test(b)) return ["public", ""];
  if (b === "apartments") return ["other", "budynek wielorodzinny"];
  if (/^(house|detached|semidetached_house|terrace|residential|bungalow)$/.test(b)) return ["other", "budynek jednorodzinny"];
  return ["other", ""];
}
/** OSM buildings that are not a closed building: roofs on posts, ruins, ones that are gone or underground. */
const notABuilding = (t: Record<string, string>) =>
  /^(no|roof|carport|ruins|collapsed|demolished|destroyed|bridge)$/.test(t.building) || t.location === "underground" || Number(t.layer) < 0;

const boxOf = (r: P2[]) => [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))];
/** Footprints (PUWG 1992) on a 64 m grid: how much of a new outline they already cover. */
class Footprints {
  private cells = new Map<number, Array<{ r: P2[]; b: number[] }>>();
  private range(b: number[], f: (k: number) => void) {
    for (let i = Math.floor(b[0] / 64); i <= Math.floor(b[2] / 64); i++) for (let j = Math.floor(b[1] / 64); j <= Math.floor(b[3] / 64); j++) f(i * 100003 + j);
  }
  add(r: P2[]) {
    const item = { r, b: boxOf(r) };
    this.range(item.b, (k) => { if (!this.cells.has(k)) this.cells.set(k, []); this.cells.get(k)!.push(item); });
  }
  /** share of the outline (sampled on a grid of ~200 points) inside the footprints */
  covered(r: P2[]): number {
    const b = boxOf(r), near = new Set<{ r: P2[]; b: number[] }>();
    this.range(b, (k) => { for (const it of this.cells.get(k) ?? []) if (touches(it.b, b)) near.add(it); });
    if (!near.size) return 0;
    const step = Math.max(0.5, Math.sqrt(Math.abs(area(r)) / 200));
    let n = 0, hit = 0;
    for (let x = b[0] + step / 2; x < b[2]; x += step) for (let y = b[1] + step / 2; y < b[3]; y += step) {
      if (!inside([x, y], r)) continue;
      n++;
      for (const it of near) if (inside([x, y], it.r)) { hit++; break; }
    }
    if (!n) { const c = centre(r); return [...near].some((it) => inside(c, it.r)) ? 1 : 0; }
    return hit / n;
  }
}

/**
 * Buildings the 3D models lack, and the LoD1 2024 prisms' roofs (edited in place): see gugikBuildings. A new
 * outline must not lie over 30 % inside a building already there (BDOT10k outlines go first, then OSM's).
 */
function missingBuildings(out: Lod2Building[], fresh: Lod2Building[], bdot: Map<string, BdotBuilding>, powiat: Map<string, string>,
  osm: OsmOutline[], bbox: number[], geoid: number): Lod2Building[] {
  const surface = gugikSurface(bbox), terrain = gugikTerrain(bbox);
  const heights: Heights = { surface, terrain: terrain.at };
  const shapes: Record<string, number> = {};
  const build = (id: string, ring: P2[], cap: number) => {
    const f = fitBuilding(ring, heights, cap);
    if (!f) return null;
    const c = centre(ring), m = meshOf(id, "", f.roofType, [], f.surfaces, fromPuwg(c[0], c[1]), geoid, PUWG_SOURCE);
    if (m) shapes[f.shape] = (shapes[f.shape] ?? 0) + 1;
    return m;
  };
  // the LoD1 prisms: the same outline with a fitted roof (kept as they are where the surface model sees none)
  let refitted = 0;
  for (const b of fresh) {
    if (!b.xy.length) continue;
    const ring = b.xy.reduce((x, y) => (Math.abs(area(y)) > Math.abs(area(x)) ? y : x));
    const m = build(b.id, ring, capOf(b.kind ?? "other", b.storeys ?? 0));
    if (!m) continue;
    Object.assign(b, { roofType: m.roofType, height: m.height, base: m.base, roof: m.roof, wall: m.wall, footprint: m.footprint });
    refitted++;
  }
  const index = new Footprints(), have = new Set(out.map(bdotId)), box = projected(bbox), added: Lod2Building[] = [];
  for (const b of out) for (const r of b.xy) index.add(r);
  const inBox = (r: P2[]) => { const c = centre(r); return c[0] >= box[0] && c[0] <= box[2] && c[1] >= box[1] && c[1] <= box[3]; };
  let fromBdot = 0, fromOsm = 0, unseen = 0;
  for (const [id, [kind, state, storeys, use, uses, flat]] of bdot) {
    if (have.has(id) || state === "zniszczony" || flat.length < 6) continue;
    const ring: P2[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
    if (!inBox(ring) || index.covered(ring) > 0.3) continue;
    const m = build(`ID-${powiat.get(id)}-${id}`, ring, capOf(kind, storeys));
    if (!m) { unseen++; continue; }
    Object.assign(m, { kind, ...(storeys ? { storeys } : {}), ...(use ? { use } : {}), ...(uses ? { uses: uses.split("|") } : {}) });
    added.push(m); index.add(ring); fromBdot++;
  }
  for (const o of osm) {
    if (notABuilding(o.tags)) continue;
    const ring = o.ring.map(([la, lo]) => toPuwg(la, lo));
    if (ring.length < 4 || !inBox(ring) || index.covered(ring) > 0.3) continue;
    const [kind, use] = osmKind(o.tags), storeys = parseInt(o.tags["building:levels"]) || 0;
    const m = build(o.id, ring, capOf(kind, storeys));
    if (!m) { unseen++; continue; }
    Object.assign(m, { kind, ...(storeys ? { storeys } : {}), ...(use ? { use, uses: [use] } : {}) });
    added.push(m); index.add(ring); fromOsm++;
  }
  console.log(`  missing buildings: +${fromBdot} BDOT10k, +${fromOsm} OSM outlines (${unseen} without a roof in the surface model); `
    + `${refitted}/${fresh.length} LoD1 roofs fitted; shapes ${Object.entries(shapes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return added;
}

// ---- orthophoto: each roof's real colour --------------------------------------------------------------
const ORTO = "https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/HighResolution";
/** Chunks of 1024 m at 0.25 m per pixel: 4096 px, the service's largest image. */
const ORTO_KM = 1024, ORTO_M = 0.25, ORTO_PX = ORTO_KM / ORTO_M;
const orthoKey = (e: number, n: number) => `${Math.floor(e / ORTO_KM) * ORTO_KM}_${Math.floor(n / ORTO_KM) * ORTO_KM}`;
const orthoFile = (key: string) => join(DIR, "orto", `${key}.jpg`);

/** Download the orthophoto chunks covering a bbox (lat/lon) into data/raw/gugik/orto/<E>_<N>.jpg; `near`
 *  skips chunks ([s, w, n, e]) the region does not need. */
export async function fetchOrtho(bbox: number[], near: (box: number[]) => boolean = () => true) {
  mkdirSync(join(DIR, "orto"), { recursive: true });
  const [e0, n0, e1, n1] = projected(bbox);
  let count = 0;
  for (let E = Math.floor(e0 / ORTO_KM) * ORTO_KM; E < e1; E += ORTO_KM)
    for (let N = Math.floor(n0 / ORTO_KM) * ORTO_KM; N < n1; N += ORTO_KM) {
      const c = [fromPuwg(E, N), fromPuwg(E + ORTO_KM, N), fromPuwg(E, N + ORTO_KM), fromPuwg(E + ORTO_KM, N + ORTO_KM)];
      if (!near([Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))])) continue;
      count++;
      const q = new URLSearchParams({
        SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: "Raster", STYLES: "", SRS: "EPSG:2180",
        BBOX: `${E},${N},${E + ORTO_KM},${N + ORTO_KM}`, WIDTH: String(ORTO_PX), HEIGHT: String(ORTO_PX), FORMAT: "image/jpeg",
      });
      await download(`${ORTO}?${q}`, orthoFile(`${E}_${N}`), `orthophoto ${E}_${N}`);
    }
  console.log(`  orthophoto: ${count} chunk(s) of ${ORTO_KM} m`);
}

/** The downloaded orthophoto chunks touching a bbox (lat/lon): south-west corner (PUWG 1992 m), side (m), pixel
 *  size (m) and file. */
export function orthoChunks(bbox: number[]): Array<{ e: number; n: number; size: number; px: number; file: string }> {
  const [e0, n0, e1, n1] = projected(bbox), out: Array<{ e: number; n: number; size: number; px: number; file: string }> = [];
  for (let E = Math.floor(e0 / ORTO_KM) * ORTO_KM; E < e1; E += ORTO_KM)
    for (let N = Math.floor(n0 / ORTO_KM) * ORTO_KM; N < n1; N += ORTO_KM) {
      const file = orthoFile(`${E}_${N}`);
      if (existsSync(file)) out.push({ e: E, n: N, size: ORTO_KM, px: ORTO_M, file });
    }
  return out;
}

/** Orthophoto pixels, chunks decoded on demand (a few kept at a time). */
class Ortho {
  chunks = new Map<string, Buffer | null>();
  async ensure(pts: P2[]) {
    for (const key of new Set(pts.map(([e, n]) => orthoKey(e, n)))) {
      if (this.chunks.has(key)) continue;
      const f = orthoFile(key);
      this.chunks.set(key, existsSync(f) ? (await sharp(f).removeAlpha().raw().toBuffer()) : null);
      if (this.chunks.size > 6) this.chunks.delete(this.chunks.keys().next().value!);
    }
  }
  /** RGB (0…1) at a PUWG 1992 point, null outside the downloaded chunks */
  at(e: number, n: number): [number, number, number] | null {
    const key = orthoKey(e, n), d = this.chunks.get(key);
    if (!d) return null;
    const [E, N] = key.split("_").map(Number), x = Math.floor((e - E) / ORTO_M), y = Math.floor((N + ORTO_KM - n) / ORTO_M);
    if (x < 0 || y < 0 || x >= ORTO_PX || y >= ORTO_PX) return null;
    const i = (y * ORTO_PX + x) * 3;
    return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
  }
}

/**
 * Which surface-model crowns (canopy.ts, PUWG 1992 metres) the orthophoto shows as foliage. The surface model
 * reads anything tall that LoD2 leaves out as a crown: fuel station canopies, shop entrance roofs, the edge of
 * a hall. A crown stays if some disc of 0.6 × its radius, shifted by up to 1 m + 0.3 × its height (≤ 6 m: the
 * photo leans tall things off their place), is ≥ 30 % green (excess green (2G − R − B) / (R + G + B) > 0.05).
 * Per 1024 m chunk a green mask at 0.5 m with an integral image; a chunk where over half its crowns would go is
 * taken for leaf-off imagery and kept whole. Crowns outside the downloaded chunks stay.
 */
export async function foliageSeen(crowns: Array<{ e: number; n: number; r: number; h: number }>): Promise<boolean[]> {
  const keep = crowns.map(() => true), byChunk = new Map<string, number[]>();
  crowns.forEach((c, i) => { const k = orthoKey(c.e, c.n); (byChunk.get(k) ?? byChunk.set(k, []).get(k)!).push(i); });
  const M = 8, CELL = 0.5, SIDE = Math.round((ORTO_KM + 2 * M) / CELL), cache = new Map<string, Buffer | null>();
  const chunk = async (key: string) => {
    if (!cache.has(key)) { const f = orthoFile(key); cache.set(key, existsSync(f) ? await sharp(f).removeAlpha().raw().toBuffer() : null); }
    return cache.get(key)!;
  };
  const keys = [...byChunk.keys()].sort((a, b) => { const [ea, na] = a.split("_").map(Number), [eb, nb] = b.split("_").map(Number); return na - nb || ea - eb; });
  for (const key of keys) {
    const ids = byChunk.get(key)!, [E, N] = key.split("_").map(Number);
    for (const k of cache.keys()) if (Number(k.split("_")[1]) < N - ORTO_KM) cache.delete(k); // rows done: 50 MB each
    if (!(await chunk(key))) continue;
    // green mask over the chunk and a margin (from the neighbouring chunks), as an integral image
    const sum = new Int32Array((SIDE + 1) * (SIDE + 1)), x0 = E - M, y1 = N + ORTO_KM + M;
    const near: Array<Buffer | null> = []; // 3 × 3 chunks, west to east, south to north
    for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) near.push(await chunk(`${E + dx * ORTO_KM}_${N + dy * ORTO_KM}`));
    for (let j = 0; j < SIDE; j++) {
      const n = y1 - (j + 0.5) * CELL, cy = Math.floor((n - N) / ORTO_KM), y = Math.floor((N + (cy + 1) * ORTO_KM - n) / ORTO_M);
      let row = 0;
      for (let i = 0; i < SIDE; i++) {
        const e = x0 + (i + 0.5) * CELL, cx = Math.floor((e - E) / ORTO_KM), d = near[(cy + 1) * 3 + cx + 1];
        let g = 0;
        if (d) {
          const o = (y * ORTO_PX + Math.floor((e - E - cx * ORTO_KM) / ORTO_M)) * 3, R = d[o], G = d[o + 1], B = d[o + 2];
          g = (2 * G - R - B) / (R + G + B + 1) > 0.05 ? 1 : 0;
        }
        row += g;
        sum[(j + 1) * (SIDE + 1) + i + 1] = sum[j * (SIDE + 1) + i + 1] + row;
      }
    }
    const share = (e: number, n: number, a: number) => { // green share of the square of half-side a around (e, n)
      const i0 = Math.max(0, Math.floor((e - a - x0) / CELL)), i1 = Math.min(SIDE, Math.ceil((e + a - x0) / CELL));
      const j0 = Math.max(0, Math.floor((y1 - n - a) / CELL)), j1 = Math.min(SIDE, Math.ceil((y1 - n + a) / CELL));
      const area = (i1 - i0) * (j1 - j0);
      return area > 0 ? (sum[j1 * (SIDE + 1) + i1] - sum[j0 * (SIDE + 1) + i1] - sum[j1 * (SIDE + 1) + i0] + sum[j0 * (SIDE + 1) + i0]) / area : 1;
    };
    const gone: number[] = [];
    for (const id of ids) {
      const c = crowns[id], a = Math.max(0.75, 0.6 * c.r * 0.886), T = Math.min(6, 1 + 0.3 * c.h); // square of a disc's area
      let seen = share(c.e, c.n, a) >= 0.3;
      for (let ox = -T; ox <= T && !seen; ox += 1) for (let oy = -T; oy <= T && !seen; oy += 1)
        if (ox * ox + oy * oy <= T * T) seen = share(c.e + ox, c.n + oy, a) >= 0.3;
      if (!seen) gone.push(id);
    }
    if (gone.length > ids.length / 2) continue; // leaf-off imagery here: no evidence either way
    for (const id of gone) keep[id] = false;
  }
  return keep;
}

/**
 * Bushes and hedges: the surface model 0.7–3.5 m above the ground where the orthophoto is green (at least half
 * of the 4 × 4 photo pixels of a 1 m cell), off buildings (+1 m) and tree crowns (1.1 × their radius), with
 * nothing taller than 3.5 m within 2 m (a crown's fringe, a wall's foot are not bushes), covered greedily by round
 * bushes, the highest cell first, each as wide as its height allows (0.6–1.5 m radius); a lone green cell is
 * dropped. A hedge comes out as a chain of bushes. Crowns and outlines in PUWG 1992 metres, as are the bushes.
 */
export async function bushes(ndom: (x: number, y: number) => number, blocked: P2[][], crowns: Array<{ e: number; n: number; r: number }>,
  bbox: number[]): Promise<Array<{ e: number; n: number; r: number; h: number }>> {
  const box = projected(bbox), out: Array<{ e: number; n: number; r: number; h: number }> = [];
  const rings = blocked.map((r) => ({ r, b: [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))] }));
  for (const ch of orthoChunks(bbox)) {
    const E = ch.e, N = ch.n, K = ch.size, sub = Math.round(1 / ch.px); // 1 m cells, sub × sub photo pixels each
    const { data, info } = await sharp(ch.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // not here: buildings (+1 m) and crowns (1.1 × their radius)
    const off = new Uint8Array(K * K);
    for (const { r, b } of rings) {
      if (b[2] < E - 1 || b[0] > E + K + 1 || b[3] < N - 1 || b[1] > N + K + 1) continue;
      for (let j = Math.max(0, Math.floor(b[1] - N) - 1); j <= Math.min(K - 1, Math.ceil(b[3] - N) + 1); j++)
        for (let i = Math.max(0, Math.floor(b[0] - E) - 1); i <= Math.min(K - 1, Math.ceil(b[2] - E) + 1); i++) {
          const x = E + i + 0.5, y = N + j + 0.5;
          if (inside([x, y], r) || [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => inside([x + dx, y + dy], r))) off[j * K + i] = 1;
        }
    }
    for (const c of crowns) {
      const R = c.r * 1.1;
      if (c.e + R < E || c.e - R > E + K || c.n + R < N || c.n - R > N + K) continue;
      for (let j = Math.max(0, Math.floor(c.n - R - N)); j <= Math.min(K - 1, Math.ceil(c.n + R - N)); j++)
        for (let i = Math.max(0, Math.floor(c.e - R - E)); i <= Math.min(K - 1, Math.ceil(c.e + R - E)); i++)
          if (Math.hypot(E + i + 0.5 - c.e, N + j + 0.5 - c.n) <= R) off[j * K + i] = 1;
    }
    // the surface everywhere, and where anything over 3.5 m stands within 2 m (5 × 5 cells)
    const surf = new Float32Array(K * K);
    for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) { const h = ndom(E + i, N + j); surf[j * K + i] = Number.isFinite(h) ? h : 0; }
    const tall = new Uint8Array(K * K), row = new Uint8Array(K * K);
    for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) for (let d = -2; d <= 2; d++) if (surf[j * K + Math.min(K - 1, Math.max(0, i + d))] > 3.5) { row[j * K + i] = 1; break; }
    for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) for (let d = -2; d <= 2; d++) if (row[Math.min(K - 1, Math.max(0, j + d)) * K + i]) { tall[j * K + i] = 1; break; }
    // candidates: green, low, free
    const cand: number[] = [], height = new Float32Array(K * K);
    for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) {
      const x = E + i, y = N + j;
      if (off[j * K + i] || tall[j * K + i] || x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      let g = 0;
      for (let v = 0; v < sub; v++) for (let u = 0; u < sub; u++) {
        const q = ((info.height - 1 - (j * sub + v)) * info.width + i * sub + u) * 3, R = data[q], G = data[q + 1], B = data[q + 2];
        if ((2 * G - R - B) / (R + G + B + 1) > 0.05) g++;
      }
      if (g * 2 < sub * sub) continue;
      const h = surf[j * K + i];
      if (!(h >= 0.7 && h <= 3.5)) continue;
      height[j * K + i] = h;
      cand.push(j * K + i);
    }
    // greedy cover, the highest first
    cand.sort((a, b) => height[b] - height[a]);
    const taken = new Uint8Array(K * K);
    for (const q of cand) {
      if (taken[q]) continue;
      const i = q % K, j = (q - i) / K, h = height[q], r = Math.max(0.6, Math.min(1.5, 0.45 + 0.3 * h)), R = Math.ceil(r);
      let n = 0;
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= K || jj >= K || di * di + dj * dj > r * r) continue;
        if (height[jj * K + ii] > 0 && !taken[jj * K + ii]) { taken[jj * K + ii] = 1; n++; }
      }
      if (n >= 2) out.push({ e: E + i + 0.5, n: N + j + 0.5, r, h });
    }
  }
  return out;
}

/** Roof colours of the house style (the renderer's roof palette), one per roofing a photo can tell apart. */
const ROOFS: Record<string, number[]> = {
  red: [0.76, 0.36, 0.25], orange: [0.84, 0.52, 0.30], brown: [0.60, 0.36, 0.26], darkBrown: [0.44, 0.29, 0.23],
  graphite: [0.34, 0.35, 0.38], grey: [0.56, 0.57, 0.60], lightGrey: [0.77, 0.77, 0.76], copper: [0.45, 0.70, 0.60],
};
/** Which roofing a photo colour shows: ceramic tiles by hue and lightness, sheet metal and membranes by lightness. */
function roofing([h, s, l]: [number, number, number]): string {
  if (s < 0.12 || l < 0.18) return l < 0.32 ? "graphite" : l < 0.58 ? "grey" : "lightGrey";
  if (h >= 80 && h <= 200) return "copper";
  if (h > 200 && h < 330) return l < 0.35 ? "graphite" : "grey"; // bluish sheet metal
  if (l < 0.30) return "darkBrown";
  if (s < 0.28) return "brown";
  return h > 20 && h < 50 && l > 0.45 ? "orange" : "red";
}

/**
 * A roof's colour in the house style: the median of the photo's pixels in the middle of the largest footprint
 * (shrunk to 60 % around its centre: the photo leans tall roofs a little off their footprint), without
 * foliage and deep shadow, tells the roofing; the palette colour of that roofing, with a quarter of the
 * photo's own colour for variety.
 */
function roofColour(xy: P2[][], ortho: Ortho): number[] | null {
  const ring = xy.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
  const c = centre(ring), r = ring.map(([x, y]) => [c[0] + (x - c[0]) * 0.6, c[1] + (y - c[1]) * 0.6] as P2);
  const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]), px: number[][] = [];
  for (let e = Math.min(...xs); e <= Math.max(...xs); e += ORTO_M) for (let n = Math.min(...ys); n <= Math.max(...ys); n += ORTO_M) {
    if (!inside([e, n], r)) continue;
    const v = ortho.at(e, n);
    if (!v) continue;
    const [R, G, B] = v, lum = 0.299 * R + 0.587 * G + 0.114 * B;
    if (lum < 0.12 || (G > R + 0.03 && G > B + 0.03)) continue; // shadow, foliage over the roof
    px.push(v);
  }
  if (px.length < 12) return null;
  const med = [0, 1, 2].map((k) => px.map((p) => p[k]).sort((a, b) => a - b)[px.length >> 1]);
  const base = ROOFS[roofing(rgbToHsl(med))];
  return base.map((v, k) => Math.round((v * 0.75 + med[k] * 0.25) * 100) / 100);
}

const area = (r: P2[]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}


const centre = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
function inside([x, y]: P2, r: P2[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}

// ---- NMT / NMPT sheets ---------------------------------------------------------------------------------
type Model = "nmt" | "nmpt";
const YEARS = ["2026", "2025", "2024", "2023iStarsze"];

type Sheet = { year: string; url: string } | null;
/** The newest sheet of a model covering a point (index WMS), or null; answers cached. */
async function sheetAt(model: Model, lat: number, lon: number, cache: Record<string, Sheet>): Promise<Sheet> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (key in cache) return cache[key];
  const M = model.toUpperCase();
  for (const year of YEARS) {
    const layer = `Skorowidze${M}${year}`;
    const q = new URLSearchParams({
      SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetFeatureInfo", LAYERS: layer, QUERY_LAYERS: layer, CRS: "EPSG:4326",
      BBOX: `${lat - 0.0005},${lon - 0.0005},${lat + 0.0005},${lon + 0.0005}`, WIDTH: "101", HEIGHT: "101", I: "50", J: "50",
      INFO_FORMAT: "text/html", FEATURE_COUNT: "10",
    });
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`https://mapy.geoportal.gov.pl/wss/service/PZGIK/${M}/WMS/SkorowidzeUkladEVRF2007?${q}`, { headers: UA, signal: AbortSignal.timeout(120_000) });
        const body = await r.text();
        // a database outage answers 200 with a ServiceException: not "no sheet here", so never cache it
        if (!r.ok || body.includes("ServiceException")) throw new Error(`HTTP ${r.status}: ${body.match(/<ServiceException>\s*([^<]{0,120})/)?.[1]?.trim() ?? "no answer"}`);
        const links = [...body.matchAll(/https:\/\/opendata\.geoportal\.gov\.pl\/NumDaneWys\/[^"'<> ]+\.asc/g)].map((m) => m[0]);
        if (links.length) return (cache[key] = { year, url: links.at(-1)! });
        break;
      } catch (err) {
        // the index WMS stalls for minutes at a time: wait it out rather than fail the whole fetch
        if (attempt === 6) throw new Error(`${layer} index at ${lat}, ${lon}: ${(err as Error).message}`);
        await new Promise((res) => setTimeout(res, 15_000 * attempt));
      }
    }
  }
  return (cache[key] = null);
}

/**
 * Download every sheet of a model touching a bbox; sheets are ~2.3 km across, so a ~1 km sample grid finds
 * all. `near` skips sample cells ([s, w, n, e]) the region does not need.
 */
async function fetchSheets(model: Model, [s, w, n, e]: number[], near: (box: number[]) => boolean = () => true) {
  const dir = join(DIR, model);
  mkdirSync(dir, { recursive: true });
  const cacheFile = join(dir, "links.json");
  const cache: Record<string, Sheet> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const steps = (a: number, b: number, d: number) => { const k = Math.max(1, Math.ceil((b - a) / d)); return Array.from({ length: k + 1 }, (_, i) => a + ((b - a) * i) / k); };
  const found = new Map<string, string>(); // url -> year
  for (const lat of steps(s, n, 0.008)) for (const lon of steps(w, e, 0.012)) {
    if (!near([lat - 0.004, lon - 0.006, lat + 0.004, lon + 0.006])) continue;
    const sheet = await sheetAt(model, lat, lon, cache);
    if (sheet) found.set(sheet.url, sheet.year);
  }
  writeFileSync(cacheFile, JSON.stringify(cache));
  for (const u of found.keys()) await download(u, join(dir, u.split("/").pop()!));
  console.log(`  ${model}: ${found.size} sheet(s), ${[...found].map(([u, y]) => `${u.split("/").pop()!.replace(/^\d+_\d+_|\.asc$/g, "")} ${y}`).join(", ")}`);
}

/**
 * A sheet decoded once: header + float32 cells (row 0 = south), NaN where there is no data. NMPT is kept at
 * 1 m as the highest of its four 0.5 m cells (crown tops), cell [x, x+1) × [y, y+1) for integer x, y; NMT
 * stays at its 1 m posting with cell centres at x0 + i, y0 + j.
 */
interface Grid { x0: number; y0: number; cell: number; nx: number; ny: number; data: Float32Array }

function decode(model: Model, asc: string): Grid {
  const f32 = asc.replace(/\.asc$/, ".f32"), hdr = asc.replace(/\.asc$/, ".grid.json");
  if (existsSync(f32) && existsSync(hdr)) {
    const b = readFileSync(f32);
    return { ...JSON.parse(readFileSync(hdr, "utf8")), data: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
  }
  const buf = readFileSync(asc);
  const head: Record<string, number> = {};
  let pos = 0;
  for (let line = 0; line < 6; line++) {
    const end = buf.indexOf(10, pos), [k, v] = buf.toString("latin1", pos, end).trim().split(/\s+/);
    head[k.toLowerCase()] = Number(v);
    pos = end + 1;
  }
  const nc = head.ncols, nr = head.nrows, cs = head.cellsize, nodata = head.nodata_value ?? -9999;
  // cell centres: xllcenter, or xllcorner + half a cell; x is easting (checked on the 2025 sheets)
  const xc = head.xllcenter ?? head.xllcorner + cs / 2, yc = head.yllcenter ?? head.yllcorner + cs / 2;
  if (!(xc > 100000 && xc < 900000 && yc > 100000 && yc < 800000)) throw new Error(`${asc}: header does not look like EPSG:2180 easting/northing`);
  const pool = model === "nmpt" && cs < 1;
  const g: Grid = pool
    ? { x0: Math.floor(xc), y0: Math.floor(yc), cell: 1, nx: Math.floor(xc + (nc - 1) * cs) - Math.floor(xc) + 1, ny: Math.floor(yc + (nr - 1) * cs) - Math.floor(yc) + 1, data: new Float32Array(0) }
    : { x0: xc, y0: yc, cell: cs, nx: nc, ny: nr, data: new Float32Array(0) };
  const data = new Float32Array(g.nx * g.ny).fill(NaN);
  // numbers in row-major order from the top row; a hand-rolled parser (149 MB of text per NMPT sheet)
  let k = 0, num = 0, frac = 0, div = 1, neg = false, inNum = false, inFrac = false;
  const put = () => {
    const v = (neg ? -1 : 1) * (num + frac / div), i = k % nc, j = nr - 1 - Math.floor(k / nc);
    k++;
    if (v === nodata) return;
    if (pool) {
      const q = (Math.floor(yc + j * cs) - g.y0) * g.nx + Math.floor(xc + i * cs) - g.x0;
      if (!(data[q] >= v)) data[q] = v;
    } else data[j * nc + i] = v;
  };
  for (let c = pos; c < buf.length; c++) {
    const ch = buf[c];
    if (ch >= 48 && ch <= 57) { if (inFrac) { frac = frac * 10 + ch - 48; div *= 10; } else num = num * 10 + ch - 48; inNum = true; }
    else if (ch === 46) inFrac = true;
    else if (ch === 45) neg = true;
    else if (ch === 69 || ch === 101) throw new Error(`${asc}: exponent notation not handled`);
    else { if (inNum) put(); num = 0; frac = 0; div = 1; neg = false; inNum = false; inFrac = false; }
  }
  if (inNum) put();
  if (k !== nc * nr) throw new Error(`${asc}: ${k} values, expected ${nc * nr}`);
  g.data = data;
  writeFileSync(f32, Buffer.from(data.buffer));
  writeFileSync(hdr, JSON.stringify({ x0: g.x0, y0: g.y0, cell: g.cell, nx: g.nx, ny: g.ny }));
  return g;
}

/** The decoded sheets of a model touching a bbox (lat/lon); each sheet is decoded once per run. */
const decoded = new Map<string, Grid>();
function grids(model: Model, bbox: number[]): Grid[] {
  const dir = join(DIR, model), box = projected(bbox);
  if (!existsSync(dir)) return [];
  const sheet = (f: string) => {
    const file = join(dir, f);
    if (!decoded.has(file)) decoded.set(file, decode(model, file));
    return decoded.get(file)!;
  };
  return readdirSync(dir).filter((f) => f.endsWith(".asc")).map(sheet)
    .filter((g) => touches([g.x0, g.y0, g.x0 + g.nx * g.cell, g.y0 + g.ny * g.cell], box));
}

/**
 * NMT terrain: (lat, lon) -> EVRF2007 height (m), bilinear between cell centres; NaN outside the sheets. Sheets
 * do not quite meet (a few metres between two can have no cell): there, the mean of the nearest cells round it
 * (8 directions at 2, 4, 8, 16 m), so the gap does not fall back to a coarser model and leave a seam.
 */
export function gugikTerrain(bbox: number[]) {
  const gs = grids("nmt", bbox);
  const at = (east: number, north: number) => {
    const z = sheetAt(east, north);
    if (Number.isFinite(z)) return z;
    for (const r of [2, 4, 8, 16]) {
      let sum = 0, n = 0;
      for (let k = 0; k < 8; k++) {
        const v = sheetAt(east + Math.cos((k * Math.PI) / 4) * r, north + Math.sin((k * Math.PI) / 4) * r);
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      if (n) return sum / n;
    }
    return NaN;
  };
  const sheetAt = (east: number, north: number) => {
    for (const g of gs) {
      const fx = (east - g.x0) / g.cell, fy = (north - g.y0) / g.cell;
      if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) continue;
      const ix = Math.min(g.nx - 2, Math.floor(fx)), iy = Math.min(g.ny - 2, Math.floor(fy)), ax = fx - ix, ay = fy - iy;
      const v = (x: number, y: number) => g.data[y * g.nx + x];
      const z = (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
      if (Number.isFinite(z)) return z;
    }
    return NaN;
  };
  return { at, atLatLon: (lat: number, lon: number) => at(...toPuwg(lat, lon)) };
}

/** NMPT surface (EVRF2007 height, the highest of its 0.5 m cells) per 1 m cell with south-west corner (x, y) in
 *  PUWG 1992; NaN outside. */
export function gugikSurface(bbox: number[]) {
  const surface = grids("nmpt", bbox);
  return (x: number, y: number) => {
    for (const g of surface) {
      const i = Math.floor(x) - g.x0, j = Math.floor(y) - g.y0;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const top = g.data[j * g.nx + i];
      if (Number.isFinite(top)) return top;
    }
    return NaN;
  };
}

/** Normalised surface (nDOM = NMPT − NMT) per 1 m cell with south-west corner (x, y) in PUWG 1992; NaN outside. */
export function gugikNdom(bbox: number[]) {
  const surface = gugikSurface(bbox), terrain = gugikTerrain(bbox);
  return (x: number, y: number) => {
    const top = surface(x, y);
    return Number.isFinite(top) ? top - terrain.at(Math.floor(x) + 0.5, Math.floor(y) + 0.5) : NaN;
  };
}
