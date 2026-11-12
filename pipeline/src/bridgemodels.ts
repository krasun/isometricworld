/**
 * Named bridges, built from their OSM outline (`man_made=bridge`, keyed by Wikidata id) where the generic
 * decks (page/renderer.ts) fall short. Dimensions from de.wikipedia; the Wikimedia Commons photos in
 * ATTRIBUTION.md were only looked at for proportions and colours.
 */
import * as THREE from "three";
import { deckHeight } from "./bridges.ts";
import { frame, type P2 } from "./frame.ts";
import { lathe, type Piece } from "./landmarks.ts";

type Ground = (x: number, y: number) => number;
/** deckAt: the generic deck height under a point (nearest OSM bridge way), null when none is near */
type Ctx = { ground: Ground; deckAt: (p: P2) => number | null };

/** long axis of an outline: centre, direction, extent along (s0..s1) and across (b0..b1) */
function axis(ring: P2[]) {
  const n = ring.length, cx = ring.reduce((a, p) => a + p[0], 0) / n, cy = ring.reduce((a, p) => a + p[1], 0) / n;
  let xx = 0, xy = 0, yy = 0;
  for (const [x, y] of ring) { xx += (x - cx) ** 2; xy += (x - cx) * (y - cy); yy += (y - cy) ** 2; }
  const t = 0.5 * Math.atan2(2 * xy, xx - yy), d: P2 = [Math.cos(t), Math.sin(t)];
  const loc = ring.map(([x, y]) => [(x - cx) * d[0] + (y - cy) * d[1], -(x - cx) * d[1] + (y - cy) * d[0]]);
  return { o: [cx, cy] as P2, d, s0: Math.min(...loc.map((q) => q[0])), s1: Math.max(...loc.map((q) => q[0])),
    b0: Math.min(...loc.map((q) => q[1])), b1: Math.max(...loc.map((q) => q[1])) };
}

function column(c: P2, ground: number, top: number, r: number, head: number, rgb: number[]): Piece {
  const h = top - ground, p: Piece = { roof: [], wall: [], footprint: [[c[0] - r, c[1] - r], [c[0] + r, c[1] - r], [c[0] + r, c[1] + r], [c[0] - r, c[1] + r]], height: h, base: ground, look: { roof: rgb, wall: rgb, style: 4 } };
  lathe(p, c, [[-1, r], [Math.max(0, h - 3), r], [h, head]], 12);
  return p;
}

const STEEL = [0.8, 0.81, 0.83], BALLAST = [0.5, 0.46, 0.42], SCREEN = [0.9, 0.92, 0.93], PIER = [0.74, 0.74, 0.72];
/**
 * S21 Neckarbrücke (Bad Cannstatt, 2023): 345 m, four tracks on a light-grey steel girder ~3 m deep, white
 * noise screens on both edges, steel "sails" over the piers in the median, round concrete piers with
 * flared heads, spans up to ~80 m. Its tracks are still `railway=construction` in OSM (not drawn), so the
 * whole bridge is built here, running straight between the terrain at its two ends.
 */
function s21Neckarbruecke(ring: P2[], { ground }: Ctx): Piece[] {
  const { o, d, s0, s1, b0, b1 } = axis(ring);
  const bc = (b0 + b1) / 2, W = b1 - b0, L = s1 - s0;
  const { at, piece, block } = frame(o, d, 0);
  const dh = deckHeight([at(s0, bc), at(s1, bc)], ground);
  const zd = (a: number) => { const p = at(a, bc); return dh.at(a - s0, p[0], p[1]); };
  const girder = piece(s0, s1, b0, b1, 0, STEEL), bed = piece(s0, s1, b0, b1, 0, BALLAST), screen = piece(s0, s1, b0, b1, 0, SCREEN);
  const sails = piece(s0, s1, b0, b1, 0, STEEL);
  girder.look.bare = 2;
  const STEP = 4;
  for (let a = s0; a < s1; a += STEP) {
    const a1 = Math.min(s1, a + STEP);
    block(girder, a, a1, b0, b1, (x) => zd(x) - 3, (x) => zd(x));
    for (const t of [-6.9, -2.3, 2.3, 6.9]) if (Math.abs(t) + 1.6 < W / 2)
      block(bed, a, a1, bc + t - 1.6, bc + t + 1.6, (x) => zd(x), (x) => zd(x) + 0.12);
    block(screen, a, a1, b0, b0 + 0.25, (x) => zd(x), (x) => zd(x) + 2);
    block(screen, a, a1, b1 - 0.25, b1, (x) => zd(x), (x) => zd(x) + 2);
  }
  const out = [girder, bed, screen, sails];
  const n = Math.max(2, Math.round(L / 55));
  for (let k = 1; k < n; k++) {
    const s = s0 + (L * k) / n, z = zd(s);
    // sail: a steel plate in the median, 12 m above the deck over the pier, concave edges down to the deck
    for (let a = s - 16; a < s + 16; a += 2)
      block(sails, a, a + 2, bc - 0.3, bc + 0.3, (x) => zd(x), (x) => zd(x) + 12 * Math.max(0, 1 - Math.abs(x - s) / 16) ** 1.6);
    for (const t of [-W * 0.22, W * 0.22]) {
      const c = at(s, bc + t), g = ground(...c);
      if (z - 3 - g > 4) out.push(column(c, g, z - 3, 1.3, 2.6, PIER));
    }
  }
  return out;
}

