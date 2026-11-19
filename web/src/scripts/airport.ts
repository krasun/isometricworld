/**
 * Airliners on the ground and in the air at the region's airport (places.ts `airport.ground`): each lands on
 * the runway, turns off at a forward-angled exit, taxis to a free stand, parks, is pushed back, taxis to the
 * threshold end and takes off. The taxi network (OSM runway, taxiways, taxilanes, stand lead-in lines) comes
 * from export's data/airport.<hash>.json. Jets hold behind traffic ahead, departures wait while an arrival
 * is on final or on the runway. Drawn like sky.ts (local frame, x forward, y side, z up).
 */
import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";
import { airliner, frame, inView, type ToScreen, type Vec3 } from "./sky.ts";
import type { Region } from "../../../pipeline/src/places.ts";

export type { AirportNetwork as AirportData } from "../../../pipeline/src/airport.ts";
import type { AirportNetwork as AirportData } from "../../../pipeline/src/airport.ts";
type Config = NonNullable<Region["airport"]>;

const GLIDE = Math.tan((3 * Math.PI) / 180), FADE = 2500, EVERY = 60;
const TAXI = 12, TURN = 35, HOLD_MAX = 30, TOUCHDOWN = 400, LIFTOFF = 1400, CLIMB = 9000;
const LIVERIES = [ // fuselage, tail (generic: no airline's colours)
  ["#f4f5f7", "#1f4e9c"], ["#f4f5f7", "#c8102e"], ["#f4f5f7", "#f2a900"], ["#f4f5f7", "#5a2d82"],
  ["#f4f5f7", "#00857c"], ["#e9edf2", "#22313f"], ["#f4f5f7", "#e35205"],
];

/** a path: smoothed ENU points, the target speed (m/s) at each, and whether each is on the ground */
interface Path { pts: Vec3[]; v: number[]; ground: boolean[]; cum: number[]; len: number }
interface Wp { p: Vec3; v: number; ground: boolean; sharp?: boolean }
interface Stand { ref: string; nodes: number[]; busy: boolean }
type Phase = "arrive" | "parked" | "push" | "depart";
interface Jet {
  id: number; livery: number; scale: number; phase: Phase; stand: Stand;
  path: Path | null; s: number; back: boolean; wait: number;
  /** where on the path: arrival threshold / exit, departure hold point / line-up / lift-off */
  marks: Record<string, number>;
  fadeIn: number; fadeOut: number;
  pose: { p: Vec3; d: [number, number] }; moving: boolean;
  /** seconds held behind traffic in a row (after HOLD_MAX it goes anyway: no gridlock) */
  held: number;
  /** after the pushback: where it stops and the taxi route on to the runway */
  out?: { y: Vec3; taxi: number[] };
}

export class AirportTraffic {
  private nodes: Vec3[] = [];
  private adj: Array<Array<{ to: number; len: number; runway: boolean }>> = [];
  private stands: Stand[] = [];
  private jets: Jet[] = [];
  private T: Vec3; private D: [number, number];
  private exits: Array<{ r: number; q: number }> = [];
  private lineUp = -1;
  private t = 0; // first new arrival after the opening departure has gone
  private ids = 0;
  private seed = 5;

