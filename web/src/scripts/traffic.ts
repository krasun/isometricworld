/**
 * Simulated traffic on real OSM roads: cars and buses wander the road graph (random walk,
 * one-way aware, right-hand lanes), drawn as small 3D boxes through the map camera.
 * Not real trips, but they behave: each vehicle keeps a safe gap to the one ahead in its lane,
 * takes turns at junctions (approaches alternate like lights), slows for turns, and its cruising
 * speed drifts so traffic flows unevenly. Lanes come from the same widths the ground was drawn
 * with, so vehicles stay on the asphalt. Hidden where the road is behind buildings or trees.
 *
 * Only the roads in and around the view are populated (a whole region has far too many roads for one
 * fixed fleet): twice a second (sim time, so film renders stay deterministic) vehicles that left that zone
 * are dropped and the zone is topped up to a fixed density, new ones preferably just off screen.
 */

export interface Road {
  c: number;        // class 0 motorway … 5 service
  o: number;        // 1 oneway forward, -1 oneway backward, 0 both
  l: number;        // lanes per direction (total if one-way)
  w?: number;       // carriageway width (m), as drawn on the map
  a: number; b: number; // OSM start / end node ids
  s: number[];      // [e, n, u, visible] × samples (≈ 6 m apart)
}

type Vec3 = [number, number, number];

interface Way { r: Road; n: number; cum: Float32Array; len: number; w: number }
interface Vehicle {
  id: number;
  w: number; dir: 1 | -1; s: number; lane: number;
  v: number;          // current speed (m/s)
  cruise: number;     // personal cruising factor
  phase: number;      // speed drift phase
  stuck: number;      // seconds spent waiting at a stop line (gridlock escape)
  through: boolean;   // granted the junction ahead: may cross the stop line
  holding: number;    // junction node this vehicle is inside (-1 none)
  next: { w: number; dir: 1 | -1 } | null; // way chosen for after this one
  len: number; wid: number; hei: number; color: [number, number, number]; bus: boolean;
  lat: number;        // lateral offset drawn (m): eases to the lane centre when the road width changes
  /** drawn pose, smoothed: position error (m) that decays, heading, sim time last drawn (-1: not drawn) */
  ex: number; ey: number; hx: number; hy: number; cx: number; cy: number; seen: number;
  alpha: number;      // fades in/out (~0.25 s) where the road passes behind trees / buildings instead of popping
}

const CLASS_WEIGHT = [3, 2.6, 2, 1.4, 0.35, 0.05];
const CLASS_SPEED = [22, 13, 12, 11, 8, 5]; // m/s (≈ 80, 47, 43, 40, 29, 18 km/h)
const ACCEL = 2.2, BRAKE = 5.5;              // m/s²
const GAP = 2.2, HEADWAY = 1.1;              // standstill gap (m), time gap (s)
const CAR_COLORS: Array<[number, number, number]> = [
  [236, 236, 236], [236, 236, 236], [190, 194, 200], [60, 62, 68], [36, 38, 44], [170, 40, 38],
  [40, 80, 150], [235, 190, 40], [120, 130, 140], [210, 210, 214],
];
const BUS_COLORS: Array<[number, number, number]> = [[40, 110, 190], [30, 150, 90], [220, 220, 222]];

export class Traffic {
  private ways: Way[] = [];
  private out = new Map<number, Array<{ w: number; dir: 1 | -1 }>>();
  private vehicles: Vehicle[] = [];
  /** junction node -> approach (way) that has green, vehicles inside, when the green started */
  private nodeHold = new Map<number, { way: number; inside: number; start: number; last: number }>();
  /** ways meeting at a node: 2 = plain split of one road (no junction) */
  private degree = new Map<number, number>();
  private lanes = new Map<string, Vehicle[]>(); // `${way}:${dir}:${lane}` -> sorted by s
  /** junction box radius per node: half the widest road meeting there + margin */
  private nodeR = new Map<number, number>();
  private t = 0;
  private rand = mulberry(7);
  private weight: number[] = [];
  /** each way's bounding box in art px */
  private box2: Float32Array;
  private zone: number[] = [];           // ways in or near the view
  private inZone = new Uint8Array(0);    // 1 near the view, 2 on screen
  private nextManage = 0;
  private nextId = 0;
  private lastView: number[] | null = null;
  /** vehicles drawn in the last frame (debug / tests) */
  drawn = 0;

