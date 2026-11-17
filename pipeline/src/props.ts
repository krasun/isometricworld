/**
 * Street furniture and roofs on posts (scene.ts), from fetch.ts osm-furniture.json:
 *
 * - street lamps (preset `streetLamps`): every highway=street_lamp, an 8 m pole with an arm reaching 1.6 m towards
 *   the nearest road and a flat lamp head; one without a road within 15 m is a 4.5 m park lamp with a lantern.
 *   Lamps are gathered into one piece per 100 m cell (the renderer gets a few hundred meshes, not two thousand).
 * - roofs on posts (preset `roofsOnPosts`): building=roof and carport outlines (fuel station canopies, carports,
 *   shelters for bins and bicycles) as a slab on posts at the corners and every ~6 m along the edges, at the
 *   surface model's height where it sees the roof, else 5 m over a fuel station, 2.4 m for a carport, 2.6 m
 *   for the rest; left out where a building already stands (the 3D models have some of them).
 */
import { beam, CLAD, type P2, type P3, type Piece, prism } from "./landmarks/shapes.ts";

type Tags = Record<string, string>;
type El = { type: string; id: number; lat?: number; lon?: number; geometry?: Array<{ lat: number; lon: number }>; tags?: Tags };
const POLE = [0.33, 0.36, 0.36], HEAD = [0.78, 0.79, 0.77], CANOPY = [0.9, 0.9, 0.88], CARPORT = [0.52, 0.53, 0.55], POST = [0.62, 0.63, 0.64];

/** Street lamps; `road(p)`: the nearest road point within 15 m, or null. */
export function streetLamps(osm: { elements: El[] }, toEnu: (lon: number, lat: number) => P2, ground: (x: number, y: number) => number,
  inBox: (p: P2) => boolean, road: (p: P2) => P2 | null): { pieces: Piece[]; count: number } {
  const cells = new Map<string, Piece>();
  let count = 0;
  for (const el of osm.elements) {
    if (el.type !== "node" || el.tags?.highway !== "street_lamp") continue;
    const p = toEnu(el.lon!, el.lat!);
    if (!inBox(p)) continue;
    const key = `${Math.floor(p[0] / 100)}_${Math.floor(p[1] / 100)}`;
    if (!cells.has(key)) {
      const x = Math.floor(p[0] / 100) * 100, y = Math.floor(p[1] / 100) * 100;
      cells.set(key, { roof: [], wall: [], footprint: [[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100]], height: 9, base: ground(p[0], p[1]) - 30, look: { roof: HEAD, wall: POLE, style: CLAD, bare: 3 } });
    }
    const piece = cells.get(key)!, z0 = ground(p[0], p[1]) - piece.base, at = (x: number, y: number, z: number): P3 => [x, y, z0 + z];
    const r = road(p);
    count++;
    if (!r) { // a park lamp
      beam(piece, at(p[0], p[1], 0), at(p[0], p[1], 4.2), 0.12);
      prism(piece, [[p[0] - 0.18, p[1] - 0.18], [p[0] + 0.18, p[1] - 0.18], [p[0] + 0.18, p[1] + 0.18], [p[0] - 0.18, p[1] + 0.18]], z0 + 4.2, z0 + 4.65);
      continue;
    }
    const d = Math.hypot(r[0] - p[0], r[1] - p[1]) || 1, u: P2 = [(r[0] - p[0]) / d, (r[1] - p[1]) / d];
    const tip: P2 = [p[0] + u[0] * 1.6, p[1] + u[1] * 1.6];
    beam(piece, at(p[0], p[1], 0), at(p[0], p[1], 8), 0.16);
    beam(piece, at(p[0], p[1], 7.75), at(tip[0], tip[1], 8.05), 0.08);
    const v: P2 = [-u[1], u[0]], h = (a: number, b: number): P2 => [tip[0] + u[0] * a + v[0] * b, tip[1] + u[1] * a + v[1] * b];
    prism(piece, [h(-0.15, -0.16), h(0.55, -0.16), h(0.55, 0.16), h(-0.15, 0.16)], z0 + 7.92, z0 + 8.08);
  }
  return { pieces: [...cells.values()], count };
}

/** Roofs on posts; `covered(ring)`: a building already stands there; `seen(ring)`: the surface model's height over the
 *  ground inside the outline (median), NaN where it has none. */
export function roofsOnPosts(osm: { elements: El[] }, toEnu: (lon: number, lat: number) => P2, ground: (x: number, y: number) => number,
  inBox: (p: P2) => boolean, covered: (ring: P2[]) => boolean, seen: (ring: P2[]) => number): Piece[] {
  const out: Piece[] = [];
  for (const el of osm.elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4 || !/^(roof|carport)$/.test(t.building ?? "")) continue;
    const ring = el.geometry.slice(0, -1).map((q) => toEnu(q.lon, q.lat));
    const c: P2 = [ring.reduce((a, q) => a + q[0], 0) / ring.length, ring.reduce((a, q) => a + q[1], 0) / ring.length];
    if (!inBox(c) || covered(ring)) continue;
    const fuel = t.amenity === "fuel", carport = t.building === "carport", tagged = parseFloat(t.height ?? "");
    const m = seen(ring), h = tagged > 1.5 && tagged < 20 ? tagged : m > 1.8 && m < 15 ? m : fuel ? 5 : carport ? 2.4 : 2.6;
    const base = Math.min(...ring.map(([x, y]) => ground(x, y)));
    const rgb = carport ? CARPORT : CANOPY;
    const p: Piece = { roof: [], wall: [], footprint: ring, height: h, base, look: { roof: rgb, wall: rgb, style: CLAD, bare: 3 } };
    const posts: Piece = { roof: [], wall: [], footprint: ring, height: h, base, look: { roof: POST, wall: POST, style: CLAD, bare: 3 } };
    // the slab, 35 cm deep, level at its height over the highest corner's ground
    const top = Math.max(...ring.map(([x, y]) => ground(x, y))) - base + h;
    prism(p, ring, top - 0.35, top);
    // posts 0.3 m in from the corners and every ~6 m along the edges
    const inset = (q: P2): P2 => { const dx = c[0] - q[0], dy = c[1] - q[1], L = Math.hypot(dx, dy) || 1, k = Math.min(0.3, L / 3); return [q[0] + (dx / L) * k, q[1] + (dy / L) * k]; };
    for (let i = 0; i < ring.length; i++) {
      const a = inset(ring[i]), b = inset(ring[(i + 1) % ring.length]), n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
      for (let k = 0; k < n; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n;
        beam(posts, [x, y, ground(x, y) - base], [x, y, top - 0.35], carport ? 0.12 : 0.3);
      }
    }
    out.push(p, posts);
  }
  return out;
}
