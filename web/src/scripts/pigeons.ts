/**
 * Pigeons on a square (places.ts `life.pigeons`): a flock walking and pecking on the paving; now and then the
 * whole flock takes off, wheels round over the square and lands somewhere else on it. Drawn larger than life
 * (a pigeon would be a pixel) and only when zoomed in close, with shadows cast like the styled render's.
 */
import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";

type Vec3 = [number, number, number];
export interface Square { name: string; at: [number, number]; r: number; count: number }
interface Bird {
  x: number; y: number; h: number;      // on the ground: position (m from the centre), heading (rad)
  walk: number; timer: number;          // walking (1) or pecking (0), seconds left
  coat: string[]; phase: number; ring: number; // flight: phase on the circle, its radius (share)
  lx: number; ly: number;               // flight: where it will land
  fx: number; fy: number; fz: number;   // where it is drawn (m from the centre, height)
}
interface Flock { c: Vec3; r: number; birds: Bird[]; air: number; next: number; climb: number }

/** [body, wing, head]: mostly blue-grey, some dark, a few white or brown */
const COATS = [
  ["#9097a1", "#737a85", "#5d6572"], ["#9097a1", "#737a85", "#5d6572"], ["#9097a1", "#737a85", "#5d6572"],
  ["#6c7079", "#555962", "#474b54"], ["#b2b6bc", "#94989f", "#6f747d"], ["#eeeeec", "#d9d9d6", "#e4e4e1"], ["#9a7f6b", "#7d6656", "#6c5a4d"],
];
const SCALE = 3.5, FLIGHT = 10;

export class Pigeons {
  private flocks: Flock[] = [];
  private seed = 23;
  private t = 0;
  private shadow: [number, number];

  /** `ground`: the ENU height of the square's paving; `camFwd`: the view's horizontal direction */
  constructor(private M: number[][], squares: Square[], ground: (x: number, y: number) => number, camFwd: [number, number]) {
    const f = camFwd, r: [number, number] = [f[1], -f[0]]; // the renderer's styled sun: shadows fall forward-right
    this.shadow = [(0.45 * f[0] + 0.55 * r[0]) / 0.8, (0.45 * f[1] + 0.55 * r[1]) / 0.8];
    for (const s of squares) {
      const [x, y] = ecefToEnu(llhToEcef(s.at[0], s.at[1], 0)), birds: Bird[] = [];
      for (let i = 0; i < s.count; i++) {
        const [bx, by] = this.spot(s.r);
        birds.push({ x: bx, y: by, h: this.rnd() * 6.3, walk: 0, timer: this.rnd() * 4, coat: COATS[Math.floor(this.rnd() * COATS.length)],
          phase: this.rnd() * 6.3, ring: 0.5 + this.rnd() * 0.5, lx: bx, ly: by, fx: bx, fy: by, fz: 0 });
      }
      this.flocks.push({ c: [x, y, ground(x, y)], r: s.r, birds, air: -1, next: 30 + this.rnd() * 60, climb: 12 });
    }
  }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  /** a random spot on the square (the inner part of the circle) */
  private spot(r: number): [number, number] { const a = this.rnd() * 6.3, d = Math.sqrt(this.rnd()) * r; return [Math.cos(a) * d, Math.sin(a) * d]; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    for (const f of this.flocks) {
      if (f.air < 0 && this.t >= f.next) { // startled: all up at once, to land somewhere else on the square
        f.air = 0; f.climb = 10 + this.rnd() * 8;
        for (const b of f.birds) { b.phase = Math.atan2(b.y, b.x); [b.lx, b.ly] = this.spot(f.r); }
      }
      if (f.air >= 0) {
        f.air += dt;
        // off the ground in ~1 s, a wide circle, down onto the landing spot over the last 1.5 s
        const k = f.air / FLIGHT, w = Math.min(1, f.air / 1.2, Math.max(0, (FLIGHT - f.air) / 1.5));
        for (const b of f.birds) {
          const a = b.phase + f.air * 0.9, R = f.r * (0.6 + 0.6 * b.ring);
          const gx = k < 0.5 ? b.x : b.lx, gy = k < 0.5 ? b.y : b.ly;
          b.fx = gx + (Math.cos(a) * R - gx) * w;
          b.fy = gy + (Math.sin(a) * R - gy) * w;
          b.fz = f.climb * (0.7 + 0.3 * b.ring) * Math.sin(Math.PI * Math.min(1, k)) * w;
          b.h = a + Math.PI / 2;
        }
        if (f.air >= FLIGHT) {
          f.air = -1; f.next = this.t + 45 + this.rnd() * 75;
          for (const b of f.birds) { b.x = b.fx = b.lx; b.y = b.fy = b.ly; b.fz = 0; b.walk = 0; b.timer = 1 + this.rnd() * 3; }
        }
        continue;
      }
      for (const b of f.birds) { // walking and pecking
        b.timer -= dt;
        if (b.timer <= 0) {
          b.walk = b.walk ? 0 : 1;
          b.timer = b.walk ? 0.8 + this.rnd() * 2 : 1.5 + this.rnd() * 5;
          if (b.walk) b.h += (this.rnd() - 0.5) * 2.4;
        }
        if (b.walk) {
          if (Math.hypot(b.x, b.y) > f.r) b.h = Math.atan2(-b.y, -b.x) + (this.rnd() - 0.5) * 0.6; // back onto the square
          b.x += Math.cos(b.h) * 0.3 * dt; b.y += Math.sin(b.h) * 0.3 * dt;
        }
        b.fx = b.x; b.fy = b.y; b.fz = 0;
      }
    }
  }

