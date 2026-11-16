/**
 * Wieliczka's hand-modelled landmarks (registries merged in landmarks.ts). Dimensions from pl.wikipedia, the
 * town's culture centre (WCK) and the salt mine museum, and measured on GUGiK data (LoD2, NMPT − NMT, the
 * orthophoto); the Wikimedia Commons photos in ATTRIBUTION.md were only looked at for shapes and colours.
 */
import type { Placed } from "../landmarks.ts";
import { beam, CLAD, disc, face, frame, lathe, type Look, type P2, type P3, panel, type Piece, piece, prism, roofFace } from "./shapes.ts";

const BRUSHWOOD = [0.31, 0.25, 0.20], LARCH = [0.78, 0.60, 0.38], SHADE = [0.30, 0.24, 0.19], TILE = [0.76, 0.36, 0.25];

/**
 * Viewing tower of the graduation tower in Park św. Kingi (2014, Asa Stożek Architekci): an octagon about 13 m
 * across, clad in blackthorn brushwood like the walls, an open larch deck under an octagonal tiled roof, 22.5 m
 * (pl.wikipedia; NMPT − NMT: 22.5 m, the part above 15 m is 6.7 m in radius with the eaves).
 */
function tezniaTower(c: P2, base: number): Piece[] {
  const N = 8, R = 6.0, deck = 15.5, rail = 16.6, eaves = 18.8, apex = 22.3;
  const body = piece(c, base, R, deck, { roof: LARCH, wall: BRUSHWOOD, style: CLAD, bare: 1 });
  lathe(body, c, [[-0.5, R], [deck, R]], N);
  disc(body, c, deck, R, 0, N);
  const railing = piece(c, base, R, rail, { roof: LARCH, wall: LARCH, style: CLAD, bare: 1 });
  lathe(railing, c, [[deck, R], [rail, R]], N);
  const inner = piece(c, base, 5.2, eaves, { roof: SHADE, wall: SHADE, style: CLAD, bare: 1 }); // the shaded deck behind the posts
  lathe(inner, c, [[deck, 5.2], [eaves, 5.2]], N);
  const posts = piece(c, base, R, eaves, { roof: LARCH, wall: LARCH, style: CLAD, bare: 1 });
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI, p: P2 = [c[0] + (R - 0.2) * Math.cos(a), c[1] + (R - 0.2) * Math.sin(a)];
    lathe(posts, p, [[rail, 0.2], [eaves, 0.2]], 6);
  }
  const roof = piece(c, base, 7.0, apex + 0.6, { roof: TILE, wall: TILE, style: CLAD, bare: 1 });
  lathe(roof, c, [[eaves - 0.25, 7.0], [eaves, 7.0], [apex, 0.35], [apex + 0.6, 0.05]], N);
  return [body, railing, inner, posts, roof];
}

/** A piece with one look whose footprint is the given ring (for shadows and binning). */
const part = (ring: P2[], base: number, height: number, look: Look): Piece => ({ roof: [], wall: [], footprint: ring, height, base, look });
const clad = (c: number[], roof = c): Look => ({ roof, wall: c, style: CLAD, bare: 1 });

/** X-braced lattice between two levels of four corners each (counter-clockwise), `n` panels high. */
function lattice(p: Piece, lo: P3[], hi: P3[], n: number, leg: number, brace: number) {
  const lvl = (k: number) => lo.map((a, i) => a.map((v, j) => v + ((hi[i][j] - v) * k) / n) as P3);
  for (let i = 0; i < 4; i++) beam(p, lo[i], hi[i], leg);
  for (let k = 0; k <= n; k++) { const L = lvl(k); for (let i = 0; i < 4; i++) beam(p, L[i], L[(i + 1) % 4], brace); }
  for (let k = 0; k < n; k++) {
    const A = lvl(k), B = lvl(k + 1);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; beam(p, A[i], B[j], brace); beam(p, A[j], B[i], brace); }
  }
}

