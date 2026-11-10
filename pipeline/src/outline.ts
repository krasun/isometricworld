/**
 * A region's map shape (places.ts `outline`): an OSM boundary relation from the region's extract plus
 * extra boxes, as a union of polygons. Fetch and render skip what lies outside, export fades the map
 * edge along it (instead of along the areas' bboxes).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeRegion, llhToPixel } from "./camera.ts";
import { RAW } from "./paths.ts";
import { REGIONS } from "./places.ts";

type Pt = [number, number];

/** Outer rings of the region's outline as [lat, lon] (null: the region has none). Cached per relation in data/raw/osm/. */
export function outlineLatLon(region = activeRegion()): Pt[][] | null {
  const R = REGIONS[region], o = R.outline;
  if (!o) return null;
  if (!R.osmExtract) throw new Error(`${region}: outline needs osmExtract`);
  const rings: Pt[][] = [];
  for (const id of o.relations) rings.push(...relationRings(R.osmExtract, id));
  for (const r of rings) if (r.length > 1 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1]) r.pop(); // GeoJSON repeats the first vertex
  for (const [s, w, n, e] of o.add ?? []) rings.push([[s, w], [s, e], [n, e], [n, w]]);
  return rings;
}

function relationRings(extract: string, id: number): Pt[][] {
  const dir = join(RAW, "osm"), cache = join(dir, `outline-${id}.json`);
  if (!existsSync(cache)) {
    const pbf = join(dir, extract.split("/").pop()!);
    if (!existsSync(pbf)) throw new Error(`${pbf} missing: run fetch for an area of the region first`);
    mkdirSync(dir, { recursive: true });
    const rel = join(dir, `rel-${process.pid}.osm.pbf`), geo = join(dir, `rel-${process.pid}.geojson`);
    execFileSync("osmium", ["getid", "-r", "-O", "-o", rel, pbf, `r${id}`], { stdio: "ignore" });
    execFileSync("osmium", ["export", "-O", "-f", "geojson", "-o", geo, rel], { stdio: "ignore" });
    // the relation's area is the largest polygon (member ways tagged as areas come out too)
    const f = JSON.parse(readFileSync(geo, "utf8")).features.filter((f: any) => /Polygon/.test(f.geometry.type))
      .sort((a: any, b: any) => JSON.stringify(b.geometry).length - JSON.stringify(a.geometry).length)[0];
    rmSync(rel); rmSync(geo);
    if (!f) throw new Error(`relation ${id} has no closed outline in ${pbf}`);
    const polys: number[][][][] = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    // outer rings only, ~10 m simplified (thousands of border vertices -> a few hundred)
    writeFileSync(cache, JSON.stringify(polys.map((p) => simplify(p[0].map(([lon, lat]) => [lat, lon] as Pt), 1e-4))));
  }
  return JSON.parse(readFileSync(cache, "utf8"));
}

const pixelCache = new Map<string, Pt[][] | null>();
/** The outline in global art pixels at the region's typical ground height (like areaPolygon). */
export function outlinePixels(): Pt[][] | null {
  const region = activeRegion();
  if (!pixelCache.has(region)) {
    const rings = outlineLatLon(region);
    pixelCache.set(region, rings && rings.map((r) => r.map(([lat, lon]) => llhToPixel(lat, lon, REGIONS[region].groundH))));
  }
  return pixelCache.get(region)!;
}

/**
 * Distance (art px) from a point to the outline's outer border, 0 outside. Border pieces shared by two
 * rings (town borders, the airport box inside them) are not edges of the union and don't count.
 */
const edgeCache = new Map<string, Array<[Pt, Pt]>>();
export function outlineEdgeDistance(p: Pt): number {
  const rings = outlinePixels();
  if (!rings) return Infinity;
  if (!rings.some((r) => insideRing(p, r))) return 0;
  const region = activeRegion();
  if (!edgeCache.has(region)) {
    const TOL = 160; // 40 m: simplified shared borders don't coincide exactly
    const near = (q: Pt, r: Pt[]) => insideRing(q, r) || r.some((a, i) => segDist(q, a, r[(i + 1) % r.length]) < TOL);
    const out: Array<[Pt, Pt]> = [];
    rings.forEach((r, k) => r.forEach((a, i) => {
      const b = r[(i + 1) % r.length], m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!rings.some((o, j) => j !== k && near(m, o))) out.push([a, b]);
    }));
    edgeCache.set(region, out);
  }
  let d = Infinity;
  for (const [a, b] of edgeCache.get(region)!) d = Math.min(d, segDist(p, a, b));
  return d;
}

function segDist([x, y]: Pt, [ax, ay]: Pt, [bx, by]: Pt) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

export function insideRing([x, y]: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Is a lat/lon box [s, w, n, e] (grown by `marginDeg`) touching the outline? Sampled, for coarse culling. */
export function boxTouchesOutline([s, w, n, e]: number[], marginDeg = 0.01, region = activeRegion()) {
  const rings = outlineLatLon(region);
  if (!rings) return true;
  s -= marginDeg; w -= marginDeg * 1.5; n += marginDeg; e += marginDeg * 1.5;
  for (const r of rings) {
    if (r.some(([la, lo]) => la >= s && la <= n && lo >= w && lo <= e)) return true;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++)
      if (insideRing([s + ((n - s) * i) / 4, w + ((e - w) * j) / 4], r)) return true;
  }
  return false;
}

/** Douglas–Peucker on a closed ring. */
function simplify(ring: Pt[], tol: number): Pt[] {
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, dmax = tol;
    const [ax, ay] = ring[a], [bx, by] = ring[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = L > 1e-12 ? Math.abs(dy * (ring[i][0] - ax) - dx * (ring[i][1] - ay)) / L : Math.hypot(ring[i][0] - ax, ring[i][1] - ay);
      if (d > dmax) { dmax = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return ring.filter((_, i) => keep[i]);
}
