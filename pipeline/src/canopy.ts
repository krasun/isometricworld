/**
 * Tree crowns from a normalised surface model (nDOM: surface height above the terrain, 1 m pixels),
 * for regions without a tree inventory. Pixels over buildings are masked out; every local maximum of
 * the smoothed canopy height (3 m+) becomes one crown, its radius from its height (open-grown city
 * trees are roughly as wide as half their height) capped by the distance to the next crown.
 */
import { toUtm } from "./utm.ts";

type P2 = [number, number];

export interface Crown { e: number; n: number; r: number; h: number }

/**
 * @param at       nDOM pixel (UTM metres, integer pixel south-west corner -> height above ground, NaN outside)
 * @param bbox     [s, w, n, e] lat/lon of the area (+ margin)
 * @param blocked  UTM footprints (buildings) where the nDOM is roof, not tree
 */
export function crowns(at: (x: number, y: number) => number, bbox: number[], blocked: P2[][]): Crown[] {
  const [S, W, N, E] = bbox;
  const corners = [[S, W], [S, E], [N, W], [N, E]].map(([la, lo]) => toUtm(la, lo));
  const x0 = Math.floor(Math.min(...corners.map((c) => c[0]))), y0 = Math.floor(Math.min(...corners.map((c) => c[1])));
  const nx = Math.ceil(Math.max(...corners.map((c) => c[0]))) - x0, ny = Math.ceil(Math.max(...corners.map((c) => c[1]))) - y0;
  const chm = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = at(x0 + i, y0 + j);
    chm[j * nx + i] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  // building mask (+1 px for eaves and roof edges)
  const mask = new Uint8Array(nx * ny);
  for (const ring of blocked) fill(ring.map(([x, y]) => [x - x0, y - y0] as P2), nx, ny, mask);
  const grown = mask.slice();
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) if (mask[j * nx + i])
    for (const d of [-1, 1, -nx, nx, -nx - 1, -nx + 1, nx - 1, nx + 1]) grown[j * nx + i + d] = 1;
  for (let k = 0; k < chm.length; k++) if (grown[k]) chm[k] = 0;
  // smooth (3×3 binomial twice): one peak per crown instead of one per branch
  let s = chm;
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float32Array(nx * ny);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      t[k] = (4 * s[k] + 2 * (s[k - 1] + s[k + 1] + s[k - nx] + s[k + nx]) + s[k - nx - 1] + s[k - nx + 1] + s[k + nx - 1] + s[k + nx + 1]) / 16;
    }
    s = t;
  }
  // local maxima within a height-dependent window
  const peaks: Crown[] = [];
  for (let j = 3; j < ny - 3; j++) for (let i = 3; i < nx - 3; i++) {
    const k = j * nx + i, h = s[k];
    if (h < 3 || chm[k] < 2.5) continue;
    const w = Math.round(Math.min(4, Math.max(2, 1 + h * 0.1)));
    let top = true;
    for (let dj = -w; dj <= w && top; dj++) for (let di = -w; di <= w; di++) {
      if ((di || dj) && di * di + dj * dj <= w * w && s[k + dj * nx + di] > h) { top = false; break; }
    }
    if (!top) continue;
    peaks.push({ e: x0 + i + 0.5, n: y0 + j + 0.5, r: 0, h: Math.max(...[k, k - 1, k + 1, k - nx, k + nx].map((q) => chm[q])) });
  }
  // radius: ~0.3 × height, at most 70 % of the way to the nearest neighbour, 1.5–8 m
  const cell = new Map<string, Crown[]>();
  const key = (e: number, n: number) => `${Math.floor(e / 10)}_${Math.floor(n / 10)}`;
  for (const p of peaks) { const k = key(p.e, p.n); (cell.get(k) ?? cell.set(k, []).get(k)!).push(p); }
  for (const p of peaks) {
    let near = 20;
    const ce = Math.floor(p.e / 10), cn = Math.floor(p.n / 10);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++)
      for (const q of cell.get(`${ce + a}_${cn + b}`) ?? []) if (q !== p) near = Math.min(near, Math.hypot(q.e - p.e, q.n - p.n));
    p.r = Math.max(1.5, Math.min(8, p.h * 0.3, near * 0.7));
  }
  return peaks;
}

/** Scanline fill of a polygon (pixel coordinates, row 0 = south) into a mask. */
function fill(ring: P2[], nx: number, ny: number, mask: Uint8Array) {
  const ys = ring.map((p) => p[1]);
  const lo = Math.max(0, Math.floor(Math.min(...ys))), hi = Math.min(ny - 1, Math.ceil(Math.max(...ys)));
  for (let j = lo; j <= hi; j++) {
    const y = j + 0.5, xs: number[] = [];
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a], [xb, yb] = ring[b];
      if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let i = Math.max(0, Math.ceil(xs[k] - 0.5)); i <= Math.min(nx - 1, Math.floor(xs[k + 1] - 0.5)); i++) mask[j * nx + i] = 1;
  }
}