  /** `px`: canvas px per art px (only drawn zoomed in) */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: number[]) {
    if (px < 0.5) return;
    const M = this.M, now = this.t;
    const proj = (p: Vec3) => toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    for (const f of this.flocks) {
      const [sx, sy] = proj(f.c);
      if (sx < view[0] - 300 || sy < view[1] - 300 || sx > view[2] + 300 || sy > view[3] + 300) continue;
      const flying = f.air >= 0;
      // shadows first, then the birds back to front
      for (const b of f.birds) {
        const g: Vec3 = [f.c[0] + b.fx + this.shadow[0] * b.fz, f.c[1] + b.fy + this.shadow[1] * b.fz, f.c[2] + 0.02];
        this.frame(ctx, proj, g, b.h, SCALE);
        ctx.globalAlpha = flying ? 0.12 : 0.22; ctx.fillStyle = "#000";
        ctx.beginPath(); ctx.ellipse(0, 0, flying ? 0.1 : 0.15, flying ? 0.18 : 0.07, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      for (const b of f.birds) {
        this.frame(ctx, proj, [f.c[0] + b.fx, f.c[1] + b.fy, f.c[2] + 0.12 + b.fz], b.h, SCALE);
        const [body, wing, head] = b.coat;
        if (flying) { // spread wings, beating
          const beat = Math.sin(now * 18 + b.phase * 7), span = 0.32 * (0.55 + 0.45 * Math.abs(beat));
          ctx.fillStyle = wing;
          for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(0.06, 0); ctx.lineTo(-0.02, s * span); ctx.lineTo(-0.1, s * span * 0.8); ctx.lineTo(-0.06, 0); ctx.closePath(); ctx.fill(); }
        }
        ctx.fillStyle = "#3a3f47"; // tail
        ctx.beginPath(); ctx.moveTo(-0.12, 0.03); ctx.lineTo(-0.2, 0.045); ctx.lineTo(-0.2, -0.045); ctx.lineTo(-0.12, -0.03); ctx.closePath(); ctx.fill();
        ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(-0.01, 0, 0.12, 0.065, 0, 0, Math.PI * 2); ctx.fill();
        if (!flying) { // folded wings with their two dark bars
          ctx.fillStyle = wing; ctx.beginPath(); ctx.ellipse(-0.04, 0, 0.08, 0.055, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#2f333a"; ctx.fillRect(-0.07, -0.05, 0.012, 0.1); ctx.fillRect(-0.045, -0.05, 0.012, 0.1);
        }
        const peck = !flying && !b.walk ? Math.max(0, Math.sin(now * 7 + b.phase * 3)) * 0.035 : 0; // head bobbing down
        ctx.fillStyle = "#6f8f7c"; ctx.beginPath(); ctx.ellipse(0.075 + peck * 0.5, 0, 0.035, 0.04, 0, 0, Math.PI * 2); ctx.fill(); // green-purple neck
        ctx.fillStyle = head; ctx.beginPath(); ctx.arc(0.11 + peck, 0, 0.032, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#c9a26b"; ctx.fillRect(0.14 + peck, -0.008, 0.02, 0.016); // beak
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  /** canvas transform: a local frame at p, heading h (x forward), scaled */
  private frame(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], p: Vec3, h: number, scale: number) {
    const d = [Math.cos(h), Math.sin(h)], o = proj(p), fwd = proj([p[0] + d[0], p[1] + d[1], p[2]]), side = proj([p[0] - d[1], p[1] + d[0], p[2]]);
    ctx.setTransform((fwd[0] - o[0]) * scale, (fwd[1] - o[1]) * scale, (side[0] - o[0]) * scale, (side[1] - o[1]) * scale, o[0], o[1]);
  }
}
