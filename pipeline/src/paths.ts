import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PIPELINE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(PIPELINE, "..");
export const DATA = join(ROOT, "data");
export const RAW = join(DATA, "raw");
export const DERIVED = join(DATA, "derived");
/** Built map data waiting to be published (served by the dev server over production); emptied by publish. */
export const WEB_CACHE = process.env.WEB_CACHE || join(DATA, "web"); // override: test exports elsewhere
/** What is published per region: tile sources + content hashes (lets export rebuild only changes). */
export const WEB_STATE = join(DATA, "web-state");
// optional local settings (.env at the repo root, never committed; see .env.example)
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
/** Chromium/Chrome for the renderer and the test scripts, and its launch flags (GPU backend etc.). */
export const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
/** The running site the test/film scripts open: their URL argument, else SITE_URL (e.g. the dev server). */
export function siteUrl(arg?: string): string {
  const url = arg || process.env.SITE_URL;
  if (!url) throw new Error("pass the site URL (the dev server prints it: http://localhost:<port>/) or set SITE_URL in .env");
  return url;
}
export const CHROME_ARGS = (process.env.CHROME_ARGS || "--enable-gpu").split(/\s+/).filter(Boolean);

export function loadEnv(): Record<string, string> {
  const file = join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
  return process.env as Record<string, string>;
}

export const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8"));

/** Write a sharp image so readers never see a half-written file (other jobs read tiles while we paint). */
export async function writeAtomic(img: import("sharp").Sharp, file: string) {
  await img.toFile(`${file}.tmp`);
  (await import("node:fs")).renameSync(`${file}.tmp`, file);
}
