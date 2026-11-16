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
