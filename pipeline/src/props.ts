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
import { beam, CLAD, lathe, type P2, type P3, panel, type Piece, prism, roofFace } from "./landmarks/shapes.ts";

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
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4 || !(/^(roof|carport)$/.test(t.building ?? "") || (t.amenity === "shelter" && !t.building))) continue;
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

/** The nearest road to a point: the point on it, its direction (unit), its carriageway width. */
export type Road = { q: P2; dir: P2; w: number } | null;
const FRAME = [0.36, 0.38, 0.4], GLASS = [0.48, 0.58, 0.62], SIGN = [0.16, 0.36, 0.72], BENCH = [0.56, 0.41, 0.27], BIN = [0.26, 0.33, 0.29];
const WHITE = [0.93, 0.92, 0.88], RED = [0.78, 0.16, 0.18], EU = [0.13, 0.25, 0.6], STONE = [0.6, 0.6, 0.58], DARK = [0.2, 0.21, 0.22];
const SHRINE_ROOF = [0.58, 0.26, 0.19], POSTER = [[0.92, 0.55, 0.2], [0.85, 0.25, 0.3], [0.25, 0.55, 0.8], [0.95, 0.8, 0.25], [0.35, 0.7, 0.45]];

/**
 * Street furniture (preset `streetFurniture`), from the nodes of osm-furniture.json: bus shelters (a glass box open
 * to the road; a bus stop without one gets its blue sign on a post), benches facing the nearest road, waste
 * baskets, flagpoles with a Polish (or EU) flag, advertising columns and billboards, wayside shrines (a white
 * pillar with a little roof and cross), wayside crosses, memorial stones, and traffic signals on both sides of the
 * road at each signal node. One piece per 100 m cell and colour.
 */
