/**
 * Playgrounds (preset `playgrounds`): the equipment OSM maps on them (playground=swing, slide, structure,
 * seesaw, roundabout, springy, trampoline, playhouse, sandpit, climbingwall, zipwire…) as small hand-built
 * pieces in bright colours, and, on public playgrounds where OSM maps none, a set by the playground's size: a
 * sandpit and a swing on a small one, then a tower with a slide, a seesaw and spring riders, a roundabout on a
 * large one, spread over the area away from its edge, along its long axis, the same every time (seeded by its
 * OSM id). Private playgrounds (gardens) get only what is mapped. Under the equipment of public playgrounds a
 * pad of rubber safety surface, one colour per playground; sandpits as sand with a wooden frame.
 *
 * The layout is shared: ground.ts draws the pads and the sand (playLayout), scene.ts builds the equipment
 * (playPieces), both from data/raw/<area>/osm-play.json.
 */
import { beam, CLAD, type P2, type P3, panel, type Piece, prism, roofFace } from "./landmarks/shapes.ts";

type Tags = Record<string, string>;
type El = { type: string; id: number; lat?: number; lon?: number; geometry?: Array<{ lat: number; lon: number }>; members?: Array<{ role: string; geometry?: Array<{ lat: number; lon: number }> }>; tags?: Tags };
/** a piece of equipment at (x, y), turned to `h` (radians, its long axis), `c` its colour pick */
export type Item = { kind: string; x: number; y: number; h: number; c: number; len?: number };
export type Layout = { items: Item[]; sand: P2[][]; pads: Array<{ r: P2[]; v: number }> };

/** clearance round each kind (m): how far apart they stand, and the radius of the pad under them (0: none) */
const SPACE: Record<string, [number, number]> = {
  swing: [2.6, 2.4], basketswing: [2.6, 2.4], structure: [3.0, 3.0], climbingframe: [2.6, 2.4], slide: [2.4, 2.0],
  seesaw: [2.0, 1.8], roundabout: [1.8, 2.0], springy: [1.0, 1.1], spring_board: [1.2, 1.2], sandpit: [1.9, 0],
  trampoline: [2.0, 0], playhouse: [1.4, 0], climbingwall: [1.8, 1.8], zipwire: [3, 0],
};
const SETS = [ // by area (m²): what a public playground without mapped equipment gets, largest first
  { min: 600, kinds: ["structure", "swing", "roundabout", "sandpit", "seesaw", "basketswing", "springy", "springy"] },
  { min: 250, kinds: ["structure", "swing", "sandpit", "seesaw", "springy", "springy"] },
  { min: 90, kinds: ["swing", "sandpit", "springy"] },
  { min: 0, kinds: ["sandpit", "springy"] },
];

const rand = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const area = (r: P2[]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
function inside([x, y]: P2, r: P2[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
function edgeDistance([x, y]: P2, r: P2[]) {
  let d = Infinity;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t));
  }
  return d;
}
/** the long axis of a ring (radians) */
function axis(r: P2[]) {
  const n = r.length, cx = r.reduce((a, p) => a + p[0], 0) / n, cy = r.reduce((a, p) => a + p[1], 0) / n;
  let xx = 0, xy = 0, yy = 0;
  for (const [x, y] of r) { xx += (x - cx) ** 2; xy += (x - cx) * (y - cy); yy += (y - cy) ** 2; }
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}
const circle = (x: number, y: number, r: number): P2[] => Array.from({ length: 20 }, (_, i) => [x + r * Math.cos((i / 20) * 2 * Math.PI), y + r * Math.sin((i / 20) * 2 * Math.PI)] as P2);

