/**
 * Life above the roofs: now and then an airliner comes in from the sea on the approach to
 * the region's airport (Ben Gurion runway 12 in Israel Center, Stuttgart runway 25; ~3° glide slope) and fades out inland, and a few small flocks of green
 * rose-ringed parakeets (Tel Aviv's famous feral parrots) dart about over the streets.
 * Drawn on the overlay canvas in a local frame projected like the cars (x forward, y side, z up).
 */
export type Vec3 = [number, number, number];
export type ToScreen = (x: number, y: number) => [number, number];

import { ink } from "./ink.ts";
import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";
import type { Airfield, RoofSign } from "../../../pipeline/src/places.ts";

/** The region's airport: runway threshold and heading (places.ts, passed on in world.json). */
export interface Airport {
  lat: number; lon: number; runwayHeadingDeg: number;
  /** threshold ellipsoid height (m, default 0: sea level) */
  h?: number;
  /** the stretch drawn, in metres before the threshold (negative: past it, on the runway) */
  from?: number; to?: number;
}
const FADE = 2500, SPEED = 75, EVERY = 110, GLIDE = Math.tan((3 * Math.PI) / 180);

/** projector + local frame (forward d, z up), scaled, as a canvas transform setter */
export function frame(ctx: CanvasRenderingContext2D, M: number[][], toScreen: ToScreen, p: Vec3, d: [number, number], scale: number) {
  const proj = (q: Vec3) => toScreen(M[0][0] * q[0] + M[0][1] * q[1] + M[0][2] * q[2], M[1][0] * q[0] + M[1][1] * q[1] + M[1][2] * q[2]);
  const o = proj(p), f = proj([p[0] + d[0], p[1] + d[1], p[2]]), s = proj([p[0] + d[1], p[1] - d[0], p[2]]);
  const ex = [(f[0] - o[0]) * scale, (f[1] - o[1]) * scale], ey = [(s[0] - o[0]) * scale, (s[1] - o[1]) * scale];
  return { o, set: () => ctx.setTransform(ex[0], ex[1], ey[0], ey[1], o[0], o[1]), perM: Math.hypot(f[0] - o[0], f[1] - o[1]) };
}

export const inView = (o: [number, number], view: number[], m: number) => o[0] > view[0] - m && o[1] > view[1] - m && o[0] < view[2] + m && o[1] < view[3] + m;

