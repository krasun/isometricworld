/**
 * GUGiK open data for Poland (Główny Urząd Geodezji i Kartografii, opendata.geoportal.gov.pl), the
 * inputs of regions with `sources: "gugik"`. All in EPSG:2180 (PUWG 1992); downloads go to data/raw/gugik/.
 *
 *   LoD2 3D buildings   per powiat; roofs from airborne LiDAR (state 2017); heights in Kronsztadt 86
 *   LoD1 3D buildings   per powiat; prisms, LiDAR median height (2024 release); EVRF2007: buildings LoD2 lacks
 *   BDOT10k buildings   per powiat (OT_BUBD_A): what each building is used for, by its BDOT10k id, which is
 *                       the 3D models' buildingId
 *   NMT, NMPT           terrain (1 m) and surface (0.5 m) per 1:5000 map sheet, ASC grids, EVRF2007
 *
 * Licences (ATTRIBUTION.md): the 3D models CC0 1.0; BDOT10k, NMT and NMPT CC BY 4.0, with the notice
 * „Wykorzystano/opracowano na podstawie materiałów państwowego zasobu geodezyjnego i kartograficznego”.
 *
 * Based on Piotr Kulpiński's Kraków branch (github.com/piotrkulpinski/isometricworld, feat/krakow-test-patch,
 * gugik.ts and elevation.ts): the PUWG 1992 parameters, the download addresses, finding a sheet through the
 * index WMS, and reading the ASC grids.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildingKind, type Lod2Building, parseLod2 } from "./lod2.ts";
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
async function download(url: string, file: string) {
  if (existsSync(file)) return;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(900_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(`${file}.tmp`, Buffer.from(await r.arrayBuffer()));
      renameSync(`${file}.tmp`, file);
      console.log(`  gugik: ${url.split("/").pop()}`);
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

/** Download what an area needs: the powiats' buildings and the NMT / NMPT sheets around the bbox. */
export async function fetchGugik(teryt: string[], bbox: number[]) {
  mkdirSync(DIR, { recursive: true });
  for (const t of teryt) for (const p of Object.keys(POWIAT) as Powiat[]) await download(POWIAT[p](t), zipOf(p, t));
  const [s, w, n, e] = bbox, m = 0.005, g = 0.01; // objects just past the edge; terrain as far as ground.ts reads
  await fetchSheets("nmpt", [s - m, w - m, n + m, e + m]);
  await fetchSheets("nmt", [s - g, w - g, n + g, e + g]);
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

/** BDOT10k id -> [kind, existence (eksploatowany, w budowie, nieczynny, zniszczony)], cached per powiat. */
function bdotBuildings(t: string): Map<string, [BuildingKind, string]> {
  const cache = join(DIR, `bdot10k-${t}.buildings.json`);
  if (!existsSync(cache)) {
    const zip = zipOf("bdot10k", t), out: Record<string, [BuildingKind, string]> = {};
    for (const m of members(zip, /OT_BUBD_A\.xml$/)) {
      for (const [b] of unzipOne(zip, m).matchAll(/<ot:OT_BUBD_A [\s\S]*?<\/ot:OT_BUBD_A>/g)) {
        const tag = (k: string) => new RegExp(`<ot:${k}>([^<]*)<`).exec(b)?.[1] ?? "";
        out[tag("lokalnyId")] = [bdotKind(tag("funkcjaOgolnaBudynku"), tag("przewazajacaFunkcjaBudynku")), tag("kategoriaIstnienia")];
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

/**
 * The buildings of an area: LoD2 meshes, shifted from Kronsztadt 86 onto EVRF2007, plus LoD1 2024 prisms of
 * buildings LoD2 does not have (built since); LoD2 buildings that are gone by 2024 are dropped. Each gets its
 * kind from BDOT10k. `geoid` turns EVRF2007 into ellipsoid heights.
 */
export function gugikBuildings(teryt: string[], bbox: number[], geoid: number): Lod2Building[] {
  const lod2: Lod2Building[] = [], lod1: Lod2Building[] = [], bdot = new Map<string, [BuildingKind, string]>();
  for (const t of teryt) {
    for (const xml of sheets("lod2", t, bbox)) lod2.push(...parseLod2(xml, bbox, geoid, { toLatLon: fromPuwg }));
    for (const xml of sheets("lod1", t, bbox)) lod1.push(...parseLod2(xml, bbox, geoid, { toLatLon: fromPuwg, lod1: true }));
    for (const [k, v] of bdotBuildings(t)) bdot.set(k, v);
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
    if (k) known++;
  }
  console.log(`  gugik: ${kept.length}/${lod2.length} LoD2 buildings (+${dz.toFixed(2)} m Kronsztadt 86 -> EVRF2007, from ${d.length}), `
    + `${fresh.length} LoD1 2024 only; ${known}/${out.length} with a BDOT10k function`);
  return out;
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
        const r = await fetch(`https://mapy.geoportal.gov.pl/wss/service/PZGIK/${M}/WMS/SkorowidzeUkladEVRF2007?${q}`, { headers: UA, signal: AbortSignal.timeout(60_000) });
        const links = [...(await r.text()).matchAll(/https:\/\/opendata\.geoportal\.gov\.pl\/NumDaneWys\/[^"'<> ]+\.asc/g)].map((m) => m[0]);
        if (links.length) return (cache[key] = { year, url: links.at(-1)! });
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((res) => setTimeout(res, 3000 * attempt));
      }
    }
  }
  return (cache[key] = null);
}

/** Download every sheet of a model touching a bbox; sheets are ~2.3 km across, so a ~1 km sample grid finds all. */
async function fetchSheets(model: Model, [s, w, n, e]: number[]) {
  const dir = join(DIR, model);
  mkdirSync(dir, { recursive: true });
  const cacheFile = join(dir, "links.json");
  const cache: Record<string, Sheet> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const steps = (a: number, b: number, d: number) => { const k = Math.max(1, Math.ceil((b - a) / d)); return Array.from({ length: k + 1 }, (_, i) => a + ((b - a) * i) / k); };
  const found = new Map<string, string>(); // url -> year
  for (const lat of steps(s, n, 0.008)) for (const lon of steps(w, e, 0.012)) {
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

/** The decoded sheets of a model touching a bbox (lat/lon). */
function grids(model: Model, bbox: number[]): Grid[] {
  const dir = join(DIR, model), box = projected(bbox);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".asc")).map((f) => decode(model, join(dir, f)))
    .filter((g) => touches([g.x0, g.y0, g.x0 + g.nx * g.cell, g.y0 + g.ny * g.cell], box));
}

/** NMT terrain: (lat, lon) -> EVRF2007 height (m), bilinear between cell centres; NaN outside the sheets. */
export function gugikTerrain(bbox: number[]) {
  const gs = grids("nmt", bbox);
  const at = (east: number, north: number) => {
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

/** Normalised surface (nDOM = NMPT − NMT) per 1 m cell with south-west corner (x, y) in PUWG 1992; NaN outside. */
export function gugikNdom(bbox: number[]) {
  const surface = grids("nmpt", bbox), terrain = gugikTerrain(bbox);
  return (x: number, y: number) => {
    for (const g of surface) {
      const i = Math.floor(x) - g.x0, j = Math.floor(y) - g.y0;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const top = g.data[j * g.nx + i];
      if (Number.isFinite(top)) return top - terrain.at(Math.floor(x) + 0.5, Math.floor(y) + 0.5);
    }
    return NaN;
  };
}
