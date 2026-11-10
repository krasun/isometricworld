/**
 * Hand-modelled landmarks for the procedural (LoD2) look, where LoD2 and OSM building:parts are too coarse.
 * Shapes come from published dimensions (de.wikipedia, OSM building:parts); the Wikimedia Commons photos in
 * ATTRIBUTION.md were only looked at for proportions and colours.
 *
 * A Piece is one mesh with one look (scene.ts turns it into a mesh entry): `roof` holds level triangles
 * (x, y, z), `wall` everything else (x, y, z, along, above), as in the LoD2 meshes. The renderer lifts
 * downward roof faces, so every sloped or vertical surface is a wall.
 */

type P2 = [number, number];
type Look = { roof: number[] | null; wall: number[] | null; style: number };
export type Piece = { roof: number[]; wall: number[]; footprint: P2[]; height: number; base: number; look: Look };

const CONCRETE = [0.82, 0.82, 0.8], ALU = [0.89, 0.89, 0.9], GLASS = [0.2, 0.23, 0.27], WHITE = [0.94, 0.94, 0.93];
const RED = [0.8, 0.2, 0.16], SILVER = [0.86, 0.87, 0.89];
const CLAD = 4; // façade style: cladding lines, no windows, no rooftop clutter

function piece(c: P2, base: number, r: number, height: number, look: Look): Piece {
  const footprint: P2[] = [];
  for (let i = 0; i < 16; i++) footprint.push([c[0] + r * Math.cos((i / 16) * 2 * Math.PI), c[1] + r * Math.sin((i / 16) * 2 * Math.PI)]);
  return { roof: [], wall: [], footprint, height, base, look };
}

/** quad a-b-c-d (counter-clockwise seen from outside) as two wall triangles; s = along, z = above per corner */
function quad(p: Piece, v: Array<[number, number, number, number, number]>) {
  for (const k of [0, 1, 2, 0, 2, 3]) p.wall.push(...v[k]);
}

