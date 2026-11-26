/**
 * Roof shapes over OSM footprints of any outline (presets osmRoofs, osmParts): walls on the footprint and the roof
 * of its `roof:shape`, laid over the footprint's smallest enclosing rectangle (the lowest of its planes, as in
 * fitroof.ts), or drawn in rings towards its centre (domes, cones).
 */
import { triangulate, type V3 } from "./lod2.ts";

type P2 = [number, number];
/** z = ax · x + ay · y + c, in metres around the rectangle's centre, above the eaves */
type Plane = [number, number, number];

const signed = (r: P2[]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const at = (pl: Plane, x: number, y: number) => pl[0] * x + pl[1] * y + pl[2];

/** The smallest rectangle around a ring: centre, unit vectors along its long (u) and short (v) side, half-sides a ≥ b. */
export function enclosing(r: P2[]) {
  let best = { area: Infinity, c: [0, 0] as P2, u: [1, 0] as P2, v: [0, 1] as P2, a: 0, b: 0 };
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const u: P2 = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], v: P2 = [-u[1], u[0]];
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const h of r) {
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

function clip(poly: P2[], f: (p: P2) => number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/** Radius (share of the outline's) and height (share of the roof's) from the eaves to the top. */
const RINGS: Record<string, Array<[number, number]>> = {
  cone: [[1, 0], [0, 1]],
  dome: [[1, 0], [0.97, 0.26], [0.87, 0.5], [0.71, 0.71], [0.5, 0.87], [0.26, 0.97], [0, 1]],
  onion: [[0.85, 0], [1, 0.16], [0.97, 0.3], [0.78, 0.46], [0.45, 0.62], [0.18, 0.78], [0.06, 0.9], [0, 1]],
};

/** The roof's planes for a shape, `rh` m from eaves to ridge; null: flat. */
function planesOf(shape: string, rh: number, across: boolean, R: ReturnType<typeof enclosing>): Plane[] | null {
  const { u, v, a, b } = R;
  const down = (d: P2, half: number, rise: number, top: number): Plane[] => // a pair of slopes falling `rise` over `half` m both ways from the ridge
    [[(-d[0] * rise) / half, (-d[1] * rise) / half, top], [(d[0] * rise) / half, (d[1] * rise) / half, top]];
  const [d, h] = across ? [u, a] as const : [v, b] as const; // gables: the ridge runs along the long side unless across
  switch (shape) {
    case "gabled": return down(d, h, rh, rh);
    case "hipped": case "half-hipped": case "side_hipped": {
      const k = rh / b, top = rh + k * (a - b);
      return [...down(v, b, rh, rh), [-u[0] * k, -u[1] * k, top], [u[0] * k, u[1] * k, top]];
    }
    case "pyramidal": case "crosspitched": return [...down(v, b, rh, rh), ...down(u, a, rh, rh)];
    case "skillion": return [[(v[0] * rh) / (2 * b), (v[1] * rh) / (2 * b), rh / 2]];
    case "gambrel": return [...down(d, h, rh * 1.6, rh * 1.6), ...down(d, h, rh * 0.5, rh)];
    case "mansard": return [...down(v, b, rh * 2.2, rh * 2.2), ...down(u, a, (rh * 2.2 * a) / b, (rh * 2.2 * a) / b), [0, 0, rh]];
    case "round": case "half_round": // tangents of the arch
      return [0.3, 0.75, 0.97].flatMap((s) => { const z = Math.sqrt(1 - s * s), m = s / z; return down(d, h, rh * m, rh * (z + m * s)); });
    default: return null;
  }
}

/**
 * Walls from `min` up to the eaves and the roof on top, as mesh arrays (lod2.ts): all heights above `base`,
 * `top` the highest point, `rh` of it roof. `ring` counter-clockwise, in ENU metres.
 */
export function roofed(ring: P2[], base: number, min: number, top: number, shape: string, rh: number, across = false) {
  const roof: number[] = [], wall: number[] = [];
  const eave = top - rh, R = enclosing(ring), [cx, cy] = R.c, local = ring.map(([x, y]) => [x - cx, y - cy] as P2);
  let along = 0;
  const side = (A: P2, B: P2, za: number, zb: number) => {
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (L < 0.01) return;
    const v = (p: P2, s: number, z: number) => wall.push(p[0], p[1], base + z, along + s, z);
    v(A, 0, min); v(B, L, min); v(B, L, zb); v(A, 0, min); v(B, L, zb); v(A, 0, za);
    along += L;
  };
  const rings = rh > 0 ? RINGS[shape] : undefined;
  if (rings) {
    const g: P2 = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    const P = (p: P2, [r, z]: [number, number]) => [g[0] + (p[0] - g[0]) * r, g[1] + (p[1] - g[1]) * r, base + eave + rh * z];
    for (let i = 0; i < ring.length; i++) {
      const A = ring[i], B = ring[(i + 1) % ring.length];
      side(A, B, eave, eave);
      for (let k = 0; k + 1 < rings.length; k++) {
        const lo = rings[k], hi = rings[k + 1];
        const a0 = P(A, lo), b0 = P(B, lo), a1 = P(A, hi), b1 = P(B, hi);
        roof.push(...a0, ...b0, ...b1);
        if (hi[0] > 0) roof.push(...a0, ...b1, ...a1);
      }
    }
    return { roof, wall };
  }
  const planes = (rh > 0 && planesOf(shape, rh, across, R)) || [[0, 0, rh] as Plane];
  const roofAt = (x: number, y: number) => Math.max(min + 0.2, eave + Math.min(...planes.map((pl) => at(pl, x, y))));
  planes.forEach((pi, i) => {
    let poly = local;
    for (let j = 0; j < planes.length && poly.length >= 3; j++) if (j !== i) poly = clip(poly, (p) => at(pi, p[0], p[1]) - at(planes[j], p[0], p[1]));
    if (poly.length < 3 || Math.abs(signed(poly)) < 0.01) return;
    for (const tri of triangulate([poly.map(([x, y]) => [x + cx, y + cy, base + eave + at(pi, x, y)] as V3)]) ?? []) for (const v of tri) roof.push(...v);
  });
  for (let e = 0; e < local.length; e++) { // each side split where the roof's edge bends (ridge, hips)
    const p = local[e], q = local[(e + 1) % local.length], ts = [0, 1];
    for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) {
      const fp = at(planes[i], p[0], p[1]) - at(planes[j], p[0], p[1]), fq = at(planes[i], q[0], q[1]) - at(planes[j], q[0], q[1]);
      if (!((fp < 0 && fq > 0) || (fp > 0 && fq < 0))) continue;
      const t = fp / (fp - fq), x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
      if (at(planes[i], x, y) <= Math.min(...planes.map((pl) => at(pl, x, y))) + 1e-6) ts.push(t);
    }
    const pts = [...new Set(ts)].sort((x, y) => x - y).map((t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] as P2);
    for (let k = 0; k + 1 < pts.length; k++) {
      const A = pts[k], B = pts[k + 1];
      side([A[0] + cx, A[1] + cy], [B[0] + cx, B[1] + cy], roofAt(...A), roofAt(...B));
    }
  }
  return { roof, wall };
}