export class Planes {
  private t = EVERY - 6; // first one shortly after load
  private flights: number[] = []; // distance flown (m) per plane in the air
  private threshold: Vec3; // runway threshold in the region's ENU metres
  private dir: [number, number];
  private START: number; private END: number;
  constructor(private M: number[][], airport: Airport) {
    const p = ecefToEnu(llhToEcef(airport.lat, airport.lon, airport.h ?? 0)), a = (airport.runwayHeadingDeg * Math.PI) / 180;
    this.threshold = [p[0], p[1], airport.h === undefined ? 0 : p[2]];
    this.dir = [Math.sin(a), Math.cos(a)];
    // default: Ben Gurion, over the sea → fading out over Ramat Gan
    this.START = airport.from ?? 22000; this.END = airport.to ?? 7000;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (this.t >= EVERY) { this.t = 0; this.flights.push(0); }
    this.flights = this.flights.map((s) => s + SPEED * dt).filter((s) => s < this.START - this.END);
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[]) {
    for (const s of this.flights) {
      const { START, END } = this;
      const left = START - s; // metres to the threshold
      const B = this.threshold, DIR = this.dir;
      // 3° glide slope, crossing the threshold at 30 m, then flaring onto the runway
      const p: Vec3 = [B[0] - DIR[0] * left, B[1] - DIR[1] * left, B[2] + Math.max(0, 30 + left * GLIDE)];
      const alpha = Math.min(1, s / FADE, (START - END - s) / FADE);
      const scale = Math.max(1, 0.12 / px); // never smaller than ~20 screen px across
      // shadow on the ground (sun high in the south-west), then the plane itself
      const above = p[2] - B[2];
      const sh = frame(ctx, this.M, toScreen, [p[0] + above * 0.25, p[1] + above * 0.35, B[2]], DIR, scale);
      const pl = frame(ctx, this.M, toScreen, p, DIR, scale);
      if (!inView(pl.o, view, 400) && !inView(sh.o, view, 400)) continue;
      ctx.globalAlpha = alpha * 0.18; sh.set(); airliner(ctx, "#000", "#000", "#000", "#000", false);
      ctx.globalAlpha = alpha; pl.set(); airliner(ctx, "#f4f5f7", "#c9ced6", "#8a93a0");
      // nav lights: red port, green starboard, white strobe on the tail
      const blink = (performance.now() % 1200) < 120;
      ctx.fillStyle = "#ff3b30"; ctx.fillRect(-2, -17.6, 1.2, 1.2);
      ctx.fillStyle = "#34c759"; ctx.fillRect(-2, 16.4, 1.2, 1.2);
      if (blink) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(-19, 0, 1.6, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}

/** narrow-body airliner from above, ~38 m long and 36 m across, nose at +x (`tail`: fin colour, default `edge`) */
export function airliner(ctx: CanvasRenderingContext2D, body: string, wing: string, edge: string, tail = edge, outline = true) {
  // ink outline like the painted map; a plane is drawn at least ~20 px long, so keep a visible line even then
  const pxPerM = Math.max(3, Math.hypot(ctx.getTransform().a, ctx.getTransform().b));
  const line = () => { if (outline) ink(ctx, pxPerM); };
  const poly = (pts: number[], color: string) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath(); ctx.fill(); line();
  };
  for (const s of [-1, 1]) {
    poly([3, s * 1.8, -3, s * 18, -6, s * 18, -5, s * 1.8], wing);           // swept wing
    poly([-14, s * 1, -18.5, s * 6.5, -20, s * 6.5, -19, s * 1], wing);      // tailplane
    poly([0.5, s * 7, -3, s * 7, -3, s * 8.6, 0.5, s * 8.6], edge);           // engine
  }
  ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, 19, 2, 0, 0, Math.PI * 2); ctx.fill(); line();
  ctx.fillStyle = tail; ctx.beginPath(); ctx.ellipse(-17.5, 0, 2.5, 0.5, 0, 0, Math.PI * 2); ctx.fill(); line(); // fin
}

interface Flock { p: Vec3; h: number; turn: number; timer: number; birds: Array<[number, number, number, number]> }

/**
 * Rotating rooftop signs (places.ts `signs`): a faceted three-pointed star in a ring on a mast, turning about the
 * vertical. Real 3D: the polygons are rotated, lit by the sun (south-west, high, as the shadows) and depth-sorted
 * along the camera's line of sight every frame, so the star turns edge-on and back.
 */
export class Signs {
  private items: Array<{ foot: Vec3; c: Vec3; R: number; mast: number; w: number; a: number }>;
  private look: Vec3; // camera viewing direction (into the scene)
  private sun: Vec3;
  constructor(private M: number[][], signs: RoofSign[]) {
    this.items = signs.map((s) => {
      const e = ecefToEnu(llhToEcef(s.lat, s.lon, s.h)), R = s.diameterM / 2;
      return { foot: [e[0], e[1], e[2]], c: [e[0], e[1], e[2] + s.mastM + R], R, mast: s.mastM, w: (2 * Math.PI * s.rpm) / 60, a: 0 };
    });
    const [a, b] = M; // the projection's null direction is the line of sight; it points down into the scene
    let v: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (v[2] > 0) v = [-v[0], -v[1], -v[2]];
    this.look = norm(v);
    this.sun = norm([-0.25, -0.35, 1]);
  }

