/**
 * Trains on the real lines (OSM route relations, exported by pipeline/src/export.ts exportTrains): Stadtbahn,
 * S-Bahn, regional and long-distance trains. Each line shuttles: out along one direction's relation, a
 * turnaround at the end, back along the other's (the Stadtbahn end to end; mainline trains come in over the
 * map edge to the Hbf terminus and leave the same way). Between stops a train accelerates, cruises and
 * brakes; it dwells at every stop of its relation. Trains of a line run its interval apart.
 *
 * Positions are a pure function of sim time (deterministic for film renders), no collision handling: lines
 * sharing a track are offset by their own phase. Cars are boxes bent along the track (each placed by its two
 * ends), hidden in tunnels and behind cover with a short fade, like the road traffic.
 */

type Vec3 = [number, number, number];
type RGB = [number, number, number];

interface EncodedLine { k: number; r: string; c: string; i: number; b: number; w: number[]; st: number[] }
interface Encoded { v: 1; n: number[]; s: number[]; vis: number[]; l: EncodedLine[] }

/** One direction of a line: its run as samples [e, n, u, visible], arc lengths, stops. */
export interface Line { k: number; ref: string; interval: number; back: number; p: Float32Array; cum: Float32Array; len: number; stops: number[] }

export function decodeTrains(data: Encoded): Line[] {
  const tracks: Float32Array[] = [];
  let p = 0, q = 0;
  for (const n of data.n) {
    const s = new Float32Array(n * 4);
    let e = 0, no = 0, u = 0;
    for (let k = 0; k < n; k++, p += 3) {
      e += data.s[p]; no += data.s[p + 1]; u += data.s[p + 2];
      s[k * 4] = e / 10; s[k * 4 + 1] = no / 10; s[k * 4 + 2] = u / 10;
    }
    const runs = data.vis[q++];
    for (let r = 0, k = 0; r < runs; r++) {
      const len = data.vis[q++], vis = r % 2 === 0 ? 1 : 0;
      for (let j = 0; j < len; j++, k++) s[k * 4 + 3] = vis;
    }
    tracks.push(s);
  }
  return data.l.map((l) => {
    const pts: number[] = [];
    l.w.forEach((wi, j) => {
      const s = tracks[wi < 0 ? ~wi : wi], n = s.length / 4;
      for (let k = j ? 1 : 0; k < n; k++) { const i = wi < 0 ? n - 1 - k : k; pts.push(s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]); }
    });
    const pa = new Float32Array(pts), n = pa.length / 4, cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pa[i * 4] - pa[i * 4 - 4], pa[i * 4 + 1] - pa[i * 4 - 3]);
    return { k: l.k, ref: l.r, interval: l.i, back: l.b, p: pa, cum, len: cum[n - 1] ?? 0, stops: l.st };
  });
}

// ---- rolling stock ------------------------------------------------------------------------------
/** body colour, roof colour, bands on the sides and ends: [from, to] height (m) and colour */
interface Livery { body: RGB; roof: RGB; bands: Array<[number, number, RGB]> }
interface Car { len: number; wid: number; hei: number; liv: Livery; gap: number }

const RED: RGB = [206, 32, 38], LIGHT: RGB = [208, 210, 214], GLASS: RGB = [34, 40, 52];
// SSB DT 8 (yellow, navy window band, grey roof), DB ET 430 S-Bahn, DB double-deck regional coaches and
// their locomotive, ICE / Flixtrain
const DT8: Livery = { body: [244, 200, 16], roof: LIGHT, bands: [[1.2, 2.55, [30, 38, 74]]] };
const ET430: Livery = { body: RED, roof: LIGHT, bands: [[0.35, 0.95, LIGHT], [1.35, 2.35, GLASS]] };
const DOSTO: Livery = { body: RED, roof: LIGHT, bands: [[0.3, 0.75, [176, 178, 184]], [1.05, 1.85, GLASS], [2.75, 3.55, GLASS]] };
const LOCO: Livery = { body: RED, roof: [150, 152, 158], bands: [[0.3, 0.8, [60, 62, 68]], [2.7, 3.3, GLASS]] };
const ICE: Livery = { body: [242, 242, 242], roof: [214, 216, 220], bands: [[0.9, 1.15, RED], [1.55, 2.4, GLASS]] };
const FLX: Livery = { body: [110, 196, 32], roof: LIGHT, bands: [[1.55, 2.4, GLASS]] };

