/**
 * A building from its footprint and a surface model, for buildings the 3D models lack (built after the LiDAR
 * flight, or never modelled): walls standing on the footprint and a roof fitted to the surface model inside it,
 * as the surfaces of a CityGML building (lod2.ts meshOf), so it is drawn like any LoD2 building (façades,
 * eaves, gutters, the roof's colour from the orthophoto).
 *
 * The roof is the best fitting shape over the footprint's smallest enclosing rectangle: flat; gabled, the ridge
 * parallel to either side anywhere across it, each slope its own pitch (modern houses often have one long, low
 * slope); a shed roof; or hipped (one pitch all round, the ridge along the long side). A pitched roof is the
 * lowest of its planes, fitted to the surface model's cells well above the ground by least squares, refitted
 * without the outliers (chimneys, dormers, overhanging trees). It must fit clearly better than a flat roof and
 * rise 10–58°.
 */
import type { Surface } from "./lod2.ts";

type P2 = [number, number];
/** z = ax · x + ay · y + c, in metres around the rectangle's centre */
type Plane = [number, number, number];

/** Surface (roofs, crowns) and bare-earth heights at a point in projected metres; NaN outside. */
export interface Heights { surface: (x: number, y: number) => number; terrain: (x: number, y: number) => number }
export interface Fitted { surfaces: Surface[]; roofType: string; shape: "flat" | "gable" | "hip" | "shed"; stand: number; height: number }

const signed = (r: P2[]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const at = (pl: Plane, x: number, y: number) => pl[0] * x + pl[1] * y + pl[2];
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
function inside([x, y]: P2, r: P2[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
function edgeDistance([x, y]: P2, r: P2[]) {
  let d = Infinity;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t));
  }
  return d;
}

/** The ring without its closing vertex and repeated points, counter-clockwise; null if it is not a polygon. */
export function cleanRing(ring: P2[]): P2[] | null {
  const r: P2[] = [];
  for (const p of ring) if (!r.length || Math.hypot(p[0] - r[r.length - 1][0], p[1] - r[r.length - 1][1]) > 0.05) r.push(p);
  while (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) <= 0.05) r.pop();
  if (r.length < 3) return null;
  const a = signed(r);
  return Math.abs(a) < 1 ? null : a < 0 ? r.reverse() : r;
}

/** The smallest rectangle around the points: centre, unit vectors along its long (u) and short (v) side, half-sides a ≥ b. */
function minRect(pts: P2[]) {
  const s = [...pts].sort((p, q) => p[0] - q[0] || p[1] - q[1]), hull: P2[] = [];
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (const pass of [s, [...s].reverse()]) {
    const start = hull.length;
    for (const p of pass) {
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
  }
  let best = { area: Infinity, c: [0, 0] as P2, u: [1, 0] as P2, v: [0, 1] as P2, a: 0, b: 0 };
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const u: P2 = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], v: P2 = [-u[1], u[0]];
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const h of hull) {
      const s = h[0] * u[0] + h[1] * u[1], t = h[0] * v[0] + h[1] * v[1];
      s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area >= best.area) continue;
    const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2, c: P2 = [u[0] * sm + v[0] * tm, u[1] * sm + v[1] * tm];
    best = s1 - s0 >= t1 - t0 ? { area, c, u, v, a: (s1 - s0) / 2, b: (t1 - t0) / 2 } : { area, c, u: v, v: u, a: (t1 - t0) / 2, b: (s1 - s0) / 2 };
  }
  return best;
}

