/**
 * Structures OSM maps but LoD2 and BDOT10k leave out (they are not buildings there), built from their OSM
 * outline: the STRUCTURES registry in landmarks.ts picks them by tag, so every place gets them.
 */
import * as THREE from "three";
import type { Rings } from "../landmarks.ts";
import { CLAD, type P2, type Piece, quad } from "./shapes.ts";

/** blackthorn brushwood, nearly black when wet with brine; larch walkway and railings */
const BRUSHWOOD = [0.31, 0.25, 0.20], LARCH = [0.78, 0.60, 0.38];

/**
 * Graduation tower (tężnia, Gradierwerk) mapped as a building with man_made=graduation_tower: brushwood walls
 * along its outline (holes: the courtyard of a ring-shaped one), `height` or 10 m tall, a level larch walkway
 * on top with railings along both edges.
 */
export function graduationTower(r: Rings, ground: (x: number, y: number) => number, t: Record<string, string>): Piece[] {
  const pts = [...r.outer, ...r.inner].flat(), gs = pts.map(([x, y]) => ground(x, y));
  const base = Math.min(...gs), H = parseFloat(t.height) || 10;
  const top = gs.reduce((a, g) => a + g, 0) / gs.length + H - base; // a level top over sloping ground
  const wall: Piece = { roof: [], wall: [], footprint: r.outer[0], height: top, base, look: { roof: LARCH, wall: BRUSHWOOD, style: CLAD, bare: 1 } };
  const rail: Piece = { roof: [], wall: [], footprint: r.outer[0], height: top + 1.1, base, look: { roof: LARCH, wall: LARCH, style: CLAD, bare: 1 } };
  // walls: outer rings counter-clockwise, holes clockwise, so every face looks away from the brushwood
  const rings = [...r.outer.map((q) => q), ...r.inner.map((q) => [...q].reverse())];
  for (const ring of rings) {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const za = ground(...a) - 0.5 - base, zb = ground(...b) - 0.5 - base;
      quad(wall, [[a[0], a[1], base + za, s, za], [b[0], b[1], base + zb, s + L, zb], [b[0], b[1], base + top, s + L, top], [a[0], a[1], base + top, s, top]]);
      // railing on the edge, seen from both sides (the walkway and the outside)
      const front: Array<[number, number, number, number, number]> = [[a[0], a[1], base + top, s, top], [b[0], b[1], base + top, s + L, top], [b[0], b[1], base + top + 1.1, s + L, top + 1.1], [a[0], a[1], base + top + 1.1, s, top + 1.1]];
      quad(rail, front);
      quad(rail, [front[1], front[0], front[3], front[2]]);
      s += L;
    }
  }
  // walkway: the outline with its holes, level at the top
  const v = (q: P2) => new THREE.Vector2(q[0], q[1]);
  for (const outer of r.outer) {
    const holes = r.inner.filter((h) => inRing(h[0], outer));
    const all = [outer, ...holes].flat();
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(outer.map(v), holes.map((h) => h.map(v)))) {
      const [a, b, c] = [all[i], all[j], all[k]];
      const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
      for (const q of ccw ? [a, b, c] : [a, c, b]) wall.roof.push(q[0], q[1], base + top);
    }
  }
  return [wall, rail];
}

function inRing([x, y]: P2, r: P2[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
