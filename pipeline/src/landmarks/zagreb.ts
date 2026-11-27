/**
 * Zagreb's landmarks (region `zagreb`, sources "zg3d"): looks set directly, the LoD2 meshes rebuilt where the survey
 * misses their detail (the cathedral's towers, St Mark's), and the market umbrellas of Dolac. Moved here from
 * landmarks.ts as it is, beside the other cities' landmarks; landmarks.ts exports what scene.ts uses.
 */
import { cut, disc, lathe, type Look, type P2, piece, type Piece, tri2 } from "./shapes.ts";

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