/** Keep the part of a polygon where f ≤ 0 (f linear), Sutherland–Hodgman. */
function clip(poly: P2[], f: (p: P2) => number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** z ≈ Σ p_j · x_j by least squares (x: each sample's terms), refitted without the outliers (over 2.5 × the median
 *  error, at least 0.4 m off); score: the mean error, capped at 1.5 m per sample. */
function robustFit(x: number[][], z: number[]): { p: number[]; score: number } | null {
  const m = x[0]?.length ?? 0, all = z.map((_, i) => i);
  let use = all, p: number[] | null = null, res: number[] = [];
  for (let pass = 0; pass < 5; pass++) {
    if (use.length < m + 2) return null;
    const A = Array.from({ length: m }, () => new Array<number>(m).fill(0)), B = new Array<number>(m).fill(0);
    for (const i of use) for (let j = 0; j < m; j++) { B[j] += x[i][j] * z[i]; for (let k = 0; k < m; k++) A[j][k] += x[i][j] * x[i][k]; }
    const q = solve(A, B);
    if (!q) return null;
    p = q;
    res = z.map((zi, i) => Math.abs(zi - x[i].reduce((s, xj, j) => s + xj * q[j], 0)));
    const cut = Math.max(0.4, 2.5 * median(use.map((i) => res[i]))), keep = all.filter((i) => res[i] <= cut);
    if (keep.length < m + 2 || (keep.length === use.length && keep.every((i, j) => i === use[j]))) break;
    use = keep;
  }
  return p && { p, score: res.reduce((s, r) => s + Math.min(1.5, r), 0) / res.length };
}

/**
 * Fit a building to `ring` (projected metres, any orientation). Null if the surface model sees no building there
 * (its median height above the ground under ~1.8 m: not built yet, demolished, or outside the model) or the
 * ring is degenerate. `cap`: the most it can plausibly rise above its lowest ground (m); a surface higher than
 * that is a tree over it, and it gets a flat roof at three quarters of `cap`.
 */
export function fitBuilding(ringIn: P2[], h: Heights, cap = 40): Fitted | null {
  const ring0 = cleanRing(ringIn);
  if (!ring0) return null;
  const R = minRect(ring0), [cx, cy] = R.c, ring = ring0.map(([x, y]) => [x - cx, y - cy] as P2);
  // the surface model's 1 m cells inside the footprint, away from its edge where they mix roof and ground
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), cells: Array<[number, number, number, number]> = [];
  for (const margin of [0.6, 0]) {
    for (let x = Math.floor(Math.min(...xs) + cx); x < Math.max(...xs) + cx; x++)
      for (let y = Math.floor(Math.min(...ys) + cy); y < Math.max(...ys) + cy; y++) {
        const p: P2 = [x + 0.5 - cx, y + 0.5 - cy];
        if (!inside(p, ring) || (margin && edgeDistance(p, ring) < margin)) continue;
        const zs = h.surface(x + 0.5, y + 0.5), zt = h.terrain(x + 0.5, y + 0.5);
        if (Number.isFinite(zs) && Number.isFinite(zt)) cells.push([p[0], p[1], zs, zt]);
      }
    if (cells.length >= 6) break;
    cells.length = 0;
  }
  if (cells.length < 3) return null;
  const stand = median(cells.map((c) => c[2] - c[3]));
  if (!(stand >= 1.8)) return null;
  // the roof: cells well above the ground (not the ground at the walls' foot, a passage or a yard); a large
  // roof is fitted to an even sample of ~800 of them
  const raised = cells.filter((c) => c[2] - c[3] >= 1.5), all = raised.length >= 3 ? raised : cells;
  const stride = Math.ceil(all.length / 800), roofCells = all.filter((_, i) => i % stride === 0);
  // the ground at each corner (where the terrain model has none: the lowest under the roof)
  const lowest = Math.min(...cells.map((c) => c[3])), grounds = ring.map(([x, y]) => { const g = h.terrain(x + cx, y + cy); return Number.isFinite(g) ? g : lowest; });
  const base = Math.min(...grounds), groundTop = Math.max(...grounds);

  // candidate roofs, each the lowest of its planes; plane(r, k, w, off): z = r − k · (p · w − off)
  const { u, v, a, b } = R;
  const plane = (r: number, k: number, w: P2, off: number): Plane => [-k * w[0], -k * w[1], r + k * off];
  const neg = (w: P2): P2 => [-w[0], -w[1]];
  const z = roofCells.map((c) => c[2]);
  // flat: the median, then the mean of what lies within a metre of it
  const m0 = median(z), near = z.filter((q) => Math.abs(q - m0) <= 1), flatZ = near.reduce((s, q) => s + q, 0) / near.length;
  const flatScore = z.reduce((s, q) => s + Math.min(1.5, Math.abs(q - flatZ)), 0) / z.length;
  type Candidate = { shape: Fitted["shape"]; planes: Plane[]; score: number };
  const candidates: Candidate[] = [];
  const pitch = (k: number) => k >= 0.18 && k <= 1.6; // 10–58°
  for (const [w, half] of [[v, b], [u, a]] as Array<[P2, number]>) {
    const t = roofCells.map((c) => c[0] * w[0] + c[1] * w[1]);
    // gabled: the ridge parallel to this side, anywhere across the rectangle, each slope its own pitch
    const step = Math.max(0.25, (2 * half - 1) / 40); // at most ~40 ridge lines
    for (let t0 = -half + 0.5; t0 <= half - 0.5 + 1e-9; t0 += step) {
      const f = robustFit(t.map((ti) => [1, -Math.max(ti - t0, 0), -Math.max(t0 - ti, 0)]), z);
      if (f && pitch(f.p[1]) && pitch(f.p[2])) candidates.push({ shape: "gable", planes: [plane(f.p[0], f.p[1], w, t0), plane(f.p[0], f.p[2], neg(w), -t0)], score: f.score });
    }
    // a shed roof, falling across this side
    const f = robustFit(t.map((ti) => [1, -ti]), z);
    if (f && Math.abs(f.p[1]) >= 0.1 && Math.abs(f.p[1]) <= 1.2) candidates.push({ shape: "shed", planes: [plane(f.p[0], f.p[1], w, 0)], score: f.score });
  }
  { // hipped: one pitch all round, the ridge along the long side
    const d = roofCells.map((c) => Math.max(Math.abs(c[0] * v[0] + c[1] * v[1]), Math.abs(c[0] * u[0] + c[1] * u[1]) - (a - b)));
    const f = robustFit(d.map((di) => [1, -di]), z);
    if (f && pitch(f.p[1])) candidates.push({ shape: "hip", planes: [plane(f.p[0], f.p[1], v, 0), plane(f.p[0], f.p[1], neg(v), 0), plane(f.p[0], f.p[1], u, a - b), plane(f.p[0], f.p[1], neg(u), a - b)], score: f.score });
  }
  // a pitched roof must fit clearly better than a flat one
  let best: Candidate = { shape: "flat", planes: [[0, 0, flatZ]], score: flatScore };
  for (const c of candidates) if (c.score <= flatScore - 0.12 && c.score <= flatScore * 0.8 && c.score < best.score) best = c;

  // each plane over the part of the footprint where it is the lowest
  const regions = (planes: Plane[]) => planes.map((pi, i) => {
    let poly = ring;
    for (let j = 0; j < planes.length && poly.length >= 3; j++) if (j !== i) poly = clip(poly, (p) => at(pi, p[0], p[1]) - at(planes[j], p[0], p[1]));
    return poly;
  });
  let planes = best.planes, shape = best.shape, parts = regions(planes);
  const roofAt = (x: number, y: number) => Math.min(...planes.map((pl) => at(pl, x, y)));
  const ridge = Math.max(...parts.flatMap((poly, i) => poly.map((p) => at(planes[i], p[0], p[1]))));
  // a tree over it, or eaves too low to stand walls under them: flat, at a plausible height
  const flat = (zz: number) => { planes = [[0, 0, zz]]; shape = "flat"; parts = regions(planes); };
  if (ridge - base > cap) flat(base + cap * 0.75);
  else if (shape !== "flat" && ring.some(([x, y], i) => roofAt(x, y) - grounds[i] < 1)) flat(Math.max(flatZ, groundTop + 2.2));
  else if (shape === "flat" && planes[0][2] < groundTop + 2) flat(groundTop + 2.2);

  const back = (p: P2, zz: number) => [p[0] + cx, p[1] + cy, zz];
  const surfaces: Surface[] = [];
  parts.forEach((poly, i) => {
    if (poly.length >= 3 && Math.abs(signed(poly)) >= 0.01) surfaces.push({ kind: "RoofSurface", rings: [poly.flatMap((p) => back(p, at(planes[i], p[0], p[1])))] });
  });
  // walls: from the lowest ground up to the roof, each side split where the roof's edge bends (ridge, hips)
  for (let e = 0; e < ring.length; e++) {
    const p = ring[e], q = ring[(e + 1) % ring.length], ts = [0, 1];
    for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) {
      const fp = at(planes[i], p[0], p[1]) - at(planes[j], p[0], p[1]), fq = at(planes[i], q[0], q[1]) - at(planes[j], q[0], q[1]);
      if (!((fp < 0 && fq > 0) || (fp > 0 && fq < 0))) continue;
      const t = fp / (fp - fq), m: P2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      if (at(planes[i], m[0], m[1]) <= roofAt(m[0], m[1]) + 1e-6) ts.push(t); // only where the roof bends
    }
    const pts = [...new Set(ts)].sort((x, y) => x - y).map((t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] as P2);
    for (let k = 0; k + 1 < pts.length; k++) {
      const A = pts[k], B = pts[k + 1];
      if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 0.01) continue;
      surfaces.push({ kind: "WallSurface", rings: [[...back(A, base), ...back(B, base), ...back(B, roofAt(B[0], B[1])), ...back(A, roofAt(A[0], A[1]))]] });
    }
  }
  surfaces.push({ kind: "GroundSurface", rings: [ring.flatMap((p) => back(p, base))] });
  const top = Math.max(...surfaces.flatMap((s) => s.rings[0].filter((_, i) => i % 3 === 2)));
  return { surfaces, roofType: shape === "flat" ? "1000" : `fitted ${shape}`, shape, stand, height: top - base };
}