function consist(line: Line, rand: () => number): Car[] {
  const cars: Car[] = [];
  const add = (n: number, c: Omit<Car, "gap">, gap: number) => { for (let i = 0; i < n; i++) cars.push({ ...c, gap }); };
  if (line.k === 0) { // DT 8: 2 cars per unit, single or double traction
    const units = rand() < 0.5 ? 2 : 1;
    for (let u = 0; u < units; u++) { add(2, { len: 19.2, wid: 2.65, hei: 3.4, liv: DT8 }, 0.5); cars.at(-1)!.gap = 1.2; }
  } else if (line.k === 1) { // ET 430: 4 cars per unit, one to two units
    const units = rand() < 0.6 ? 2 : 1;
    for (let u = 0; u < units; u++) { add(4, { len: 16.8, wid: 2.95, hei: 3.85, liv: ET430 }, 0.6); cars.at(-1)!.gap = 1.2; }
  } else if (line.k === 2) { // locomotive + double-deck coaches (push-pull)
    add(1, { len: 19, wid: 2.95, hei: 4.2, liv: LOCO }, 1);
    add(3 + Math.floor(rand() * 3), { len: 26.8, wid: 2.8, hei: 4.6, liv: DOSTO }, 0.8);
  } else {
    const liv = /^FLX/i.test(line.ref) ? FLX : ICE;
    add(8, { len: 25.5, wid: 2.95, hei: 3.85, liv }, 0.8);
  }
  return cars;
}

// ---- timetable ----------------------------------------------------------------------------------
/** per kind: top speed (m/s), acceleration = braking (m/s²), dwell at a stop, turnaround at the end (s) */
const RUN = [
  { v: 15, a: 1.0, dwell: 25, turn: 240 },
  { v: 24, a: 0.9, dwell: 35, turn: 300 },
  { v: 28, a: 0.6, dwell: 50, turn: 480 },
  { v: 30, a: 0.5, dwell: 70, turn: 720 },
];

/** a stretch of one leg: from s0 to s1 (front of the train), starting at t0, running for `run` s, then waiting `wait` s */
interface Hop { t0: number; s0: number; s1: number; run: number; wait: number }
interface Leg { line: Line; rev: boolean; hops: Hop[]; t0: number; dur: number }
interface Service { legs: Leg[]; cycle: number; cars: Car[][]; phase: number[]; k: number }

const runTime = (d: number, v: number, a: number) => (d >= (v * v) / a ? d / v + v / a : 2 * Math.sqrt(d / a));
/** distance covered after time t of a run of length d (accelerate, cruise, brake) */
function runPos(d: number, t: number, v: number, a: number) {
  const T = runTime(d, v, a);
  if (t >= T) return d;
  const vp = Math.min(v, Math.sqrt(a * d)), ta = vp / a;
  if (t < ta) return 0.5 * a * t * t;
  if (t > T - ta) { const r = T - t; return d - 0.5 * a * r * r; }
  return 0.5 * a * ta * ta + vp * (t - ta);
}

export class Trains {
  private services: Service[] = [];
  private t = 0;
  private alpha = new Map<string, { a: number; seen: number }>();
  drawn = 0;

