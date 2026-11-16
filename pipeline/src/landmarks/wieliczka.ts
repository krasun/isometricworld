/**
 * Wieliczka's hand-modelled landmarks (registries merged in landmarks.ts). Dimensions from pl.wikipedia, the
 * town's culture centre (WCK) and the salt mine museum, and measured on GUGiK data (LoD2, NMPT − NMT, the
 * orthophoto); the Wikimedia Commons photos in ATTRIBUTION.md were only looked at for shapes and colours.
 */
import type { Placed } from "../landmarks.ts";
import { CLAD, disc, lathe, type P2, type Piece, piece } from "./shapes.ts";

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

/** Models at a measured point, for parts OSM does not map on their own. */
export const PLACED: Placed[] = [
  // centre of the round part of the graduation tower's OSM outline (a circle fitted to its outer and inner arcs,
  // r 7.6 m), as the walls are drawn from that outline; the surface model has the roof 1.2 m further east
  { name: "Tężnia solankowa: wieża widokowa", at: [49.984448, 20.052061], clear: 8, model: tezniaTower },
];
