/**
 * Fences, walls and hedges (preset `barriers`): the barrier lines OSM maps (fetch.ts osm-barriers.json), following
 * the terrain. A fence is drawn see-through, posts every 2.5 m and rails (a panel fence, the usual round Polish
 * gardens; railings lower, chain link and wire mesh green-grey); walls are solid (plaster, 1.8 m); noise barriers
 * along the motorways 3.5 m grey-green panels; retaining walls low concrete; guard rails a metal rail on posts.
 * OSM `height` wins. Hedges become rows of bushes (page/trees.ts richBushes), left out where the surface model
 * already found a bush.
 */
import { beam, CLAD, type P2, type P3, type Piece } from "./landmarks/shapes.ts";

type Tags = Record<string, string>;
type El = { type: string; id: number; geometry?: Array<{ lat: number; lon: number }>; tags?: Tags };

const METAL = [0.33, 0.35, 0.37], MESH = [0.42, 0.52, 0.44], WOOD = [0.58, 0.44, 0.31], CONCRETE = [0.72, 0.71, 0.68];
const PLASTER = [0.86, 0.84, 0.79], NOISE = [0.55, 0.62, 0.58];

/** What a barrier is: its kind (fence, wall, hedge…), height and colour. */
function kindOf(t: Tags) {
  const h = parseFloat(t.height ?? "");
  const b = t.barrier, ft = t.fence_type ?? "", m = t.material ?? "";
  const tall = (d: number) => (h > 0.3 && h < 8 ? h : d);
  if (b === "hedge") return { kind: "hedge", h: tall(1.6), rgb: MESH };
  if (b === "retaining_wall") return { kind: "wall", h: tall(1.0), rgb: CONCRETE, w: 0.3 };
  if (b === "guard_rail") return { kind: "rail", h: 0.75, rgb: [0.68, 0.7, 0.72] };
  if (b === "noise_barrier" || t.wall === "noise_barrier") return { kind: "wall", h: tall(3.5), rgb: NOISE, w: 0.2 };
  if (b === "wall" || b === "city_wall") return { kind: "wall", h: tall(1.8), rgb: m === "concrete" ? CONCRETE : PLASTER, w: 0.25 };
  if (b === "fence") {
    if (ft === "railing") return { kind: "fence", h: tall(1.0), rgb: METAL };
    if (/chain_link|wire|net|mesh/.test(ft)) return { kind: "fence", h: tall(1.6), rgb: MESH };
    if (m === "wood" || ft === "wood") return { kind: "fence", h: tall(1.3), rgb: WOOD };
    return { kind: "fence", h: tall(1.5), rgb: METAL };
  }
  return null;
}

/**
 * The barriers of osm-barriers.json within `inBox` (ENU), `toEnu` mapping lon, lat into it: pieces for fences, walls
 * and rails, bush positions ([x, y, radius, top]) for hedges away from the `near` bushes already there.
 */
export function barriers(osm: { elements: El[] }, toEnu: (lon: number, lat: number) => P2, ground: (x: number, y: number) => number,
  inBox: (p: P2) => boolean, nearBush: (x: number, y: number) => boolean) {
  const pieces: Piece[] = [], hedges: Array<[number, number, number, number]> = [];
  let km = 0;
  for (const el of osm.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const k = kindOf(el.tags ?? {});
    if (!k) continue;
    const line = el.geometry.map((q) => toEnu(q.lon, q.lat));
    if (!line.some(inBox)) continue;
    if (k.kind === "hedge") { // a row of bushes every 0.9 m
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / 0.9));
        for (let j = i === 1 ? 0 : 1; j <= n; j++) {
          const x = a[0] + ((b[0] - a[0]) * j) / n, y = a[1] + ((b[1] - a[1]) * j) / n;
          if (!nearBush(x, y)) hedges.push([x, y, 0.65, k.h + (((x * 7.3 + y * 3.1) % 1) - 0.5) * 0.3]);
        }
        km += L / 1000;
      }
      continue;
    }
    const base = Math.min(...line.map(([x, y]) => ground(x, y)));
    const p: Piece = { roof: [], wall: [], footprint: [], height: k.h, base, look: { roof: k.rgb, wall: k.rgb, style: CLAD, bare: 3 } };
    const xs = line.map((q) => q[0]), ys = line.map((q) => q[1]);
    p.footprint = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]];
    const z = (x: number, y: number) => ground(x, y) - base; // this point's ground above the piece's base
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.05) continue;
      km += L / 1000;
      const n = Math.max(1, Math.round(L / 2.5)); // posts and rail pieces every ~2.5 m, each on its own ground
      const pts = Array.from({ length: n + 1 }, (_, j) => { const x = a[0] + ((b[0] - a[0]) * j) / n, y = a[1] + ((b[1] - a[1]) * j) / n; return [x, y, z(x, y)] as P3; });
      for (let j = 0; j < n; j++) {
        const [p0, p1] = [pts[j], pts[j + 1]];
        if (k.kind === "wall") { // a solid wall, both faces and its top
          const dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy) || 1, ox = (-dy / l) * (k.w ?? 0.25) / 2, oy = (dx / l) * (k.w ?? 0.25) / 2;
          for (const s of [1, -1]) panelAt(p, [p0[0] + ox * s, p0[1] + oy * s], [p1[0] + ox * s, p1[1] + oy * s], p0[2], p1[2], k.h);
          beam(p, [p0[0], p0[1], p0[2] + k.h - 0.05], [p1[0], p1[1], p1[2] + k.h - 0.05], (k.w ?? 0.25) + 0.04);
        } else if (k.kind === "rail") {
          beam(p, [p0[0], p0[1], p0[2] + k.h - 0.15], [p1[0], p1[1], p1[2] + k.h - 0.15], 0.12);
        } else { // fence: a top and a middle rail, a low base
          beam(p, [p0[0], p0[1], p0[2] + k.h - 0.05], [p1[0], p1[1], p1[2] + k.h - 0.05], 0.05);
          beam(p, [p0[0], p0[1], p0[2] + k.h * 0.5], [p1[0], p1[1], p1[2] + k.h * 0.5], 0.04);
          beam(p, [p0[0], p0[1], p0[2] + 0.1], [p1[0], p1[1], p1[2] + 0.1], 0.12);
        }
      }
      if (k.kind !== "wall") for (const q of pts) beam(p, [q[0], q[1], q[2]], [q[0], q[1], q[2] + k.h], k.kind === "rail" ? 0.1 : 0.07);
    }
    pieces.push(p);
  }
  return { pieces, hedges, km };
}

/** a vertical panel from a to b, each end standing on its own ground (za, zb), h tall */
function panelAt(p: Piece, a: P2, b: P2, za: number, zb: number, h: number) {
  // one quad per side (both faces, so the wall shows from anywhere); shapes.ts panel is level
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const f: Array<[number, number, number, number, number]> = [[a[0], a[1], p.base + za, 0, za], [b[0], b[1], p.base + zb, L, zb], [b[0], b[1], p.base + zb + h, L, zb + h], [a[0], a[1], p.base + za + h, 0, za + h]];
  for (const k of [0, 1, 2, 0, 2, 3]) p.wall.push(...f[k]);
  for (const k of [1, 0, 3, 1, 3, 2]) p.wall.push(...f[k]);
}
