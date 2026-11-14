/** Sea level and the renderer's height pass (one 256² PNG per render tile). */
import sharp from "sharp";
import { activeRegion } from "./camera.ts";
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
