/**
 * A region's published state (what export last built and publish uploaded: every tile's source stamp and
 * content hash) lives on R2 next to the region, regions/<region>/state.json, as well as locally in
 * data/web-state/<region>.json. publish uploads it; export and publish download it when this machine has
 * none, so any maintainer (or a copy of the region's folder from another bucket) carries it along.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTING } from "./hosting.ts";
import { WEB_STATE } from "./paths.ts";

/** key under regions/<region>/ */
export const STATE_REL = "state.json";
/** the state is rewritten in place at every publish: never served from a cache */
export const STATE_CACHE = "no-cache";
export const stateHash = (s: string | Buffer) => createHash("sha1").update(s).digest("hex").slice(0, 16);
export const publishedStateFile = (region: string) => join(WEB_STATE, `${region}.json`);

/** The published state on R2 as text, or null when none has been uploaded yet. */
export async function remoteState(region: string): Promise<string | null> {
  const url = `${HOSTING.origin}/regions/${region}/${STATE_REL}?t=${Date.now()}`;
  const r = await fetch(url, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(300_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** Download the published state from R2 when this machine has none (true: downloaded). */
export async function fetchPublishedState(region: string): Promise<boolean> {
  const f = publishedStateFile(region);
  if (existsSync(f)) return false;
  const text = await remoteState(region);
  if (text === null) return false;
  mkdirSync(WEB_STATE, { recursive: true });
  writeFileSync(f, text);
  return true;
}