/** surface of revolution around c: rings [z, r] from bottom to top, n sides, heights above `base` */
function lathe(p: Piece, c: P2, rings: Array<[number, number]>, n: number) {
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
function disc(p: Piece, c: P2, z: number, outer: number, inner: number, n: number) {
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

/**
 * Fernsehturm Stuttgart (1956, Leonhardt): 216.6 m. Concrete shaft 10.8 m wide at the foot, parabolic taper
 * to 5.04 m at the basket (138 m). Basket of four storeys (138/141/144/147 m), the lower three leaning out 9°,
 * aluminium parapets and window bands, 14.6 m wide (OSM part). Two platforms (150, 152.8 m), concrete head
 * to 161 m, then the red and white antenna. `base` is the ground at the foot.
 */
function fernsehturm(c: P2, base: number): Piece[] {
  const N = 32, out: Piece[] = [];
  const shaft = piece(c, base, 5.4, 161, { roof: CONCRETE, wall: CONCRETE, style: CLAD });
  const zs = [0, 3, 7, 12, 19, 28, 40, 55, 72, 92, 114, 138];
  lathe(shaft, c, zs.map((z) => [z, 2.52 + 2.88 * (1 - z / 138) ** 2.2]), N);
  out.push(shaft);
  // basket: radius 7.3 m from 147 m up, 3 m storeys leaning out 9° below
  const R = 7.3, lean = Math.tan((9 * Math.PI) / 180);
  const rAt = (z: number) => (z >= 147 ? R : R - (147 - z) * lean);
  const alu = piece(c, base, R, 150, { roof: ALU, wall: ALU, style: CLAD });
  const glass = piece(c, base, R, 150, { roof: ALU, wall: GLASS, style: CLAD });
  for (let s = 0; s < 4; s++) {
    const z0 = 138 + 3 * s, zp = z0 + 1.1, z1 = z0 + 3;
    lathe(alu, c, [[z0, rAt(z0)], [zp, rAt(zp)]], N);     // parapet
    lathe(glass, c, [[zp, rAt(zp)], [z1, rAt(z1)]], N);   // window band
  }
  disc(alu, c, 150, R, 4.58, N);
  out.push(alu, glass);
  // platforms 150–153 m (white, open), concrete head 153–161 m
  const deck = piece(c, base, 4.58, 153, { roof: WHITE, wall: WHITE, style: CLAD });
  lathe(deck, c, [[150, 4.58], [151.2, 4.58]], N);
  lathe(deck, c, [[152.8, 4.58], [153, 4.58]], N);
  disc(deck, c, 153, 4.58, 3.03, N);
  const gap = piece(c, base, 3.4, 153, { roof: GLASS, wall: GLASS, style: CLAD });
  lathe(gap, c, [[151.2, 3.4], [152.8, 3.4]], N);           // shaded platform interior
  const head = piece(c, base, 3.03, 161, { roof: CONCRETE, wall: CONCRETE, style: CLAD });
  lathe(head, c, [[153, 3.03], [161, 2.8]], N);
  disc(head, c, 161, 2.8, 1.21, N);
  out.push(deck, gap, head);
  // antenna 161–216.6 m: ten red and white bands, tapering
  const top = 216.6, bands = 10, rA = (z: number) => 1.21 - (0.9 * (z - 161)) / (top - 161);
  const red = piece(c, base, 1.21, top, { roof: RED, wall: RED, style: CLAD });
  const white = piece(c, base, 1.21, top, { roof: WHITE, wall: WHITE, style: CLAD });
  for (let k = 0; k < bands; k++) {
    const z0 = 161 + ((top - 161) * k) / bands, z1 = 161 + ((top - 161) * (k + 1)) / bands;
    lathe(k % 2 ? white : red, c, [[z0, rA(z0)], [z1, rA(z1)]], 12);
  }
  disc(white, c, top, rA(top), 0, 12);
  out.push(red, white);
  return out;
}

/**
 * Mercedes star on the Bahnhofsturm (since 1952, 5 m across, rotating): a vertical ring with three prongs on a
 * short mast, turned to face the camera (`headingDeg`). `top` is the roof height of the tower.
 */
function mercedesStar(c: P2, top: number, headingDeg: number): Piece[] {
  const h = (headingDeg * Math.PI) / 180;
  const n: P2 = [-Math.sin(h), -Math.cos(h)], u: P2 = [-n[1], n[0]]; // toward the camera, sideways
  const mast = piece(c, top, 0.6, 2, { roof: SILVER, wall: [0.55, 0.56, 0.58], style: CLAD });
  lathe(mast, c, [[0, 0.6], [0.4, 0.6], [0.4, 0.25], [2, 0.25]], 8);
  disc(mast, c, 0.4, 0.6, 0.25, 8);
  const star = piece(c, top, 2.5, 6.5, { roof: SILVER, wall: SILVER, style: CLAD });
  const cz = 4, R = 2.5, r = 2.12, d = 0.18; // centre 4 m above the roof, ring 0.38 m wide, 0.36 m deep
  const P = (a: number, rad: number, off: number): [number, number, number, number, number] => {
    const s = rad * Math.cos(a), z = cz + rad * Math.sin(a);
    return [c[0] + u[0] * s + n[0] * off, c[1] + u[1] * s + n[1] * off, top + z, s + 10, z + 10];
  };
  const M = 32;
  for (let i = 0; i < M; i++) {
    const a0 = (i / M) * 2 * Math.PI, a1 = ((i + 1) / M) * 2 * Math.PI;
    for (const off of [d, -d]) quad(star, [P(a0, r, off), P(a0, R, off), P(a1, R, off), P(a1, r, off)]); // faces
    quad(star, [P(a0, R, d), P(a0, R, -d), P(a1, R, -d), P(a1, R, d)]);                              // rim
    quad(star, [P(a0, r, d), P(a0, r, -d), P(a1, r, -d), P(a1, r, d)]);
  }
  // prongs: up and ±120°, each a ridged blade 0.7 m wide at the hub, pointed at the ring
  for (const a of [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3]) {
    const side = 0.35, tip = P(a, r, 0), l = P(a + Math.PI / 2, side, 0), rr = P(a - Math.PI / 2, side, 0);
    const ridge = P(a, 0, d * 1.6), back = P(a, 0, -d * 1.6);
    for (const k of [tip, l, ridge, tip, ridge, rr, tip, back, l, tip, rr, back]) star.wall.push(...k);
  }
  return [mast, star];
}

/** towers replaced as a whole: model at the centre of the OSM outline, standing on `base` */
export const TOWERS: Record<string, (c: P2, base: number) => Piece[]> = {
  "Fernsehturm Stuttgart": fernsehturm,
};

/** additions on top of a LoD2 building: model at the centre of the OSM outline, on its highest roof point */
export const TOPS: Record<string, (c: P2, top: number, headingDeg: number) => Piece[]> = {
  Bahnhofsturm: mercedesStar,
};
