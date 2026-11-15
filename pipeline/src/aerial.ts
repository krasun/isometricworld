/**
 * Aerial pass: an open-data orthophoto draped onto the render's view, pixel-aligned with the render
 * tiles, as a colour/material guide for painting (roof colours, green roofs, solar panels, paving, trees).
 *
 * For every art pixel the height pass gives the visible surface height; inverting the camera at that
 * height gives the ground point, which is sampled from the orthophoto. Walls (steep in the height pass)
 * have no top-down information and stay flat neutral grey; unrendered pixels stay black.
 *
 *   npx tsx src/aerial.ts stuttgart-core --near 48.7905,9.1846 --radius 1 [--source city|lgl]
 *
 * Writes data/derived/<area>/aerial-<source>/<tx>_<ty>.png; orthophoto cells are cached in data/raw/aerial/.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { CAMERA, axes, enuToLlh, llhToPixel } from "./camera.ts";
import { readHeights } from "./heights.ts";
import { DERIVED, RAW } from "./paths.ts";
import { toUtm } from "./utm.ts";

/** Open orthophoto WMS services (EPSG:25832, 20 cm). Credits: see ATTRIBUTION.md. */
const SOURCES: Record<string, { url: string; layer: string }> = {
  // Landeshauptstadt Stuttgart, Stadtmessungsamt: Luftbilder 2023, CC BY 4.0 (opendata.stuttgart.de)
  city: { url: "https://geoserver.stuttgart.de/gdc/Hintergrundbilder/wms", layer: "A62_Luftbild_2023_EPSG25832" },
  // LGL Baden-Württemberg DOP20 RGB, dl-de/by-2.0
  lgl: { url: "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C", layer: "IMAGES_DOP_20_RGB" },
};
const CELL = 200, RES = 0.2, CPX = CELL / RES; // orthophoto cache cells: 200 m, 1000 px
const T = CAMERA.tile, HS = 256, K = T / HS; // height pass: 256² per tile
const WIN = 1024, STRIDE = 896;
/** Height change per height sample (1 m screen) above which a pixel is a wall: ~74° and steeper. */
const WALL = 1.1;
const WALL_GREY = 128;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    near: { type: "string" },
    radius: { type: "string", default: "1" },
    source: { type: "string", default: "city" },
    force: { type: "boolean", default: false },
  },
});
const areaName = positionals[0];
if (!areaName || !args.near) throw new Error("usage: aerial.ts <area> --near lat,lon [--radius 1] [--source city|lgl]");
const src = SOURCES[args.source!];
if (!src) throw new Error(`unknown source ${args.source}`);
openArea(areaName);
const base = join(DERIVED, areaName);
const outDir = join(base, `aerial-${args.source}`);
const cacheDir = join(RAW, "aerial", args.source!);
mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

// ---- camera inverse: art pixel + ENU height -> ENU east/north -------------------------------------
const { right: r, up: v } = axes();
const det = r[0] * v[1] - r[1] * v[0];
function pixelToEN(x: number, y: number, u: number): [number, number] {
  const a = x * CAMERA.mpp, b = -y * CAMERA.mpp - u * v[2];
  return [(a * v[1] - r[1] * b) / det, (r[0] * b - a * v[0]) / det];
}
const R = 6371000;
/** ellipsoid height -> ENU up at (e, n) (the inverse of enuHeight). */
const toU = (h: number, e: number, n: number) => h - (e * e + n * n) / (2 * R);

// ---- orthophoto cells ------------------------------------------------------------------------------
const cells = new Map<string, Promise<Buffer | null>>();
async function fetchCell(ce: number, cn: number): Promise<Buffer | null> {
  const f = join(cacheDir, `${ce}_${cn}.jpg`);
  if (!existsSync(f)) {
    const e0 = ce * CELL, n0 = cn * CELL;
    const url = `${src.url}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${src.layer}&STYLES=&SRS=EPSG:25832`
      + `&BBOX=${e0},${n0},${e0 + CELL},${n0 + CELL}&WIDTH=${CPX}&HEIGHT=${CPX}&FORMAT=image/jpeg`;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        const buf = Buffer.from(await res.arrayBuffer());
        if (!res.ok || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`${res.status} ${buf.subarray(0, 200).toString()}`);
        writeFileSync(f, buf);
        break;
      } catch (e) {
        if (attempt >= 3) { console.warn(`  cell ${ce}_${cn}: ${e}`); return null; }
      }
    }
  }
  return sharp(f).removeAlpha().raw().toBuffer();
}
const cell = (ce: number, cn: number) => {
  const k = `${ce}_${cn}`;
  if (!cells.has(k)) cells.set(k, fetchCell(ce, cn));
  return cells.get(k)!;
};

