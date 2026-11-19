/** Sea level and the renderer's height pass (one 256² PNG per render tile). */
import { existsSync } from "node:fs";
import sharp from "sharp";
import { activeRegion, llhToPixel } from "./camera.ts";
import { REGIONS } from "./places.ts";

/** Ellipsoid height of mean sea level in the active region (geoid undulation, EGM2008). */
export const seaH = () => REGIONS[activeRegion()].geoidM;

/** Ellipsoid height the height pass counts from (see Region.heightBase). */
export const heightBase = (region = activeRegion()) => REGIONS[region].heightBase ?? 0;

/** Decode a height PNG (ellipsoid height in cm above heightBase - 100 m, R<<8|G; alpha 0 = nothing rendered). */
export async function readHeights(file: string) {
  const buf = await sharp(file).ensureAlpha().raw().toBuffer();
  const n = buf.length / 4, h = new Float32Array(n), base = heightBase() - 100;
  for (let i = 0; i < n; i++) h[i] = buf[i * 4 + 3] ? (buf[i * 4] * 256 + buf[i * 4 + 1]) / 100 + base : NaN;
  return h;
}

/**
 * Art pixel of a ground point. llhToPixel needs the point's height, which varies by ~200 m across a region
 * (Stuttgart: Kessel ~300 m, airport ~440 m ellipsoidal; 100 m is ~280 px): start at the region's typical
 * ground, then re-project at the lowest surface the height pass shows within ±32 px, until it settles.
 */
export async function groundPixel(heightDir: string, lat: number, lon: number): Promise<[number, number]> {
  let p = llhToPixel(lat, lon, REGIONS[activeRegion()].groundH);
  for (let it = 0; it < 5; it++) {
    let low = Infinity;
    for (let dy = -32; dy <= 32; dy += 4) for (let dx = -32; dx <= 32; dx += 4) {
      const x = p[0] + dx, y = p[1] + dy, tx = Math.floor(x / 1024), ty = Math.floor(y / 1024);
      const f = `${heightDir}/${tx}_${ty}.png`;
      if (!existsSync(f)) continue;
      const v = (await cachedHeights(f))[Math.floor((y - ty * 1024) / 4) * 256 + Math.floor((x - tx * 1024) / 4)];
      if (!Number.isNaN(v)) low = Math.min(low, v);
    }
    if (low === Infinity) break;
    const q = llhToPixel(lat, lon, low);
    const moved = Math.hypot(q[0] - p[0], q[1] - p[1]);
    p = q;
    if (moved < 1) break;
  }
  return p;
}
const heightFiles = new Map<string, Promise<Float32Array>>();
const cachedHeights = (f: string) => { if (!heightFiles.has(f)) heightFiles.set(f, readHeights(f)); return heightFiles.get(f)!; };
