/** Overpass API client shared by fetch.ts and boundaries.ts. */

/** Public Overpass instances, tried in turn (the main one often answers 502/504 under load). */
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const UA = { "User-Agent": "isometric-world/0.3 (open-data isometric map)" };

export async function overpass(query: string) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    const url = OVERPASS[(attempt - 1) % OVERPASS.length];
    try {
      const r = await fetch(url, {
        method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(900_000),
      });
      if (r.ok) return await r.json();
      console.warn(`  overpass ${new URL(url).host} ${r.status}, retrying…`);
    } catch (err) {
      console.warn(`  overpass ${new URL(url).host} ${(err as Error).message}, retrying…`);
    }
    await new Promise((res) => setTimeout(res, Math.min(60_000, 10_000 * attempt)));
  }
  throw new Error("overpass failed");
}
