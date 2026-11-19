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
/** bare: 1 = no roof furniture; 2 = also a bridge deck: a drop shadow instead of a footprint shadow; 3 = no shadow (hand-built
 * structures whose footprint is only a bounding box) */
type Look = { roof: number[] | null; wall: number[] | null; style: number; bare?: 1 | 2 | 3 };
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

/** surface of revolution around c: rings [z, r] from bottom to top, n sides (the first corner at `phase`), heights above `base` */
export function lathe(p: Piece, c: P2, rings: Array<[number, number]>, n: number, phase = 0) {
  for (let k = 0; k + 1 < rings.length; k++) {
    const [z0, r0] = rings[k], [z1, r1] = rings[k + 1];
    for (let i = 0; i < n; i++) {
      const a0 = phase + (i / n) * 2 * Math.PI, a1 = phase + ((i + 1) / n) * 2 * Math.PI;
      const at = (a: number, r: number, z: number, s: number): [number, number, number, number, number] =>
        [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), p.base + z, s, z];
      quad(p, [at(a0, r0, z0, a0 * r0), at(a1, r0, z0, a1 * r0), at(a1, r1, z1, a1 * r1), at(a0, r1, z1, a0 * r1)]);
    }
  }
}

/** level ring (annulus, or a disc if inner = 0) at height z above base, as roof triangles */
function disc(p: Piece, c: P2, z: number, outer: number, inner: number, n: number, phase = 0) {
  for (let i = 0; i < n; i++) {
    const a0 = phase + (i / n) * 2 * Math.PI, a1 = phase + ((i + 1) / n) * 2 * Math.PI;
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

/**
 * Looks for named landmarks whose OSM tags are missing or off (e.g. the Neues Schloss is tagged near-white with a
 * brown roof; its walls are sandstone and its mansards slate). Merged over the building's OSM tags (scene.ts);
 * an empty value clears a tag. Chosen from the Commons photos in ATTRIBUTION.md.
 */
export const LOOKS: Record<string, Record<string, string>> = {
  "Neues Schloss": { "building:material": "sandstone", "building:colour": "", "roof:colour": "", "roof:material": "slate" },
  "Königsbau": { "building:material": "sandstone", "building:colour": "", "roof:colour": "", "roof:material": "zinc" },
  "Königsbau-Passagen": { "roof:material": "glass" },
};

/**
 * Colonnades carved into a LoD2 block, whose front is a flat wall: `facing` (compass °) picks the front, the
 * wall below `height` (m above base) moves back by `depth` into a shaded hall, columns stand on the old wall
 * line every `spacing` m; the wall above stays as entablature. Königsbau (1856–60): two-storey Ionic colonnade
 * along the Schlossplatz front (Commons photos in ATTRIBUTION.md).
 */
type Arcade = { facing: number; height: number; depth: number; spacing: number; r: number };
export const ARCADES: Record<string, Arcade> = {
  Königsbau: { facing: 121, height: 10.5, depth: 4.5, spacing: 3.3, r: 0.55 },
};

type V5 = [number, number, number, number, number];
/** Carve `a` into a mesh's walls (edited in place); returns the hall wall, floor and columns. */
export function arcade(b: { wall: number[]; base: number; footprint: P2[]; height: number }, a: Arcade): Piece[] {
  const az = (a.facing * Math.PI) / 180, n: P2 = [Math.sin(az), Math.cos(az)], t: P2 = [-n[1], n[0]];
  const dn = (v: number[]) => v[0] * n[0] + v[1] * n[1], dt = (v: number[]) => v[0] * t[0] + v[1] * t[1];
  const tris: V5[][] = [];
  for (let i = 0; i + 14 < b.wall.length; i += 15) tris.push([0, 1, 2].map((k) => b.wall.slice(i + k * 5, i + k * 5 + 5) as V5));
  // front triangles: normal within ~15° of `facing`, on the outermost plane that way (±1.5 m)
  const facingN = (tr: V5[]) => {
    const ux = tr[1][0] - tr[0][0], uy = tr[1][1] - tr[0][1], uz = tr[1][2] - tr[0][2], vx = tr[2][0] - tr[0][0], vy = tr[2][1] - tr[0][1], vz = tr[2][2] - tr[0][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, L = Math.hypot(nx, ny) || 1;
    return Math.abs((nx * n[0] + ny * n[1]) / L);
  };
  const cand = tris.filter((tr) => facingN(tr) > 0.96);
  if (!cand.length) return [];
  const front = Math.max(...cand.flatMap((tr) => tr.map(dn)));
  const isFront = (tr: V5[]) => facingN(tr) > 0.96 && tr.every((v) => dn(v) > front - 1.5);
  const keep: number[] = [], hall: number[] = [];
  let s0 = Infinity, s1 = -Infinity;
  for (const tr of tris) {
    if (!isFront(tr)) { for (const v of tr) keep.push(...v); continue; }
    for (const v of tr) { s0 = Math.min(s0, dt(v)); s1 = Math.max(s1, dt(v)); }
    // split at `height` above base (Sutherland–Hodgman on one plane), fan-triangulate both halves
    const lo: V5[] = [], hi: V5[] = [];
    for (let k = 0; k < 3; k++) {
      const p = tr[k], q = tr[(k + 1) % 3], fp = p[4] - a.height, fq = q[4] - a.height;
      (fp <= 0 ? lo : hi).push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
        const f = fp / (fp - fq), x = p.map((c, j) => c + (q[j] - c) * f) as V5;
        lo.push(x); hi.push(x);
      }
    }
    for (let k = 1; k + 1 < hi.length; k++) for (const v of [hi[0], hi[k], hi[k + 1]]) keep.push(...v);
    for (let k = 1; k + 1 < lo.length; k++) for (const v of [lo[0], lo[k], lo[k + 1]])
      hall.push(v[0] - n[0] * a.depth, v[1] - n[1] * a.depth, v[2], v[3], v[4]);
  }
  b.wall.splice(0, b.wall.length, ...keep);
  if (!hall.length) return [];
  const SAND = [0.88, 0.8, 0.64], SHADE = [0.58, 0.52, 0.44];
  const hallP: Piece = { roof: [], wall: hall, footprint: b.footprint, height: a.height, base: b.base, look: { roof: null, wall: SHADE, style: 2 } };
  // floor of the hall, in shade: from the moved wall to the column line
  const at = (s: number, d: number, z: number) => [n[0] * d + t[0] * s, n[1] * d + t[1] * s, z];
  const floor: Piece = { roof: [], wall: [], footprint: b.footprint, height: 0.1, base: b.base, look: { roof: [0.5, 0.47, 0.42], wall: SHADE, style: 4 } };
  const z = b.base + 0.08, f0 = at(s0, front - a.depth, z), f1 = at(s1, front - a.depth, z), f2 = at(s1, front, z), f3 = at(s0, front, z);
  floor.roof.push(...f0, ...f1, ...f2, ...f0, ...f2, ...f3);
  // columns: evenly over the front, base and capital a little wider than the tapering shaft
  const cols: Piece = { roof: [], wall: [], footprint: b.footprint, height: a.height, base: b.base, look: { roof: SAND, wall: SAND, style: CLAD } };
  const count = Math.max(2, Math.round((s1 - s0) / a.spacing)), step = (s1 - s0 - 2 * a.r) / (count - 1);
  for (let k = 0; k < count; k++) {
    const c = at(s0 + a.r + k * step, front - a.r - 0.15, 0), r = a.r, H = a.height;
    lathe(cols, [c[0], c[1]], [[0, r * 1.3], [0.5, r * 1.3], [0.5, r], [H - 0.7, r * 0.86], [H - 0.7, r * 1.25], [H, r * 1.25]], 10);
  }
  return [hallP, floor, cols];
}

/**
 * Jubiläumssäule (1841–46, Schlossplatz): 30 m (OSM height). Stepped granite pedestal ~6 m with the bronze
 * reliefs, a smooth granite shaft, a capital and the bronze Concordia (~5 m) on top.
 */
function jubilaeumssaeule(c: P2, base: number): Piece[] {
  const GRANITE = [0.72, 0.7, 0.67], BRONZE = [0.36, 0.42, 0.36];
  const plinth = piece(c, base, 3.2, 6.2, { roof: GRANITE, wall: GRANITE, style: CLAD });
  // square steps and die: a 4-sided lathe turned 45° is a square of half-width r·cos45°
  const sq = (p: Piece, rings: Array<[number, number]>) => {
    const k = Math.SQRT2;
    for (let i = 0; i + 1 < rings.length; i++) {
      const [z0, r0] = rings[i], [z1, r1] = rings[i + 1];
      for (let j = 0; j < 4; j++) {
        const a0 = Math.PI / 4 + (j * Math.PI) / 2, a1 = a0 + Math.PI / 2;
        const at = (a: number, r: number, z: number, s: number): [number, number, number, number, number] => [c[0] + r * k * Math.cos(a), c[1] + r * k * Math.sin(a), base + z, s, z];
        quad(p, [at(a0, r0, z0, j * 2 * r0), at(a1, r0, z0, (j + 1) * 2 * r0), at(a1, r1, z1, (j + 1) * 2 * r1), at(a0, r1, z1, j * 2 * r1)]);
      }
      if (r1 < r0) for (let j = 0; j < 4; j++) { // ledge where the next step is narrower
        const a0 = Math.PI / 4 + (j * Math.PI) / 2, a1 = a0 + Math.PI / 2, P = (a: number, r: number) => [c[0] + r * k * Math.cos(a), c[1] + r * k * Math.sin(a), base + z1];
        p.roof.push(...P(a0, r1), ...P(a0, r0), ...P(a1, r0), ...P(a0, r1), ...P(a1, r0), ...P(a1, r1));
      }
    }
  };
  sq(plinth, [[0, 3.2], [0.5, 3.2], [0.5, 2.7], [1.0, 2.7], [1.0, 2.2], [5.4, 2.2], [5.4, 2.45], [6.2, 2.45], [6.2, 0]]); // last ring: the top
  const shaft = piece(c, base, 1.2, 24, { roof: GRANITE, wall: GRANITE, style: CLAD });
  lathe(shaft, c, [[6.2, 1.25], [6.8, 1.25], [6.8, 0.95], [23.2, 0.82], [23.2, 1.3], [24, 1.3]], 12);
  disc(shaft, c, 24, 1.3, 0, 12);
  // Concordia: a robed figure (wide skirt, waist, shoulders, head) holding up a wreath
  const fig = piece(c, base, 0.8, 30, { roof: BRONZE, wall: BRONZE, style: CLAD });
  lathe(fig, c, [[24, 0.75], [25.6, 0.62], [26.9, 0.4], [27.8, 0.48], [28.2, 0.2], [28.3, 0.24], [28.8, 0.2], [29, 0]], 10);
  lathe(fig, [c[0] + 0.25, c[1]], [[27.6, 0.12], [29.6, 0.1], [29.6, 0.3], [29.9, 0.3], [29.9, 0.1], [30, 0]], 6);
  return [plinth, shaft, fig];
}

/**
 * Crown on the dome of the Neues Schloss: a gilded crown on a short drum on the lantern. `top` is the
 * dome's highest LoD2 roof point.
 */
function schlossKrone(c: P2, top: number): Piece[] {
  const GOLD = [0.86, 0.7, 0.3];
  const k = piece(c, top, 1, 3, { roof: GOLD, wall: GOLD, style: CLAD });
  lathe(k, c, [[0, 0.9], [0.3, 0.9], [0.3, 0.7], [0.9, 0.95], [1.6, 0.8], [2.0, 0.35], [2.2, 0.25], [2.4, 0.3], [2.7, 0]], 10);
  return [k];
}

/**
 * Hochbunker Pragsattel ("BW 116 Pragbunker", 1942; OSM building relation 5459734 and its parts): a windowless
 * concrete drum, r 8 m, 30 m, with one ring of small openings below the top, an advertising crown 30–36 m
 * (white light box, dark frames), the flak crew's splinter cell on the roof, an antenna mast to 50 m slightly
 * off centre, and an LED screen 19–28 m on the north-west face (OSM part, 8 m wide). Commons photos in
 * ATTRIBUTION.md for proportions and colours; no logos.
 */
function pragbunker(c: P2, base: number): Piece[] {
  const N = 32, R = 8, H = 30, BUNKER = [0.8, 0.79, 0.76], DARK = [0.2, 0.21, 0.24], MAST = [0.42, 0.43, 0.46];
  const body = piece(c, base, R, H, { roof: [0.62, 0.62, 0.6], wall: BUNKER, style: CLAD });
  lathe(body, c, [[0, R + 0.25], [0.6, R + 0.25], [0.6, R], [H, R]], N);              // plinth, drum
  disc(body, c, H, R, 0, N);
  // ring of small openings at ~25 m: 14 dark recesses, 1.3 × 1.5 m, just proud of the wall
  const holes = piece(c, base, R, H, { roof: DARK, wall: DARK, style: CLAD, bare: 3 });
  for (let i = 0; i < 14; i++) {
    const a = ((i + 0.5) / 14) * 2 * Math.PI, da = 0.65 / R, r = R + 0.04;
    const at = (b: number, z: number, s: number): V5 => [c[0] + r * Math.cos(b), c[1] + r * Math.sin(b), base + z, s, z];
    quad(holes, [at(a - da, 24.6, 0), at(a + da, 24.6, 1.3), at(a + da, 26.1, 1.3), at(a - da, 26.1, 0)]);
  }
  // advertising crown 30–36 m: light box between dark frames, open inside (a thin ring seen from above)
  const RC = R + 0.15;
  const frame = piece(c, base, RC, 36, { roof: DARK, wall: DARK, style: CLAD, bare: 3 });
  lathe(frame, c, [[H, RC], [H + 0.5, RC]], N);
  lathe(frame, c, [[35.4, RC], [36, RC]], N);
  disc(frame, c, 36, RC, RC - 0.35, N);
  const box = piece(c, base, RC, 36, { roof: WHITE, wall: [0.97, 0.97, 0.95], style: CLAD, bare: 3 });
  lathe(box, c, [[H + 0.5, RC], [35.4, RC]], N);
  // splinter cell (32 m) and lift head (31.5 m) on the roof
  const cell = piece(c, base, 1.6, 32, { roof: [0.62, 0.62, 0.6], wall: BUNKER, style: CLAD, bare: 3 });
  lathe(cell, c, [[H, 1.5], [32, 1.5]], 8); disc(cell, c, 32, 1.5, 0, 8);
  lathe(cell, [c[0] + 2.2, c[1] + 1.2], [[H, 0.9], [31.5, 0.9]], 4); disc(cell, [c[0] + 2.2, c[1] + 1.2], 31.5, 0.9, 0, 4);
  // antenna mast to 50 m with two dish rings and a red light
  const mc: P2 = [c[0] - 1.6, c[1] + 1.3];
  const mast = piece(mc, base, 0.5, 50, { roof: MAST, wall: MAST, style: CLAD, bare: 3 });
  lathe(mast, mc, [[32, 0.32], [50, 0.14]], 8);
  for (const z of [41, 46]) { lathe(mast, mc, [[z, 0.75], [z + 0.6, 0.75]], 8); disc(mast, mc, z + 0.6, 0.75, 0, 8); }
  const lamp = piece(mc, base, 0.2, 50.4, { roof: RED, wall: RED, style: CLAD, bare: 3 });
  lathe(lamp, mc, [[50, 0.2], [50.4, 0.2]], 6); disc(lamp, mc, 50.4, 0.2, 0, 6);
  // LED screen on the north-west face (OSM part: 8 m wide, 19–28 m): a dark panel with a light rim
  const a = (116 * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), tx = -uy, ty = ux;
  const P = (s: number, o: number): P2 => [c[0] + ux * (R + o) + tx * s, c[1] + uy * (R + o) + ty * s];
  const slab = (p: Piece, w: number, z0: number, z1: number, o0: number, o1: number) => {
    const q = [P(-w, o0), P(w, o0), P(w, o1), P(-w, o1)]; // counter-clockwise from above (tangent, then outward)
    for (let i = 0; i < 4; i++) {
      const A = q[i], B = q[(i + 1) % 4], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      quad(p, [[A[0], A[1], base + z0, 0, z0], [B[0], B[1], base + z0, L, z0], [B[0], B[1], base + z1, L, z1], [A[0], A[1], base + z1, 0, z1]]);
    }
    p.roof.push(...q[0], base + z1, ...q[1], base + z1, ...q[2], base + z1, ...q[0], base + z1, ...q[2], base + z1, ...q[3], base + z1);
  };
  const rim = piece(c, base, R, 28, { roof: SILVER, wall: SILVER, style: CLAD, bare: 3 });
  slab(rim, 4, 19, 28, -0.6, 0.55);
  const screen = piece(c, base, R, 28, { roof: DARK, wall: [0.16, 0.2, 0.3], style: CLAD, bare: 3 });
  slab(screen, 3.7, 19.3, 27.7, 0.55, 0.6);
  return [body, holes, frame, box, cell, mast, lamp, rim, screen];
}

/** towers and monuments replaced as a whole: model at the centre of the OSM outline, standing on `base` */
export const TOWERS: Record<string, (c: P2, base: number) => Piece[]> = {
  "Fernsehturm Stuttgart": fernsehturm,
  "Jubiläumssäule": jubilaeumssaeule,
  "BW 116 Pragbunker": pragbunker,
};

/** additions on top of a LoD2 building: model at its highest roof point inside the OSM outline (centre of that top face) */
export const TOPS: Record<string, (c: P2, top: number, headingDeg: number) => Piece[]> = {
  Bahnhofsturm: mercedesStar,
  "Neues Schloss": schlossKrone,
};

// ---- Zagreb -------------------------------------------------------------------------------------------------------

/**
 * Looks set directly (colours as rendered, not OSM tags lifted into the house palette) for Zagreb landmarks whose
 * OSM tags are missing or off; `style` is a façade style (renderer: 2 public, 3 glass, 6 prefab slab, 8 Gothic
 * stone, 9 dark glass, 10 stone ribs and window slots). Chosen from the Commons photos in ATTRIBUTION.md. Landmarks get no roof furniture.
 */
export const PAINT: Record<string, { wall?: number[]; roof?: number[]; style?: number }> = {
  // HNK (1895, Fellner & Helmer): ochre-yellow, pale green copper roofs and domes (OSM: orange brick, asbestos)
  "Hrvatsko narodno kazalište u Zagrebu": { wall: [0.93, 0.74, 0.36], roof: [0.52, 0.72, 0.6], style: 2 },
  // Art Pavilion (1898): yellow, the glass and iron dome and side roofs grey-green
  "Umjetnički paviljon": { wall: [0.96, 0.8, 0.42], roof: [0.52, 0.6, 0.6], style: 2 },
  // Glavni kolodvor (1892): salmon-beige stucco, red tile
  "Zagreb Glavni kolodvor": { wall: [0.91, 0.76, 0.66], roof: [0.66, 0.36, 0.27], style: 2 },
  // Cibona tower (1987, 92 m): dark blue glass cylinder; Zagrepčanka (1976, 95 m): light stone ribs and dark window strips
  "Cibonin toranj": { wall: [0.2, 0.25, 0.32], roof: [0.3, 0.32, 0.35], style: 9 },
  Zagrepčanka: { wall: [0.9, 0.89, 0.85], roof: [0.6, 0.6, 0.6], style: 10 },
  // Mamutica, Super Andrija (Travno, 1970s): grey prefab slabs
  Mamutica: { wall: [0.8, 0.8, 0.78], style: 6 },
  "Super Andrija": { wall: [0.84, 0.82, 0.77], style: 6 },
  // Lotrščak (13th c.): whitewashed stone, hardly any windows (style 4: plain); Stone Gate
  "Kula Lotršćak": { wall: [0.93, 0.92, 0.88], roof: [0.55, 0.36, 0.27], style: 4 },
  "Kamenita vrata": { wall: [0.9, 0.86, 0.78], style: 4 },
};

type Part = { ring: P2[]; h: number; min: number; t: Record<string, string> };
/** a LoD2 mesh as scene.ts holds it; `look` overrides the OSM look (bare 1: no roof furniture) */
export type MeshRef = { roof: number[]; wall: number[]; footprint: P2[]; base: number; height: number; look?: Look };
/** OSM outline of the landmark, its building:parts and the LoD2 meshes standing in it (edited in place) */
export type RebuildCtx = { ring: P2[]; parts: Part[]; meshes: MeshRef[] };

const centroid = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
const LIMESTONE = [0.9, 0.87, 0.8], SPIRE_STONE = [0.87, 0.86, 0.82], LEDGE = [0.78, 0.75, 0.68], GOLD = [0.88, 0.7, 0.3];

/** drop the LoD2 triangles whose centre lies in `inside` (e.g. a surveyed spire to be rebuilt) */
function cut(m: MeshRef, inside: (x: number, y: number) => boolean) {
  const keep = (a: number[], stride: number) => {
    const out: number[] = [];
    for (let i = 0; i + 3 * stride - 1 < a.length; i += 3 * stride) {
      const x = (a[i] + a[i + stride] + a[i + 2 * stride]) / 3, y = (a[i + 1] + a[i + stride + 1] + a[i + 2 * stride + 1]) / 3;
      if (!inside(x, y)) for (let k = 0; k < 3 * stride; k++) out.push(a[i + k]);
    }
    return out;
  };
  m.roof.splice(0, m.roof.length, ...keep(m.roof, 3));
  m.wall.splice(0, m.wall.length, ...keep(m.wall, 5));
}

/** flat triangle in a vertical plane, both sides (gables in front of a wall) */
function tri2(p: Piece, a: number[], b: number[], c: number[], base: number) {
  const s = (v: number[]) => [v[0], v[1], v[2], (v[0] + v[1]) * 0.7, v[2] - base]; // façade coordinates: any steady along-axis
  p.wall.push(...s(a), ...s(b), ...s(c), ...s(a), ...s(c), ...s(b));
}

/**
 * One tower of Zagreb Cathedral (Hermann Bollé, 1880–1902): a square stone shaft with corner buttresses, the
 * clock storey with a gable on each face and pinnacles at the corners, an octagonal openwork stage from 62 m
 * and the openwork spire from 74 m to `top` (108 m, OSM building:parts), with crockets up its edges and a
 * gilt finial. Turned by `ang` like the building. Proportions from the Commons photos in ATTRIBUTION.md.
 */
function cathedralTower(c: P2, base: number, ang: number, zC: number, zS: number, top: number): Piece[] {
  const look = (wall: number[], roof = LEDGE) => ({ roof, wall, style: 8, bare: 3 as const });
  const q = Math.SQRT2, ph4 = ang + Math.PI / 4, ph8 = ang + Math.PI / 8, zB = zC - 17;
  const at = (u: number, v: number): P2 => [c[0] + u * Math.cos(ang) - v * Math.sin(ang), c[1] + u * Math.sin(ang) + v * Math.cos(ang)];
  const shaft = piece(c, base, 6.6, zC, look(LIMESTONE));
  shaft.footprint = [at(-6.6, -6.6), at(6.6, -6.6), at(6.6, 6.6), at(-6.6, 6.6)];
  shaft.look.bare = 1; // the shaft casts the tower's contact shadow
  lathe(shaft, c, [[-3, 6.6 * q], [1.2, 6.6 * q], [1.2, 6.2 * q], [zB, 6.2 * q]], 4, ph4);
  disc(shaft, c, zB, 6.2 * q, 5.2 * q, 4, ph4);
  lathe(shaft, c, [[zB, 5.2 * q], [zC, 5.2 * q]], 4, ph4);
  disc(shaft, c, zC, 5.6 * q, 4.6, 4, ph4);
  lathe(shaft, c, [[zC - 0.6, 5.6 * q], [zC, 5.6 * q]], 4, ph4); // cornice
  const out: Piece[] = [shaft];
  // corner buttresses: stepping back at a third and two thirds, pinnacles where they end
  const butt = piece(c, base, 6.6, zC + 9, look(LIMESTONE));
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const b = at(su * 6.3, sv * 6.3);
    lathe(butt, b, [[-3, 1.5 * q], [zB * 0.4, 1.5 * q], [zB * 0.4 + 0.8, 1.15 * q], [zB * 0.75, 1.15 * q], [zB * 0.75 + 0.8, 0.85 * q], [zB, 0.85 * q], [zB + 3, 0]], 4, ph4);
    const pn = at(su * 5.1, sv * 5.1); // pinnacles on the clock storey's corners
    lathe(butt, pn, [[zB, 0.8 * q], [zC - 1, 0.8 * q], [zC - 1, 0.95 * q], [zC, 0.95 * q], [zC, 0.6 * q], [zC + 9, 0]], 4, ph4);
  }
  out.push(butt);
  // clock storey: a gable (wimperg) on each face rising past the cornice, and a clock face under it
  const gab = piece(c, base, 6, zC + 6, look(SPIRE_STONE));
  const rim = piece(c, base, 6, zC, { roof: null, wall: [0.25, 0.24, 0.24], style: 4, bare: 3 });
  const dial = piece(c, base, 6, zC, { roof: null, wall: [0.95, 0.94, 0.9], style: 4, bare: 3 });
  for (let k = 0; k < 4; k++) {
    const a = ang + (k * Math.PI) / 2, n: P2 = [Math.cos(a), Math.sin(a)], t: P2 = [-n[1], n[0]], d = 5.35;
    const P = (s: number, dd: number, z: number) => [c[0] + n[0] * dd + t[0] * s, c[1] + n[1] * dd + t[1] * s, base + z];
    tri2(gab, P(-3.3, d, zC - 3), P(3.3, d, zC - 3), P(0, d, zC + 6), base);
    // clock: a 12-sided white face with a dark rim, ~2/3 up the storey
    const cz = zB + 9.5, R = 1.9;
    for (const [rad, off, dst] of [[R, 0.12, rim.wall], [R - 0.3, 0.2, dial.wall]] as Array<[number, number, number[]]>) {
      const ring = Array.from({ length: 12 }, (_, i) => { const w = (i / 12) * 2 * Math.PI; return P(rad * Math.cos(w), d + off, cz + rad * Math.sin(w)); });
      const ctr = P(0, d + off, cz);
      for (let i = 0; i < 12; i++) {
        const A = ring[i], B = ring[(i + 1) % 12], s = (v: number[]) => [v[0], v[1], v[2], 0, v[2] - base];
        dst.push(...s(ctr), ...s(A), ...s(B), ...s(ctr), ...s(B), ...s(A));
      }
    }
  }
  out.push(gab, rim, dial);
  // octagonal openwork stage, a gallery ledge, then the spire with crockets every 2.4 m and a gilt finial
  const oct = piece(c, base, 4.6, zS, look(SPIRE_STONE));
  lathe(oct, c, [[zC, 4.6], [zS - 0.8, 4.6], [zS - 0.8, 5.0], [zS, 5.0]], 8, ph8);
  disc(oct, c, zS, 5.0, 3.9, 8, ph8);
  for (let k = 0; k < 8; k++) { // pinnacles round the gallery, at the octagon's corners
    const a = ph8 + (k * Math.PI) / 4, pc: P2 = [c[0] + 4.6 * Math.cos(a), c[1] + 4.6 * Math.sin(a)];
    lathe(oct, pc, [[zS - 2, 0.45], [zS + 1, 0.45], [zS + 6, 0]], 4, ph4);
  }
  out.push(oct);
  const spire = piece(c, base, 4.2, top, look(SPIRE_STONE, SPIRE_STONE));
  const zTip = top - 2.2, rAt = (z: number) => 3.9 * Math.max(0, 1 - (z - zS) / (zTip - zS)) ** 1.2 + 0.2; // a needle: slightly concave
  const rings: Array<[number, number]> = [];
  for (let z = zS; z + 3 < zTip; z += 3) rings.push([z, rAt(z)], [z + 2.6, rAt(z + 2.6)], [z + 2.6, rAt(z + 2.6) + 0.22], [z + 3, rAt(z + 3) + 0.05]);
  rings.push([zTip, 0.22], [zTip + 0.4, 0]);
  lathe(spire, c, rings, 8, ph8);
  const fin = piece(c, base, 0.6, top, { roof: GOLD, wall: GOLD, style: 4, bare: 3 });
  lathe(fin, c, [[zTip - 0.2, 0.25], [zTip + 0.2, 0.55], [zTip + 0.7, 0.55], [zTip + 1.0, 0.12], [top, 0.08], [top + 0.05, 0]], 8);
  lathe(fin, c, [[top - 1.3, 0.1], [top - 1.3, 0.75], [top - 1.0, 0.75], [top - 1.0, 0.1]], 4, ang); // cross arms
  out.push(spire, fin);
  return out;
}

/**
 * Zagreb Cathedral: ZG3D (2019–22) has only the south spire, surveyed during the post-earthquake works, and the
 * renderer took it for a glass tower. Both towers are rebuilt from the OSM building:parts (the 74–108 m spire
 * octagons, the 62–74 m belfry squares give the turn); the nave stays LoD2, in limestone under green copper.
 */
function zagrebCathedral(ctx: RebuildCtx): Piece[] {
  const spires = ctx.parts.filter((p) => p.h >= 90 && p.min >= 60), belfries = ctx.parts.filter((p) => p.min >= 50 && p.h < 90);
  if (spires.length !== 2 || !ctx.meshes.length) return [];
  const base = Math.min(...ctx.meshes.map((m) => m.base)), out: Piece[] = [];
  for (const sp of spires) {
    const c = centroid(sp.ring);
    const bf = belfries.sort((a, b) => Math.hypot(...sub(centroid(a.ring), c)) - Math.hypot(...sub(centroid(b.ring), c)))[0];
    const r = bf?.ring ?? sp.ring;
    let ang = 0, best = 0; // the belfry's longest edge, folded into 0…90°
    for (let i = 0; i < r.length; i++) {
      const d = sub(r[(i + 1) % r.length], r[i]), L = Math.hypot(...d);
      if (L > best) { best = L; ang = Math.atan2(d[1], d[0]); }
    }
    ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const local = (x: number, y: number) => { const dx = x - c[0], dy = y - c[1]; return [dx * Math.cos(ang) + dy * Math.sin(ang), -dx * Math.sin(ang) + dy * Math.cos(ang)]; };
    for (const m of ctx.meshes) cut(m, (x, y) => { const [u, v] = local(x, y); return Math.abs(u) < 8 && Math.abs(v) < 8; });
    out.push(...cathedralTower(c, base, ang, bf?.min ?? 62, sp.min, sp.h));
  }
  for (const m of ctx.meshes) m.look = { roof: [0.46, 0.66, 0.58], wall: LIMESTONE, style: 8, bare: 1 };
  return out;
}
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];