/** Open railing on a closed ring: a handrail band (thicker than life, to read at 0.25 m/px) and posts every ~1.3 m. */
function railing(p: Piece, ring: P2[], z0: number, h: number) {
  panel(p, ring, z0 + h - 0.3, z0 + h);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.3));
    for (let k = 0; k < n; k++) { const q = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]; beam(p, [q[0], q[1], z0], [q[0], q[1], z0 + h - 0.3], 0.12); }
  }
}

const SALMON = [0.94, 0.83, 0.79], KHAKI = [0.89, 0.85, 0.68];
const BLACK_STEEL = [0.21, 0.22, 0.24], HOOD = [0.25, 0.26, 0.28], GALLERY = [0.36, 0.36, 0.37];

/**
 * Szyb Regis: the black steel lattice headframe rising out of the shaft house's roof, a railed gallery on top
 * and a curved hood over the sheaves. Hood outline and heights from LoD2 (3.85 × 6.75 m, long axis 352.5°,
 * eaves 23.4 m, ridge 24.3 m above the building's ground); the lattice's taper and panels from the photos.
 */
function regisHeadframe(c: P2, base: number, ground: number): Piece[] {
  const at = frame(c, 352.5), z = (h: number) => h - (base - ground), cap = base - ground;
  const rect = (U: number, V: number): P2[] => [at(-U, -V), at(U, -V), at(U, V), at(-U, V)];
  const corners = (U: number, V: number, h: number): P3[] => rect(U, V).map((q) => [q[0], q[1], z(h)]);
  const hoodRing = rect(3.38, 1.93), deckRing = rect(3.1, 1.7);
  const steel = part(rect(3.2, 1.8), base, z(20.8), clad(BLACK_STEEL));
  lattice(steel, corners(3.15, 1.78, cap), corners(2.6, 1.3, 20.55), 2, 0.32, 0.13);
  const gallery = part(deckRing, base, z(21.85), clad(GALLERY));
  prism(gallery, deckRing, z(20.55), z(20.8));
  const rail = part(deckRing, base, z(21.85), clad(BLACK_STEEL));
  railing(rail, deckRing, z(20.8), 1.05);
  for (const q of corners(3.0, 1.6, 20.8)) beam(rail, q, [q[0], q[1], z(22.9)], 0.24);
  // hood: a fascia, then a shallow barrel vault along the long axis (gable ends closed)
  const hood = part(hoodRing, base, z(24.3), clad(HOOD));
  prism(hood, hoodRing, z(22.85), z(23.4), false);
  const N = 6, arc = Array.from({ length: N + 1 }, (_, k) => { const v = -1.93 + (3.86 * k) / N; return [v, 23.4 + 0.9 * (1 - (v / 1.93) ** 2)]; });
  for (let k = 0; k < N; k++) {
    const [v0, h0] = arc[k], [v1, h1] = arc[k + 1], a0 = at(-3.38, v0), a1 = at(-3.38, v1), b0 = at(3.38, v0), b1 = at(3.38, v1);
    roofFace(hood, [[a0[0], a0[1], z(h0)], [b0[0], b0[1], z(h0)], [b1[0], b1[1], z(h1)], [a1[0], a1[1], z(h1)]]);
  }
  const mid = at(0, 0);
  for (const u of [-3.38, 3.38]) // the gable ends above the eaves line (convex: the arc and its chord)
    face(hood, arc.map(([v, h]) => { const q = at(u, v); return [q[0], q[1], z(h)] as P3; }), [mid[0], mid[1], z(23.6)]);
  return [steel, gallery, rail, hood];
}

const GRAPHITE = [0.29, 0.31, 0.33], STEEL = [0.78, 0.80, 0.81], YELLOW = [0.95, 0.78, 0.18], WHITE = [0.92, 0.93, 0.93];
const CAGE_ROOF = [0.47, 0.49, 0.51], FASCIA = [0.30, 0.31, 0.33], FLAG_RED = [0.83, 0.13, 0.20];

/**
 * Szyb Daniłowicza: a column clad in graphite panels rising out of the shaft house, a balcony half way up, a
 * steel platform with an open cage on top (a landing inside, yellow stairs and railings) under a flat pyramid
 * roof with a flagpole, and a white lattice strut down to the back (south-west). Roof outline and heights from
 * LoD2 (5.3 m square on the building's axes, 59.6°; eaves 27.9 m, top 29.5 m); the column, cage and strut from
 * the photos (column ≈ 0.7 of the roof's width, platform at ≈ 22 m).
 */