  constructor(private M: number[][], private cfg: Config, data: AirportData) {
    const t = ecefToEnu(llhToEcef(cfg.lat, cfg.lon, cfg.h ?? 0)), a = (cfg.runwayHeadingDeg * Math.PI) / 180;
    this.T = [t[0], t[1], t[2]];
    this.D = [Math.sin(a), Math.cos(a)];
    for (let i = 0; i < data.n.length; i += 3) { this.nodes.push([data.n[i] / 10, data.n[i + 1] / 10, data.n[i + 2] / 10]); this.adj.push([]); }
    const link = (i: number, j: number, runway: boolean) => {
      const len = this.dist(i, j);
      this.adj[i].push({ to: j, len, runway }); this.adj[j].push({ to: i, len, runway });
    };
    for (const [kind, ...ids] of data.w) for (let k = 1; k < ids.length; k++) link(ids[k - 1], ids[k], kind === 0);
    const ok = new RegExp(cfg.ground?.stands ?? ".");
    for (const s of data.s) if (ok.test(s.r)) this.stands.push({ ref: s.r, nodes: s.p, busy: false });
    // runway nodes where a taxiway leaves: forward-angled ones 1.3–2.6 km down the runway are the exits for
    // arrivals; the one nearest the threshold is where departures line up
    let best = Infinity;
    this.adj.forEach((edges, r) => {
      if (!edges.some((e) => e.runway)) return;
      for (const e of edges) {
        if (e.runway) continue;
        const along = this.along(this.nodes[r]), q = this.nodes[e.to], p = this.nodes[r];
        const fwd = ((q[0] - p[0]) * this.D[0] + (q[1] - p[1]) * this.D[1]) / Math.max(1, e.len);
        if (along > 1300 && along < 2600 && fwd > 0.5) this.exits.push({ r, q: e.to });
        if (Math.abs(along) < best) { best = Math.abs(along); this.lineUp = r; }
      }
    });
    // the apron when the map opens: about half the stands taken, the first departures due soon
    // not realistic, lively: the apron half full, its jets due within ~15 min (a queue at the holding point
    // soon), one jet on short final, one taxiing in, one taxiing out to the runway
    for (const st of this.stands) if (this.rnd() < 0.45) this.park(this.newJet(st), 10 + this.rnd() * 900);
    for (const at of [(j: Jet) => j.marks.exit + 300, (j: Jet) => j.marks.threshold - 5000]) {
      const j = this.spawnArrival();
      if (j) { j.s = at(j); j.pose = poseAt(j.path!, j.s, false); }
    }
    const first = this.jets.find((j) => j.phase === "parked");
    if (first) {
      this.pushback(first);
      if (first.phase === "push") { this.taxiOut(first); first.s = Math.max(0, first.marks.hold - 60); first.pose = poseAt(first.path!, first.s, false); }
    }
  }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  private dist(i: number, j: number) { const a = this.nodes[i], b = this.nodes[j]; return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  private along(p: Vec3) { return (p[0] - this.T[0]) * this.D[0] + (p[1] - this.T[1]) * this.D[1]; }
  /** on the runway centre line `d` m past the threshold, `up` m above it */
  private onRunway(d: number, up: number): Vec3 { return [this.T[0] + this.D[0] * d, this.T[1] + this.D[1] * d, this.T[2] + up]; }

  private newJet(stand: Stand): Jet {
    stand.busy = true;
    return {
      id: this.ids++, livery: Math.floor(this.rnd() * LIVERIES.length), scale: this.rnd() < 0.3 ? 0.85 : 1, phase: "parked", stand,
      path: null, s: 0, back: false, wait: 0, marks: {}, fadeIn: 0, fadeOut: 0, pose: { p: [0, 0, 0], d: [1, 0] }, moving: false, held: 0,
    };
  }

  /** shortest taxi route between two nodes (the runway only when nothing else goes) */
  private route(from: number, to: number): number[] | null {
    const n = this.nodes.length, cost = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    cost[from] = 0;
    const heap: Array<[number, number]> = [[0, from]];
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [c, u] = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === to) break;
      for (const e of this.adj[u]) {
        const nc = c + e.len * (e.runway ? 20 : 1);
        if (nc < cost[e.to]) { cost[e.to] = nc; prev[e.to] = u; heap.push([nc, e.to]); }
      }
    }
    if (from !== to && prev[to] < 0) return null;
    const out = [to];
    while (out[0] !== from) out.unshift(prev[out[0]]);
    return out;
  }

  private spawnArrival(): Jet | null {
    const free = this.stands.filter((s) => !s.busy);
    if (!free.length || !this.exits.length) return null;
    const stand = free[Math.floor(this.rnd() * free.length)], exit = this.exits[Math.floor(this.rnd() * this.exits.length)];
    const taxi = this.route(exit.q, stand.nodes[0]);
    if (!taxi) { stand.busy = true; return null; } // not reachable: never use it
    const from = this.cfg.from ?? 6000, exitAlong = this.along(this.nodes[exit.r]);
    const wps: Wp[] = [
      { p: this.onRunway(-from, 15 + from * GLIDE), v: 75, ground: false, sharp: true },
      { p: this.onRunway(0, 15), v: 72, ground: false, sharp: true },
      { p: this.onRunway(TOUCHDOWN, this.nodes[exit.r][2] - this.T[2]), v: 68, ground: true, sharp: true },
      { p: this.onRunway(exitAlong - 250, this.nodes[exit.r][2] - this.T[2]), v: 20, ground: true, sharp: true },
      ...[exit.r, ...taxi, ...stand.nodes.slice(1)].map((i): Wp => ({ p: this.nodes[i], v: TAXI, ground: true })),
    ];
    wps[4].v = 16; // still fast on the rapid exit
    wps.at(-1)!.v = 1; wps.at(-1)!.sharp = true;
    if (wps.length > 6) wps.at(-2)!.v = 3;
    const jet = this.newJet(stand);
    jet.phase = "arrive"; jet.path = path(wps); jet.s = 0; jet.fadeIn = FADE;
    jet.marks = { threshold: from, exit: jet.path.cum[findNear(jet.path, this.nodes[exit.r])] };
    this.jets.push(jet);
    return jet;
  }

  private park(jet: Jet, wait: number) {
    const p = jet.stand.nodes.map((i) => this.nodes[i]), a = p.at(-2)!, b = p.at(-1)!, l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    Object.assign(jet, { phase: "parked", path: null, back: false, wait, fadeIn: 0, fadeOut: 0, moving: false });
    jet.pose = { p: b, d: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
    if (!this.jets.includes(jet)) this.jets.push(jet);
  }

  /** pushed back down the lead-in line and on, tail first, so the taxi-out starts nose forward */
  private pushback(jet: Jet) {
    const st = jet.stand.nodes, p0 = st[0];
    const taxi = this.route(p0, this.lineUp);
    if (!taxi || taxi.length < 2) { jet.wait = 600; return; }
    // the first taxi leg leaves p0 towards taxi[1]: push back the other way along the taxilane
    const a = this.nodes[p0], x = this.nodes[taxi[1]], l = Math.hypot(x[0] - a[0], x[1] - a[1]) || 1;
    const y: Vec3 = [a[0] - ((x[0] - a[0]) / l) * 45, a[1] - ((x[1] - a[1]) / l) * 45, a[2]];
    const wps: Wp[] = [...st].reverse().map((i) => ({ p: this.nodes[i], v: 1.6, ground: true }));
    wps[0].sharp = true;
    wps.push({ p: y, v: 0.8, ground: true, sharp: true });
    Object.assign(jet, { phase: "push", path: path(wps), s: 0, back: true, out: { y, taxi } });
  }

  private taxiOut(jet: Jet) {
    const { y, taxi } = jet.out!;
    const L = this.along(this.nodes[this.lineUp]);
    const wps: Wp[] = [
      { p: y, v: 4, ground: true, sharp: true },
      ...taxi.map((i): Wp => ({ p: this.nodes[i], v: TAXI, ground: true })),
      { p: this.onRunway(L + 60, this.nodes[this.lineUp][2] - this.T[2]), v: 6, ground: true, sharp: true },
      { p: this.onRunway(L + 250, this.nodes[this.lineUp][2] - this.T[2]), v: 35, ground: true, sharp: true },
      { p: this.onRunway(L + LIFTOFF, this.nodes[this.lineUp][2] - this.T[2]), v: 80, ground: true, sharp: true },
      { p: this.onRunway(L + LIFTOFF + CLIMB, CLIMB * 0.08), v: 95, ground: false, sharp: true },
    ];
    wps[wps.length - 5].v = 4; // turning onto the runway
    const p = path(wps), lineUp = p.cum[findNear(p, this.nodes[this.lineUp])];
    Object.assign(jet, { phase: "depart", path: p, s: 0, back: false, fadeOut: FADE });
    jet.marks = { hold: Math.max(0, lineUp - 90), lineUp, liftoff: p.len - CLIMB };
    jet.stand.busy = false;
  }

  /** an arrival within ~40 s of the threshold or still on the runway, or a departure rolling */
  private runwayBusy(self: Jet) {
    return this.jets.some((j) => j !== self && j.path && (
      (j.phase === "arrive" && j.s > j.marks.threshold - 3000 && j.s < j.marks.exit) ||
      (j.phase === "depart" && j.s > j.marks.hold + 0.5 && j.s < j.marks.liftoff)));
  }

  /** a departure close to the holding point: the next arrival waits until it rolls (landings and take-offs alternate) */
  private departing() {
    return this.jets.some((j) => j.phase === "depart" && j.s > j.marks.hold - 300 && j.s < j.marks.hold + 1);
  }

  /** someone on the ground right ahead: hold (queue behind, the younger jet yields head-on, pushbacks go first) */
  private blocked(jet: Jet): "queue" | "yield" | false {
    const { p, d } = jet.pose, dir = d;
    for (const o of this.jets) {
      if (o === jet || o.phase === "parked" || !isGround(o)) continue;
      const dx = o.pose.p[0] - p[0], dy = o.pose.p[1] - p[1], r = Math.hypot(dx, dy);
      if (r > 85 || r < 1 || (dx * dir[0] + dy * dir[1]) / r < 0.8) continue;
      if (o.pose.d[0] * d[0] + o.pose.d[1] * d[1] > 0.3) return "queue";
      if (o.id < jet.id || o.phase === "push") return "yield";
    }
    return false;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (this.t >= EVERY && !this.departing()) { this.t = 0; this.spawnArrival(); }
    for (const j of this.jets) {
      if (j.phase === "parked") {
        j.wait -= dt;
        // push back once the taxilane behind is clear and fewer than 5 are already taxiing out (start-up clearance)
        if (j.wait <= 0 && this.jets.filter((o) => o.phase === "push" || (o.phase === "depart" && o.s <= o.marks.hold + 1)).length < 5 && !this.jets.some((o) => o !== j && o.phase !== "parked" && isGround(o) && Math.hypot(o.pose.p[0] - this.nodes[j.stand.nodes[0]][0], o.pose.p[1] - this.nodes[j.stand.nodes[0]][1]) < 100)) this.pushback(j);
        continue;
      }
      const r = j.path!;
      let v = speedAt(r, j.s);
      // queue behind traffic going the same way; a head-on stand-off ends after HOLD_MAX s (no gridlock)
      const b = j.phase !== "push" && isGround(j) ? this.blocked(j) : false;
      if (b === "queue" || (b === "yield" && j.held < HOLD_MAX)) { v = 0; j.held += dt; }
      else j.held = 0;
      if (j.phase === "depart" && j.s >= j.marks.hold - 1 && j.s < j.marks.hold + 1 && this.runwayBusy(j)) { v = 0; j.s = j.marks.hold; }
      j.moving = v > 0;
      j.s = Math.min(r.len, j.s + v * dt);
      j.pose = poseAt(r, j.s, j.back);
      if (j.s >= r.len) {
        if (j.phase === "arrive") this.park(j, 120 + this.rnd() * 240);
        else if (j.phase === "push") { j.wait = 0; this.taxiOut(j); }
        else j.path = null; // departed
      }
    }
    this.jets = this.jets.filter((j) => j.phase === "parked" || j.path);
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, view: number[]) {
    const now = performance.now();
    for (const j of this.jets) {
      const { p, d } = j.pose, ground = isGround(j);
      const r = j.path, alpha = r ? Math.min(1, j.fadeIn ? j.s / j.fadeIn : 1, j.fadeOut ? (r.len - j.s) / j.fadeOut : 1) : 1;
      // true size close up; never under ~14 px long on the ground (stands are tight), ~22 px in the air
      const scale = Math.max(j.scale, (ground ? 14 : 22) / (38 * frame(ctx, this.M, toScreen, p, d, 1).perM));
      // shadow (sun high in the south-west) on the ground below, or on the runway's level in the air
      const gz = ground ? p[2] : this.T[2], above = p[2] - gz;
      const sh = frame(ctx, this.M, toScreen, [p[0] + above * 0.25 + 1.2, p[1] + above * 0.35 + 1.6, gz], d, scale);
      const pl = frame(ctx, this.M, toScreen, p, d, scale);
      if (!inView(pl.o, view, 300) && !inView(sh.o, view, 300)) continue;
      const [body, tail] = LIVERIES[j.livery];
      ctx.globalAlpha = alpha * 0.18; sh.set(); airliner(ctx, "#000", "#000", "#000", "#000", false);
      ctx.globalAlpha = alpha; pl.set(); airliner(ctx, body, "#c9ced6", "#8a93a0", tail);
      if (j.phase !== "parked") {
        ctx.fillStyle = "#ff3b30"; ctx.fillRect(-5.1, -18, 1.2, 1.2); // wingtips (x -3…-6, y ±18)
        ctx.fillStyle = "#34c759"; ctx.fillRect(-5.1, 16.8, 1.2, 1.2);
        if ((now + j.id * 170) % 1000 < 110) { ctx.fillStyle = "#ff2a1a"; ctx.beginPath(); ctx.arc(-6, 0, 1.3, 0, Math.PI * 2); ctx.fill(); } // beacon
        if (!ground || (j.phase === "depart" && j.s > j.marks.lineUp)) if (now % 1200 < 100) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(-19, 0, 1.6, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}

/** on the ground at its current point of the path (parked jets always) */
function isGround(j: Jet) {
  if (!j.path) return true;
  const { i } = segAt(j.path, j.s);
  return j.path.ground[i - 1] && j.path.ground[i];
}

/** smooth the corners (cut non-sharp ones up to TURN m back, three passes), slow down in tight turns */
function path(wps: Wp[]): Path {
  wps = wps.filter((w, i) => i === 0 || Math.hypot(w.p[0] - wps[i - 1].p[0], w.p[1] - wps[i - 1].p[1]) > 0.5);
  for (let k = 0; k < 3; k++) {
    const out: Wp[] = [];
    wps.forEach((w, i) => {
      if (w.sharp || i === 0 || i === wps.length - 1) { out.push(w); return; }
      for (const n of [wps[i - 1], wps[i + 1]]) {
        const len = Math.hypot(n.p[0] - w.p[0], n.p[1] - w.p[1]), f = Math.min(0.25, TURN / Math.max(1, len) / (k + 1));
        out.push({ p: [w.p[0] + (n.p[0] - w.p[0]) * f, w.p[1] + (n.p[1] - w.p[1]) * f, w.p[2] + (n.p[2] - w.p[2]) * f], v: w.v, ground: w.ground && n.ground });
      }
    });
    wps = out;
  }
  // taxi speed in curves: v ≈ √(a·R) with ~0.8 m/s² sideways
  for (let i = 1; i < wps.length - 1; i++) {
    const w = wps[i];
    if (!w.ground || w.v > TAXI) continue;
    const a = wps[i - 1].p, b = w.p, c = wps[i + 1].p;
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    const turn = Math.abs(((h2 - h1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    const R = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1])) / Math.max(turn, 1e-3);
    w.v = Math.min(w.v, Math.max(3, Math.sqrt(0.8 * R)));
  }
  const cum = [0];
  for (let i = 1; i < wps.length; i++) cum.push(cum[i - 1] + Math.hypot(wps[i].p[0] - wps[i - 1].p[0], wps[i].p[1] - wps[i - 1].p[1], wps[i].p[2] - wps[i - 1].p[2]));
  return { pts: wps.map((w) => w.p), v: wps.map((w) => w.v), ground: wps.map((w) => w.ground), cum, len: cum.at(-1)! };
}

function findNear(r: Path, q: Vec3) {
  let bi = 0, bd = Infinity;
  r.pts.forEach((p, i) => { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
function segAt(r: Path, s: number) {
  let lo = 1, hi = r.cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (r.cum[m] < s) lo = m + 1; else hi = m; }
  return { i: lo, f: Math.max(0, Math.min(1, (s - r.cum[lo - 1]) / Math.max(1e-6, r.cum[lo] - r.cum[lo - 1]))) };
}
function speedAt(r: Path, s: number) {
  const { i, f } = segAt(r, s);
  return Math.max(0.6, r.v[i - 1] + (r.v[i] - r.v[i - 1]) * f);
}
function poseAt(r: Path, s: number, back: boolean): { p: Vec3; d: [number, number] } {
  const { i, f } = segAt(r, s), a = r.pts[i - 1], b = r.pts[i];
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, k = back ? -1 : 1;
  return { p: [a[0] + dx * f, a[1] + dy * f, a[2] + (b[2] - a[2]) * f], d: [(k * dx) / l, (k * dy) / l] };
}