const YELLOW = [0.93, 0.74, 0.12], GIRDER = [0.42, 0.43, 0.45], DECK = [0.7, 0.69, 0.67], GREY = [0.6, 0.61, 0.63];
/**
 * König-Karls-Brücke (Bad Cannstatt, 1976): 184 m steel box girder carrying the road and the Stadtbahn over
 * the Neckar. A slab 1 m under the generic decks over the whole OSM outline (they leave the river showing
 * between the carriageways), the yellow fascia band over a dark girder along every edge, and rows of round
 * grey columns.
 */
function koenigKarlsBruecke(ring: P2[], { ground, deckAt }: Ctx): Piece[] {
  const { o, d, s0, s1, b0, b1 } = axis(ring);
  const { at, local } = frame(o, d, 0);
  // deck height: a straight line between the generic decks at the outline's two ends (the bridge is
  // nearly level; per-point heights from the nearest way jump where ramps and footpaths meet it)
  const ends = [at(s0 + 6, (b0 + b1) / 2), at(s1 - 6, (b0 + b1) / 2)].map((p) => deckAt(p) ?? ground(...p));
  const z = (p: P2) => ends[0] + ((ends[1] - ends[0]) * (local(p)[0] - s0 - 6)) / (s1 - s0 - 12 || 1);
  const r = THREE.ShapeUtils.isClockWise(ring.map(([x, y]) => new THREE.Vector2(x, y))) ? ring.slice().reverse() : ring.slice();
  if (r.length > 1 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1]) r.pop();
  const zs = r.map(z);
  const fp: P2[] = r;
  const mk = (rgb: number[]): Piece => ({ roof: [], wall: [], footprint: fp, height: 0, base: 0, look: { roof: rgb, wall: rgb, style: 4, bare: 3 } });
  const deck = mk(DECK), band = mk(YELLOW), girder = mk(GIRDER);
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(r.map(([x, y]) => new THREE.Vector2(x, y)), []))
    deck.roof.push(r[i][0], r[i][1], zs[i] - 1, r[j][0], r[j][1], zs[j] - 1, r[k][0], r[k][1], zs[k] - 1);
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const j = (i + 1) % r.length, A = r[i], B = r[j], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const quad = (p: Piece, lo: number, hi: number) => p.wall.push(
      A[0], A[1], zs[i] + lo, s, lo, B[0], B[1], zs[j] + lo, s + L, lo, B[0], B[1], zs[j] + hi, s + L, hi,
      A[0], A[1], zs[i] + lo, s, lo, B[0], B[1], zs[j] + hi, s + L, hi, A[0], A[1], zs[i] + hi, s, hi);
    quad(band, -1.1, 0.25);
    quad(girder, -2.8, -1.1);
    s += L;
  }
  const out = [deck, band, girder];
  const inRing = ([x, y]: P2) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    return c;
  };
  const n = Math.max(2, Math.round((s1 - s0) / 32));
  for (let k = 1; k < n; k++) {
    const sa = s0 + ((s1 - s0) * k) / n;
    for (let b = b0 + 4; b <= b1 - 4; b += 9) {
      const c = at(sa, b);
      if (!inRing(c)) continue;
      const g = ground(...c), top = z(c) - 2.8;
      if (top - g > 3) out.push(column(c, g, top, 0.75, 1.1, GREY));
    }
  }
  return out;
}

export const BRIDGES: Record<string, (ring: P2[], ctx: Ctx) => Piece[]> = {
  Q1973696: s21Neckarbruecke,
  Q1298655: koenigKarlsBruecke,
};
