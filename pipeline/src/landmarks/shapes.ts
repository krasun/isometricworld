/**
 * Building blocks of hand-modelled landmarks (landmarks.ts; one file per region in this folder).
 *
 * A Piece is one mesh with one look (scene.ts turns it into a mesh entry): `roof` holds level triangles
 * (x, y, z), `wall` everything else (x, y, z, along, above), as in the LoD2 meshes. The renderer lifts
 * downward roof faces, so every sloped or vertical surface is a wall.
 */

export type P2 = [number, number];
/** bare: 1 = no roof furniture; 2 = also a bridge deck: a drop shadow instead of a footprint shadow; 3 = no shadow (hand-built
 * structures whose footprint is only a bounding box) */
export type Look = { roof: number[] | null; wall: number[] | null; style: number; bare?: 1 | 2 | 3 };
export type Piece = { roof: number[]; wall: number[]; footprint: P2[]; height: number; base: number; look: Look };

export const CLAD = 4; // façade style: cladding lines, no windows, no rooftop clutter

export function piece(c: P2, base: number, r: number, height: number, look: Look): Piece {
  const footprint: P2[] = [];
  for (let i = 0; i < 16; i++) footprint.push([c[0] + r * Math.cos((i / 16) * 2 * Math.PI), c[1] + r * Math.sin((i / 16) * 2 * Math.PI)]);
  return { roof: [], wall: [], footprint, height, base, look };
}

/** quad a-b-c-d (counter-clockwise seen from outside) as two wall triangles; s = along, z = above per corner */
export function quad(p: Piece, v: Array<[number, number, number, number, number]>) {
  for (const k of [0, 1, 2, 0, 2, 3]) p.wall.push(...v[k]);
}

/** surface of revolution around c: rings [z, r] from bottom to top, n sides, heights above `base` */
export function lathe(p: Piece, c: P2, rings: Array<[number, number]>, n: number) {
  for (let k = 0; k + 1 < rings.length; k++) {
    const [z0, r0] = rings[k], [z1, r1] = rings[k + 1];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI;
      const at = (a: number, r: number, z: number, s: number): [number, number, number, number, number] =>
        [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), p.base + z, s, z];
      quad(p, [at(a0, r0, z0, a0 * r0), at(a1, r0, z0, a1 * r0), at(a1, r1, z1, a1 * r1), at(a0, r1, z1, a0 * r1)]);
    }
  }
}

/** level ring (annulus, or a disc if inner = 0) at height z above base, as roof triangles */
export function disc(p: Piece, c: P2, z: number, outer: number, inner: number, n: number) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI;
    const o0 = [c[0] + outer * Math.cos(a0), c[1] + outer * Math.sin(a0), p.base + z];
    const o1 = [c[0] + outer * Math.cos(a1), c[1] + outer * Math.sin(a1), p.base + z];
    if (inner <= 0) { p.roof.push(c[0], c[1], p.base + z, ...o0, ...o1); continue; }
    const i0 = [c[0] + inner * Math.cos(a0), c[1] + inner * Math.sin(a0), p.base + z];
    const i1 = [c[0] + inner * Math.cos(a1), c[1] + inner * Math.sin(a1), p.base + z];
    p.roof.push(...i0, ...o0, ...o1, ...i0, ...o1, ...i1);
  }
}

// ---- straight-edged parts (headframes, platforms) --------------------------------------------------------
// Heights are above the piece's base. Faces are wound by these helpers (the renderer culls back faces).

export type P3 = [number, number, number];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: P3): P3 => mul(a, 1 / (Math.hypot(...a) || 1));
const area2 = (r: P2[]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);

/** Local axes around c: u along `bearing` (compass °), v 90° clockwise of it; returns ENU x, y. */
export function frame(c: P2, bearing: number) {
  const a = (bearing * Math.PI) / 180, s = Math.sin(a), k = Math.cos(a);
  return (u: number, v: number): P2 => [c[0] + s * u + k * v, c[1] + k * u - s * v];
}

/** Flat convex polygon as a wall face turned away from `inside` (a point within the solid). */
export function face(p: Piece, v: P3[], inside: P3) {
  const n = cross(sub(v[1], v[0]), sub(v[2], v[0])), m = mul(v.reduce(add), 1 / v.length);
  const w = n[0] * (m[0] - inside[0]) + n[1] * (m[1] - inside[1]) + n[2] * (m[2] - inside[2]) >= 0 ? v : [...v].reverse();
  const s = (q: P3) => Math.hypot(q[0] - w[0][0], q[1] - w[0][1]); // along the face, for the cladding pattern
  for (let i = 1; i + 1 < w.length; i++) for (const q of [w[0], w[i], w[i + 1]]) p.wall.push(q[0], q[1], p.base + q[2], s(q), q[2]);
}

/** Sloped or level convex polygon facing up (a roof surface: the roof colour). */
export function roofFace(p: Piece, v: P3[]) {
  const w = area2(v.map((q) => [q[0], q[1]] as P2)) >= 0 ? v : [...v].reverse();
  for (let i = 1; i + 1 < w.length; i++) for (const q of [w[0], w[i], w[i + 1]]) p.roof.push(q[0], q[1], p.base + q[2]);
}

/** Vertical prism over a convex ring from z0 to z1, with a level top unless `top` is false. */
export function prism(p: Piece, ring: P2[], z0: number, z1: number, top = true) {
  const cx = ring.reduce((a, q) => a + q[0], 0) / ring.length, cy = ring.reduce((a, q) => a + q[1], 0) / ring.length;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    face(p, [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], [cx, cy, (z0 + z1) / 2]);
  }
  if (top) roofFace(p, ring.map((q) => [q[0], q[1], z1]));
}

/** Straight member of square section w from a to b (legs, braces, struts, poles). */
export function beam(p: Piece, a: P3, b: P3, w: number) {
  const d = sub(b, a), e1 = unit(cross(d, Math.abs(d[2]) > 0.9 * Math.hypot(...d) ? [1, 0, 0] : [0, 0, 1])), e2 = unit(cross(d, e1));
  const off = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([i, j]) => add(mul(e1, (i * w) / 2), mul(e2, (j * w) / 2)));
  const mid = mul(add(a, b), 0.5);
  for (let k = 0; k < 4; k++) { const o = off[k], q = off[(k + 1) % 4]; face(p, [add(a, o), add(a, q), add(b, q), add(b, o)], mid); }
}

/** Thin panel (railing, flag) along a polyline from z0 to z1, seen from both sides. */
export function panel(p: Piece, line: P2[], z0: number, z1: number, closed = true) {
  let s = 0;
  for (let i = 0; i + (closed ? 0 : 1) < line.length; i++) {
    const a = line[i], b = line[(i + 1) % line.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const f: Array<[number, number, number, number, number]> = [[a[0], a[1], p.base + z0, s, z0], [b[0], b[1], p.base + z0, s + L, z0], [b[0], b[1], p.base + z1, s + L, z1], [a[0], a[1], p.base + z1, s, z1]];
    quad(p, f);
    quad(p, [f[1], f[0], f[3], f[2]]);
    s += L;
  }
}