  constructor(roads: Road[], private enu2px: number[][], private camFwd: [number, number], private density = 1) {
    for (const r of roads) {
      const n = r.s.length / 4;
      if (n < 2) continue;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++)
        cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const w = this.ways.push({ r, n, cum, len: cum[n - 1], w: r.w ?? Math.max(4, r.l * (r.o ? 3.2 : 6.4)) }) - 1;
      const R = Math.min(16, (r.w ?? 6) / 2 + 1.5);
      for (const n of [r.a, r.b]) {
        this.nodeR.set(n, Math.max(this.nodeR.get(n) ?? 0, R));
        this.degree.set(n, (this.degree.get(n) ?? 0) + 1);
      }
      if (r.o >= 0) this.link(r.a, { w, dir: 1 });
      if (r.o <= 0) this.link(r.b, { w, dir: -1 });
    }
    for (const [n, d] of this.degree) if (d <= 2) this.nodeR.set(n, 0); // not a junction: no box, no stop line
    this.weight = this.ways.map((w) => w.len * CLASS_WEIGHT[w.r.c]);
    const M = this.enu2px;
    this.box2 = new Float32Array(this.ways.length * 4);
    this.ways.forEach((way, w) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < way.n; i++) {
        const e = way.r.s[i * 4], n = way.r.s[i * 4 + 1], u = way.r.s[i * 4 + 2];
        const x = M[0][0] * e + M[0][1] * n + M[0][2] * u, y = M[1][0] * e + M[1][1] * n + M[1][2] * u;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      this.box2.set([x0, y0, x1, y1], w * 4);
    });
    this.inZone = new Uint8Array(this.ways.length);
  }

  /**
   * Keep the fleet on the roads around the view `art` (art px box): drop vehicles outside, top up to
   * ~1 vehicle per 55 weighted metres (class weights: busy roads get more), thinned evenly when that exceeds
   * the cap. Only on the first fill and after a jump (the view moved or zoomed by more than half) is the
   * screen itself filled; otherwise new vehicles start off screen and drive in, so nothing pops up in view.
   */
  private manage([ax0, ay0, ax1, ay1]: number[]) {
    const mx = (ax1 - ax0) * 0.5, my = (ay1 - ay0) * 0.5, B = this.box2;
    this.zone = [];
    let total = 0;
    for (let w = 0; w < this.ways.length; w++) {
      const x0 = B[w * 4], y0 = B[w * 4 + 1], x1 = B[w * 4 + 2], y1 = B[w * 4 + 3];
      if (x1 < ax0 - mx || x0 > ax1 + mx || y1 < ay0 - my || y0 > ay1 + my) { this.inZone[w] = 0; continue; }
      const vis = x1 >= ax0 && x0 <= ax1 && y1 >= ay0 && y0 <= ay1;
      this.inZone[w] = vis ? 2 : 1;
      this.zone.push(w); total += this.weight[w];
    }
    const before = this.vehicles.length;
    this.vehicles = this.vehicles.filter((v) => { if (this.inZone[v.w]) return true; this.release(v); return false; });
    if (this.vehicles.length !== before) this.regroup();
    const count = Math.round(Math.min(2500, (total / 55) * this.density));
    if (this.vehicles.length >= count) return;
    const L = this.lastView, size = Math.max(ax1 - ax0, ay1 - ay0);
    const jump = !L || Math.hypot((ax0 + ax1 - L[0] - L[2]) / 2, (ay0 + ay1 - L[1] - L[3]) / 2) > size / 2
      || Math.abs(Math.log(size / Math.max(L[2] - L[0], L[3] - L[1]))) > Math.log(1.5);
    this.lastView = [ax0, ay0, ax1, ay1];
    const fillScreen = jump;
    const pool = fillScreen ? this.zone : this.zone.filter((w) => this.inZone[w] === 1);
    if (!pool.length) return;
    const weights = pool.map((w) => this.weight[w]), sum = weights.reduce((a, b) => a + b, 0);
    for (let tries = 0, need = count - this.vehicles.length; need > 0 && tries < need * 4; tries++) {
      let pick = this.rand() * sum, k = 0;
      while (pick > weights[k] && k < weights.length - 1) pick -= weights[k++];
      if (this.spawn(pool[k])) need--;
    }
  }

  /** a new vehicle somewhere on way w (false if it doesn't fit) */
  private spawn(w: number) {
    const way = this.ways[w];
    const dir: 1 | -1 = way.r.o === 1 ? 1 : way.r.o === -1 ? -1 : this.rand() < 0.5 ? 1 : -1;
    const bus = way.r.c <= 2 && this.rand() < 0.08;
    const len = bus ? 12 : 4.4 + this.rand() * 0.6;
    if (way.len < len + 4) return false;
    const s = len / 2 + this.rand() * (way.len - len);
    const lane = bus ? 0 : Math.floor(this.rand() * way.r.l);
    // never spawn on top of another vehicle
    const key = `${w}:${dir}:${lane}`, group = this.lanes.get(key) ?? [];
    if (group.some((o) => Math.abs(o.s - s) < (o.len + len) / 2 + GAP)) return false;
    const v: Vehicle = {
      id: this.nextId++, w, dir, s, lane, bus, len, stuck: 0, through: false, holding: -1, next: null,
      cruise: 0.8 + this.rand() * 0.35, phase: this.rand() * Math.PI * 2, v: 0,
      wid: bus ? 2.55 : 1.8, hei: bus ? 3.1 : 1.5,
      color: bus ? BUS_COLORS[Math.floor(this.rand() * BUS_COLORS.length)] : CAR_COLORS[Math.floor(this.rand() * CAR_COLORS.length)], lat: 0, ex: 0, ey: 0, hx: 1, hy: 0, cx: 0, cy: 0, seen: -1, alpha: 0,
    };
    v.lat = this.offset(way, v);
    v.v = this.limit(v) * 0.8;
    this.vehicles.push(v);
    group.push(v);
    group.sort((a, b) => a.s - b.s);
    this.lanes.set(key, group);
    return true;
  }

  get count() { return this.vehicles.length; }

  private link(node: number, e: { w: number; dir: 1 | -1 }) {
    if (!this.out.has(node)) this.out.set(node, []);
    this.out.get(node)!.push(e);
  }

  private regroup() {
    this.lanes.clear();
    for (const v of this.vehicles) {
      const k = `${v.w}:${v.dir}:${v.lane}`;
      const g = this.lanes.get(k);
      if (g) g.push(v); else this.lanes.set(k, [v]);
    }
    for (const g of this.lanes.values()) g.sort((a, b) => a.s - b.s);
  }

  /** Cruising speed right now: class limit × personality × slow drift (traffic waves). */
  private limit(v: Vehicle) {
    const base = CLASS_SPEED[this.ways[v.w].r.c] * v.cruise * (v.bus ? 0.8 : 1);
    return base * (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this.t * 0.11 + v.phase)));
  }

  private endNode(v: Vehicle) { const r = this.ways[v.w].r; return v.dir === 1 ? r.b : r.a; }

  private chooseNext(v: Vehicle) {
    const options = (this.out.get(this.endNode(v)) ?? []).filter((o) => o.w !== v.w);
    const pool = v.bus ? options.filter((o) => this.ways[o.w].r.c <= 3) : options;
    const from = pool.length ? pool : options;
    if (!from.length) return null;
    const weights = from.map((o) => CLASS_WEIGHT[this.ways[o.w].r.c] + 0.05);
    let pick = this.rand() * weights.reduce((a, b) => a + b, 0), k = 0;
    while (pick > weights[k] && k < weights.length - 1) pick -= weights[k++];
    return from[k];
  }

  /** Free space beyond the junction box at the start of `next`, in the lane we would enter. */
  private entryClear(v: Vehicle, next: { w: number; dir: 1 | -1 }) {
    const lane = v.bus ? 0 : Math.min(v.lane, this.ways[next.w].r.l - 1);
    const g = this.lanes.get(`${next.w}:${next.dir}:${lane}`);
    return !g?.length || g[0].s - g[0].len / 2 > (this.nodeR.get(this.endNode(v)) ?? 4) + v.len + GAP;
  }

  /** Distance from the vehicle's front to the stop line before the junction box ahead. */
  private toStop(v: Vehicle) {
    return this.ways[v.w].len - v.s - v.len / 2 - (this.nodeR.get(this.endNode(v)) ?? 4);
  }

  private isJunction(node: number) { return (this.degree.get(node) ?? 0) > 2; }

  /**
   * May the vehicle enter the junction ahead now? Vehicles from the same approach go together
   * (a green phase, at most 12 s while others wait); other approaches wait until the box is empty.
   */
  private grant(v: Vehicle) {
    if (!v.next || !this.entryClear(v, v.next)) return false;
    const node = this.endNode(v);
    if (!this.isJunction(node)) { v.through = true; return true; }
    let hold = this.nodeHold.get(node);
    if (hold && hold.inside <= 0 && this.t - hold.last > 0.8) { this.nodeHold.delete(node); hold = undefined; }
    if (hold && this.t - hold.last > 10) { this.nodeHold.delete(node); hold = undefined; } // lost vehicle: reset
    if (hold && (hold.way !== v.w || this.t - hold.start > 12)) return false;
    if (!hold) { hold = { way: v.w, inside: 0, start: this.t, last: this.t }; this.nodeHold.set(node, hold); }
    hold.inside++; hold.last = this.t;
    v.through = true; v.holding = node;
    return true;
  }

  private release(v: Vehicle) {
    if (v.holding < 0) return;
    const h = this.nodeHold.get(v.holding);
    if (h) { h.inside--; h.last = this.t; }
    v.holding = -1;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    this.regroup();
    for (const g of this.lanes.values()) {
      for (let k = 0; k < g.length; k++) {
        const v = g[k], way = this.ways[v.w];
        if (v.next === null) v.next = this.chooseNext(v);
        let target = this.limit(v);
        if (v.stuck > 25) { this.respawn(v); continue; } // gridlock escape
        // car following: stay a safe gap behind the vehicle ahead in this lane
        const lead = g[k + 1];
        if (lead) {
          const gap = lead.s - lead.len / 2 - (v.s + v.len / 2) - GAP;
          target = Math.min(target, Math.max(0, gap / HEADWAY), lead.v + Math.max(0, gap) * 0.5);
        }
        // approaching the junction: slow for the turn; at the stop line wait until it's granted
        const toStop = this.toStop(v);
        if (!v.through && v.next && toStop < 30) {
          const go = (toStop < 2 || !this.isJunction(this.endNode(v))) && this.grant(v);
          if (!go) target = Math.min(target, Math.max(0, toStop - 0.3) / HEADWAY);
          if (!go && toStop < 2 && v.v < 0.5) v.stuck += dt; else if (go) v.stuck = 0;
          if (way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 5 + Math.max(0, toStop) * 0.3);
        } else if (v.through && way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 7);
        // left the junction box behind: release it
        if (v.holding >= 0 && v.holding !== this.endNode(v) && v.s - v.len / 2 > (this.nodeR.get(v.holding) ?? 0)) this.release(v);
        // accelerate gently, brake firmly; never overrun the stop point
        v.v = target > v.v ? Math.min(target, v.v + ACCEL * dt) : Math.max(target, v.v - BRAKE * dt);
        if (lead) v.v = Math.min(v.v, Math.max(0, (lead.s - lead.len / 2 - (v.s + v.len / 2) - 0.5) / dt));
        v.s += v.v * dt;
      }
    }
    for (const v of this.vehicles) { const o = this.offset(this.ways[v.w], v); v.lat += Math.max(-1.5 * dt, Math.min(1.5 * dt, o - v.lat)); }
    // move vehicles that have driven past the end of their way onto the next one
    for (const v of this.vehicles) {
      let way = this.ways[v.w];
      if (!v.next || !v.through) {
        if (v.s + v.len / 2 < way.len) continue;
        if (v.next) { v.s = way.len - v.len / 2; v.v = 0; continue; } // not granted: hold at the end
        // dead end
        if (way.r.o === 0) { v.dir = v.dir === 1 ? -1 : 1; v.s = v.len / 2; v.through = false; }
        else this.respawn(v);
        continue;
      }
      // hand over when the centre (the drawn position) crosses the node: the car moves on continuously
      if (v.s < way.len) continue;
      const over = v.s - way.len;
      v.w = v.next.w; v.dir = v.next.dir; v.next = null; v.through = false;
      way = this.ways[v.w];
      v.lane = v.bus ? 0 : Math.min(v.lane, way.r.l - 1);
      v.s = Math.min(way.len, over);
      v.phase += 0.7;
    }
  }

  /** Move a vehicle stranded at a one-way dead end (data gap) to a random free road start. */
  private respawn(v: Vehicle) {
    this.release(v);
    for (let tries = 0; tries < 20; tries++) {
      const w = this.zone[Math.floor(this.rand() * this.zone.length)], way = this.ways[w];
      if (w === undefined || this.inZone[w] !== 1) continue; // never reappear in view
      const dir: 1 | -1 = way.r.o === -1 ? -1 : way.r.o === 1 ? 1 : this.rand() < 0.5 ? 1 : -1;
      const start = (this.nodeR.get(dir === 1 ? way.r.a : way.r.b) ?? 4) + v.len / 2;
      if (way.r.c > 3 || way.len < start + v.len + 30 || (v.bus && way.r.c > 2)) continue;
      const g = this.lanes.get(`${w}:${dir}:0`);
      if (g?.some((o) => Math.abs(o.s - start) < v.len + 2 * GAP + o.len)) continue;
      Object.assign(v, { w, dir, lane: 0, s: start, v: 0, next: null, stuck: 0, through: false, seen: -1 });
      v.lat = this.offset(way, v);
      return;
    }
  }

  /** Lateral offset (m, + = right of travel) of the lane centre, kept inside the drawn asphalt. */
  private offset(way: Way, v: Vehicle) {
    const r = way.r, half = way.w / 2;
    const lanes = Math.max(1, r.l);
    const lw = r.o === 0 ? half / lanes : way.w / lanes;
    const o = half - (v.lane + 0.5) * lw;
    return Math.max(-half + v.wid / 2 + 0.2, Math.min(half - v.wid / 2 - 0.2, o));
  }

  /** Draw vehicles. `toScreen` maps global art px -> canvas px; `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    if (px < 0.14) return; // cars < ~2.5 px: skip
    const [vx0, vy0, vx1, vy1] = view;
    if (this.t >= this.nextManage) {
      // the view in art px (toScreen is scale + offset)
      const [ox, oy] = toScreen(0, 0), [sx1, sy1] = toScreen(1, 1), kx = sx1 - ox, ky = sy1 - oy;
      this.manage([(vx0 - ox) / kx, (vy0 - oy) / ky, (vx1 - ox) / kx, (vy1 - oy) / ky]);
      this.nextManage = this.t + 0.5;
    }
    const M = this.enu2px;
    const proj = (p: Vec3): [number, number] =>
      toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ v: Vehicle; c: Vec3; d: [number, number]; depth: number }> = [];
    for (const v of this.vehicles) {
      const way = this.ways[v.w], S = way.r.s;
      const at = (dist: number) => { // sample index at distance along the travel direction
        const s = Math.max(0, Math.min(way.len, v.dir === 1 ? dist : way.len - dist));
        let i = 1;
        while (i < way.n - 1 && way.cum[i] < s) i++;
        return { i, s };
      };
      const mid = at(v.s);
      // hidden when the road under the car's centre is (the nearest sample), so it fades only once it is
      // well into the cover; a lone hidden sample between visible ones (a crown's edge) doesn't count
      const j = mid.s - way.cum[mid.i - 1] < way.cum[mid.i] - mid.s ? mid.i - 1 : mid.i;
      const vis = !!S[j * 4 + 3] || (j > 0 && j < way.n - 1 && !!S[(j - 1) * 4 + 3] && !!S[(j + 1) * 4 + 3]);
      const { i, s } = mid, k0 = (i - 1) * 4, k1 = i * 4;
      const f = (s - way.cum[i - 1]) / Math.max(1e-3, way.cum[i] - way.cum[i - 1]);
      let dx = S[k1] - S[k0], dy = S[k1 + 1] - S[k0 + 1];
      const L = Math.hypot(dx, dy) || 1;
      dx = (dx / L) * v.dir; dy = (dy / L) * v.dir;
      const off = v.lat;
      const c: Vec3 = [S[k0] + (S[k1] - S[k0]) * f + dy * off, S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f - dx * off, S[k0 + 2] + (S[k1 + 2] - S[k0 + 2]) * f];
      // The lane offset swings sideways where the road bends (polyline vertices, way handovers, U-turns).
      // Keep motion continuous: the gap between where the car would be had it simply driven on and the
      // new pose becomes an error that fades out in ~0.15 s; the heading turns the same way.
      const dtf = this.t - v.seen;
      if (v.seen >= 0 && dtf > 0 && dtf < 0.5) {
        const k = Math.exp(-dtf / 0.15), step = v.v * dtf;
        const px = v.cx + v.hx * step, py = v.cy + v.hy * step;
        let gx = px - c[0], gy = py - c[1];
        if (gx * gx + gy * gy > 100) gx = gy = 0; // > 10 m: a real teleport (respawn), don't slide
        v.ex = gx * k; v.ey = gy * k;
        let hx = v.hx + (dx - v.hx) * (1 - k), hy = v.hy + (dy - v.hy) * (1 - k);
        const hl = Math.hypot(hx, hy);
        if (hl < 0.3 || v.hx * dx + v.hy * dy < -0.5) { hx = dx; hy = dy; } else { hx /= hl; hy /= hl; }
        v.hx = hx; v.hy = hy;
      } else if (dtf !== 0) { v.ex = v.ey = 0; v.hx = dx; v.hy = dy; }
      c[0] += v.ex; c[1] += v.ey;
      v.alpha = v.seen < 0 ? (vis ? 1 : 0) : Math.max(0, Math.min(1, v.alpha + (vis ? 1 : -1) * Math.max(0, dtf) / 0.25));
      v.cx = c[0]; v.cy = c[1]; v.seen = this.t;
      if (v.alpha <= 0) continue;
      dx = v.hx; dy = v.hy;
      const [sx, sy] = proj(c);
      if (sx < vx0 - 40 || sy < vy0 - 40 || sx > vx1 + 40 || sy > vy1 + 40) continue;
      items.push({ v, c, d: [dx, dy], depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
    }
    items.sort((a, b) => b.depth - a.depth); // back to front
    this.drawn = items.length;
    for (const { v, c, d } of items) this.box(ctx, proj, c, d, v);
  }

  private box(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], v: Vehicle) {
    const r: [number, number] = [d[1], -d[0]];
    const hl = v.len / 2, hw = v.wid / 2;
    const corner = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const base = [corner(hl, hw, 0.25), corner(hl, -hw, 0.25), corner(-hl, -hw, 0.25), corner(-hl, hw, 0.25)];
    const top = base.map((p) => [p[0], p[1], p[2] + v.hei] as Vec3);
    const [R, G, B] = v.color;
    const fill = (pts: Vec3[], k: number) => {
      ctx.fillStyle = `rgb(${R * k | 0},${G * k | 0},${B * k | 0})`;
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fill();
    };
    // soft contact shadow
    const a = v.alpha;
    ctx.globalAlpha = 0.25 * a;
    fill(base.map((p) => [p[0] + 0.4, p[1] - 0.4, p[2] - 0.25] as Vec3), 0);
    ctx.globalAlpha = a;
    // sides facing the camera (outward normal · camera forward < 0), then roof
    for (let i = 0; i < 4; i++) {
      const a = base[i], b = base[(i + 1) % 4];
      const nx = (b[1] - a[1]), ny = -(b[0] - a[0]);
      const facing = nx * this.camFwd[0] + ny * this.camFwd[1];
      if (facing >= 0) continue;
      fill([a, b, top[(i + 1) % 4], top[i]], 0.72 + 0.1 * (i % 2));
    }
    fill(top, 1.05);
    // windscreen / bus window band on the roof
    const wb = v.bus ? [corner(hl - 0.3, hw - 0.15, v.hei + 0.26), corner(hl - 0.3, -hw + 0.15, v.hei + 0.26), corner(-hl + 0.3, -hw + 0.15, v.hei + 0.26), corner(-hl + 0.3, hw - 0.15, v.hei + 0.26)]
      : [corner(hl * 0.45, hw - 0.2, v.hei + 0.26), corner(hl * 0.45, -hw + 0.2, v.hei + 0.26), corner(-hl * 0.35, -hw + 0.2, v.hei + 0.26), corner(-hl * 0.35, hw - 0.2, v.hei + 0.26)];
    ctx.globalAlpha = (v.bus ? 0.25 : 0.55) * a;
    ctx.fillStyle = "#26303a";
    ctx.beginPath();
    wb.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