  constructor(lines: Line[], private enu2px: number[][], private camFwd: [number, number]) {
    let seed = 11;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    lines.forEach((A, ia) => {
      if (A.back >= 0 && A.back < ia) return; // the pair was built from its first line
      const R = RUN[A.k];
      const B = A.back >= 0 ? lines[A.back] : A;
      const sample: Car[] = consist(A, rand), L = sample.reduce((s, c) => s + c.len + c.gap, 0);
      const legs: Leg[] = [];
      let t = 0;
      for (const [line, rev] of [[A, false], [B, A.back < 0]] as Array<[Line, boolean]>) {
        if (line.len < L + 60) return;
        // the front runs from L (whole train on the track) to the end; stops as front positions
        const stops = (rev ? line.stops.map((s) => line.len - s).reverse() : line.stops)
          .map((s) => Math.min(line.len, s + L / 2)).filter((s) => s > L + 40 && s < line.len - 40);
        const pts = [L, ...stops, line.len], hops: Hop[] = [], t0 = t;
        for (let i = 1; i < pts.length; i++) {
          const run = runTime(pts[i] - pts[i - 1], R.v, R.a), wait = i === pts.length - 1 ? R.turn : R.dwell;
          hops.push({ t0: t, s0: pts[i - 1], s1: pts[i], run, wait });
          t += run + wait;
        }
        legs.push({ line, rev, hops, t0, dur: t - t0 });
      }
      const cycle = t, n = Math.max(1, Math.round(cycle / (A.interval * 60)));
      const cars = [sample], phase = [rand() * cycle];
      for (let i = 1; i < n; i++) { cars.push(consist(A, rand)); phase.push(phase[0] + (i * cycle) / n); }
      this.services.push({ legs, cycle, cars, phase, k: A.k });
    });
  }

  get count() { return this.services.reduce((n, s) => n + s.phase.length, 0); }

  step(dt: number) { this.t += Math.min(dt, 0.1); }

  /** front position of train `i` of a service now: leg and distance along the leg's line */
  private where(sv: Service, i: number) {
    const tau = (((this.t + sv.phase[i]) % sv.cycle) + sv.cycle) % sv.cycle;
    const leg = sv.legs[tau < sv.legs[0].dur || sv.legs.length < 2 ? 0 : 1];
    const R = RUN[sv.k];
    for (const h of leg.hops) {
      const dt = tau - h.t0;
      if (dt < 0 || dt >= h.run + h.wait) continue;
      return { leg, s: h.s0 + runPos(h.s1 - h.s0, dt, R.v, R.a) };
    }
    return { leg, s: leg.hops.at(-1)!.s1 };
  }

