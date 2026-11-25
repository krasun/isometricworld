/**
 * Tower cranes at work on the construction sites (pipeline/page/sites.ts plans them, export.ts exportCranes lists
 * them). The tiles draw the ballast and the mast; this draws what slews on top: deck, cab, jib, counter-jib with
 * its weights, the A-frame and ties, the trolley, the hook and what hangs on it, and the jib's shadow on the
 * ground.
 *
 * Each crane repeats its own loop of lifts: slew and run the trolley out to a pick-up point, lower the hook, wait
 * while the load is slung, lift, slew to the drop point, lower, wait, lift the empty hook. Positions are a pure
 * function of sim time (deterministic for film renders).
 *
 * Geometry as the crane the renderer drew before (page/renderer.ts crane): local u along the jib, v across, w up
 * from the crane's base.
 */

type Vec3 = [number, number, number];
type RGB = [number, number, number];

const YEL: RGB = [237, 184, 33], GREY: RGB = [158, 158, 153], DARK: RGB = [64, 64, 69], CAB: RGB = [230, 230, 224], WINCH: RGB = [102, 107, 115];
const LOADS: Array<{ size: Vec3; col: RGB }> = [
  { size: [1.6, 1.2, 0.9], col: [176, 150, 112] }, // a pallet of blocks
  { size: [6, 0.6, 0.4], col: [138, 84, 60] }, // a bundle of rebar
  { size: [2.4, 1.2, 1.1], col: [150, 154, 160] }, // a skip
  { size: [5, 1.8, 0.25], col: [196, 196, 190] }, // a formwork panel
];
const SLEW = (4 * Math.PI) / 180, TROLLEY = 0.9, HOIST = 1.3; // rad/s, m/s, m/s at full speed
const JW = 0.8, JH = 1.6, M = 1.0; // jib half-width and height, mast half-width

/** where the hook is: slew angle, trolley radius, hook height above the base; the load on it (-1: none) */
interface Pose { th: number; r: number; z: number; load: number }
interface Seg { t0: number; dur: number; a: Pose; b: Pose }
interface Crane { o: Vec3; h: number; jib: number; counter: number; segs: Seg[]; cycle: number; phase: number }

const ease = (f: number) => f * f * (3 - 2 * f);

export class Cranes {
  private cranes: Crane[];
  private t = 0;
  private look: Vec3;
  private sun: Vec3;