/**
 * St Mark's Church: the glazed tile roof (1880) with the arms of the Kingdom of Croatia, Slavonia and Dalmatia
 * (west) and of the City of Zagreb (east) on its south slope. Every pitched LoD2 roof plane of the church
 * (not the tower) moves into a style-7 piece whose façade coordinates place the renderer's tile pattern: the
 * largest south-facing plane gets the arms (x -10…10 along it, y 0…10 eave to ridge), the others the lozenges
 * and chevrons in metres. White walls; the tower's bulbous spire dark green copper.
 */
function stMark(ctx: RebuildCtx): Piece[] {
  if (!ctx.meshes.length) return [];
  const WHITE = [0.95, 0.94, 0.91];
  const tower = ctx.meshes.reduce((a, m) => (m.height > a.height ? m : a));
  tower.look = { roof: [0.26, 0.4, 0.34], wall: WHITE, style: 4, bare: 1 }; // whitewashed, hardly any openings
  // the lantern above the tower's cornice (the top quarter) is dark green copper like its cap
  const cap: Piece = { roof: [], wall: [], footprint: tower.footprint, height: tower.height, base: tower.base, look: { roof: null, wall: [0.24, 0.37, 0.31], style: 4, bare: 3 } };
  const keepW: number[] = [], zCap = tower.base + tower.height * 0.72;
  for (let i = 0; i + 14 < tower.wall.length; i += 15) {
    const tri = tower.wall.slice(i, i + 15);
    (Math.min(tri[2], tri[7], tri[12]) > zCap - 0.2 ? cap.wall : keepW).push(...tri);
  }
  tower.wall.splice(0, tower.wall.length, ...keepW);
  type Plane = { m: MeshRef; n: number[]; tris: number[][]; area: number };
  const planes: Plane[] = [];
  for (const m of ctx.meshes) {
    if (m === tower) continue;
    m.look = { roof: [0.66, 0.36, 0.27], wall: WHITE, style: 2, bare: 1 };
    const keep: number[] = [];
    for (let i = 0; i + 8 < m.roof.length; i += 9) {
      const t = m.roof.slice(i, i + 9);
      const u = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], v = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], L = Math.hypot(...n);
      if (L < 1e-6) continue;
      const nn = n.map((x) => x / L * Math.sign(n[2] || 1)), area = L / 2;
      if (nn[2] > 0.97) { keep.push(...t); continue; } // flat bits keep the LoD2 roof
      const d = nn[0] * t[0] + nn[1] * t[1] + nn[2] * t[2];
      let pl = planes.find((q) => q.m === m && Math.abs(q.n[0] - nn[0]) + Math.abs(q.n[1] - nn[1]) + Math.abs(q.n[2] - nn[2]) < 0.06 && Math.abs(q.n[0] * t[0] + q.n[1] * t[1] + q.n[2] * t[2] - d) < 0.5);
      if (!pl) planes.push(pl = { m, n: nn, tris: [], area: 0 });
      pl.tris.push(t); pl.area += area;
    }
    m.roof.splice(0, m.roof.length, ...keep);
  }
  const south = planes.filter((q) => q.n[1] < -0.35).sort((a, b) => b.area - a.area)[0];
  const out: Piece[] = cap.wall.length ? [cap] : [];
  for (const pl of planes) {
    // eave direction: horizontal in the plane, pointing east (north where the plane faces east or west)
    let e = [-pl.n[1], pl.n[0]];
    const el = Math.hypot(e[0], e[1]) || 1; e = [e[0] / el, e[1] / el];
    if (e[0] < -0.2 || (Math.abs(e[0]) <= 0.2 && e[1] < 0)) e = [-e[0], -e[1]];
    const pts = pl.tris.flatMap((t) => [0, 3, 6].map((k) => t.slice(k, k + 3)));
    const ss = pts.map((p) => p[0] * e[0] + p[1] * e[1]), zs = pts.map((p) => p[2]);
    const s0 = Math.min(...ss), s1 = Math.max(...ss), z0 = Math.min(...zs), z1 = Math.max(...zs), sinT = Math.sqrt(Math.max(0.05, 1 - pl.n[2] ** 2));
    const uv = (p: number[]) => pl === south
      ? [((p[0] * e[0] + p[1] * e[1] - (s0 + s1) / 2) / (s1 - s0 || 1)) * 20, 0.06 + ((p[2] - z0) / (z1 - z0 || 1)) * 10]
      : [p[0] * e[0] + p[1] * e[1] - (s0 + s1) / 2 + 1000, 0.06 + (p[2] - z0) / sinT];
    const pc = { roof: [] as number[], wall: [] as number[], footprint: pl.m.footprint, height: pl.m.height, base: pl.m.base, look: { roof: null, wall: [0.9, 0.9, 0.9], style: 7, bare: 3 as const } };
    for (const t of pl.tris) {
      // the renderer lights walls by their winding: keep each triangle's normal pointing up
      const vs = [0, 3, 6].map((k) => t.slice(k, k + 3));
      const u = [vs[1][0] - vs[0][0], vs[1][1] - vs[0][1]], v = [vs[2][0] - vs[0][0], vs[2][1] - vs[0][1]];
      if (u[0] * v[1] - u[1] * v[0] < 0) vs.reverse();
      for (const p of vs) pc.wall.push(p[0], p[1], p[2], ...uv(p));
    }
    out.push(pc);
  }
  return out;
}

