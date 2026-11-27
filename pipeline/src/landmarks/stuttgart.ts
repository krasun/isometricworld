/**
 * Stuttgart's hand-modelled landmarks (registries merged in landmarks.ts). Shapes come from published
 * dimensions (de.wikipedia, OSM building:parts); the Wikimedia Commons photos in ATTRIBUTION.md were only
 * looked at for proportions and colours.
 */
import type { Arcade, RebuildCtx } from "../landmarks.ts";
import { CLAD, cut, disc, lathe, type P2, type Piece, piece, quad, tri2 } from "./shapes.ts";

const CONCRETE = [0.82, 0.82, 0.8], ALU = [0.89, 0.89, 0.9], GLASS = [0.2, 0.23, 0.27], WHITE = [0.94, 0.94, 0.93];
const RED = [0.8, 0.2, 0.16], SILVER = [0.86, 0.87, 0.89];
type V5 = [number, number, number, number, number];

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

/** Königsbau (1856–60): two-storey Ionic colonnade along the Schlossplatz front (Commons photos in ATTRIBUTION.md). */
export const ARCADES: Record<string, Arcade> = {
  Königsbau: { facing: 121, height: 10.5, depth: 4.5, spacing: 3.3, r: 0.55 },
};

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

/**
 * Johanneskirche am Feuersee, Stuttgart (Christian Friedrich von Leins, 1864–76). LoD2 has the nave but not the
 * tower. The tower today ends about 45 m up (66 m with its spire, burnt out in 1944 and never rebuilt; Stuttgarter
 * Zeitung): a square sandstone shaft, a clock storey, then an open octagonal lantern with a balustrade and no
 * spire. OSM's bell_tower part gives the octagon's place and size; its 30 m is too low against the Commons photos
 * in ATTRIBUTION.md. Yellow Stuttgart sandstone, red-brown tile roof.
 */
function johanneskirche(ctx: RebuildCtx): Piece[] {
  const oct8 = ctx.parts.find((p) => p.t["tower:type"] === "bell_tower");
  if (!oct8 || !ctx.meshes.length) return [];
  const c = centroid(oct8.ring), base = Math.min(...ctx.meshes.map((m) => m.base));
  const sq = ctx.parts.filter((p) => p !== oct8 && Math.hypot(...sub(centroid(p.ring), c)) < 2).sort((a, b) => b.h - a.h)[0];
  let ang = 0, best = 0; // the square part's longest edge, folded into 0…90°
  const r = sq?.ring ?? oct8.ring;
  for (let i = 0; i < r.length; i++) {
    const d = sub(r[(i + 1) % r.length], r[i]), L = Math.hypot(...d);
    if (L > best) { best = L; ang = Math.atan2(d[1], d[0]); }
  }
  ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  const local = (x: number, y: number) => { const dx = x - c[0], dy = y - c[1]; return [dx * Math.cos(ang) + dy * Math.sin(ang), -dx * Math.sin(ang) + dy * Math.cos(ang)]; };
  const half = sq ? Math.max(...sq.ring.map((p) => Math.max(...local(...p).map(Math.abs)))) : 4.5;
  const R8 = Math.max(...oct8.ring.map((p) => Math.hypot(...sub(p, c)))); // octagon circumradius
  for (const m of ctx.meshes) {
    cut(m, (x, y) => { const [u, v] = local(x, y); return Math.abs(u) < half + 0.5 && Math.abs(v) < half + 0.5; });
    m.look = { roof: TILE_BROWN, wall: SANDSTONE, style: 2, bare: 1 };
  }
  const q = Math.SQRT2, ph4 = ang + Math.PI / 4, ph8 = ang + Math.PI / 8, zC = 34, zT = 44.2;
  const look = (wall: number[], roof = SANDSTONE_LEDGE) => ({ roof, wall, style: 2, bare: 3 as const });
  const at = (u: number, v: number): P2 => [c[0] + u * Math.cos(ang) - v * Math.sin(ang), c[1] + u * Math.sin(ang) + v * Math.cos(ang)];
  const a = half - 0.6; // the shaft inside its buttresses
  const shaft = piece(c, base, half, zC, look(SANDSTONE));
  shaft.footprint = [at(-half, -half), at(half, -half), at(half, half), at(-half, half)];
  shaft.look.bare = 1; // the shaft casts the tower's contact shadow
  lathe(shaft, c, [[-3, a * q], [zC - 0.8, a * q], [zC - 0.8, (a + 0.4) * q], [zC, (a + 0.4) * q]], 4, ph4);
  disc(shaft, c, zC, (a + 0.4) * q, 0, 4, ph4);
  const butt = piece(c, base, half, zC + 5, look(SANDSTONE));
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const b = at(su * (half - 0.7), sv * (half - 0.7));
    lathe(butt, b, [[-3, 1.0 * q], [12, 1.0 * q], [12.6, 0.8 * q], [24, 0.8 * q], [24.6, 0.6 * q], [zC, 0.6 * q], [zC, 0.5 * q], [zC + 5, 0]], 4, ph4);
  }
  // the lantern: an octagon of tall pointed openings (dark panels on each face), a ledge and a balustrade, flat top
  const oct = piece(c, base, R8, zT + 0.8, look(SANDSTONE));
  lathe(oct, c, [[zC, R8], [zT, R8], [zT, R8 + 0.35], [zT + 0.8, R8 + 0.35]], 8, ph8);
  disc(oct, c, zT + 0.8, R8 + 0.35, 0, 8, ph8);
  const hole = piece(c, base, R8, zT, { roof: null, wall: [0.2, 0.17, 0.14], style: 4, bare: 3 });
  for (let k = 0; k < 8; k++) {
    const a0 = ph8 + (k * Math.PI) / 4, a1 = a0 + Math.PI / 4, m = (a0 + a1) / 2, ri = R8 * Math.cos(Math.PI / 8) + 0.06;
    const n: P2 = [Math.cos(m), Math.sin(m)], t: P2 = [-n[1], n[0]], w = R8 * Math.sin(Math.PI / 8) * 0.55;
    const P = (s: number, z: number) => [c[0] + n[0] * ri + t[0] * s, c[1] + n[1] * ri + t[1] * s, base + z];
    tri2(hole, P(-w, zC + 1.5), P(w, zC + 1.5), P(w, zT - 2.2), base);
    tri2(hole, P(-w, zC + 1.5), P(w, zT - 2.2), P(-w, zT - 2.2), base);
    tri2(hole, P(-w, zT - 2.2), P(w, zT - 2.2), P(0, zT - 1), base); // pointed arch
  }
  for (let k = 0; k < 8; k++) { // small pinnacles round the balustrade
    const a0 = ph8 + (k * Math.PI) / 4, pc: P2 = [c[0] + R8 * Math.cos(a0), c[1] + R8 * Math.sin(a0)];
    lathe(oct, pc, [[zT - 1, 0.3], [zT + 1.2, 0.3], [zT + 2.6, 0]], 4, ph4);
  }
  return [shaft, butt, oct, hole];
}
const SANDSTONE = [0.86, 0.76, 0.56], SANDSTONE_LEDGE = [0.76, 0.66, 0.48], TILE_BROWN = [0.58, 0.28, 0.2];
const centroid = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];

/** landmarks rebuilt in part from their LoD2 meshes and OSM building:parts, keyed by OSM wikidata */
export const REBUILDS: Record<string, (ctx: RebuildCtx) => Piece[]> = {
  Q6217188: johanneskirche,
};
