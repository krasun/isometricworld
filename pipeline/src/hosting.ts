/**
 * Where published map data lives. Shared by the pipeline and the web viewer.
 *
 * Tiles and region data are not in git or web/public: `npm run export` builds changed files into the
 * local cache (data/web/regions/<region>/), the dev server serves that cache on top of production,
 * and `npm run publish` uploads the cache to R2 and empties it.
 *
 * The public origin and the Cloudflare account come from the environment (.env, see .env.example).
 * In the browser there is no process.env: the web build injects the origin (astro.config.mjs).
 */
const env = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
function need(name: string): string {
  const v = env()[name];
  if (!v) throw new Error(`${name} is not set: add it to .env (see .env.example)`);
  return v;
}

export const HOSTING = {
  /** R2 bucket (Cloudflare account CLOUDFLARE_ACCOUNT_ID): production, or a contributor's own (TILES_BUCKET). */
  get bucket() { return env().TILES_BUCKET || "isometricworldtiles"; },
  /** the bucket's jurisdiction ("eu", "fedramp"), if it has one: R2's API needs it for every object */
  get jurisdiction() { return env().TILES_JURISDICTION || ""; },
  get accountId() { return need("CLOUDFLARE_ACCOUNT_ID"); },
  /** Public origin of the bucket (its custom domain), no trailing slash. */
  get origin() { return need("TILES_ORIGIN").replace(/\/+$/, ""); },
  /** Cache-Control per kind: tile URLs carry ?v=<content hash> and data/preview files their hash in the
   *  name, so they never change (cacheTiles); only data/world.json is rewritten in place (cacheData). */
  cacheTiles: "public, max-age=31536000, immutable",
  cacheData: "public, max-age=60, stale-while-revalidate=600",
};
