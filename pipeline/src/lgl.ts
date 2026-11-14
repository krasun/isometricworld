/**
 * LGL Baden-Württemberg open data (https://opengeodata.lgl-bw.de, Datenlizenz Deutschland –
 * Namensnennung 2.0, "Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0"). All products come in
 * 2 km × 2 km zips on the ETRS89/UTM32 grid (named by their south-west corner in km: odd easting,
 * even northing), each holding four 1 km × 1 km files.
 *
 *   dgm1   bare-earth terrain, 1 m posting, XYZ text, heights NHN (DHHN2016)
 *   ndom1  normalised surface model (surface minus terrain), 1 m GeoTIFF float32
 *   lod2   3D buildings with roof shapes, CityGML 1.0, UTM32 + NHN
 *
 * Downloads go to data/raw/lgl/<product>/, decoded 1 km rasters to data/raw/lgl/<product>/<e>_<n>.f32.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { boxTouchesOutline } from "./outline.ts";
import { RAW } from "./paths.ts";
import { fromUtm, toUtm } from "./utm.ts";

export type Product = "dgm1" | "ndom1" | "lod2";
const PATH: Record<Product, [string, string]> = { dgm1: ["dgm", "dgm1"], ndom1: ["ndom1", "ndom1"], lod2: ["lod2", "LoD2"] };
const DIR = join(RAW, "lgl");
const UA = { "User-Agent": "isometric-world/0.3 (open-data isometric map)" };

/** South-west corners (km) of the 2 km tiles covering a bbox [s, w, n, e] (and touching the region's outline). */
export function tiles2km([s, w, n, e]: number[]): Array<[number, number]> {
  const pts = [[s, w], [s, e], [n, w], [n, e]].map(([la, lo]) => toUtm(la, lo));
  const ex = pts.map((p) => p[0] / 1000), ny = pts.map((p) => p[1] / 1000);
  const out: Array<[number, number]> = [];
  for (let E = Math.floor((Math.min(...ex) - 1) / 2) * 2 + 1; E < Math.max(...ex); E += 2)
    for (let N = Math.floor(Math.min(...ny) / 2) * 2; N < Math.max(...ny); N += 2) {
      const c = [[E, N], [E + 2, N + 2]].map(([e, n]) => fromUtm(e * 1000, n * 1000));
      if (boxTouchesOutline([c[0][0], c[0][1], c[1][0], c[1][1]])) out.push([E, N]);
    }
  return out;
}

const zipName = (p: Product, E: number, N: number) => `${PATH[p][1]}_32_${E}_${N}_2_bw.zip`;
const zipFile = (p: Product, E: number, N: number) => join(DIR, p, zipName(p, E, N));

