/**
 * The archive: every file the pipeline fetched or made (data/derived, data/raw) in a private R2 bucket, so no
 * machine is the only copy of the paintings, and a later repaint downloads and uploads only the part it touches.
 *
 *   npm run archive -- zagreb                        # upload what is new or changed for the region
 *   npm run archive -- shared                        # the rest of data/raw (DEM, city-wide source files)
 *   npm run archive -- --tar <url> [--sha256 <hex>]  # stream a tar of data/… (a contributor's backup) into it
 *   npm run archive -- zagreb --verify [--sample 40] # every entry's object is there with its size; N downloaded + hashed
 *   npm run pull -- zagreb                           # the region's small files: manifests, ground, height, scene, raw…
 *   npm run pull -- zagreb --near 45.81,15.97 --radius 1   # + renders, paintings, windows for a patch (paint --near)
 *   npm run pull -- zagreb --all                     # everything (not the history: windows-replaced, paint-withdrawn,
 *                                                    # work; --history adds it)
 *
 * Layout, content-addressed: objects/<sha256> (objects/<sha256>.gz over 90 MB through the REST API; each distinct file once: hard links and windows shared between
 * areas cost nothing), manifests/<unit>.json = { "<path under data/>": [sha256, size, mtimeMs] } and a dated copy
 * of it per upload in manifests/<unit>/. Nothing is ever deleted: a changed file adds an object, the old one stays.
 * Units: one per region (derived/<area>/ and raw/<area>/ of its areas, raw/boundaries/<region>.json) and "shared".
 *
 * Pull checks every file's hash, never overwrites a local file that differs from the archive (--force does) and
 * restores mtimes (paint.ts and export.ts compare them). The patch of `--near … --radius r` is what
 * `paint --near … --radius r` repaints plus two rings: the neighbours it continues and every window under its tiles.
 *
 * Bucket: ARCHIVE_BUCKET (default isometricworld-archive, Infrequent Access), same account. Auth as publish.ts:
 * R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (S3 API, 16 at a time), else CLOUDFLARE_API_TOKEN or the wrangler login
 * (REST API, ~4 requests/s).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { AREAS, openArea } from "./areas.ts";
import { llhToPixel } from "./camera.ts";
import { HOSTING } from "./hosting.ts";
import { DATA } from "./paths.ts";
import { REGIONS } from "./places.ts";
import { s3Fetch, s3Keys } from "./r2s3.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tar: { type: "string" }, sha256: { type: "string" },
    verify: { type: "boolean", default: false }, sample: { type: "string", default: "40" },
    near: { type: "string" }, radius: { type: "string", default: "1" },
    all: { type: "boolean", default: false }, history: { type: "boolean", default: false },
    force: { type: "boolean", default: false }, dry: { type: "boolean", default: false },
  },
});

// ---------------------------------------------------------------------------------------------- the bucket
const BUCKET = { name: process.env.ARCHIVE_BUCKET || "isometricworld-archive", jurisdiction: process.env.ARCHIVE_JURISDICTION || "" };
const S3 = s3Keys() !== null;
let token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const refresh = () => { // the wrangler OAuth token lasts ~1 h; wrangler refreshes it on demand
  token = execFileSync("npx", ["-y", "wrangler@4", "auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1)!;
};
if (!S3 && !token) refresh();
const RATE = S3 ? Infinity : 3.8; // the Cloudflare API allows ~1200 requests / 5 min per user
let nextSlot = Date.now();
const slot = async () => { const t = Math.max(Date.now(), nextSlot); nextSlot = t + 1000 / RATE; await new Promise((r) => setTimeout(r, t - Date.now())); };
const api = () => `https://api.cloudflare.com/client/v4/accounts/${HOSTING.accountId}/r2/buckets/${BUCKET.name}/objects`;
const restHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...(BUCKET.jurisdiction ? { "cf-r2-jurisdiction": BUCKET.jurisdiction } : {}) });

async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { await slot(); return await fn(); } catch (e) {
      if (attempt >= 8) throw new Error(`${what}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
async function check(r: Response) {
  if (r.status === 429) { nextSlot = Date.now() + 30_000; throw new Error("429 rate limited"); }
  if ((r.status === 401 || r.status === 403) && !S3) { if (!process.env.CLOUDFLARE_API_TOKEN) refresh(); throw new Error(`auth ${r.status}`); }
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

/** Upload and check (stored size / ETag). */
async function put(key: string, body: Buffer<ArrayBuffer>, type = "application/octet-stream") {
  await retry(key, async () => {
    if (S3) {
      const r = await check(await s3Fetch("PUT", key, body, { "Content-Type": type }, BUCKET));
      const md5 = createHash("md5").update(body).digest("hex");
      if (r.headers.get("etag")?.replace(/"/g, "") !== md5) throw new Error("ETag ≠ local MD5");
      return;
    }
    const r = await check(await fetch(`${api()}/${key}`, { method: "PUT", headers: { ...restHeaders(), "Content-Type": type }, body }));
    const j = (await r.json()) as { success: boolean; result?: { size: string | number } };
    if (!j.success || Number(j.result!.size) !== body.length) throw new Error(`stored ${j.result?.size} bytes, local ${body.length}`);
  });
}
/** Download, or null when the key is not there. */
async function get(key: string): Promise<Buffer | null> {
  return retry(key, async () => {
    const r = S3 ? await s3Fetch("GET", key, undefined, {}, BUCKET) : await fetch(`${api()}/${key}`, { headers: restHeaders() });
    if (r.status === 404) return null;
    await check(r);
    return Buffer.from(await r.arrayBuffer());
  });
}
/** Every key under a prefix with its size. */
async function list(prefix: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor = "";
  do {
    await retry(`list ${prefix}`, async () => {
      if (S3) {
        const r = await check(await s3Fetch("GET", "", undefined, {}, BUCKET,
          { "list-type": "2", prefix, "max-keys": "1000", ...(cursor ? { "continuation-token": cursor } : {}) }));
        const xml = await r.text();
        for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) out.set(m[1], Number(m[2]));
        cursor = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]+)</)?.[1] ?? "") : "";
        return;
      }
      const q = new URLSearchParams({ prefix, per_page: "1000", ...(cursor ? { cursor } : {}) });
      const r = await check(await fetch(`${api()}?${q}`, { headers: restHeaders() }));
      const j = (await r.json()) as { result: Array<{ key: string; size: number }>; result_info?: { cursor?: string; is_truncated?: boolean | string } };
      for (const o of j.result) out.set(o.key, Number(o.size));
      const t = j.result_info?.is_truncated;
      cursor = t === true || t === "true" ? (j.result_info?.cursor ?? "") : "";
    });
  } while (cursor);
  return out;
}