/** Bilinear sample of the orthophoto at UTM (east, north); null outside fetched cells. */
async function sample(east: number, north: number, out: Buffer, o: number) {
  const fx = east / RES - 0.5, fy = north / RES - 0.5; // pixel-centre coordinates (north up -> rows go down)
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  const acc = [0, 0, 0];
  for (const [dx, dy, w] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]]) {
    const px = x0 + dx, py = y0 + dy;
    const ce = Math.floor(px / CPX), cn = Math.floor(py / CPX);
    const buf = await cell(ce, cn);
    if (!buf) return;
    const ix = px - ce * CPX, iy = CPX - 1 - (py - cn * CPX);
    const s = (iy * CPX + ix) * 3;
    for (let c = 0; c < 3; c++) acc[c] += buf[s + c] * w;
  }
  for (let c = 0; c < 3; c++) out[o + c] = Math.round(acc[c]);
}

async function tile(tx: number, ty: number) {
  const hf = join(base, "height", `${tx}_${ty}.png`), of = join(outDir, `${tx}_${ty}.png`);
  if (!existsSync(hf)) return;
  if (existsSync(of) && !args.force) return;
  const h = await readHeights(hf);
  const out = Buffer.alloc(T * T * 3);
  // per height sample: visible surface height in ENU, and whether it is a wall
  const U = new Float32Array(HS * HS), wall = new Uint8Array(HS * HS);
  for (let sy = 0; sy < HS; sy++) for (let sx = 0; sx < HS; sx++) {
    const k = sy * HS + sx, hv = h[k];
    if (Number.isNaN(hv)) { U[k] = NaN; continue; }
    const [e, n] = pixelToEN((tx * T) + (sx + 0.5) * K, (ty * T) + (sy + 0.5) * K, hv);
    U[k] = toU(hv, e, n);
  }
  for (let sy = 0; sy < HS; sy++) for (let sx = 0; sx < HS; sx++) {
    const k = sy * HS + sx;
    if (Number.isNaN(U[k])) continue;
    // a wall drops ~1.41 m per sample down the screen; compare with the neighbours above and below
    const up = sy > 0 ? U[k - HS] : NaN, dn = sy < HS - 1 ? U[k + HS] : NaN;
    if (U[k] - dn > WALL && (Number.isNaN(up) || up - U[k] > WALL)) wall[k] = 1;
  }
  for (let y = 0; y < T; y++) {
    const sy = Math.min(HS - 1, Math.floor(y / K));
    for (let x = 0; x < T; x++) {
      const sx = Math.min(HS - 1, Math.floor(x / K)), k = sy * HS + sx, o = (y * T + x) * 3;
      if (Number.isNaN(U[k])) continue;
      if (wall[k]) { out[o] = out[o + 1] = out[o + 2] = WALL_GREY; continue; }
      const [e, n] = pixelToEN(tx * T + x + 0.5, ty * T + y + 0.5, U[k]);
      const [lat, lon] = enuToLlh([e, n, U[k]]);
      const [ue, un] = toUtm(lat, lon);
      await sample(ue, un, out, o);
    }
  }
  await sharp(out, { raw: { width: T, height: T, channels: 3 } }).png().toFile(of);
  console.log(`  ${tx}_${ty}`);
}

async function main() {
  const [lat, lon] = args.near!.split(",").map(Number);
  const [px, py] = llhToPixel(lat, lon, 300);
  const ci = Math.floor(px / STRIDE), cj = Math.floor(py / STRIDE), rad = Number(args.radius);
  const tiles = new Set<string>();
  for (let j = cj - rad; j <= cj + rad; j++) for (let i = ci - rad; i <= ci + rad; i++)
    for (let ty = Math.floor(j * STRIDE / T); ty <= Math.floor((j * STRIDE + WIN - 1) / T); ty++)
      for (let tx = Math.floor(i * STRIDE / T); tx <= Math.floor((i * STRIDE + WIN - 1) / T); tx++) tiles.add(`${tx}_${ty}`);
  console.log(`aerial (${args.source}): ${tiles.size} tiles around window ${ci}_${cj}`);
  for (const k of tiles) { const [tx, ty] = k.split("_").map(Number); await tile(tx, ty); }
}

main();