  /** `data`: [e, n, u, a, h, jib, counter] per crane (export.ts exportCranes) */
  constructor(data: number[][], private M: number[][]) {
    const [a, b] = M; // the projection's null direction is the line of sight
    let v: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (v[2] > 0) v = [-v[0], -v[1], -v[2]];
    this.look = norm(v);
    // the map's sun (page/renderer.ts SUN, styled): from the viewer's back left, high
    const f = norm([this.look[0], this.look[1], 0]), right = norm([a[0], a[1], 0]);
    this.sun = norm([-0.45 * f[0] - 0.55 * right[0], -0.45 * f[1] - 0.55 * right[1], 0.8]);
    this.cranes = data.map(([e, n, u, th0, h, jib, counter], i) => {
      let seed = (Math.abs(Math.round(e * 7 + n * 13)) % 2147483646) + 1 + i;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const reach = (f: number) => 4 + f * (jib - 6), travel = h * 0.62;
      const segs: Seg[] = [];
      let t = 0, at: Pose = { th: th0, r: reach(0.4), z: travel, load: -1 };
      const go = (to: Partial<Pose>, wait = 0) => {
        const b: Pose = { ...at, ...to };
        const dth = Math.abs(b.th - at.th), dur = Math.max(dth / SLEW * 1.5, Math.abs(b.r - at.r) / TROLLEY * 1.5, Math.abs(b.z - at.z) / HOIST * 1.5);
        if (dur > 0) { segs.push({ t0: t, dur, a: at, b }); t += dur; }
        at = b;
        if (wait > 0) { segs.push({ t0: t, dur: wait, a: at, b: at }); t += wait; }
      };
      const turn = (th: number) => { // the shorter way round, now and then the long way (the operator's choice)
        let d = ((th - at.th) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
        if (rnd() < 0.15) d -= Math.sign(d) * 2 * Math.PI;
        return at.th + d;
      };
      const lifts = 4 + Math.floor(rnd() * 3);
      for (let k = 0; k < lifts; k++) {
        const load = Math.floor(rnd() * LOADS.length), low = 1.2 + LOADS[load].size[2];
        go({ th: turn(at.th + (rnd() - 0.5) * 2.6), r: reach(0.15 + 0.8 * rnd()) }, 1 + 3 * rnd()); // to the pick-up
        go({ z: low }, 8 + 10 * rnd()); // down, slung
        go({ z: travel, load });
        go({ th: turn(at.th + (rnd() < 0.5 ? 1 : -1) * (0.6 + 1.8 * rnd())), r: reach(0.15 + 0.8 * rnd()) }, 1 + 2 * rnd()); // over
        go({ z: low }, 6 + 8 * rnd()); // down, unhooked
        go({ z: travel, load: -1 }, 5 + 25 * rnd());
      }
      go({ th: th0 + Math.round((at.th - th0) / (2 * Math.PI)) * 2 * Math.PI, r: reach(0.4) }, 3); // back where the loop starts
      return { o: [e, n, u], h, jib, counter, segs, cycle: t, phase: rnd() * t };
    });
  }

  step(dt: number) { this.t += Math.min(dt, 0.25); }

  private pose(c: Crane): Pose {
    const t = (this.t + c.phase) % c.cycle;
    let lo = 0, hi = c.segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c.segs[m].t0 <= t) lo = m; else hi = m - 1; }
    const s = c.segs[lo], f = ease(Math.min(1, Math.max(0, (t - s.t0) / s.dur)));
    return { th: s.a.th + (s.b.th - s.a.th) * f, r: s.a.r + (s.b.r - s.a.r) * f, z: s.a.z + (s.b.z - s.a.z) * f, load: f < 0.5 ? s.a.load : s.b.load };
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], view: number[]) {
    const Mx = this.M, L = this.look, S = this.sun;
    const proj = (q: Vec3) => toScreen(Mx[0][0] * q[0] + Mx[0][1] * q[1] + Mx[0][2] * q[2], Mx[1][0] * q[0] + Mx[1][1] * q[1] + Mx[1][2] * q[2]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const c of this.cranes) {
      const o = proj(c.o), up = proj([c.o[0], c.o[1], c.o[2] + 1]), perM = Math.hypot(up[0] - o[0], up[1] - o[1]);
      const reach = (c.jib + c.h) * perM;
      if (reach < 6 || o[0] < view[0] - reach || o[1] < view[1] - reach || o[0] > view[2] + reach || o[1] > view[3] + reach) continue;
      const p = this.pose(c), cu = Math.cos(p.th), sn = Math.sin(p.th);
      const P = (u: number, v: number, w: number): Vec3 => [c.o[0] + u * cu - v * sn, c.o[1] + u * sn + v * cu, c.o[2] + w];
      const top = c.h + 1, detail = perM > 1.6;
      const jb = (u: number, side: number) => P(u, side * JW, top), jt = (u: number) => P(u, 0, top + JH * Math.max(0.35, 1 - (u / c.jib) * 0.65));
      const bars: Array<{ a: Vec3; b: Vec3; w: number; col: RGB }> = [], boxes: Array<{ q: Vec3; s: Vec3; col: RGB }> = [];
      const bar = (a: Vec3, b: Vec3, w: number, col = YEL) => bars.push({ a, b, w, col });
      const box = (q: Vec3, s: Vec3, col: RGB) => boxes.push({ q, s, col }); // q: centre of the base; s: along, across, up

      // the jib's shadow on the ground (the site is flat round the crane): jib, counter-jib, cable
      const shadow = (q: Vec3): [number, number] => { const k = (q[2] - c.o[2]) / S[2]; return proj([q[0] - S[0] * k, q[1] - S[1] * k, c.o[2]]); };
      ctx.globalAlpha = 0.22; ctx.strokeStyle = "#1c1f24";
      ctx.lineWidth = Math.max(1, 1.8 * perM);
      ctx.beginPath();
      let s0 = shadow(P(-c.counter, 0, top)), s1 = shadow(P(c.jib, 0, top));
      ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]);
      ctx.stroke();
      ctx.lineWidth = Math.max(0.7, 0.15 * perM);
      ctx.beginPath();
      s0 = shadow(P(p.r, 0, top)); s1 = shadow(P(p.r, 0, p.z));
      ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // slewing deck and cab
      box(P(0, 0, c.h), [3.2, 3.2, 1.0], YEL);
      box(P(2.2, 1.4, c.h - 0.2), [2.2, 1.6, 2.2], CAB);
      // jib: two bottom chords, a top chord, lacing every 2.5 m (when close enough to see it)
      bar(jb(1.6, -1), jb(c.jib, -1), 0.3); bar(jb(1.6, 1), jb(c.jib, 1), 0.3); bar(jt(1.6), jt(c.jib), 0.3);
      if (detail) for (let u = 1.6, k = 0; u < c.jib; u += 2.5, k++) {
        const u1 = Math.min(c.jib, u + 2.5);
        bar(jb(u, -1), jb(u, 1), 0.14);
        bar(jb(k % 2 ? u : u1, -1), jt(k % 2 ? u1 : u), 0.14);
        bar(jb(k % 2 ? u : u1, 1), jt(k % 2 ? u1 : u), 0.14);
      }
      // counter-jib, its weights and the winch
      bar(P(-1.6, -JW, top), P(-c.counter, -JW, top), 0.3); bar(P(-1.6, JW, top), P(-c.counter, JW, top), 0.3);
      if (detail) for (let u = 1.6; u < c.counter; u += 2.5) bar(P(-u, -JW, top), P(-u, JW, top), 0.14);
      box(P(-c.counter + 1.6, 0, top - 2.6), [2.6, 2.4, 2.8], GREY);
      box(P(-c.counter * 0.55, 0, top), [2.0, 1.4, 1.1], WINCH);
      // A-frame head and the pendant ties
      const apex = P(0, 0, top + 7);
      for (const u of [-1.2, 1.2]) for (const v of [-JW, JW]) bar(P(u, v, top), apex, 0.3);
      bar(apex, jt(c.jib * 0.62), 0.08, DARK); bar(apex, P(-c.counter + 1, 0, top), 0.08, DARK);
      // trolley, cable, hook block, the load slung under it
      box(P(p.r, 0, top - 1.0), [1.4, 1.8, 0.5], DARK);
      bar(P(p.r, 0, top - 1.0), P(p.r, 0, p.z + 0.8), 0.06, DARK);
      box(P(p.r, 0, p.z), [0.6, 0.6, 0.8], YEL);
      if (p.load >= 0) {
        const ld = LOADS[p.load], w = p.z - 0.9 - ld.size[2];
        for (const v of [-0.4, 0.4]) bar(P(p.r, 0, p.z), P(p.r + v * ld.size[0], 0, w + ld.size[2]), 0.04, DARK); // slings
        box(P(p.r, 0, w), ld.size, ld.col);
      }

      // far to near along the line of sight
      type Item = { d: number; draw: () => void };
      const items: Item[] = [];
      const ink = Math.max(0.6, Math.min(2.2, 0.3 * perM)), dot = (q: Vec3) => q[0] * L[0] + q[1] * L[1] + q[2] * L[2];
      for (const { a, b, w, col } of bars) items.push({ d: (dot(a) + dot(b)) / 2, draw: () => {
        const pa = proj(a), pb = proj(b), lw = Math.max(0.6, w * perM);
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
        if (lw > 1.2) { ctx.strokeStyle = "#1c1f24"; ctx.lineWidth = lw + ink; ctx.stroke(); }
        ctx.strokeStyle = rgb(col, 1); ctx.lineWidth = lw; ctx.stroke();
      } });
      for (const { q, s, col } of boxes) {
        const ax: Vec3 = [cu, sn, 0], ay: Vec3 = [-sn, cu, 0];
        const C = (i: number, j: number, k: number): Vec3 => [q[0] + ax[0] * i * s[0] / 2 + ay[0] * j * s[1] / 2, q[1] + ax[1] * i * s[0] / 2 + ay[1] * j * s[1] / 2, q[2] + k * s[2]];
        const faces: Array<[Vec3[], Vec3]> = [
          [[C(-1, -1, 1), C(1, -1, 1), C(1, 1, 1), C(-1, 1, 1)], [0, 0, 1]],
          [[C(1, -1, 0), C(1, 1, 0), C(1, 1, 1), C(1, -1, 1)], ax],
          [[C(-1, 1, 0), C(-1, -1, 0), C(-1, -1, 1), C(-1, 1, 1)], [-ax[0], -ax[1], 0]],
          [[C(-1, -1, 0), C(1, -1, 0), C(1, -1, 1), C(-1, -1, 1)], [-ay[0], -ay[1], 0]],
          [[C(1, 1, 0), C(-1, 1, 0), C(-1, 1, 1), C(1, 1, 1)], ay],
        ];
        const centre: Vec3 = [q[0], q[1], q[2] + s[2] / 2];
        items.push({ d: dot(centre), draw: () => {
          for (const [pts, n] of faces) {
            if (dot(n) >= 0) continue; // facing away
            const lam = Math.max(0, n[0] * S[0] + n[1] * S[1] + n[2] * S[2]);
            ctx.beginPath();
            pts.forEach((pt, i) => { const [x, y] = proj(pt); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
            ctx.closePath();
            ctx.fillStyle = rgb(col, 0.62 + 0.42 * lam); ctx.fill();
            ctx.strokeStyle = "#1c1f24"; ctx.lineWidth = ink; ctx.stroke();
          }
        } });
      }
      items.sort((x, y) => y.d - x.d);
      for (const it of items) it.draw();
    }
  }
}

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const rgb = ([r, g, b]: RGB, k: number) => `rgb(${Math.min(255, r * k) | 0},${Math.min(255, g * k) | 0},${Math.min(255, b * k) | 0})`;