// ------------------------------------------------------------------------------------------- manifests
type Entry = [sha256: string, size: number, mtimeMs: number];
type Manifest = Record<string, Entry>;
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const objectKey = (sha: string) => `objects/${sha}`;
/** The REST API takes at most ~100 MB per request: bigger files (a city-wide GeoJSON) go up gzipped, as objects/<sha>.gz */
const GZIP_OVER = 90e6;
const stored = (have: Map<string, number>, sha: string, size: number) => have.get(objectKey(sha)) === size || have.has(`${objectKey(sha)}.gz`);
async function putContent(sha: string, body: Buffer<ArrayBuffer>) {
  if (body.length > GZIP_OVER && !S3) await put(`${objectKey(sha)}.gz`, gzipSync(body, { level: 9 }) as Buffer<ArrayBuffer>, "application/gzip");
  else await put(objectKey(sha), body);
}
async function getContent(sha: string): Promise<Buffer | null> {
  const b = await get(objectKey(sha));
  if (b) return b;
  const z = await get(`${objectKey(sha)}.gz`);
  return z ? gunzipSync(z) : null;
}
async function getManifest(unit: string): Promise<Manifest> {
  const b = await get(`manifests/${unit}.json`);
  return b ? JSON.parse(b.toString("utf8")) : {};
}
/** Merge `entries` into the unit's manifest in the bucket (read just before: another upload may have added some). */
async function saveManifest(unit: string, entries: Manifest, dated = false) {
  if (!Object.keys(entries).length) return;
  const merged = { ...(await getManifest(unit)), ...entries };
  const body = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)))));
  await put(`manifests/${unit}.json`, body, "application/json");
  if (dated) await put(`manifests/${unit}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, body, "application/json");
}

/** The unit a path under data/ belongs to, or null (not archived). */
function unitOf(rel: string): string | null {
  const p = rel.split("/");
  if (p.at(-1)!.endsWith(".tmp") || p.at(-1) === ".DS_Store") return null;
  if (p[0] === "derived") return AREAS[p[1]]?.region ?? null;
  if (p[0] === "raw") {
    if (AREAS[p[1]]) return AREAS[p[1]].region;
    if (p[1] === "boundaries" && p.length === 3) return p[2].replace(/\.json$/, "");
    return "shared";
  }
  return null;
}
const UNITS = new Set([...Object.keys(REGIONS), "shared"]);
const posix = (p: string) => p.split(sep).join("/");
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
    .map((d) => posix(relative(DATA, join(d.parentPath, d.name))));
}
function localFiles(unit: string): string[] {
  const roots = unit === "shared" ? [join(DATA, "raw")]
    : Object.entries(AREAS).filter(([, a]) => a.region === unit).flatMap(([n]) => [join(DATA, "derived", n), join(DATA, "raw", n)])
      .concat(join(DATA, "raw", "boundaries"));
  return [...new Set(roots.flatMap(walk))].filter((rel) => unitOf(rel) === unit).sort();
}

/** Local hash cache: path -> [mtimeMs, size, sha256] (hashing 30 GB again for every upload would take minutes). */
const INDEX = join(DATA, "archive-index.json");
const index: Record<string, [number, number, string]> = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : {};
let indexDirty = 0;
function saveIndex(force = false) {
  if (!indexDirty || (!force && indexDirty < 500)) return;
  writeFileSync(`${INDEX}.tmp`, JSON.stringify(index));
  renameSync(`${INDEX}.tmp`, INDEX);
  indexDirty = 0;
}
function hashLocal(rel: string, body?: Buffer): Entry {
  const st = statSync(join(DATA, rel)), c = index[rel];
  if (c && c[0] === st.mtimeMs && c[1] === st.size && !body) return [c[2], st.size, st.mtimeMs];
  const h = sha256(body ?? readFileSync(join(DATA, rel)));
  index[rel] = [st.mtimeMs, st.size, h];
  indexDirty++;
  return [h, st.size, st.mtimeMs];
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let t = q.shift(); t !== undefined; t = q.shift()) await fn(t); }));
}
const MB = (b: number) => `${(b / 1e6).toFixed(0)} MB`;
let objects: Map<string, number> | null = null; // what the bucket has (listed once per run)
async function haveObjects() { return (objects ??= await list("objects/")); }

// ---------------------------------------------------------------------------------------------- upload
async function push(unit: string) {
  const files = localFiles(unit);
  const have = await haveObjects(), remote = await getManifest(unit);
  const pending: Manifest = {};
  let uploaded = 0, bytes = 0, same = 0, done = 0, lastSave = Date.now();
  const t0 = Date.now(), failed: string[] = [];
  console.log(`${unit}: ${files.length} local files, ${Object.keys(remote).length} in the archive's manifest`);
  await pool(files, S3 ? 16 : 8, async (rel) => {
    const e = hashLocal(rel);
    const r = remote[rel];
    if (r && r[0] === e[0] && stored(have, e[0], e[1])) { same++; done++; return; }
    if (!stored(have, e[0], e[1])) {
      if (args.dry) { uploaded++; bytes += e[1]; done++; return; }
      const body = readFileSync(join(DATA, rel));
      if (sha256(body) !== e[0]) { failed.push(`${rel}: changed while uploading`); return; }
      try { await putContent(e[0], body); } catch (err) { failed.push((err as Error).message); return; }
      have.set(objectKey(e[0]), e[1]);
      uploaded++; bytes += e[1];
    }
    pending[rel] = e;
    if (++done % 100 === 0) process.stdout.write(`\r  ${done}/${files.length} · ${uploaded} uploaded (${MB(bytes)}) · ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
    saveIndex();
    if (Date.now() - lastSave > 120_000 && !args.dry) { // checkpoint: a stopped upload resumes (objects already there are skipped)
      lastSave = Date.now();
      const batch = { ...pending };
      await saveManifest(unit, batch);
    }
  });
  saveIndex(true);
  if (args.dry) return console.log(`\n  dry run: ${uploaded} files (${MB(bytes)}) to upload, ${same} unchanged`);
  await saveManifest(unit, pending, true);
  console.log(`\n  ${unit}: ${uploaded} uploaded (${MB(bytes)}), ${Object.keys(pending).length} manifest entries updated, ${same} unchanged`);
  if (failed.length) { process.exitCode = 1; console.error(`  ${failed.length} not uploaded (run again):\n    ${failed.slice(0, 20).join("\n    ")}`); }
}

// -------------------------------------------------------------------------------------- tar into archive
/** Bytes of a URL in order, resuming with Range after a dropped connection; hashes everything it reads. */
class Stream {
  pos = 0; total = -1; hash = createHash("sha256");
  private chunks: Buffer[] = []; private buffered = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  constructor(private url: string) {}
  private async open() {
    const r = await fetch(this.url, { headers: this.pos ? { Range: `bytes=${this.pos}-` } : {} });
    if (this.pos ? r.status !== 206 : !r.ok) throw new Error(`${this.url}: HTTP ${r.status}`);
    if (this.total < 0) this.total = Number(r.headers.get("content-length") ?? -1);
    this.reader = r.body!.getReader();
  }
  async read(n: number): Promise<Buffer> {
    let failures = 0;
    while (this.buffered < n) {
      try {
        if (!this.reader) await this.open();
        const { done, value } = await this.reader!.read();
        if (done) {
          this.reader = null;
          if (this.total >= 0 && this.pos >= this.total) throw Object.assign(new Error("unexpected end of tar"), { fatal: true });
          continue; // ended early: reopen at pos
        }
        const b = Buffer.from(value);
        this.chunks.push(b); this.buffered += b.length; this.pos += b.length; this.hash.update(b);
        failures = 0;
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal || ++failures > 20) throw e;
        this.reader = null;
        console.warn(`\n  connection dropped at ${MB(this.pos)} (${(e as Error).message}), resuming`);
        await new Promise((r) => setTimeout(r, 3000 * failures));
      }
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    this.chunks = all.length > n ? [all.subarray(n)] : []; this.buffered = all.length - n;
    return out;
  }
}

async function ingestTar(url: string, expect?: string) {
  const s = new Stream(url), have = await haveObjects();
  const pending = new Map<string, Manifest>(); // unit -> entries
  const seen = new Map<string, Entry>(); // tar path -> entry (hard links point back to it)
  const str = (b: Buffer) => { const z = b.indexOf(0); return (z < 0 ? b : b.subarray(0, z)).toString("utf8"); };
  const num = (b: Buffer) => (b[0] & 0x80 ? b.subarray(1).reduce((v, x) => v * 256 + x, 0) : parseInt(str(b).trim() || "0", 8));
  let longName: string | null = null, longLink: string | null = null, files = 0, uploaded = 0, bytes = 0, skipped = 0;
  let inflight: Promise<void>[] = [], lastSave = Date.now();
  const t0 = Date.now();
  const record = (rel: string, e: Entry) => {
    const unit = unitOf(rel);
    if (!unit) { skipped++; return; }
    if (!pending.has(unit)) pending.set(unit, {});
    pending.get(unit)![rel] = e;
  };
  const flush = async (dated = false) => { for (const [unit, m] of pending) await saveManifest(unit, m, dated); };
  for (;;) {
    const h = await s.read(512);
    if (h.every((b) => b === 0)) break; // end of archive
    const type = String.fromCharCode(h[156] || 48), size = num(h.subarray(124, 136)), mtime = num(h.subarray(136, 148)) * 1000;
    const ustar = h.subarray(257, 263).toString("latin1") === "ustar\0";
    let name = longName ?? ((ustar && str(h.subarray(345, 500)) ? `${str(h.subarray(345, 500))}/` : "") + str(h.subarray(0, 100)));
    const link = longLink ?? str(h.subarray(157, 257));
    longName = longLink = null;
    const body = size ? await s.read(size) : Buffer.alloc(0);
    if (size % 512) await s.read(512 - (size % 512));
    if (type === "L") { longName = str(body); continue; }
    if (type === "K") { longLink = str(body); continue; }
    if (type === "x") { for (const m of body.toString("utf8").matchAll(/\d+ (path|linkpath)=([^\n]*)\n/g)) m[1] === "path" ? (longName = m[2]) : (longLink = m[2]); continue; }
    if (type === "g" || type === "5") continue;
    name = name.replace(/^\.\//, "");
    if (!name.startsWith("data/")) { skipped++; continue; }
    const rel = name.slice(5);
    if (type === "1") { // hard link: the same content as a file earlier in the tar
      const e = seen.get(link.replace(/^\.\//, ""));
      if (!e) throw new Error(`${name}: hard link to ${link}, which is not earlier in the tar`);
      record(rel, [e[0], e[1], mtime || e[2]]);
      continue;
    }
    if (type !== "0" && type !== "7") { console.warn(`\n  ${name}: tar type ${type} skipped`); skipped++; continue; }
    const sha = sha256(body), e: Entry = [sha, size, mtime];
    seen.set(name, e);
    record(rel, e);
    files++;
    if (!stored(have, sha, size)) {
      have.set(objectKey(sha), size); // claimed now: a later identical file doesn't upload it again
      const copy = Buffer.from(body);
      inflight.push(putContent(sha, copy).then(() => { uploaded++; bytes += size; }));
      if (inflight.length >= (S3 ? 32 : 12)) { await Promise.all(inflight); inflight = []; }
    }
    if (files % 100 === 0) process.stdout.write(`\r  ${files} files · ${uploaded} uploaded (${MB(bytes)}) · read ${MB(s.pos)}${s.total > 0 ? ` of ${MB(s.total)}` : ""} · ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
    if (Date.now() - lastSave > 300_000) { await Promise.all(inflight); inflight = []; lastSave = Date.now(); await flush(); }
  }
  await Promise.all(inflight);
  // the rest of the stream (zero padding) completes the tar's checksum
  while (s.total > 0 && s.pos < s.total) await s.read(Math.min(1 << 20, s.total - s.pos));
  const got = s.hash.digest("hex");
  await flush(true);
  console.log(`\n  ${url.split("/").at(-1)}: ${files} files, ${uploaded} uploaded (${MB(bytes)}), ${skipped} skipped · sha256 ${got}`);
  if (expect && got !== expect) throw new Error(`sha256 mismatch: expected ${expect}, got ${got} (entries are hashed one by one, so what was uploaded is intact; check the tar)`);
  if (expect) console.log("  sha256 matches");
}

// ---------------------------------------------------------------------------------------------- verify
async function verify(unit: string) {
  const m = await getManifest(unit), have = await haveObjects();
  const entries = Object.entries(m);
  const bad = entries.filter(([, e]) => !stored(have, e[0], e[1]));
  const totalBytes = entries.reduce((s, [, e]) => s + e[1], 0);
  const distinct = new Set(entries.map(([, e]) => e[0]));
  console.log(`${unit}: ${entries.length} files (${MB(totalBytes)}; ${distinct.size} distinct objects), ${bad.length} missing or wrong size`);
  for (const [rel] of bad.slice(0, 10)) console.log(`  missing: ${rel}`);
  const n = Math.min(Number(args.sample), entries.length);
  const pick = [...entries].sort(() => Math.random() - 0.5).slice(0, n);
  let ok = 0;
  for (const [rel, e] of pick) {
    const b = await getContent(e[0]);
    if (b && b.length === e[1] && sha256(b) === e[0]) ok++; else console.log(`  BAD download: ${rel}`);
  }
  console.log(`  ${ok}/${n} random files downloaded and hash-checked`);
  // local copies that differ from the archive (changed since the last upload)
  const differ = entries.filter(([rel, e]) => existsSync(join(DATA, rel)) && hashLocal(rel)[0] !== e[0]).length;
  const notUp = localFiles(unit).filter((rel) => !m[rel]).length;
  saveIndex(true);
  console.log(`  local: ${notUp} files not in the archive, ${differ} differ from it`);
  if (bad.length || ok < n) process.exitCode = 1;
}

// ------------------------------------------------------------------------------------------------ pull
const WIN = 1024, STRIDE = WIN - 128; // paint.ts's window grid
const TILE = /^derived\/[^/]+\/(render|paint)\/(-?\d+)_(-?\d+)\.png$/, WINDOW = /^derived\/[^/]+\/windows\/(-?\d+)_(-?\d+)\.png$/;
const HISTORY = /^derived\/[^/]+\/(windows-replaced|paint-withdrawn|work)\//;

async function pull(unit: string) {
  let inPatch: ((rel: string) => boolean) | null = null;
  if (args.near && unit !== "shared") {
    const area = Object.entries(AREAS).find(([, a]) => a.region === unit)?.[0];
    if (!area) throw new Error(`--near: ${unit} is not a region`);
    openArea(area);
    const [lat, lon] = args.near.split(",").map(Number), r = Number(args.radius) + 2;
    const [x, y] = llhToPixel(lat, lon, 25);
    const ci = Math.floor(x / STRIDE), cj = Math.floor(y / STRIDE), T = 1024;
    const px0 = (ci - r) * STRIDE, px1 = (ci + r) * STRIDE + WIN, py0 = (cj - r) * STRIDE, py1 = (cj + r) * STRIDE + WIN;
    inPatch = (rel) => {
      let m = rel.match(WINDOW);
      if (m) return Math.abs(Number(m[1]) - ci) <= r && Math.abs(Number(m[2]) - cj) <= r;
      m = rel.match(TILE);
      if (m) { const tx = Number(m[2]), ty = Number(m[3]); return (tx + 1) * T > px0 && tx * T < px1 && (ty + 1) * T > py0 && ty * T < py1; }
      return false;
    };
  }
  const m = await getManifest(unit);
  const want = Object.entries(m).filter(([rel]) => {
    if (HISTORY.test(rel)) return args.history;
    if (TILE.test(rel) || WINDOW.test(rel)) return args.all || (inPatch?.(rel) ?? false);
    return true;
  });
  const byHash = new Map<string, string>(); // sha -> a local file with that content (linked, not downloaded again)
  let got = 0, linked = 0, same = 0, conflicts = 0, bytes = 0, done = 0;
  console.log(`${unit}: ${want.length} of ${Object.keys(m).length} archived files${inPatch ? ` (patch around ${args.near}, radius ${args.radius})` : ""}`);
  await pool(want, S3 ? 16 : 8, async ([rel, [sha, size, mtime]]) => {
    const file = join(DATA, rel);
    if (existsSync(file)) {
      if (statSync(file).size === size && hashLocal(rel)[0] === sha) { same++; byHash.set(sha, file); return; }
      if (!args.force) { conflicts++; console.warn(`\n  kept local ${rel}: differs from the archive (--force replaces it)`); return; }
    }
    mkdirSync(dirname(file), { recursive: true });
    const twin = byHash.get(sha);
    if (twin && existsSync(twin)) {
      try { linkSync(twin, `${file}.tmp`); renameSync(`${file}.tmp`, file); linked++; return; } catch { /* other volume: download */ }
    }
    const b = await getContent(sha);
    if (!b || b.length !== size || sha256(b) !== sha) throw new Error(`${rel}: archive object ${sha} missing or corrupt`);
    writeFileSync(`${file}.tmp`, b);
    utimesSync(`${file}.tmp`, new Date(), new Date(mtime));
    renameSync(`${file}.tmp`, file);
    index[rel] = [statSync(file).mtimeMs, size, sha]; indexDirty++;
    byHash.set(sha, file);
    got++; bytes += size;
    if (++done % 50 === 0) process.stdout.write(`\r  ${got} downloaded (${MB(bytes)})   `);
  });
  saveIndex(true);
  console.log(`\r  ${got} downloaded (${MB(bytes)}), ${linked} linked, ${same} already here${conflicts ? `, ${conflicts} kept (differ locally)` : ""}`);
}

// ------------------------------------------------------------------------------------------------ main
const PULL = positionals[0] === "pull";
const units = PULL ? positionals.slice(1) : positionals;
for (const u of units) if (!UNITS.has(u)) throw new Error(`unknown unit ${u} (a region: ${Object.keys(REGIONS).join(", ")}; or shared)`);
console.log(`  archive: r2://${BUCKET.name} through ${S3 ? "R2's S3 API" : "the Cloudflare REST API"}`);
if (args.tar) await ingestTar(args.tar, args.sha256);
for (const u of units) {
  if (PULL) await pull(u);
  else if (args.verify) await verify(u);
  else await push(u);
}
if (!args.tar && !units.length) console.log("nothing to do: name a region (or shared), or --tar <url>");
