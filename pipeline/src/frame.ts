/**
 * A local frame for hand-built structures (portals.ts, bridgemodels.ts): `a` along a direction `d`, `b`
 * to its left, heights above `base`. `block` adds a prism over an (a, b) rectangle whose bottom and top
 * may vary with (a, b): arches, sloped wing walls, girders that follow a deck.
 */
import type { Piece } from "./landmarks.ts";

export type P2 = [number, number];
type Z = number | ((a: number, b: number) => number);

export function frame(o: P2, d: P2, base: number) {
  const v: P2 = [-d[1], d[0]];
  const at = (a: number, b: number): P2 => [o[0] + d[0] * a + v[0] * b, o[1] + d[1] * a + v[1] * b];
  /** where a point lies in the frame */
  const local = (p: P2): P2 => { const x = p[0] - o[0], y = p[1] - o[1]; return [x * d[0] + y * d[1], x * v[0] + y * v[1]]; };
  /** a Piece of one colour over the (a, b) rectangle; its footprint is only a bounding box, so it casts no footprint shadow */
  const piece = (a0: number, a1: number, b0: number, b1: number, height: number, rgb: number[], style = 4): Piece =>
    ({ roof: [], wall: [], footprint: [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)], height, base, look: { roof: rgb, wall: rgb, style, bare: 3 } });
  /** prism over (a0..a1) × (b0..b1) from z0 to zt (heights above base); a top steeper than 45° is a wall */
  const block = (p: Piece, a0: number, a1: number, b0: number, b1: number, z0: Z, zt: Z) => {
    const f = (z: Z) => (typeof z === "number" ? () => z : z);
    const lo = f(z0), hi = f(zt);
    const c: P2[] = [[a0, b0], [a1, b0], [a1, b1], [a0, b1]];
    let s = 0;
    for (let i = 0; i < 4; i++) { // counter-clockwise seen from above: right of each edge is outside
      const pa = c[i], pb = c[(i + 1) % 4], A = at(...pa), B = at(...pb), L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const [la, lb, ha, hb] = [lo(...pa), lo(...pb), hi(...pa), hi(...pb)];
      if (ha <= la && hb <= lb) { s += L; continue; }
      p.wall.push(A[0], A[1], base + la, s, la, B[0], B[1], base + lb, s + L, lb, B[0], B[1], base + hb, s + L, hb,
        A[0], A[1], base + la, s, la, B[0], B[1], base + hb, s + L, hb, A[0], A[1], base + ha, s, ha);
      s += L;
    }
    const q = c.map(([a, b]) => [...at(a, b), base + hi(a, b)]);
    const rise = Math.max(Math.abs(hi(a1, b0) - hi(a0, b0)) / (a1 - a0), Math.abs(hi(a0, b1) - hi(a0, b0)) / (b1 - b0));
    if (rise < 1) p.roof.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
    else for (const k of [0, 1, 2, 0, 2, 3]) p.wall.push(...q[k], 0, hi(...c[k]));
  };
  return { at, local, piece, block };
}
