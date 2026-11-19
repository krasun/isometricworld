/**
 * Publish a region's exported files to R2 and empty the local cache.
 *
 *   npm run publish -- israel-center [--yes] [--keep]
 *   npm run publish -- israel-center --state-only [--yes]   # upload only data/web-state/<region>.json
 *
 * Uploads everything in data/web/regions/<region>/ (only what `npm run export` changed) to the
 * bucket in hosting.ts: tiles first, then previews and the content-hashed data files, then the export's
 * state (regions/<region>/state.json, webstate.ts), world.json last (it names the current files, so the
 * live site never points at one that is not there yet). Each upload is checked (stored size = local size);
 * then the export's state becomes the published state (data/web-state/<region>.json) and the cache is
 * deleted (--keep: leave it).
 *
 * Rate: the Cloudflare REST API allows ~4 uploads/s, so a full region (~9k files) takes ~40 min the
 * first time; later publishes only carry what changed.
 *
 * Auth: CLOUDFLARE_API_TOKEN (R2 write) if set, else the wrangler login (`npx wrangler login`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { HOSTING } from "./hosting.ts";
import { WEB_CACHE, WEB_STATE } from "./paths.ts";
import { REGIONS } from "./places.ts";
import { STATE_CACHE, STATE_REL, publishedStateFile, remoteState, stateHash } from "./webstate.ts";

const args = process.argv.slice(2);
const region = args.find((a) => !a.startsWith("--")) ?? "israel-center";
if (!REGIONS[region]) throw new Error(`unknown region ${region}`);
const dir = join(WEB_CACHE, "regions", region), pending = join(WEB_CACHE, `${region}.state.json`);
const STATE_ONLY = args.includes("--state-only");
if (STATE_ONLY && !existsSync(publishedStateFile(region))) { console.log(`nothing to upload: no ${publishedStateFile(region)}`); process.exit(0); }
if (!STATE_ONLY && !existsSync(dir)) { console.log(`nothing to publish: ${dir} is empty (run npm run export first)`); process.exit(0); }

async function confirm(question = "publish? [y/N] ") {
  if (args.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ok = /^y(es)?$/i.test((await rl.question(question)).trim());
  rl.close();
  return ok;
}

const rank = (f: string) => (f.startsWith("tiles/") ? 0 : f.endsWith("world.json") ? 2 : 1);
const files = STATE_ONLY ? [] : readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(avif|webp|json)$/.test(f))
  .sort((a, b) => rank(a) - rank(b));
const bytes = files.reduce((s, f) => s + statSync(join(dir, f)).size, 0);
const tiles = files.filter((f) => f.startsWith("tiles/")).length;
// someone else published this region since this export (or this machine's state) was made: their tiles would
// be overwritten with stale ones and their state lost
const remote = await remoteState(region);
const startedFrom = STATE_ONLY ? stateHash(readFileSync(publishedStateFile(region)))
  : existsSync(pending) ? (JSON.parse(readFileSync(pending, "utf8")).base ?? null) : undefined;
if (remote !== null && startedFrom !== undefined && stateHash(remote) !== startedFrom) {
  console.error(`${region}: R2 has a newer published state than ${STATE_ONLY ? publishedStateFile(region) : "this export started from"} (someone published since).
  Move ${publishedStateFile(region)} and data/web/${region}* aside, export again (it downloads R2's state), then publish.`);
  process.exit(1);
}
if (!STATE_ONLY) {
  console.log(`${region}: ${tiles} tiles + ${files.length - tiles} data files, ${(bytes / 1e6).toFixed(1)} MB → r2://${HOSTING.bucket}/regions/${region}/ (${HOSTING.origin})`);
  if (!(await confirm())) process.exit(1);
}

let token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const refresh = () => { // the wrangler OAuth token lasts ~1 h; wrangler refreshes it on demand
  token = execFileSync("npx", ["-y", "wrangler@4", "auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1)!;
};
if (!token) refresh();

// The Cloudflare API allows ~1200 requests / 5 min per user: pace uploads at ~3.8/s, back off on 429.
const RATE = 3.8;
let nextSlot = Date.now();
const slot = async () => { const t = Math.max(Date.now(), nextSlot); nextSlot = t + 1000 / RATE; await new Promise((r) => setTimeout(r, t - Date.now())); };

const TYPES: Record<string, string> = { avif: "image/avif", webp: "image/webp", json: "application/json" };
const api = `https://api.cloudflare.com/client/v4/accounts/${HOSTING.accountId}/r2/buckets/${HOSTING.bucket}/objects/`;
async function put(rel: string, body: Buffer<ArrayBuffer> = readFileSync(join(dir, rel)), cache?: string) {
  const key = `regions/${region}/${rel}`;
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    ...(HOSTING.jurisdiction ? { "cf-r2-jurisdiction": HOSTING.jurisdiction } : {}),
    "Content-Type": TYPES[rel.split(".").pop()!],
    // world.json is the one name that is reused; tiles carry ?v=<hash>, everything else has it in its name
    "Cache-Control": cache ?? (rel.endsWith("world.json") ? HOSTING.cacheData : HOSTING.cacheTiles),
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await slot();
      const r = await fetch(api + key, { method: "PUT", headers: headers(), body });
      if (r.status === 429) { nextSlot = Date.now() + 30_000; throw new Error("429 rate limited"); }
      if (r.status === 401 || r.status === 403) { if (!process.env.CLOUDFLARE_API_TOKEN) refresh(); throw new Error(`auth ${r.status}`); }
      const j = (await r.json()) as { success: boolean; result?: { size: string | number }; errors?: unknown[] };
      if (!r.ok || !j.success) throw new Error(`${r.status} ${JSON.stringify(j.errors)}`);
      if (Number(j.result!.size) !== body.length) throw new Error(`stored ${j.result!.size} bytes, local ${body.length}`);
      return;
    } catch (e) {
      if (attempt >= 8) throw new Error(`${key}: ${(e as Error).message}`);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

if (STATE_ONLY) await stateOnly();

/** --state-only: upload this machine's published state (a region published before states went to R2). */
async function stateOnly(): Promise<never> {
  const body = readFileSync(publishedStateFile(region));
  console.log(`${region}: ${publishedStateFile(region)} (${(body.length / 1e6).toFixed(1)} MB) → r2://${HOSTING.bucket}/regions/${region}/${STATE_REL}`);
  if (!(await confirm("upload? [y/N] "))) process.exit(1);
  await put(STATE_REL, body, STATE_CACHE);
  console.log("  uploaded and checked");
  process.exit(0);
}

