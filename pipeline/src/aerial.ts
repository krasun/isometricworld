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
 * Also writes data/derived/<area>/mask/<tx>_<ty>.png (255 = keep the render: streets, rails, squares, water,
 * bridge decks; from ground/features.json), which paint.ts --aerial-input uses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { CAMERA, axes, enuToLlh } from "./camera.ts";
import { groundPixel, readHeights } from "./heights.ts";
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
/** data mask (render wins): independent of the photo source */
const maskDir = join(base, "mask");
mkdirSync(outDir, { recursive: true });
mkdirSync(maskDir, { recursive: true });
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

// ---- data mask: where the render's OSM geometry beats the photo --------------------------------------
// Streets, rails, squares and water are exact in the render (OSM) but blurred in the photo by trees, shadows,
// market stalls and lean; tunnel portals and bus loops vanish. These pixels keep the render in the paint input.
type P2 = [number, number];
interface Feature { k: string; r?: P2[][]; l?: P2[]; w?: number; b?: 1 }
const MASK_RES = 0.25; // m per mask pixel
const ELEVATED = 2.5;  // m above the terrain: a roof or a tree crown, not the street surface
/** stroke width (m) of a line feature in the mask: the renderer's road plus kerbs and pavements */
const LINE_W: Record<string, (w: number) => number> = {
  street: (w) => w + 6, highway: (w) => w + 2, lane: (w) => w + 2, plaza: (w) => w + 1, rail: () => 4,
};
/** area kinds the render draws exactly: paved squares, water */
const AREA_KINDS = new Set(["paving", "water", "pool"]);
const groundDir = join(base, "ground");
const gmeta = JSON.parse(readFileSync(join(groundDir, "meta.json"), "utf8"));
const gb = readFileSync(join(groundDir, "height.bin"));
const terrain = new Float32Array(gb.buffer, gb.byteOffset, gb.byteLength / 4);
function terrainAt(x: number, y: number) {
  const fx = Math.min(gmeta.nx - 1.001, Math.max(0, (x - gmeta.x0) / gmeta.step));
  const fy = Math.min(gmeta.ny - 1.001, Math.max(0, (y - gmeta.y0) / gmeta.step));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * gmeta.nx + ix;
  return (terrain[i] * (1 - ax) + terrain[i + 1] * ax) * (1 - ay) + (terrain[i + gmeta.nx] * (1 - ax) + terrain[i + gmeta.nx + 1] * ax) * ay;
}
const maskFeatures = (JSON.parse(readFileSync(join(groundDir, "features.json"), "utf8")) as Feature[])
  .filter((f) => (f.l && LINE_W[f.k]) || (f.r && AREA_KINDS.has(f.k)))
  .map((f) => {
    const pts = f.l ?? f.r!.flat();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { f, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
const svgPath = (pts: P2[], close: boolean) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join("") + (close ? "Z" : "");
/** Rasterise features into an ENU-aligned grey mask over [e0,n0]-[e1,n1]; bridges: only bridge decks, else only ground features. */
async function rasterMask(e0: number, n0: number, e1: number, n1: number, bridges: boolean) {
  const W = Math.ceil((e1 - e0) / MASK_RES), H = Math.ceil((n1 - n0) / MASK_RES);
  const parts: string[] = [];
  for (const { f, bb } of maskFeatures) {
    if (!!f.b !== bridges || bb[2] < e0 - 30 || bb[0] > e1 + 30 || bb[3] < n0 - 30 || bb[1] > n1 + 30) continue;
    if (f.l) parts.push(`<path d="${svgPath(f.l, false)}" fill="none" stroke="#fff" stroke-width="${LINE_W[f.k](f.w ?? 0)}"/>`);
    else parts.push(`<path d="${f.r!.map((r) => svgPath(r, true)).join("")}" fill="#fff" fill-rule="evenodd"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}"/>`
    + `<g transform="scale(${1 / MASK_RES},${-1 / MASK_RES}) translate(${-e0},${-n1})" stroke-linecap="round" stroke-linejoin="round">${parts.join("")}</g></svg>`;
  return { W, H, px: await sharp(Buffer.from(svg)).removeAlpha().extractChannel(0).raw().toBuffer() };
}

async function tile(tx: number, ty: number) {
  const hf = join(base, "height", `${tx}_${ty}.png`), of = join(outDir, `${tx}_${ty}.png`), mf = join(maskDir, `${tx}_${ty}.png`);
  if (!existsSync(hf)) return;
  const doPhoto = !existsSync(of) || args.force, doMask = !existsSync(mf) || args.force;
  if (!doPhoto && !doMask) return;
  const h = await readHeights(hf);
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
  // ground point (ENU east/north) of every visible non-wall pixel
  const E = new Float32Array(T * T).fill(NaN), N = new Float32Array(T * T);
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (let y = 0; y < T; y++) {
    const sy = Math.min(HS - 1, Math.floor(y / K));
    for (let x = 0; x < T; x++) {
      const sx = Math.min(HS - 1, Math.floor(x / K)), k = sy * HS + sx, p = y * T + x;
      if (Number.isNaN(U[k]) || wall[k]) continue;
      const [e, n] = pixelToEN(tx * T + x + 0.5, ty * T + y + 0.5, U[k]);
      E[p] = e; N[p] = n;
      e0 = Math.min(e0, e); n0 = Math.min(n0, n); e1 = Math.max(e1, e); n1 = Math.max(n1, n);
    }
  }
  if (doPhoto) {
    const out = Buffer.alloc(T * T * 3);
    for (let y = 0; y < T; y++) {
      const sy = Math.min(HS - 1, Math.floor(y / K));
      for (let x = 0; x < T; x++) {
        const sx = Math.min(HS - 1, Math.floor(x / K)), k = sy * HS + sx, p = y * T + x, o = p * 3;
        if (Number.isNaN(U[k])) continue;
        if (wall[k]) { out[o] = out[o + 1] = out[o + 2] = WALL_GREY; continue; }
        const [lat, lon] = enuToLlh([E[p], N[p], U[k]]);
        const [ue, un] = toUtm(lat, lon);
        await sample(ue, un, out, o);
      }
    }
    await sharp(out, { raw: { width: T, height: T, channels: 3 } }).png().toFile(of);
  }
  if (doMask) {
    const mask = Buffer.alloc(T * T);
    if (e0 < e1) {
      const [g, b] = await Promise.all([rasterMask(e0, n0, e1, n1, false), rasterMask(e0, n0, e1, n1, true)]);
      for (let y = 0; y < T; y++) {
        const sy = Math.min(HS - 1, Math.floor(y / K));
        for (let x = 0; x < T; x++) {
          const p = y * T + x;
          if (Number.isNaN(E[p])) continue;
          const mx = Math.floor((E[p] - e0) / MASK_RES), my = Math.floor((n1 - N[p]) / MASK_RES);
          if (mx < 0 || my < 0 || mx >= g.W || my >= g.H) continue;
          const q = my * g.W + mx;
          const elevated = U[Math.min(HS - 1, Math.floor(x / K)) + sy * HS] - terrainAt(E[p], N[p]) > ELEVATED;
          if (b.px[q] > 127 || (g.px[q] > 127 && !elevated)) mask[p] = 255;
        }
      }
    }
    await sharp(mask, { raw: { width: T, height: T, channels: 1 } }).png().toFile(mf);
  }
  console.log(`  ${tx}_${ty}${doPhoto ? " photo" : ""}${doMask ? " mask" : ""}`);
}

async function main() {
  const [lat, lon] = args.near!.split(",").map(Number);
  const [px, py] = await groundPixel(join(base, "height"), lat, lon);
  const ci = Math.floor(px / STRIDE), cj = Math.floor(py / STRIDE), rad = Number(args.radius);
  const tiles = new Set<string>();
  for (let j = cj - rad; j <= cj + rad; j++) for (let i = ci - rad; i <= ci + rad; i++)
    for (let ty = Math.floor(j * STRIDE / T); ty <= Math.floor((j * STRIDE + WIN - 1) / T); ty++)
      for (let tx = Math.floor(i * STRIDE / T); tx <= Math.floor((i * STRIDE + WIN - 1) / T); tx++) tiles.add(`${tx}_${ty}`);
  console.log(`aerial (${args.source}): ${tiles.size} tiles around window ${ci}_${cj}`);
  for (const k of tiles) { const [tx, ty] = k.split("_").map(Number); await tile(tx, ty); }
}

main();