/** Download the zips of a product covering a bbox (skips ones already there). */
export async function download(p: Product, bbox: number[]) {
  mkdirSync(join(DIR, p), { recursive: true });
  const list = tiles2km(bbox);
  for (const [i, [E, N]] of list.entries()) {
    const file = zipFile(p, E, N);
    if (existsSync(file)) continue;
    const url = `https://opengeodata.lgl-bw.de/data/${PATH[p][0]}/${zipName(p, E, N)}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(600_000) });
        if (r.status === 404) { console.log(`  ${p} ${E}_${N}: none (outside Baden-Württemberg?)`); break; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        writeFileSync(`${file}.tmp`, Buffer.from(await r.arrayBuffer()));
        (await import("node:fs")).renameSync(`${file}.tmp`, file);
        console.log(`  ${p} ${E}_${N} (${i + 1}/${list.length})`);
        break;
      } catch (err) {
        if (attempt === 4) throw new Error(`${url}: ${(err as Error).message}`);
        await new Promise((res) => setTimeout(res, 5000 * attempt));
      }
    }
  }
}

/** Names of the members of a zip matching a pattern. */
function members(zip: string, re: RegExp) {
  return execFileSync("unzip", ["-Z1", zip], { encoding: "latin1" }).split("\n").filter((m) => re.test(m));
}
const unzipOne = (zip: string, member: string) => execFileSync("unzip", ["-p", zip, member], { maxBuffer: 1 << 30 });

/** The 2 km zip holding a 1 km cell (km south-west corner). */
const parent = (e: number, n: number): [number, number] => [Math.floor((e - 1) / 2) * 2 + 1, Math.floor(n / 2) * 2];

/** 1000×1000 float32 raster of a 1 km cell, row 0 = north, NaN where missing; cached as .f32. */
function raster(p: "dgm1" | "ndom1", e: number, n: number): Float32Array | null {
  const cache = join(DIR, p, `${e}_${n}.f32`);
  if (existsSync(cache)) { const b = readFileSync(cache); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); }
  const zip = zipFile(p, ...parent(e, n));
  if (!existsSync(zip)) return null;
  const m = members(zip, new RegExp(`_32_${e}_${n}_1_bw.*\\.(xyz|tif)$`))[0];
  if (!m) return null;
  const out = new Float32Array(1000 * 1000).fill(NaN);
  if (m.endsWith(".xyz")) {
    // "513000.50 5402999.50 251.79" per line, any order
    const txt = unzipOne(zip, m).toString("latin1");
    let i = 0;
    while (i < txt.length) {
      const j = txt.indexOf("\n", i), line = txt.slice(i, j < 0 ? txt.length : j);
      i = j < 0 ? txt.length : j + 1;
      const a = line.indexOf(" "), b = line.indexOf(" ", a + 1);
      if (a < 0 || b < 0) continue;
      const x = Math.floor(Number(line.slice(0, a)) - e * 1000), y = Math.floor((n + 1) * 1000 - Number(line.slice(a + 1, b)));
      if (x >= 0 && x < 1000 && y >= 0 && y < 1000) out[y * 1000 + x] = Number(line.slice(b + 1));
    }
  } else {
    return null; // tif: decoded asynchronously by rasterAsync
  }
  writeFileSync(cache, Buffer.from(out.buffer));
  return out;
}

async function rasterAsync(p: "dgm1" | "ndom1", e: number, n: number): Promise<Float32Array | null> {
  const r = raster(p, e, n);
  if (r || p !== "ndom1") return r;
  const zip = zipFile(p, ...parent(e, n));
  if (!existsSync(zip)) return null;
  const m = members(zip, new RegExp(`_32_${e}_${n}_1_bw\\.tif$`))[0];
  if (!m) return null;
  const { data, info } = await sharp(unzipOne(zip, m)).extractChannel(0).raw({ depth: "float" }).toBuffer({ resolveWithObject: true });
  if (info.width !== 1000 || info.height !== 1000) throw new Error(`${m}: ${info.width}×${info.height}`);
  const out = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
  writeFileSync(join(DIR, p, `${e}_${n}.f32`), Buffer.from(out.buffer));
  return out;
}

/** UTM32 raster sampler over every 1 km cell touching a bbox: (east, north) -> value (bilinear on 1 m pixel centres). */
export async function rasterSampler(p: "dgm1" | "ndom1", bbox: number[]) {
  const cells = new Map<string, Float32Array | null>();
  for (const [E, N] of tiles2km(bbox)) for (const [e, n] of [[E, N], [E + 1, N], [E, N + 1], [E + 1, N + 1]])
    cells.set(`${e}_${n}`, await rasterAsync(p, e, n));
  const px = (x: number, y: number) => {
    const e = Math.floor(x / 1000), n = Math.floor(y / 1000), c = cells.get(`${e}_${n}`);
    if (!c) return NaN;
    return c[(999 - Math.floor(y - n * 1000)) * 1000 + Math.floor(x - e * 1000)];
  };
  const at = (east: number, north: number) => {
    const fx = east - 0.5, fy = north - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    const v00 = px(ix, iy), v10 = px(ix + 1, iy), v01 = px(ix, iy + 1), v11 = px(ix + 1, iy + 1);
    return (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
  };
  return { at, px };
}

/** Every LoD2 CityGML document (1 km cell) touching a bbox, as text. */
export function* lod2Files(bbox: number[]): Generator<{ name: string; xml: string }> {
  for (const [E, N] of tiles2km(bbox)) {
    const zip = zipFile("lod2", E, N);
    if (!existsSync(zip)) continue;
    for (const m of members(zip, /\.gml$/i)) yield { name: m, xml: unzipOne(zip, m).toString("utf8") };
  }
}

export { fromUtm, toUtm };