function danilowiczHeadframe(c: P2, base: number, ground: number): Piece[] {
  const at = frame(c, 59.6), z = (h: number) => h - (base - ground); // u: north-east, to the lawn and the gable
  const sq = (h: number): P2[] => [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
  const column = part(sq(1.9), base, z(22.1), clad(GRAPHITE));
  prism(column, sq(1.9), 0, z(21.8), false);
  const decks = part(sq(2.6), base, z(25), clad(STEEL));
  prism(decks, sq(2.6), z(16.65), z(16.9)); // balcony
  prism(decks, sq(2.6), z(21.8), z(22.1)); // platform under the cage
  prism(decks, sq(1.5), z(22.1), z(24.6)); // sheave housing
  prism(decks, sq(2.3), z(24.85), z(25.0)); // landing
  for (const q of sq(2.4)) beam(decks, [q[0], q[1], z(22.1)], [q[0], q[1], z(27.6)], 0.3);
  const rails = part(sq(2.6), base, z(26), clad(YELLOW));
  railing(rails, sq(2.6), z(16.9), 1.05);
  railing(rails, sq(2.6), z(22.1), 1.05);
  railing(rails, sq(2.3), z(25.0), 1.0);
  const top = part(sq(2.65), base, z(29.5), clad(FASCIA, CAGE_ROOF));
  prism(top, sq(2.65), z(27.55), z(27.85), false);
  const r = sq(2.65), apex: P3 = [c[0], c[1], z(29.5)];
  for (let i = 0; i < 4; i++) { const a = r[i], b = r[(i + 1) % 4]; roofFace(top, [[a[0], a[1], z(27.85)], [b[0], b[1], z(27.85)], apex]); }
  // flagpole and the Polish flag (white over red), flying north-west
  const pole = part(sq(0.5), base, z(35), clad(WHITE));
  beam(pole, apex, [c[0], c[1], z(35)], 0.14);
  const fly = [c, at(0, -1.5)];
  panel(pole, fly, z(34.35), z(34.8), false);
  const red = part(sq(0.5), base, z(34.4), clad(FLAG_RED));
  panel(red, fly, z(33.9), z(34.35), false);
  // strut: two white tubes from under the platform down to the low building at the back, laced together
  const strut = part([at(-11, -1.6), at(-2.4, -1.6), at(-2.4, 1.6), at(-11, 1.6)], base, z(22), clad(WHITE));
  const tube = (v: number, t: number): P3 => { const q = at(-2.4 - 8.6 * t, v); return [q[0], q[1], z(22.0 - 17.5 * t)]; };
  for (const v of [-1.3, 1.3]) beam(strut, tube(v, 0), tube(v, 1), 0.38);
  for (let k = 0; k < 7; k++) beam(strut, tube(k % 2 ? 1.3 : -1.3, k / 7), tube(k % 2 ? -1.3 : 1.3, (k + 1) / 7), 0.16);
  return [column, decks, rails, top, pole, red, strut];
}

/** Models at a measured point, for parts OSM does not map on their own. */
export const PLACED: Placed[] = [
  // centre of the round part of the graduation tower's OSM outline (a circle fitted to its outer and inner arcs,
  // r 7.6 m), as the walls are drawn from that outline; the surface model has the roof 1.2 m further east
  { name: "Tężnia solankowa: wieża widokowa", at: [49.984448, 20.052061], clear: 8, model: tezniaTower },
  // headframes: the centre of the LoD2 block standing in for each (its roof outline), cut off at the roofs around
  { name: "Szyb Regis", at: [49.983825, 20.061206], clear: 4, cut: 4.3, walls: SALMON, model: regisHeadframe },
  { name: "Szyb Daniłowicza", at: [49.983034, 20.055672], clear: 4, cut: 4.0, walls: KHAKI, model: danilowiczHeadframe },
];