/** landmarks rebuilt in part from their LoD2 meshes and OSM building:parts, keyed by OSM wikidata (names repeat: Novi Zagreb has its own St Mark's) */
export const REBUILDS: Record<string, (ctx: RebuildCtx) => Piece[]> = {
  Q312220: zagrebCathedral,
  Q1637186: stMark,
};

/**
 * Market umbrellas on a square (OSM place=square / pedestrian area by name): Dolac's upper plaza is covered in
 * rows of red Šestine umbrellas with a white band near the rim (Commons photo in ATTRIBUTION.md). Umbrellas
 * 4.2 m across, nearly touching in rows along the square's long axis, 2.6 m high, kept clear of the outline.
 */
export const UMBRELLAS: Record<string, { size: number; gap: [number, number] }> = {
  Dolac: { size: 4.2, gap: [4.3, 4.5] },
};
export function umbrellas(ring: P2[], ground: (x: number, y: number) => number, u: { size: number; gap: [number, number] }, isInside: (p: P2, r: P2[]) => boolean): Piece[] {
  const RED = [0.74, 0.13, 0.12], BAND = [0.93, 0.9, 0.86], POLE = [0.35, 0.33, 0.3];
  let ang = 0, best = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = sub(ring[(i + 1) % ring.length], ring[i]), L = Math.hypot(...d);
    if (L > best) { best = L; ang = Math.atan2(d[1], d[0]); }
  }
  const c = centroid(ring), ca = Math.cos(ang), sa = Math.sin(ang);
  const us = ring.map((p) => (p[0] - c[0]) * ca + (p[1] - c[1]) * sa), vs = ring.map((p) => -(p[0] - c[0]) * sa + (p[1] - c[1]) * ca);
  const canopy = piece(c, 0, u.size / 2, 3, { roof: RED, wall: RED, style: 4, bare: 3 });
  const band = piece(c, 0, u.size / 2, 3, { roof: BAND, wall: BAND, style: 4, bare: 3 });
  const pole = piece(c, 0, 0.1, 3, { roof: POLE, wall: POLE, style: 4, bare: 3 });
  canopy.base = band.base = pole.base = 0; // heights below are absolute (each umbrella on its own ground)
  const R = u.size / 2, margin = R + 0.6;
  const rot = (x: number, y: number): P2 => [c[0] + x * ca - y * sa, c[1] + x * sa + y * ca];
  const near = (p: P2) => ring.some((a, i) => { // distance to the outline
    const b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], f = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy) < margin;
  });
  let n = 0;
  for (let x = Math.min(...us) + margin; x <= Math.max(...us) - margin; x += u.gap[0])
    for (let y = Math.min(...vs) + margin; y <= Math.max(...vs) - margin; y += u.gap[1]) {
      const p = rot(x, y);
      if (!isInside(p, ring) || near(p)) continue;
      const g = ground(p[0], p[1]), k = 8, ph = ang + Math.PI / 8;
      // a shallow octagonal cone, the white band 70–85 % out, a short skirt, the pole
      lathe(canopy, p, [[g + 2.25, R], [g + 2.5, R * 0.85]], k, ph);
      lathe(band, p, [[g + 2.5, R * 0.85], [g + 2.55, R * 0.76]], k, ph);
      lathe(canopy, p, [[g + 2.55, R * 0.76], [g + 2.85, 0.12], [g + 2.9, 0]], k, ph);
      lathe(canopy, p, [[g + 2.05, R], [g + 2.25, R]], k, ph);
      lathe(pole, p, [[g, 0.05], [g + 2.3, 0.05]], 4);
      n++;
    }
  return n ? [canopy, band, pole] : [];
}
