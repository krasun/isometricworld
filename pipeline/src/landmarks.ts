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

/** towers and monuments replaced as a whole: model at the centre of the OSM outline, standing on `base` */
export const TOWERS: Record<string, (c: P2, base: number) => Piece[]> = {
  "Fernsehturm Stuttgart": fernsehturm,
  "Jubiläumssäule": jubilaeumssaeule,
};

/** additions on top of a LoD2 building: model at its highest roof point inside the OSM outline (centre of that top face) */
export const TOPS: Record<string, (c: P2, top: number, headingDeg: number) => Piece[]> = {
  Bahnhofsturm: mercedesStar,
  "Neues Schloss": schlossKrone,
};