  step(dt: number) {
    for (const s of this.items) s.a = (s.a + s.w * Math.min(dt, 0.1)) % (2 * Math.PI);
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, view: number[]) {
    const M = this.M, proj = (q: Vec3) => toScreen(M[0][0] * q[0] + M[0][1] * q[1] + M[0][2] * q[2], M[1][0] * q[0] + M[1][1] * q[1] + M[1][2] * q[2]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const s of this.items) {
      const o = proj(s.c), top = proj([s.c[0], s.c[1], s.c[2] + 1]), perM = Math.hypot(top[0] - o[0], top[1] - o[1]);
      if (s.R * perM < 1.5 || !inView(o, view, s.R * perM + 20)) continue;
      const cs = Math.cos(s.a), sn = Math.sin(s.a), R = s.R;
      // local (u across, v up, t through the plane) → ENU
      const P = (u: number, v: number, t: number): Vec3 => [s.c[0] + (u * cs - t * sn) * R, s.c[1] + (u * sn + t * cs) * R, s.c[2] + v * R];
      const polys: Vec3[][] = [];
      // the star: three arms, each a low pyramid on both faces (ridge from the raised centre to the tip)
      for (let k = 0; k < 3; k++) {
        const f = Math.PI / 2 + (k * 2 * Math.PI) / 3, tip = [Math.cos(f) * 0.97, Math.sin(f) * 0.97];
        const l = [Math.cos(f + Math.PI / 3) * 0.19, Math.sin(f + Math.PI / 3) * 0.19], r = [Math.cos(f - Math.PI / 3) * 0.19, Math.sin(f - Math.PI / 3) * 0.19];
        for (const t of [0.13, -0.13]) {
          polys.push([P(0, 0, t), P(tip[0], tip[1], 0), P(l[0], l[1], 0)]);
          polys.push([P(0, 0, t), P(tip[0], tip[1], 0), P(r[0], r[1], 0)]);
        }
      }
      // the ring: both faces and the outer rim, in 32 segments
      const N = 32, r0 = 0.95, r1 = 1.08, h = 0.05;
      for (let k = 0; k < N; k++) {
        const g0 = (k / N) * 2 * Math.PI, g1 = ((k + 1) / N) * 2 * Math.PI, c0 = Math.cos(g0), s0 = Math.sin(g0), c1 = Math.cos(g1), s1 = Math.sin(g1);
        for (const t of [h, -h]) polys.push([P(c0 * r0, s0 * r0, t), P(c0 * r1, s0 * r1, t), P(c1 * r1, s1 * r1, t), P(c1 * r0, s1 * r0, t)]);
        polys.push([P(c0 * r1, s0 * r1, h), P(c1 * r1, s1 * r1, h), P(c1 * r1, s1 * r1, -h), P(c0 * r1, s0 * r1, -h)]);
      }
      // the mast (dark, behind everything it holds)
      const m0 = proj(s.foot), m1 = proj([s.c[0], s.c[1], s.c[2] - R * 0.95]);
      const ink = Math.max(1.5, Math.min(3, 0.12 * R * perM)); // the map's dark outline, in screen pixels
      ctx.lineCap = "round";
      ctx.strokeStyle = "#1c1f24"; ctx.lineWidth = Math.max(1, 0.35 * perM) + 2 * ink;
      ctx.beginPath(); ctx.moveTo(m0[0], m0[1]); ctx.lineTo(m1[0], m1[1]); ctx.stroke();
      ctx.strokeStyle = "#5a6068"; ctx.lineWidth = Math.max(1, 0.35 * perM);
      ctx.beginPath(); ctx.moveTo(m0[0], m0[1]); ctx.lineTo(m1[0], m1[1]); ctx.stroke();
      // far to near along the line of sight; each face lit as seen (double-sided chrome)
      const L = this.look, depth = (p: Vec3[]) => p.reduce((d, q) => d + q[0] * L[0] + q[1] * L[1] + q[2] * L[2], 0) / p.length;
      polys.sort((p, q) => depth(q) - depth(p));
      ctx.lineJoin = "round";
      // ink first: every face stroked wide in the dark outline colour, so only the silhouette's rim stays dark
      ctx.fillStyle = ctx.strokeStyle = "#1c1f24"; ctx.lineWidth = 2 * ink;
      for (const p of polys) {
        ctx.beginPath();
        p.forEach((q, i) => { const [x, y] = proj(q); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.lineWidth = 0.6;
      for (const p of polys) {
        const e1 = sub(p[1], p[0]), e2 = sub(p[2], p[0]);
        let n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
        if (n[0] * L[0] + n[1] * L[1] + n[2] * L[2] > 0) n = [-n[0], -n[1], -n[2]]; // the face seen
        const lam = Math.max(0, n[0] * this.sun[0] + n[1] * this.sun[1] + n[2] * this.sun[2]);
        const hv = norm([this.sun[0] - L[0], this.sun[1] - L[1], this.sun[2] - L[2]]); // glint
        const spec = Math.pow(Math.max(0, n[0] * hv[0] + n[1] * hv[1] + n[2] * hv[2]), 24);
        const v = Math.min(1, 0.32 + 0.55 * lam + 0.5 * spec);
        const col = `rgb(${Math.round(70 + 180 * v)},${Math.round(76 + 178 * v)},${Math.round(86 + 172 * v)})`;
        ctx.fillStyle = col; ctx.strokeStyle = col;
        ctx.beginPath();
        p.forEach((q, i) => { const [x, y] = proj(q); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
  }
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export class Parrots {
  private flocks: Flock[] = [];
  private seed = 7;
  private box: number[];

  /** `area` = [e0, n0, e1, n1]: the flocks wander over this, turning back at the edges */
  constructor(private M: number[][], area: number[], count = 6) {
    const pad = 300;
    this.box = [area[0] + pad, area[1] + pad, area[2] - pad, area[3] - pad];
    const b = this.box;
    for (let k = 0; k < count; k++) {
      const n = 3 + Math.floor(this.rnd() * 5), birds: Flock["birds"] = [];
      for (let i = 0; i < n; i++) birds.push([(this.rnd() - 0.5) * 14, (this.rnd() - 0.5) * 14, (this.rnd() - 0.5) * 3, this.rnd() * 6]);
      this.flocks.push({
        p: [b[0] + this.rnd() * (b[2] - b[0]), b[1] + this.rnd() * (b[3] - b[1]), 25 + this.rnd() * 20],
        h: this.rnd() * Math.PI * 2, turn: 0, timer: 0, birds,
      });
    }
  }

  get count() { return this.flocks.reduce((a, f) => a + f.birds.length, 0); }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    const b = this.box;
    for (const f of this.flocks) {
      f.timer -= dt;
      if (f.timer <= 0) { f.timer = 1 + this.rnd() * 3; f.turn = (this.rnd() - 0.5) * 1.6; } // swooping, chattering turns
      const out = f.p[0] < b[0] || f.p[0] > b[2] || f.p[1] < b[1] || f.p[1] > b[3];
      if (out) { // steer back towards the middle
        const want = Math.atan2((b[0] + b[2]) / 2 - f.p[0], (b[1] + b[3]) / 2 - f.p[1]);
        f.turn = Math.sign(Math.sin(want - f.h)) * 0.9;
      }
      f.h += f.turn * dt;
      f.p[0] += Math.sin(f.h) * 14 * dt; f.p[1] += Math.cos(f.h) * 14 * dt;
      f.p[2] = 30 + 10 * Math.sin(performance.now() / 4000 + f.birds.length);
    }
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[]) {
    if (px < 0.5) return;
    const now = performance.now() / 1000;
    for (const f of this.flocks) {
      const d: [number, number] = [Math.sin(f.h), Math.cos(f.h)];
      for (const [bx, by, bz, ph] of f.birds) {
        const wob = Math.sin(now * 1.3 + ph) * 1.5;
        const p: Vec3 = [f.p[0] + d[0] * bx + d[1] * (by + wob), f.p[1] + d[1] * bx - d[0] * (by + wob), f.p[2] + bz];
        const bird = frame(ctx, this.M, toScreen, p, d, 8 / Math.min(1, px)); // ≥ 8× life size, or a parakeet is a speck
        if (!inView(bird.o, view, 30)) continue;
        bird.set();
        const flap = Math.sin(now * 22 + ph * 5); // fast parakeet wingbeats
        ctx.fillStyle = "#3fae3a";
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(0.05, s * 0.03); ctx.lineTo(-0.08, s * (0.12 + 0.2 * Math.abs(flap))); ctx.lineTo(-0.14, s * 0.03); ctx.closePath(); ctx.fill();
        }
        ctx.beginPath(); ctx.moveTo(-0.08, 0); ctx.lineTo(-0.36, 0.02); ctx.lineTo(-0.36, -0.02); ctx.closePath(); ctx.fill(); // long tail
        ctx.fillStyle = "#57c94d"; ctx.beginPath(); ctx.ellipse(0, 0, 0.11, 0.04, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#d8333a"; ctx.beginPath(); ctx.arc(0.12, 0, 0.018, 0, Math.PI * 2); ctx.fill(); // red beak
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}

// ---- light aircraft at a small airfield (places.ts `airfield`) ------------------------------------

/** a flight path: smoothed ENU points with the target speed (m/s) at each, and how its ends fade */
interface Route { pts: Vec3[]; v: number[]; cum: number[]; len: number; fadeIn: number; fadeOut: number; ground: number }
interface Wp { p: Vec3; v: number; sharp?: boolean }
type Kind = "echo" | "ul";
interface Flight { r: Route; s: number; kind: Kind; livery: number; landing: boolean }

const GA_EVERY = 70, LIFTOFF = 280, TOUCHDOWN = 120, STOP = 480, TURN = 300;
const LIVERIES: Record<Kind, Array<[string, string]>> = { // body, trim
  echo: [["#f6f6f2", "#c8322b"], ["#f6f6f2", "#2a5aa8"], ["#efe6cf", "#7a4a26"]],
  ul: [["#f8f8f8", "#e8b21c"], ["#f8f8f8", "#2f8f5b"], ["#f8f8f8", "#d04a2a"]],
};

/**
 * Echo-class planes (~C172) and ultralights take off from the airfield, fly its published routes and
 * land again: departures leave over the map edge, arrivals come in over it, circuits do both.
 */
export class LightAircraft {
  private flights: Flight[] = [];
  private t = GA_EVERY - 8;
  private n = 0;
  private seed = 11;
  private takeoff: Wp[]; private landing: Wp[];
  private ground: number;
  private enu: (f: number[]) => Vec3;

  constructor(private M: number[][], private a: Airfield) {
    const [T, F] = a.runway.map(([lat, lon, h]) => ecefToEnu(llhToEcef(lat, lon, h)) as Vec3);
    this.ground = T[2];
    this.enu = ([lat, lon, agl]) => ecefToEnu(llhToEcef(lat, lon, a.runway[0][2] + (agl ?? a.agl))) as Vec3;
    const L = Math.hypot(F[0] - T[0], F[1] - T[1]);
    // along the runway from the threshold (negative: before it on the extended centre line), up `agl`
    const along = (d: number, agl: number): Vec3 => {
      const f = d / L;
      return [T[0] + (F[0] - T[0]) * f, T[1] + (F[1] - T[1]) * f, T[2] + (F[2] - T[2]) * Math.max(0, Math.min(1, f)) + agl];
    };
    this.takeoff = [
      { p: along(0, 0), v: 3, sharp: true }, { p: along(LIFTOFF, 0), v: 28, sharp: true },
      { p: along(L + 300, 40), v: 36, sharp: true },
    ];
    this.landing = [
      { p: along(-1000, 60), v: 32, sharp: true }, { p: along(0, 15), v: 30, sharp: true },
      { p: along(TOUCHDOWN, 0), v: 27, sharp: true }, { p: along(STOP, 0), v: 4, sharp: true },
    ];
    // two in the air already when the map opens
    this.spawn("circuit", 0.45); this.spawn("arrival", 0.3);
  }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  private pick<T>(xs: T[]) { return xs[Math.floor(this.rnd() * xs.length)]; }

  private spawn(type: "departure" | "arrival" | "circuit", at = 0) {
    const a = this.a, fix = (f: number[]): Wp => ({ p: this.enu(f), v: 45 });
    let wps: Wp[];
    if (type === "departure") wps = [...this.takeoff, ...a.out.map(fix), ...this.pick(a.exits).map(fix)];
    else if (type === "arrival") wps = [...this.pick(a.entries).map(fix), ...a.in.map(fix), ...this.landing];
    else wps = [...this.takeoff, ...a.out.map(fix), ...a.circuit.map(fix), ...a.in.map(fix), ...this.landing];
    const r = route(wps, type === "arrival" ? 1500 : 40, type === "departure" ? 1500 : 60, this.ground);
    const kind: Kind = this.rnd() < 0.55 ? "echo" : "ul";
    this.flights.push({ r, s: at * r.len, kind, livery: Math.floor(this.rnd() * 3), landing: type !== "departure" });
  }

  /** the runway is busy: someone is on short final, rolling out or taking off */
  private runwayBusy() {
    return this.flights.some((f) => (f.landing && f.r.len - f.s < 2500) || (f.r.fadeIn < 100 && f.s < 700));
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (this.t >= GA_EVERY) {
      const type = (["circuit", "departure", "arrival", "circuit", "arrival", "departure"] as const)[this.n % 6];
      if (type === "arrival" || !this.runwayBusy()) { this.spawn(type); this.n++; this.t = 0; } // else hold short
    }
    for (const f of this.flights) f.s += speedAt(f.r, f.s) * (f.kind === "ul" ? 0.8 : 1) * dt;
    this.flights = this.flights.filter((f) => f.s < f.r.len);
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, _px: number, view: number[]) {
    for (const f of this.flights) {
      const { p, d } = poseAt(f.r, f.s);
      // never under ~22 screen px long (a 1:1 Cessna is a speck next to the 20 m runway even zoomed in)
      const scale = Math.max(1, 22 / (8.5 * frame(ctx, this.M, toScreen, p, d, 1).perM));
      const alpha = Math.min(1, f.s / f.r.fadeIn, (f.r.len - f.s) / f.r.fadeOut);
      const above = p[2] - f.r.ground;
      const sh = frame(ctx, this.M, toScreen, [p[0] + above * 0.25, p[1] + above * 0.35, f.r.ground], d, scale);
      const pl = frame(ctx, this.M, toScreen, p, d, scale);
      if (!inView(pl.o, view, 200) && !inView(sh.o, view, 200)) continue;
      const [body, trim] = LIVERIES[f.kind][f.livery];
      ctx.globalAlpha = alpha * 0.2; sh.set(); this.shape(ctx, f.kind, "#000", "#000", false);
      ctx.globalAlpha = alpha; pl.set(); this.shape(ctx, f.kind, body, trim, true);
      const tip = f.kind === "echo" ? 5.5 : 5.35;
      ctx.fillStyle = "#ff3b30"; ctx.fillRect(-0.4, -tip, 0.4, 0.4);
      ctx.fillStyle = "#34c759"; ctx.fillRect(-0.4, tip - 0.4, 0.4, 0.4);
      if ((performance.now() + f.livery * 400) % 1500 < 100) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(-0.2, -tip, 0.5, 0, Math.PI * 2); ctx.arc(-0.2, tip, 0.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  /** from above, nose at +x, metres: Echo ~ Cessna 172 (high wing, 8.3 m long, 11 m span), UL slim low-wing (6.5 m, 10.7 m) */
  private shape(ctx: CanvasRenderingContext2D, kind: Kind, body: string, trim: string, detail: boolean) {
    const poly = (pts: number[], color: string, mirror = true) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      if (mirror) for (let i = pts.length - 2; i >= 0; i -= 2) ctx.lineTo(pts[i], -pts[i + 1]);
      ctx.closePath(); ctx.fill();
      if (detail && color === body) ink(ctx, Math.max(3, Math.hypot(ctx.getTransform().a, ctx.getTransform().b)));
    };
    if (kind === "echo") {
      poly([4.2, 0.35, 3.4, 0.6, 0.8, 0.62, -2.2, 0.4, -4.3, 0.15], body);          // fuselage
      poly([-3.4, 0.3, -3.6, 1.7, -4.4, 1.7, -4.4, 0], body);                         // tailplane
      if (detail) poly([3.4, 0.15, -3.8, 0.15], trim);                                // cheat line
      poly([1.3, 0, 1.3, 5.5, -0.15, 5.5, -0.15, 0], body);                           // high wing on top
      if (detail) { poly([1.3, 4.6, 1.3, 5.5, -0.15, 5.5, -0.15, 4.6], trim, false); poly([1.3, -4.6, 1.3, -5.5, -0.15, -5.5, -0.15, -4.6], trim, false); }
    } else {
      poly([0.6, 0, 0.35, 5.35, -0.3, 5.35, -0.55, 0], body);                         // low wing below
      poly([-3.6, 0.2, -3.75, 1.3, -4.15, 1.3, -4.15, 0], body);                      // T-tail
      poly([2.4, 0.2, 1.6, 0.5, 0.2, 0.5, -1.6, 0.3, -4.1, 0.1], body);              // teardrop fuselage
      if (detail) { poly([0.35, 4.5, 0.3, 5.35, -0.3, 5.35, -0.35, 4.5], trim, false); poly([0.35, -4.5, 0.3, -5.35, -0.3, -5.35, -0.35, -4.5], trim, false); poly([-2.5, 0.12, -4.1, 0.1], trim); }
    }
    if (!detail) return;
    ctx.fillStyle = "rgba(40,60,80,0.75)"; ctx.beginPath(); ctx.ellipse(kind === "echo" ? 2 : 1.2, 0, 0.7, 0.38, 0, 0, Math.PI * 2); ctx.fill(); // windows / canopy
    ctx.fillStyle = "rgba(60,60,60,0.25)"; ctx.beginPath(); ctx.ellipse(kind === "echo" ? 4.3 : 2.5, 0, 0.08, 0.95, 0, 0, Math.PI * 2); ctx.fill(); // propeller disc
  }
}

/** smooth the corners (cut each non-sharp corner `TURN` m back, three times), then measure */
function route(wps: Wp[], fadeIn: number, fadeOut: number, ground: number): Route {
  for (let k = 0; k < 3; k++) {
    const out: Wp[] = [];
    wps.forEach((w, i) => {
      if (w.sharp || i === 0 || i === wps.length - 1) { out.push(w); return; }
      for (const n of [wps[i - 1], wps[i + 1]]) {
        const len = Math.hypot(n.p[0] - w.p[0], n.p[1] - w.p[1]), f = Math.min(0.25, TURN / Math.max(1, len) / (k + 1));
        const q: Wp = { p: [w.p[0] + (n.p[0] - w.p[0]) * f, w.p[1] + (n.p[1] - w.p[1]) * f, w.p[2] + (n.p[2] - w.p[2]) * f], v: w.v + (n.v - w.v) * f };
        out.push(q);
      }
    });
    wps = out;
  }
  const cum = [0];
  for (let i = 1; i < wps.length; i++) cum.push(cum[i - 1] + Math.hypot(wps[i].p[0] - wps[i - 1].p[0], wps[i].p[1] - wps[i - 1].p[1], wps[i].p[2] - wps[i - 1].p[2]));
  return { pts: wps.map((w) => w.p), v: wps.map((w) => w.v), cum, len: cum.at(-1)!, fadeIn, fadeOut, ground };
}

function segAt(r: Route, s: number) {
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < s) i++;
  return { i, f: Math.max(0, Math.min(1, (s - r.cum[i - 1]) / Math.max(1e-6, r.cum[i] - r.cum[i - 1]))) };
}
function speedAt(r: Route, s: number) {
  const { i, f } = segAt(r, s);
  return Math.max(3, r.v[i - 1] + (r.v[i] - r.v[i - 1]) * f);
}
function poseAt(r: Route, s: number): { p: Vec3; d: [number, number] } {
  const { i, f } = segAt(r, s), a = r.pts[i - 1], b = r.pts[i];
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return { p: [a[0] + dx * f, a[1] + dy * f, a[2] + (b[2] - a[2]) * f], d: [dx / l, dy / l] };
}