/** The playgrounds of osm-play.json in the frame `toEnu` maps lon, lat into. */
export function playLayout(osm: { elements: El[] }, toEnu: (lon: number, lat: number) => P2): Layout {
  const ring = (g: Array<{ lat: number; lon: number }>) => g.map((q) => toEnu(q.lon, q.lat));
  const grounds: Array<{ r: P2[]; id: number; public: boolean; mapped: Item[] }> = [];
  const loose: Item[] = [], sand: P2[][] = [];
  for (const el of osm.elements) {
    const t = el.tags ?? {};
    if (t.leisure === "playground") {
      const rings = el.type === "way" && el.geometry ? [ring(el.geometry)] : (el.members ?? []).filter((m) => m.role === "outer" && m.geometry).map((m) => ring(m.geometry!));
      for (const r of rings) if (r.length >= 4 && Math.abs(area(r)) > 20) grounds.push({ r, id: el.id, public: t.access !== "private" && t.access !== "no", mapped: [] });
      continue;
    }
    const kind = t.playground;
    if (!kind) continue;
    if (el.type === "node") { const [x, y] = toEnu(el.lon!, el.lat!); loose.push({ kind, x, y, h: 0, c: el.id % 5 }); continue; }
    if (!el.geometry || el.geometry.length < 2) continue;
    const g = ring(el.geometry), closed = g.length >= 4 && Math.hypot(g[0][0] - g.at(-1)![0], g[0][1] - g.at(-1)![1]) < 0.01;
    if (kind === "sandpit" && closed) {
      sand.push(g);
      loose.push({ kind: "sandframe", x: g.reduce((a, q) => a + q[0], 0) / g.length, y: g.reduce((a, q) => a + q[1], 0) / g.length, h: 0, c: 0, len: sand.length - 1 });
      continue;
    }
    const cx = g.reduce((a, p) => a + p[0], 0) / g.length, cy = g.reduce((a, p) => a + p[1], 0) / g.length;
    const len = Math.hypot(g.at(-1)![0] - g[0][0], g.at(-1)![1] - g[0][1]);
    loose.push({ kind, x: cx, y: cy, h: closed ? axis(g) : Math.atan2(g.at(-1)![1] - g[0][1], g.at(-1)![0] - g[0][0]), c: el.id % 5, ...(kind === "zipwire" ? { len } : {}) });
  }
  const items: Item[] = [], pads: Layout["pads"] = [];
  for (const it of loose) {
    const home = it.kind === "sandframe" ? null : grounds.find((g) => inside([it.x, it.y], g.r));
    if (home) { it.h = it.h || axis(home.r); home.mapped.push(it); } else items.push(it);
  }
  for (const g of grounds) {
    const pad = g.id % 3, a = Math.abs(area(g.r)), turn = axis(g.r);
    let placed = g.mapped;
    if (!placed.length && g.public) {
      // a set by size, each where it is farthest from what is already placed, clear of the edge
      const set = SETS.find((s) => a >= s.min)!.kinds, rnd = rand(g.id % 2147483646 + 1);
      const xs = g.r.map((p) => p[0]), ys = g.r.map((p) => p[1]), cands: P2[] = [];
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) if (inside([x, y], g.r)) cands.push([x, y]);
      placed = [];
      for (const kind of set) {
        const [need] = SPACE[kind];
        let best: P2 | null = null, bestScore = -Infinity;
        for (const p of cands) {
          if (edgeDistance(p, g.r) < need * 0.7) continue;
          let near = Infinity;
          for (const q of placed) near = Math.min(near, Math.hypot(p[0] - q.x, p[1] - q.y) - SPACE[q.kind][0]);
          if (near < need * 0.8) continue;
          const score = Math.min(near, 30) + rnd() * 0.5;
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (best) placed.push({ kind, x: best[0], y: best[1], h: turn + (rnd() < 0.5 ? 0 : Math.PI / 2), c: Math.floor(rnd() * 5) });
      }
    }
    for (const it of placed) {
      items.push(it);
      const r = SPACE[it.kind]?.[1] ?? 0;
      if (g.public && r > 0) pads.push({ r: circle(it.x, it.y, r), v: pad });
    }
  }
  // a sandpit without an outline (a point, or placed here): a square of sand along its axis
  for (const it of items) if (it.kind === "sandpit") {
    const u = [Math.cos(it.h), Math.sin(it.h)], v = [-u[1], u[0]], s = 1.3;
    sand.push([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [it.x + (u[0] * i + v[0] * j) * s, it.y + (u[1] * i + v[1] * j) * s] as P2));
    it.kind = "sandframe"; it.len = sand.length - 1;
  }
  return { items, sand, pads };
}

// ---- equipment -------------------------------------------------------------------------------------
const RED = [0.86, 0.27, 0.22], YELLOW = [0.96, 0.78, 0.22], BLUE = [0.22, 0.48, 0.86], GREEN = [0.32, 0.68, 0.3], ORANGE = [0.95, 0.55, 0.2];
const WOOD = [0.64, 0.47, 0.32], METAL = [0.58, 0.6, 0.63], DARK = [0.2, 0.21, 0.22];
const BRIGHT = [RED, YELLOW, BLUE, GREEN, ORANGE];