  /** point at distance `s` along a leg (reversed legs run the line backwards) */
  private at(leg: Leg, s: number) {
    const l = leg.line, P = l.p, C = l.cum;
    const d = Math.max(0, Math.min(l.len, leg.rev ? l.len - s : s));
    let lo = 0, hi = C.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] < d) lo = m; else hi = m; }
    const f = (d - C[lo]) / Math.max(1e-3, C[hi] - C[lo]), a = lo * 4, b = hi * 4;
    const near = f < 0.5 ? a : b;
    return { e: P[a] + (P[b] - P[a]) * f, n: P[a + 1] + (P[b + 1] - P[a + 1]) * f, u: P[a + 2] + (P[b + 2] - P[a + 2]) * f, vis: P[near + 3] };
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    if (px < 0.08) return;
    const [vx0, vy0, vx1, vy1] = view, M = this.enu2px;
    const proj = (p: Vec3): [number, number] =>
      toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ c: Vec3; d: [number, number]; car: Car; a: number; depth: number }> = [];
    this.services.forEach((sv, si) => sv.phase.forEach((_, ti) => {
      const { leg, s } = this.where(sv, ti);
      const head = this.at(leg, s), [hx, hy] = proj([head.e, head.n, head.u]), m = 400 * px;
      if (hx < vx0 - m || hy < vy0 - m || hx > vx1 + m || hy > vy1 + m) return;
      let front = s;
      sv.cars[ti].forEach((car, ci) => {
        const p = this.at(leg, front), q = this.at(leg, front - car.len);
        front -= car.len + car.gap;
        const c: Vec3 = [(p.e + q.e) / 2, (p.n + q.n) / 2, (p.u + q.u) / 2];
        let dx = p.e - q.e, dy = p.n - q.n;
        const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        const vis = (p.vis || q.vis) && this.at(leg, front + car.gap + car.len / 2).vis;
        // fade in / out (~0.3 s) at tunnel mouths and behind cover
        const key = `${si}:${ti}:${ci}`, st = this.alpha.get(key);
        const dtf = st ? this.t - st.seen : 0;
        const a = !st || dtf > 1 ? (vis ? 1 : 0) : Math.max(0, Math.min(1, st.a + (vis ? 1 : -1) * Math.max(0, dtf) / 0.3));
        this.alpha.set(key, { a, seen: this.t });
        if (a <= 0) return;
        items.push({ c, d: [dx, dy], car, a, depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
      });
    }));
    items.sort((a, b) => b.depth - a.depth);
    this.drawn = items.length;
    for (const it of items) this.box(ctx, proj, it.c, it.d, it.car, it.a);
  }

  private box(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], car: Car, alpha: number) {
    const r: [number, number] = [d[1], -d[0]], hl = car.len / 2, hw = car.wid / 2;
    const corner = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const Z0 = 0.35; // on the rails
    const base = [corner(hl, hw, Z0), corner(hl, -hw, Z0), corner(-hl, -hw, Z0), corner(-hl, hw, Z0)];
    const poly = (pts: Vec3[], [R, G, B]: RGB, k: number) => {
      ctx.fillStyle = `rgb(${Math.min(255, R * k) | 0},${Math.min(255, G * k) | 0},${Math.min(255, B * k) | 0})`;
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fill();
    };
    const up = (p: Vec3, z: number): Vec3 => [p[0], p[1], p[2] + z];
    ctx.globalAlpha = 0.25 * alpha; // contact shadow
    poly(base.map((p) => [p[0] + 0.5, p[1] - 0.5, p[2] - Z0] as Vec3), [0, 0, 0], 0);
    ctx.globalAlpha = alpha;
    for (let i = 0; i < 4; i++) {
      const a = base[i], b = base[(i + 1) % 4];
      const facing = (b[1] - a[1]) * this.camFwd[0] - (b[0] - a[0]) * this.camFwd[1];
      if (facing >= 0) continue;
      const k = 0.72 + 0.1 * (i % 2);
      poly([a, b, up(b, car.hei - 0.2), up(a, car.hei - 0.2)], car.liv.body, k);
      // bands: inset at the car ends on the long sides (i odd), full width on the ends (windscreens)
      const ins = i % 2 ? 0.5 / car.len : 0.18;
      const a2: Vec3 = [a[0] + (b[0] - a[0]) * ins, a[1] + (b[1] - a[1]) * ins, a[2]], b2: Vec3 = [b[0] + (a[0] - b[0]) * ins, b[1] + (a[1] - b[1]) * ins, b[2]];
      for (const [z0, z1, col] of car.liv.bands) poly([up(a2, z0), up(b2, z0), up(b2, z1), up(a2, z1)], col, k);
    }
    // rounded roof: the body colour runs over the roof edges (that is what reads from above), the roof
    // itself is a narrower raised strip
    const top = [corner(hl, hw, Z0 + car.hei - 0.2), corner(hl, -hw, Z0 + car.hei - 0.2), corner(-hl, -hw, Z0 + car.hei - 0.2), corner(-hl, hw, Z0 + car.hei - 0.2)];
    poly(top, car.liv.body, 0.95);
    const rh = hw * 0.55, rl = hl - 0.4;
    poly([corner(rl, rh, Z0 + car.hei), corner(rl, -rh, Z0 + car.hei), corner(-rl, -rh, Z0 + car.hei), corner(-rl, rh, Z0 + car.hei)], car.liv.roof, 1.06);
    ctx.globalAlpha = 1;
  }
}
