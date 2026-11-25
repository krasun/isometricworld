/**
 * Parked cars (preset `parkedCars`): the parking lots and bays OSM maps (amenity=parking, amenity=parking_space),
 * about two thirds occupied, the same every time (seeded by the OSM id). Cars stand on the stalls OSM maps;
 * a lot or bay without any is laid out by its shape (its smallest enclosing rectangle): a strip under 3.5 m
 * wide is a lane of cars parked one behind the other, one up to 7 m a row of cars side by side, a wider lot
 * rows of stalls along its long side, back to back between 6 m aisles. Stall lines are painted on lots (not
 * along kerbs). Underground and multi-storey parking is left out (the building stands there).
 *
 * The layout is shared: ground.ts paints the stall lines (parkLayout), scene.ts builds the cars (parkPieces),
 * both from data/raw/<area>/osm-parking.json.
 */
import { CLAD, type P2, type Piece, prism } from "./landmarks/shapes.ts";

type Tags = Record<string, string>;
type El = { type: string; id: number; geometry?: Array<{ lat: number; lon: number }>; members?: Array<{ role: string; geometry?: Array<{ lat: number; lon: number }> }>; tags?: Tags };
/** a parked car at (x, y) facing h (radians), its paint (index into PAINT), a van or not, its lot */
export type Car = { x: number; y: number; h: number; paint: number; van: boolean; lot: number };
export type ParkLayout = { cars: Car[]; lines: Array<{ lot: number; rings: P2[][] }> };

const rand = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const area = (r: P2[]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
function inside([x, y]: P2, r: P2[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
/** smallest enclosing rectangle: centre, unit vectors along its long (u) and short (v) side, half-sides a ≥ b */
function minRect(pts: P2[]) {
  let best = { area: Infinity, c: [0, 0] as P2, u: [1, 0] as P2, v: [0, 1] as P2, a: 0, b: 0 };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const u: P2 = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], v: P2 = [-u[1], u[0]];
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const h of pts) { const s = h[0] * u[0] + h[1] * u[1], t = h[0] * v[0] + h[1] * v[1]; s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    const A = (s1 - s0) * (t1 - t0);
    if (A >= best.area) continue;
    const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2, c: P2 = [u[0] * sm + v[0] * tm, u[1] * sm + v[1] * tm];
    best = s1 - s0 >= t1 - t0 ? { area: A, c, u, v, a: (s1 - s0) / 2, b: (t1 - t0) / 2 } : { area: A, c, u: v, v: u, a: (t1 - t0) / 2, b: (s1 - s0) / 2 };
  }
  return best;
}
/** a rectangle round (x, y): `l` along u, `w` along v */
const rect = (x: number, y: number, u: P2, v: P2, l: number, w: number): P2[] =>
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [x + (u[0] * i * l) / 2 + (v[0] * j * w) / 2, y + (u[1] * i * l) / 2 + (v[1] * j * w) / 2] as P2);

/** paint shares as seen on Polish roads: white, silver, grey, black, blue, red, green, beige, brown */
const SHARE = [22, 18, 14, 17, 10, 8, 4, 4, 3];