export function streetFurniture(osm: { elements: El[] }, toEnu: (lon: number, lat: number) => P2, ground: (x: number, y: number) => number,
  inBox: (p: P2) => boolean, road: (p: P2, max: number) => Road): { pieces: Piece[]; counts: Record<string, number> } {
  const cells = new Map<string, Piece>(), counts: Record<string, number> = {};
  const piece = (p: P2, wall: number[], roof = wall) => {
    const cx = Math.floor(p[0] / 100), cy = Math.floor(p[1] / 100), key = `${cx}_${cy}|${wall}|${roof}`;
    if (!cells.has(key)) cells.set(key, { roof: [], wall: [], footprint: [[cx * 100, cy * 100], [cx * 100 + 100, cy * 100], [cx * 100 + 100, cy * 100 + 100], [cx * 100, cy * 100 + 100]], height: 6, base: ground(cx * 100 + 50, cy * 100 + 50) - 40, look: { roof, wall, style: CLAD, bare: 3 } });
    return cells.get(key)!;
  };
  const hash = (p: P2) => { const h = Math.sin(p[0] * 12.9898 + p[1] * 78.233) * 43758.5453; return h - Math.floor(h); };
  const nodes = osm.elements.filter((e) => e.type === "node" && e.lat !== undefined).map((e) => ({ p: toEnu(e.lon!, e.lat!), t: e.tags ?? {} })).filter((n) => inBox(n.p));
  const shelters = nodes.filter((n) => n.t.amenity === "shelter").map((n) => n.p);
  for (const { p, t } of nodes) {
    // a local frame: a along the nearest road (or a turn from the point), b towards it
    const r = road(p, 25), dir: P2 = r ? r.dir : [Math.cos(hash(p) * 6.28), Math.sin(hash(p) * 6.28)];
    let toward: P2 = [-dir[1], dir[0]];
    if (r && (r.q[0] - p[0]) * toward[0] + (r.q[1] - p[1]) * toward[1] < 0) toward = [-toward[0], -toward[1]];
    const z0 = (q: P2) => ground(q[0], q[1]);
    const at = (pc: Piece, a: number, b: number, z: number): P3 => { const x = p[0] + dir[0] * a + toward[0] * b, y = p[1] + dir[1] * a + toward[1] * b; return [x, y, z0(p) - pc.base + z]; };
    const xy = (a: number, b: number): P2 => [p[0] + dir[0] * a + toward[0] * b, p[1] + dir[1] * a + toward[1] * b];
    const box = (pc: Piece, a0: number, b0: number, a1: number, b1: number, z1: number, z2: number) =>
      prism(pc, [xy(a0, b0), xy(a1, b0), xy(a1, b1), xy(a0, b1)], z0(p) - pc.base + z1, z0(p) - pc.base + z2);
    const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
    const shelterHere = () => {
      const f = piece(p, FRAME), g = piece(p, GLASS);
      box(f, -1.8, -0.85, 1.8, 0.85, 2.4, 2.55);                                   // roof
      for (const a of [-1.75, 1.75]) for (const b of [-0.8, 0.8]) beam(f, at(f, a, b, 0), at(f, a, b, 2.4), 0.08);
      box(g, -1.75, -0.82, 1.75, -0.76, 0.15, 2.35);                               // back glass, away from the road
      for (const a of [-1.75, 1.72]) box(g, a, -0.8, a + 0.03, 0.2, 0.15, 2.35); // side glass
      box(piece(p, BENCH), -1.2, -0.7, 1.2, -0.4, 0.42, 0.48);
      count("bus shelter");
    };
    if (t.amenity === "shelter") { shelterHere(); continue; }
    if (t.highway === "bus_stop") {
      if (t.shelter === "yes" && !shelters.some((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) < 12)) { shelterHere(); continue; }
      const pole = piece(p, FRAME);
      beam(pole, at(pole, 0, 0, 0), at(pole, 0, 0, 2.6), 0.07);
      box(piece(p, SIGN), -0.25, -0.03, 0.25, 0.03, 2.1, 2.6);
      count("bus stop sign");
      continue;
    }
    if (t.amenity === "bench") {
      const w = piece(p, BENCH);
      box(w, -0.9, -0.22, 0.9, 0.22, 0.42, 0.48);
      box(w, -0.9, -0.25, 0.9, -0.2, 0.48, 0.88); // backrest, away from the road
      count("bench");
      continue;
    }
    if (t.amenity === "waste_basket") { box(piece(p, BIN), -0.2, -0.2, 0.2, 0.2, 0, 0.9); count("waste basket"); continue; }
    if (t.man_made === "flagpole") {
      const pole = piece(p, WHITE);
      beam(pole, at(pole, 0, 0, 0), at(pole, 0, 0, 9), 0.12);
      const eu = hash(p) < 0.25, line = [xy(0.1, 0), xy(1.6, 0)], h = z0(p) - pole.base; // panel heights are above the piece's base
      if (eu) panel(piece(p, EU), line, h + 7.8, h + 8.7, false);
      else { panel(piece(p, WHITE), line, h + 8.25, h + 8.7, false); panel(piece(p, RED), line, h + 7.8, h + 8.25, false); }
      count("flagpole");
      continue;
    }
    if (t.advertising === "column") {
      const c = piece(p, POSTER[Math.floor(hash(p) * POSTER.length)]);
      lathe(c, p, [[z0(p) - c.base, 0.6], [z0(p) - c.base + 2.7, 0.6]], 12);
      lathe(piece(p, DARK), p, [[z0(p) - c.base + 2.7, 0.7], [z0(p) - c.base + 3.1, 0.15]], 12);
      count("advertising column");
      continue;
    }
    if (t.advertising === "billboard") {
      const f = piece(p, FRAME);
      for (const a of [-1.8, 1.8]) beam(f, at(f, a, 0, 0), at(f, a, 0, 3), 0.18);
      box(piece(p, POSTER[Math.floor(hash(p) * POSTER.length)]), -3, -0.08, 3, 0.08, 3, 6);
      count("billboard");
      continue;
    }
    if (t.historic === "wayside_shrine") {
      const w = piece(p, WHITE), r2 = piece(p, SHRINE_ROOF);
      box(w, -0.45, -0.45, 0.45, 0.45, 0, 1.9);
      roofFace(r2, [at(r2, -0.6, -0.6, 1.9), at(r2, 0.6, -0.6, 1.9), at(r2, 0.6, 0, 2.45), at(r2, -0.6, 0, 2.45)]);
      roofFace(r2, [at(r2, 0.6, 0.6, 1.9), at(r2, -0.6, 0.6, 1.9), at(r2, -0.6, 0, 2.45), at(r2, 0.6, 0, 2.45)]);
      const d = piece(p, DARK);
      beam(d, at(d, 0, 0, 2.45), at(d, 0, 0, 3.0), 0.05); beam(d, at(d, -0.15, 0, 2.85), at(d, 0.15, 0, 2.85), 0.05);
      count("wayside shrine");
      continue;
    }
    if (t.historic === "wayside_cross") {
      box(piece(p, STONE), -0.35, -0.35, 0.35, 0.35, 0, 0.6);
      const d = piece(p, DARK);
      beam(d, at(d, 0, 0, 0.6), at(d, 0, 0, 4), 0.16); beam(d, at(d, -0.7, 0, 3.2), at(d, 0.7, 0, 3.2), 0.14);
      count("wayside cross");
      continue;
    }
    if (t.historic === "memorial") {
      const s = piece(p, STONE);
      if (t.memorial === "obelisk") box(s, -0.4, -0.4, 0.4, 0.4, 0, 3.2);
      else box(s, -0.6, -0.35, 0.6, 0.35, 0, 1.4);
      count("memorial");
      continue;
    }
    if (t.highway === "traffic_signals" && r) {
      const d = piece(p, DARK), off = r.w / 2 + 1.2;
      for (const side of [1, -1]) {
        const b = side * off;
        beam(d, at(d, 0, b, 0), at(d, 0, b, 3.6), 0.12);
        box(d, -0.12, b - 0.15, 0.12, b + 0.15, 2.5, 3.4);
      }
      count("traffic signals");
    }
  }
  return { pieces: [...cells.values()], counts };
}
