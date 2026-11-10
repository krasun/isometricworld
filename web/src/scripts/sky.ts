/**
 * Life above the roofs: now and then an airliner comes in from the sea on the approach to
 * the region's airport (Ben Gurion runway 12 in Israel Center, Stuttgart runway 25; ~3° glide slope) and fades out inland, and a few small flocks of green
 * rose-ringed parakeets (Tel Aviv's famous feral parrots) dart about over the streets.
 * Drawn on the overlay canvas in a local frame projected like the cars (x forward, y side, z up).
 */
type Vec3 = [number, number, number];
type ToScreen = (x: number, y: number) => [number, number];

import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";

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
function frame(ctx: CanvasRenderingContext2D, M: number[][], toScreen: ToScreen, p: Vec3, d: [number, number], scale: number) {
  const proj = (q: Vec3) => toScreen(M[0][0] * q[0] + M[0][1] * q[1] + M[0][2] * q[2], M[1][0] * q[0] + M[1][1] * q[1] + M[1][2] * q[2]);
  const o = proj(p), f = proj([p[0] + d[0], p[1] + d[1], p[2]]), s = proj([p[0] + d[1], p[1] - d[0], p[2]]);
  const ex = [(f[0] - o[0]) * scale, (f[1] - o[1]) * scale], ey = [(s[0] - o[0]) * scale, (s[1] - o[1]) * scale];
  return { o, set: () => ctx.setTransform(ex[0], ex[1], ey[0], ey[1], o[0], o[1]) };
}

const inView = (o: [number, number], view: number[], m: number) => o[0] > view[0] - m && o[1] > view[1] - m && o[0] < view[2] + m && o[1] < view[3] + m;

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
      ctx.globalAlpha = alpha * 0.18; sh.set(); this.shape(ctx, "#000", "#000", "#000");
      ctx.globalAlpha = alpha; pl.set(); this.shape(ctx, "#f4f5f7", "#c9ced6", "#8a93a0");
      // nav lights: red port, green starboard, white strobe on the tail
      const blink = (performance.now() % 1200) < 120;
      ctx.fillStyle = "#ff3b30"; ctx.fillRect(-2, -17.6, 1.2, 1.2);
      ctx.fillStyle = "#34c759"; ctx.fillRect(-2, 16.4, 1.2, 1.2);
      if (blink) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(-19, 0, 1.6, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  /** narrow-body airliner from above, ~38 m long and 36 m across, nose at +x */
  private shape(ctx: CanvasRenderingContext2D, body: string, wing: string, edge: string) {
    const poly = (pts: number[], color: string) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath(); ctx.fill();
    };
    for (const s of [-1, 1]) {
      poly([3, s * 1.8, -3, s * 18, -6, s * 18, -5, s * 1.8], wing);           // swept wing
      poly([-14, s * 1, -18.5, s * 6.5, -20, s * 6.5, -19, s * 1], wing);      // tailplane
      poly([0.5, s * 7, -3, s * 7, -3, s * 8.6, 0.5, s * 8.6], edge);           // engine
    }
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, 19, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = edge; ctx.beginPath(); ctx.ellipse(-17.5, 0, 2.5, 0.5, 0, 0, Math.PI * 2); ctx.fill(); // fin
  }
}

interface Flock { p: Vec3; h: number; turn: number; timer: number; birds: Array<[number, number, number, number]> }

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