/** The equipment of a layout as pieces on the ground (`ground`: terrain height); `sand`: the layout's sand rings. */
export function playPieces(layout: Layout, ground: (x: number, y: number) => number): Piece[] {
  const out: Piece[] = [];
  for (const it of layout.items) {
    const base = ground(it.x, it.y), u: P2 = [Math.cos(it.h), Math.sin(it.h)], v: P2 = [-u[1], u[0]];
    const at = (a: number, b: number, z: number): P3 => [it.x + u[0] * a + v[0] * b, it.y + u[1] * a + v[1] * b, z];
    const xy = (a: number, b: number): P2 => [it.x + u[0] * a + v[0] * b, it.y + u[1] * a + v[1] * b];
    const parts = new Map<string, Piece>();
    const p = (rgb: number[], roof = rgb) => {
      const k = `${rgb}|${roof}`;
      if (!parts.has(k)) parts.set(k, { roof: [], wall: [], footprint: [xy(-1.5, -1.5), xy(1.5, -1.5), xy(1.5, 1.5), xy(-1.5, 1.5)], height: 3, base, look: { roof, wall: rgb, style: CLAD, bare: 3 } });
      return parts.get(k)!;
    };
    const col = (k = 0) => BRIGHT[(it.c + k) % BRIGHT.length];
    const box = (q: Piece, a0: number, b0: number, a1: number, b1: number, z0: number, z1: number) => prism(q, [xy(a0, b0), xy(a1, b0), xy(a1, b1), xy(a0, b1)], z0, z1);
    switch (it.kind) {
      case "swing": case "basketswing": {
        const f = p(col());
        for (const a of [-1.5, 1.5]) for (const b of [-0.8, 0.8]) beam(f, at(a, b, 0), at(a, 0, 2.3), 0.1);
        beam(f, at(-1.6, 0, 2.3), at(1.6, 0, 2.3), 0.12);
        const seat = p(it.kind === "basketswing" ? col(2) : DARK);
        if (it.kind === "basketswing") {
          prism(seat, Array.from({ length: 10 }, (_, i) => xy(0.55 * Math.cos((i / 10) * 2 * Math.PI), 0.55 * Math.sin((i / 10) * 2 * Math.PI))), 0.45, 0.6);
          for (const a of [-0.4, 0.4]) beam(p(DARK), at(a, 0, 2.3), at(a * 0.9, 0, 0.6), 0.04);
        } else for (const a of [-0.6, 0.6]) {
          box(seat, a - 0.22, -0.1, a + 0.22, 0.1, 0.42, 0.48);
          for (const d of [-0.18, 0.18]) beam(p(DARK), at(a + d, 0, 2.3), at(a + d, 0, 0.48), 0.04);
        }
        break;
      }
      case "structure": case "climbingframe": {
        const w = p(WOOD), roof = p(col(), col());
        for (const a of [-0.7, 0.7]) for (const b of [-0.7, 0.7]) beam(w, at(a, b, 0), at(a, b, 2.3), 0.12);
        box(w, -0.75, -0.75, 0.75, 0.75, 1.2, 1.3);
        panel(p(col(1)), [xy(-0.75, -0.75), xy(-0.75, 0.75)], 1.3, 1.95, false);
        panel(p(col(1)), [xy(0.75, 0.75), xy(-0.75, 0.75)], 1.3, 1.95, false);
        for (const [a0, b0, a1, b1] of [[-0.85, -0.85, 0.85, -0.85], [0.85, -0.85, 0.85, 0.85], [0.85, 0.85, -0.85, 0.85], [-0.85, 0.85, -0.85, -0.85]])
          roofFace(roof, [at(a0, b0, 2.2), at(a1, b1, 2.2), at(0, 0, 2.9)]);
        if (it.kind === "structure") { // a slide down one side, a ladder up the other
          const s = p(col(2));
          roofFace(s, [at(0.75, -0.28, 1.25), at(3.1, -0.28, 0.25), at(3.1, 0.28, 0.25), at(0.75, 0.28, 1.25)]);
          for (const b of [-0.3, 0.3]) beam(s, at(0.75, b, 1.45), at(3.1, b, 0.45), 0.06);
          for (const b of [-0.28, 0.28]) beam(w, at(-1.3, b, 0), at(-0.75, b, 1.3), 0.06);
          for (let k = 1; k < 5; k++) beam(w, at(-1.3 + 0.11 * k, -0.28, 0.26 * k), at(-1.3 + 0.11 * k, 0.28, 0.26 * k), 0.04);
        }
        break;
      }
      case "slide": {
        const s = p(col()), m = p(METAL);
        for (const b of [-0.3, 0.3]) beam(m, at(-1.2, b, 0), at(-0.8, b, 1.5), 0.06);
        box(m, -0.9, -0.35, -0.5, 0.35, 1.4, 1.5);
        roofFace(s, [at(-0.5, -0.28, 1.45), at(1.9, -0.28, 0.25), at(1.9, 0.28, 0.25), at(-0.5, 0.28, 1.45)]);
        for (const b of [-0.3, 0.3]) beam(s, at(-0.5, b, 1.65), at(1.9, b, 0.45), 0.06);
        break;
      }
      case "seesaw": {
        box(p(METAL), -0.15, -0.15, 0.15, 0.15, 0, 0.45);
        const plank = p(col());
        beam(plank, at(-1.5, 0, 0.3), at(1.5, 0, 0.7), 0.24);
        for (const a of [-1.2, 1.2]) beam(p(col(1)), at(a, -0.25, a < 0 ? 0.55 : 0.85), at(a, 0.25, a < 0 ? 0.55 : 0.85), 0.06);
        break;
      }
      case "roundabout": {
        const d = p(col(), col());
        prism(d, Array.from({ length: 12 }, (_, i) => xy(0.95 * Math.cos((i / 12) * 2 * Math.PI), 0.95 * Math.sin((i / 12) * 2 * Math.PI))), 0.2, 0.32);
        beam(p(METAL), at(0, 0, 0.32), at(0, 0, 0.95), 0.08);
        for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2; beam(p(METAL), at(0, 0, 0.9), at(0.8 * Math.cos(a), 0.8 * Math.sin(a), 0.55), 0.05); }
        break;
      }
      case "springy": case "spring_board": {
        beam(p(DARK), at(0, 0, 0), at(0, 0, 0.35), 0.12);
        box(p(col()), -0.32, -0.12, 0.32, 0.12, 0.35, 0.7);
        box(p(col(1)), 0.2, -0.1, 0.42, 0.1, 0.6, 0.9);
        break;
      }
      case "trampoline": {
        const t = p(BLUE, DARK);
        prism(t, Array.from({ length: 14 }, (_, i) => xy(1.6 * Math.cos((i / 14) * 2 * Math.PI), 1.6 * Math.sin((i / 14) * 2 * Math.PI))), 0.5, 0.62);
        for (let k = 0; k < 6; k++) { const a = (k * Math.PI) / 3, q = at(1.55 * Math.cos(a), 1.55 * Math.sin(a), 0); beam(p(DARK), q, [q[0], q[1], 2.1], 0.05); }
        break;
      }
      case "playhouse": {
        box(p(WOOD), -0.75, -0.65, 0.75, 0.65, 0, 1.3);
        const r = p(col(), col());
        roofFace(r, [at(-0.85, -0.75, 1.3), at(0.85, -0.75, 1.3), at(0.85, 0, 1.9), at(-0.85, 0, 1.9)]);
        roofFace(r, [at(0.85, 0.75, 1.3), at(-0.85, 0.75, 1.3), at(-0.85, 0, 1.9), at(0.85, 0, 1.9)]);
        break;
      }
      case "climbingwall": {
        box(p(col()), -1.3, -0.12, 1.3, 0.12, 0, 2.4);
        for (let k = 0; k < 10; k++) { const a = -1.1 + (k % 5) * 0.55, z = 0.5 + Math.floor(k / 5) * 1.0 + (k % 2) * 0.3; box(p(col(k % 4 + 1)), a - 0.08, 0.12, a + 0.08, 0.2, z, z + 0.12); }
        break;
      }
      case "zipwire": {
        const L = Math.max(8, Math.min(40, it.len ?? 15)), m = p(METAL);
        beam(m, at(-L / 2, 0, 0), at(-L / 2, 0, 2.8), 0.14); beam(m, at(L / 2, 0, 0), at(L / 2, 0, 2.2), 0.14);
        beam(p(DARK), at(-L / 2, 0, 2.7), at(L / 2, 0, 2.1), 0.04);
        break;
      }
      case "sandframe": {
        const ring = layout.sand[it.len ?? 0];
        if (ring) { const f = p(WOOD); f.base = ground(ring[0][0], ring[0][1]); panel(f, ring, 0, 0.25); }
        break;
      }
      default: { // balance beams, activity panels, monkey bars, rotators…: a small frame
        const f = p(col());
        for (const a of [-0.8, 0.8]) beam(f, at(a, 0, 0), at(a, 0, 1.5), 0.08);
        beam(f, at(-0.85, 0, 1.45), at(0.85, 0, 1.45), 0.08);
      }
    }
    out.push(...parts.values());
  }
  return out;
}