/** The parking of osm-parking.json in the frame `toEnu` maps lon, lat into. */
export function parkLayout(osm: { elements: El[] }, toEnu: (lon: number, lat: number) => P2): ParkLayout {
  const ring = (g: Array<{ lat: number; lon: number }>) => g.map((q) => toEnu(q.lon, q.lat));
  const lots: Array<{ r: P2[]; id: number; t: Tags }> = [], spaces: Array<{ r: P2[]; id: number }> = [];
  for (const el of osm.elements) {
    const t = el.tags ?? {};
    const rings = el.type === "way" && el.geometry ? [ring(el.geometry)] : (el.members ?? []).filter((m) => m.role === "outer" && m.geometry).map((m) => ring(m.geometry!));
    for (const r0 of rings) {
      if (r0.length < 4) continue;
      const r = r0.slice(0, -1);
      if (t.amenity === "parking_space") spaces.push({ r, id: el.id });
      else if (t.amenity === "parking" && !/^(underground|multi-storey|rooftop)$/.test(t.parking ?? "")) lots.push({ r, id: el.id, t });
    }
  }
  const cars: Car[] = [], lines: ParkLayout["lines"] = [];
  const paintOf = (rnd: () => number) => { let k = rnd() * 100; for (let i = 0; i < SHARE.length; i++) if ((k -= SHARE[i]) < 0) return i; return 0; };
  const park = (x: number, y: number, h: number, lot: number, rnd: () => number, share: number) => {
    if (rnd() >= share) return;
    cars.push({ x, y, h: h + (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 0.06, paint: paintOf(rnd), van: rnd() < 0.07, lot });
  };
  // mapped stalls: a car along each one's long side
  const lotOf = (p: P2) => lots.find((l) => inside(p, l.r));
  const withStalls = new Set<number>();
  for (const s of spaces) {
    const R = minRect(s.r), home = lotOf(R.c);
    if (home) withStalls.add(home.id);
    const rnd = rand((s.id % 2147483646) + 1);
    park(R.c[0], R.c[1], Math.atan2(R.u[1], R.u[0]), home?.id ?? s.id, rnd, 0.65);
  }
  // lots and bays without mapped stalls: laid out by their shape
  for (const lot of lots) {
    if (withStalls.has(lot.id) || Math.abs(area(lot.r)) < 10) continue;
    const R = minRect(lot.r), rnd = rand((lot.id % 2147483646) + 1), share = lot.t.access === "private" ? 0.72 : 0.62;
    const along = Math.atan2(R.u[1], R.u[0]), across = along + Math.PI / 2;
    const fits = (q: P2[]) => q.every((p) => inside(p, lot.r));
    if (R.b * 2 < 3.5) { // a lane: one behind the other
      for (let s = -R.a + 2.9; s <= R.a - 2.9; s += 5.8) {
        const x = R.c[0] + R.u[0] * s, y = R.c[1] + R.u[1] * s;
        if (fits(rect(x, y, R.u, R.v, 4.4, 1.8))) park(x, y, along, lot.id, rnd, share);
      }
      continue;
    }
    // rows of 2.5 m stalls along the long side, 5 m deep: one row in a bay, rows back to back between aisles on a lot
    const rows = R.b * 2 <= 7 ? [0] : (() => {
      const out: number[] = [];
      for (let t = -R.b + 2.5; t <= R.b - 2.5; ) { out.push(t); t += out.length % 2 ? 11 : 5; }
      return out;
    })();
    const stalls: P2[][] = [];
    for (const t of rows) for (let s = -R.a + 1.25; s <= R.a - 1.25; s += 2.5) {
      const x = R.c[0] + R.u[0] * s + R.v[0] * t, y = R.c[1] + R.u[1] * s + R.v[1] * t, q = rect(x, y, R.u, R.v, 2.5, 5);
      if (!fits(q)) continue;
      stalls.push(q);
      park(x, y, across, lot.id, rnd, share);
    }
    if (stalls.length && lot.t.parking !== "street_side" && lot.t.parking !== "lane") lines.push({ lot: lot.id, rings: stalls });
  }
  return { cars, lines };
}

// ---- the cars ----------------------------------------------------------------------------------------
const PAINT = [[0.92, 0.92, 0.91], [0.72, 0.73, 0.75], [0.45, 0.46, 0.48], [0.13, 0.13, 0.14], [0.18, 0.28, 0.48],
  [0.64, 0.14, 0.13], [0.2, 0.33, 0.24], [0.76, 0.7, 0.58], [0.4, 0.29, 0.21]];
const GLASS = [0.17, 0.2, 0.24];

/** The cars of a layout, a body and a cabin piece per paint per lot (one mesh each, not one per car). */
export function parkPieces(layout: ParkLayout, ground: (x: number, y: number) => number): Piece[] {
  const parts = new Map<string, Piece>();
  const piece = (key: string, x: number, y: number, wall: number[], roof: number[]) => {
    if (!parts.has(key)) parts.set(key, { roof: [], wall: [], footprint: [[x - 1, y - 1], [x + 1, y - 1], [x + 1, y + 1], [x - 1, y + 1]], height: 2, base: ground(x, y), look: { roof, wall, style: CLAD, bare: 3 } });
    return parts.get(key)!;
  };
  for (const c of layout.cars) {
    const paint = PAINT[c.van ? 0 : c.paint], u: P2 = [Math.cos(c.h), Math.sin(c.h)], v: P2 = [-u[1], u[0]];
    const body = piece(`${c.lot}|${c.van ? "v" : c.paint}|b`, c.x, c.y, paint, paint), cab = piece(`${c.lot}|${c.van ? "v" : c.paint}|c`, c.x, c.y, GLASS, paint);
    const dz = ground(c.x, c.y) - body.base; // its own ground, within the lot's piece
    const box = (p: Piece, s0: number, s1: number, w: number, z0: number, z1: number) => {
      const q: P2[] = [[s0, -w / 2], [s1, -w / 2], [s1, w / 2], [s0, w / 2]].map(([s, t]) => [c.x + u[0] * s + v[0] * t, c.y + u[1] * s + v[1] * t]);
      prism(p, q, dz + z0, dz + z1);
    };
    if (c.van) { box(body, -2.5, 1.7, 1.95, 0.25, 2.05); box(cab, 1.7, 2.5, 1.9, 0.25, 1.75); continue; } // a box van: glass cab in front
    box(body, -2.2, 2.2, 1.8, 0.25, 0.85);
    box(cab, -1.35, 0.75, 1.62, 0.85, 1.4); // glass sides, the roof in the paint
  }
  return [...parts.values()];
}