// tiles and previews in parallel, then the data files in order (the state, then world.json last)
const t0 = Date.now();
let done = 0;
const tileFiles = files.filter((f) => !f.startsWith("data/")), dataFiles = files.filter((f) => f.startsWith("data/")); // world.json sorts last
const queue = [...tileFiles];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let f = queue.shift(); f; f = queue.shift()) {
    await put(f);
    if (++done % 200 === 0) process.stdout.write(`\r  ${done}/${files.length} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}));
// the export's state goes up before world.json makes this publish live: the next export, here or on another
// machine, starts from it
const finalState = existsSync(pending) ? readFileSync(pending) : null;
for (const f of dataFiles.filter((f) => !f.endsWith("world.json"))) { await put(f); done++; }
if (finalState) await put(STATE_REL, finalState, STATE_CACHE);
for (const f of dataFiles.filter((f) => f.endsWith("world.json"))) { await put(f); done++; }
console.log(`\r  ${done}/${files.length} uploaded and checked in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// spot check through the public domain (what the site loads)
const probe = dataFiles.find((f) => f.endsWith("world.json")) ?? tileFiles[0];
const r = await fetch(`${HOSTING.origin}/regions/${region}/${probe}?check=${Date.now()}`);
if (!r.ok) throw new Error(`${HOSTING.origin}/regions/${region}/${probe}: ${r.status} (uploaded, cache kept)`);
console.log(`  ${HOSTING.origin}/regions/${region}/${probe}: ${r.status}`);

mkdirSync(WEB_STATE, { recursive: true });
if (finalState) renameSync(pending, publishedStateFile(region));
if (!args.includes("--keep")) { rmSync(dir, { recursive: true, force: true }); console.log(`  cache emptied: ${dir}`); }
