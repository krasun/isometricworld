/**
 * Construction sites (preset constructionSites): one seeded plan per OSM landuse=construction area, so every tile
 * draws the same site. Real sites cluster, so the plan does too:
 *  - a container compound by the fence: rows of site offices and containers along it, toilets at the end
 *  - material yards: heaps, pipes, steel and pallets bunched on a gravel pad
 *  - work spots: a dug, darker pit with an excavator, a loader, trucks queued on the haul road to it
 *  - a slab being poured (bigger sites): concrete pad, mixer trucks, a tower crane beside it
 *  - an excavation (bigger sites): a rectangular pit behind sheet piles, braced with struts, a base slab poured on its
 *    floor, an excavator down in it (ground.ts draws the far walls and floor as the camera sees them)
 *  - a mobile fence round the site, open at the gates (renderer.ts)
 *  - haul roads from the compound to the work spots, and large faint patches of lighter and darker earth
 * page/ground.ts draws the pads and roads, renderer.ts the objects (sprites from the AI sheets
 * style/textures/construction-sprites*.png). Vehicles face along their road, containers along the fence.
 */
import type { Feature } from "./ground.ts";
import { axes } from "../src/camera.ts";

type P2 = [number, number];
/** turn: row of the turned sheet (construction-sprites-turns: 4 headings each) and the world direction it faces;
 *  still: object of the plain sheet (construction-sprites), seen as drawn */
export type SiteItem = { x: number; y: number; turn?: number; dir?: P2; still?: number };
/** a tower crane (renderer.ts crane): foot, jib direction (rad), mast height, jib and counter-jib length (m), trolley (0..1) */
export type Crane = { x: number; y: number; a: number; h: number; jib: number; counter: number; trolley: number };
/** an excavation: its rim (a turned rectangle), depth (m), the base slab on its floor (rim coordinates) */
export type Pit = { rim: P2[]; depth: number; slab: P2[]; struts: Array<[P2, P2]> };
/** fence: panels (from, to) of the mobile fence, ~3.5 m each; none at a gate or on a road or track */
export type SitePlan = { pads: Array<{ pts: P2[]; c: string }>; roads: P2[][]; items: SiteItem[]; cranes: Crane[]; pits: Pit[]; gates: P2[]; fence: Array<[P2, P2]> };

/** where a point `d` m below the ground shows on the ground in the map's camera (orthographic): towards the viewer */
export function sunk([x, y]: P2, d: number): P2 {
  const { dir } = axes(), k = d / Math.abs(dir[2]);
  return [x - dir[0] * k, y - dir[1] * k];
}

const T = { excavator: 0, loader: 1, truck: 2, mixer: 3, offices: 4, container: 5, shipping: 6 };
const S = { toilets: 8, gravel: 9, topsoil: 10, pipes: 11, steel: 12, pallet: 13 };
/** long side of the turned objects (m), for spacing rows */
const LEN = [10, 7, 9, 9, 6, 6, 12];

const plans = new WeakMap<Feature, SitePlan>();
/** roads, rails and paths of the whole area (not a tile's share, so every tile plans the same site): OSM site polygons
 *  often take in a road or a track corridor, and nothing of the plan may sit on one */
let blockers: Feature[] = [];
export function setSiteBlockers(fs: Feature[]) { blockers = fs.filter((f) => f.l && ((f.w ?? 0) > 0 || f.k === "rail")); }

export function sitePlan(f: Feature): SitePlan {
  const cached = plans.get(f);
  if (cached) return cached;
  const outer = f.r![0], holes = f.r!.slice(1);
  let seed = (Math.round(outer[0][0] * 10) * 73856093) ^ (Math.round(outer[0][1] * 10) * 19349663);
  const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0) >>> 0) / 2 ** 32;
  const area = Math.abs(outer.reduce((a, [x, y], i) => { const [u, v] = outer[(i + 1) % outer.length]; return a + x * v - u * y; }, 0)) / 2;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x, y] of outer) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  const near = blockers.filter((b) => b.l!.some(([x, y]) => x > bx0 - 60 && x < bx1 + 60 && y > by0 - 60 && y < by1 + 60));
  const blocked = (x: number, y: number, clear = 3) => near.some((b) => {
    const l = b.l!, m = (b.w ?? 3) / 2 + clear; // rails carry no width: a track and its bed
    for (let i = 0; i + 1 < l.length; i++) {
      const [ax, ay] = l[i], [cx, cy] = l[i + 1], ex = cx - ax, ey = cy - ay, L2 = ex * ex + ey * ey || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2));
      if (Math.hypot(x - ax - ex * t, y - ay - ey * t) < m) return true;
    }
    return false;
  });
  const inside = (x: number, y: number) => inRing(x, y, outer) && !holes.some((r) => inRing(x, y, r)) && !blocked(x, y);
  /** distance to the fence, the fence's direction there and the way into the site */
  const edge = (x: number, y: number) => {
    let d = Infinity, dir: P2 = [1, 0], into: P2 = [0, 1];
    for (const r of f.r!) for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length], ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2)), px = ax + ex * t, py = ay + ey * t, e = Math.hypot(x - px, y - py);
      if (e < d) { d = e; const L = Math.sqrt(L2); dir = [ex / L, ey / L]; into = e > 1e-6 ? [(x - px) / e, (y - py) / e] : [-ey / L, ex / L]; }
    }
    return { d, dir, into };
  };
  const plan: SitePlan = { pads: [], roads: [], items: [], cranes: [], pits: [], gates: [], fence: [] };
  plans.set(f, plan);
  if (area < 600) return plan;
  const centres: P2[] = [];
  /** a random point inside, minD..maxD from the fence and `sep` from the other clusters */
  const pick = (minD: number, maxD: number, sep: number): P2 | null => {
    for (let t = 0; t < 300; t++) {
      const x = bx0 + (bx1 - bx0) * rnd(), y = by0 + (by1 - by0) * rnd();
      if (!inside(x, y) || plan.pits.some((p) => inRing(x, y, grow(p.rim, 14)))) continue;
      const { d } = edge(x, y);
      if (d < minD || d > maxD || centres.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < sep * (1 - t / 600))) continue;
      centres.push([x, y]);
      return [x, y];
    }
    return null;
  };
  /** an irregular blob of radius ~r (pads, pits, patches) */
  const blob = ([cx, cy]: P2, r: number, c: string) => {
    // stretched (aspect 0.5..1, turned), lobed by a few low waves, and a little ragged: never a circle
    const n = 28, e = 0.5 + 0.5 * rnd(), t = rnd() * Math.PI, ct = Math.cos(t), st = Math.sin(t);
    const w = [0, 1, 2].map(() => [0.12 + 0.14 * rnd(), rnd() * 2 * Math.PI]);
    const k = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI;
      return 1 + w[0][0] * Math.sin(2 * a + w[0][1]) + w[1][0] * Math.sin(3 * a + w[1][1]) + 0.6 * w[2][0] * Math.sin(5 * a + w[2][1]) + 0.08 * (rnd() - 0.5);
    });
    plan.pads.push({ c, pts: k.map((s, i) => {
      const a = (i / n) * 2 * Math.PI, u = Math.cos(a) * r * s / Math.sqrt(e), v = Math.sin(a) * r * s * Math.sqrt(e);
      return [cx + u * ct - v * st, cy + u * st + v * ct];
    }) });
  };
  const ok = (x: number, y: number, gap: number, fence = 3) =>
    inside(x, y) && edge(x, y).d >= fence && plan.items.every((i) => Math.hypot(i.x - x, i.y - y) >= gap) &&
    !plan.pits.some((p) => inRing(x, y, grow(p.rim, 4)));
  const put = (i: SiteItem, gap: number) => { if (!ok(i.x, i.y, gap)) return false; plan.items.push(i); return true; };
  const turn = (a: number): P2 => [Math.cos(a), Math.sin(a)];
  /** scatter `n` of `ids` round c within r, at least gap apart */
  const scatter = (c: P2, r: number, n: number, make: () => SiteItem, gap: number) => {
    for (let i = 0, t = 0; i < n && t < n * 30; t++) {
      const a = rnd() * 2 * Math.PI, s = r * Math.sqrt(rnd()), it = make();
      it.x = c[0] + Math.cos(a) * s; it.y = c[1] + Math.sin(a) * s;
      if (put(it, gap)) i++;
    }
  };

  // large faint patches of lighter and darker earth: the ground is never one colour
  for (let i = 0, n = Math.min(40, Math.ceil(area / 2500)); i < n; i++) {
    const x = bx0 + (bx1 - bx0) * rnd(), y = by0 + (by1 - by0) * rnd();
    if (inside(x, y)) blob([x, y], 12 + 25 * rnd(), ["rgba(150,125,90,0.18)", "rgba(235,222,195,0.25)", "rgba(120,105,85,0.14)"][Math.floor(rnd() * 3)]);
  }

  // the container compound: rows along the fence, offices first, toilets at the end (a second one on big sites)
  const gate = pick(5, 9, 0);
  if (area > 80000) { const g2 = pick(5, 9, 150); if (g2) compound(g2); }
  if (gate) compound(gate);
  function compound(gate: P2) {
    const { dir, into } = edge(gate[0], gate[1]);
    plan.gates.push([gate[0] - into[0] * edge(gate[0], gate[1]).d, gate[1] - into[1] * edge(gate[0], gate[1]).d]);
    const rows = area > 20000 ? 2 : 1, m = Math.max(2, Math.min(6, Math.round(area / 9000)));
    blob([gate[0] + into[0] * 3, gate[1] + into[1] * 3], 6 + m * 3.5, "rgba(196,191,180,0.85)");
    for (let j = 0; j < rows; j++) {
      const kinds = Array.from({ length: m }, (_, i) => (j === 0 && i < Math.ceil(m / 2) ? T.offices : rnd() < 0.3 ? T.shipping : T.container));
      const total = kinds.reduce((a, k) => a + LEN[k] + 1, -1);
      let s = -total / 2;
      for (const k of kinds) {
        const c = s + LEN[k] / 2; s += LEN[k] + 1;
        put({ x: gate[0] + dir[0] * c + into[0] * j * 4, y: gate[1] + dir[1] * c + into[1] * j * 4, turn: k, dir }, 2.5);
      }
      if (j === 0) put({ x: gate[0] + dir[0] * (total / 2 + 3), y: gate[1] + dir[1] * (total / 2 + 3), still: S.toilets }, 2.5);
    }
  }
  const hub: P2 = gate ? [gate[0], gate[1]] : [(bx0 + bx1) / 2, (by0 + by1) / 2];
  /** a haul road to `to`: it branches off the road network (the hub at first; the nearest of a few points on it that
   *  works), wanders through 2–3 bends (a smooth curve through them) and ends in a trampled turning patch. Bends are
   *  tried gentler and stronger until the road stays on the site and clears every pit by 3 m. If no branch works (a
   *  long bent strip) the road comes in from the nearest fence through a gate of its own; failing that, none is drawn
   *  (the line is still returned for the trucks on it). */
  const road = (to: P2) => {
    const pits = plan.pits.map((p) => grow(p.rim, 3));
    const curve = (from: P2): P2[] | null => {
      const L = Math.hypot(to[0] - from[0], to[1] - from[1]), ux = (to[0] - from[0]) / (L || 1), uy = (to[1] - from[1]) / (L || 1);
      const end = ([x, y]: P2) => Math.hypot(x - from[0], y - from[1]) < 6 || Math.hypot(x - to[0], y - to[1]) < 6; // gates sit on the fence
      for (const g of [1, 0.6, 1.4, 0.35, 1.8, 0.15, 2.2, 0.05, 2.6, 3]) { // gentler and stronger bends in turn
        const n = L > 80 ? 3 : 2, amp = Math.min(25, 0.12 * L) * g;
        const ctl: P2[] = [from];
        for (let i = 1; i <= n; i++) {
          const f = (i + (rnd() - 0.5) * 0.5) / (n + 1), o = (rnd() - 0.5) * 2 * amp;
          ctl.push([from[0] + ux * L * f - uy * o, from[1] + uy * L * f + ux * o]);
        }
        ctl.push(to);
        const l: P2[] = [];
        for (let i = 0; i + 1 < ctl.length; i++) { // Catmull-Rom, a point every ~3 m
          const p0 = ctl[Math.max(0, i - 1)], p1 = ctl[i], p2 = ctl[i + 1], p3 = ctl[Math.min(ctl.length - 1, i + 2)];
          const m = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 3));
          for (let k = 0; k < m; k++) {
            const q = k / m, q2 = q * q, q3 = q2 * q;
            const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * q + (2 * a - 5 * b + 4 * c - d) * q2 + (3 * b - a - 3 * c + d) * q3);
            l.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
          }
        }
        l.push(to);
        if (!l.some((p) => pits.some((r) => inRing(p[0], p[1], r)) || (!end(p) && !inRing(p[0], p[1], outer)))) return l;
      }
      return null;
    };
    // the network's points by distance, a few of them at least 15 m apart
    const pts = [hub, ...plan.roads.flat()].sort((a, b) => Math.hypot(to[0] - a[0], to[1] - a[1]) - Math.hypot(to[0] - b[0], to[1] - b[1]));
    const tries: P2[] = [];
    for (const q of pts) if (tries.length < 6 && tries.every((t) => Math.hypot(t[0] - q[0], t[1] - q[1]) > 15)) tries.push(q);
    let l: P2[] | null = null;
    for (const from of tries) if ((l = curve(from))) break;
    if (!l) { // a gate of its own in the nearest fence
      const { d, into } = edge(to[0], to[1]), g: P2 = [to[0] - into[0] * d, to[1] - into[1] * d];
      if (!blocked(g[0], g[1], 0.5) && (l = curve(g))) plan.gates.push(g);
    }
    if (!l) return [tries[0] ?? hub, to];
    plan.roads.push(l);
    blob(to, 6 + 3 * rnd(), "rgba(168,143,108,0.32)"); // where the trucks turn
    return l;
  };




  // the excavation (sites over 8,000 m², two over 80,000): a turned rectangle well inside the fence
  for (let p = 0, n = area < 8000 ? 0 : area > 80000 ? 2 : 1; p < n; p++) {
    for (let t = 0; t < 40; t++) {
      const c = pick(14, Infinity, 45);
      if (!c) break;
      const a = rnd() * Math.PI, u = turn(a), v: P2 = [-u[1], u[0]];
      const s = Math.max(0.75, Math.min(1, Math.sqrt(area / 40000))), hw = (15 + 12 * rnd()) * s, hd = (8 + 5 * rnd()) * s;
      const at = (i: number, j: number): P2 => [c[0] + u[0] * i + v[0] * j, c[1] + u[1] * i + v[1] * j];
      const rim = [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd)];
      const probe = [...grow(rim, 4), c, at(-hw, 0), at(hw, 0), at(0, -hd - 4), at(0, hd + 4), at(-hw / 2, 0), at(hw / 2, 0)];
      if (!probe.every(([x, y]) => inside(x, y) && edge(x, y).d > 3)) { centres.pop(); continue; }
      const depth = 5 + 3 * rnd(), sl = 0.35 + 0.4 * rnd(), side = rnd() < 0.5 ? -1 : 1; // the slab: one end of the floor
      const slab = [at(side * hw, -hd + 1), at(side * hw * (1 - 2 * sl), -hd + 1), at(side * hw * (1 - 2 * sl), hd - 1), at(side * hw, hd - 1)];
      const struts: Array<[P2, P2]> = [];
      for (let i = -hw + 4; i < hw - 2; i += 6) struts.push([at(i, -hd), at(i, hd)]);
      plan.pits.push({ rim, depth, slab, struts });
      // an excavator on the floor at the open end, a truck waiting at the rim on a road in
      const [ex, ey] = sunk(at(-side * hw * 0.55, (rnd() - 0.5) * hd), depth);
      plan.items.push({ x: ex, y: ey, turn: T.excavator, dir: turn(rnd() * 2 * Math.PI) });
      const rimAt = at(-side * (hw + 6), 0), l = road(rimAt);
      const [dx, dy] = [l[l.length - 1][0] - l[l.length - 2][0], l[l.length - 1][1] - l[l.length - 2][1]], L = Math.hypot(dx, dy) || 1;
      put({ x: rimAt[0], y: rimAt[1], turn: T.truck, dir: [dx / L, dy / L] }, 6);
      break;
    }
  }

  // work spots: a pit, an excavator in it, trucks queued on the road in, maybe a loader and a heap of spoil
  const spots = area < 2500 ? 0 : Math.max(1, Math.min(12, Math.round(area / 12000)));
  for (let w = 0; w < spots; w++) {
    const c = pick(12, Infinity, 35);
    if (!c) break;
    const r = 9 + 8 * rnd();
    blob(c, r + 4, "rgba(170,145,105,0.45)");
    blob(c, r, "rgba(150,124,88,0.55)");
    const l = road(c);
    put({ x: c[0], y: c[1], turn: T.excavator, dir: turn(rnd() * 2 * Math.PI) }, 4);
    // trucks back along the road from the pit
    let along = 0;
    for (let i = l.length - 1, q = 0; i > 0 && q < 1 + Math.floor(rnd() * 2); i--) {
      along += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
      if (along < r + 2 + q * 11) continue;
      const dx = l[i][0] - l[i - 1][0], dy = l[i][1] - l[i - 1][1], L = Math.hypot(dx, dy) || 1;
      if (put({ x: l[i][0], y: l[i][1], turn: T.truck, dir: [dx / L, dy / L] }, 7)) q++;
    }
    if (rnd() < 0.6) scatter(c, r + 6, 1, () => ({ x: 0, y: 0, turn: T.loader, dir: turn(rnd() * 2 * Math.PI) }), 7);
    scatter(c, r + 8, 1 + Math.floor(rnd() * 2), () => ({ x: 0, y: 0, still: S.topsoil }), 7);
  }

  // material yards on a gravel pad: stacked side by side in rows along the nearest fence, as material is really laid
  // down, pallets in groups; a yard goes where at least 80% of it fits (on a narrow strip, rows along the strip)
  const yards = area < 1500 ? 0 : Math.min(5, Math.ceil(area / 30000));
  const kinds = [S.pipes, S.steel, S.pallet, S.gravel, S.steel, S.pallet, S.topsoil, S.pipes];
  const WIDE: Record<number, number> = { [S.gravel]: 8, [S.topsoil]: 8, [S.pipes]: 6.5, [S.steel]: 8, [S.pallet]: 3.2 };
  const gapAfter = (k: number) => (k === S.pallet ? 0.2 : 1.2);
  for (let y = 0; y < yards; y++) {
    for (let t = 0; t < 8; t++) {
      const c = pick(8, Infinity, 30);
      if (!c) break;
      const r = 9 + Math.min(10, area / 6000), rows = r > 13 ? 2 : 1;
      const { dir: u } = edge(c[0], c[1]), v: P2 = [-u[1], u[0]];
      const slots: SiteItem[] = [];
      for (let j = 0; j < rows; j++) {
        const list: number[] = [];
        for (let len = 0, i = Math.floor(rnd() * kinds.length); len < 1.6 * r; i++) {
          const k = kinds[i % kinds.length], m = k === S.pallet ? 2 + Math.floor(rnd() * 3) : 1;
          for (let q = 0; q < m; q++) { list.push(k); len += WIDE[k] + gapAfter(k); }
        }
        let at = -list.reduce((a, k) => a + WIDE[k] + gapAfter(k), 0) / 2;
        const o = (j - (rows - 1) / 2) * 7.5;
        for (const k of list) {
          const w = WIDE[k];
          slots.push({ x: c[0] + u[0] * (at + w / 2) + v[0] * o, y: c[1] + u[1] * (at + w / 2) + v[1] * o, still: k });
          at += w + gapAfter(k);
        }
      }
      if (slots.filter((it) => ok(it.x, it.y, 2.5)).length < 0.8 * slots.length) { centres.pop(); continue; }
      blob(c, r, "rgba(190,184,172,0.8)");
      if (spots) road(c);
      for (const it of slots) put(it, 2.5);
      break;
    }
  }

  // a slab being poured: light concrete, mixer trucks beside it
  for (let p = 0, slabs = area < 12000 ? 0 : Math.min(4, Math.ceil(area / 40000) - (rnd() < 0.3 ? 1 : 0)); p < slabs; p++) {
    const c = pick(14, Infinity, 30);
    if (c) {
      const a = rnd() * Math.PI, u = turn(a), v: P2 = [-u[1], u[0]], hw = 9 + 6 * rnd(), hd = 6 + 4 * rnd();
      plan.pads.push({ c: "rgba(212,208,198,0.95)", pts: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([p, q]) => [c[0] + u[0] * p * hw + v[0] * q * hd, c[1] + u[1] * p * hw + v[1] * q * hd]) });
      road(c);
      for (let i = 0; i < 1 + Math.floor(rnd() * 2); i++)
        put({ x: c[0] + v[0] * (hd + 4) + u[0] * (i * 11 - 5), y: c[1] + v[1] * (hd + 4) + u[1] * (i * 11 - 5), turn: T.mixer, dir: u }, 6);
      scatter(c, hw, 2, () => ({ x: 0, y: 0, still: rnd() < 0.5 ? S.steel : S.pallet }), 4);
      // the crane at the slab's end, its jib over the slab or swung round
      const cx = c[0] + u[0] * (hw + 4), cy = c[1] + u[1] * (hw + 4);
      if (inside(cx, cy) && edge(cx, cy).d > 4) {
        const jib = 40 + 15 * rnd();
        plan.cranes.push({ x: cx, y: cy, a: a + Math.PI + (rnd() - 0.5) * 2.4, h: 35 + 15 * rnd(), jib, counter: 0.3 * jib, trolley: 0.3 + 0.6 * rnd() });
      }
    }
  }
  // the fence (last, once every gate is known): panels along every ring, open at the gates and wherever a road or track crosses the site's edge
  for (const r of f.r!) for (let i = 0; i < r.length; i++) {
    const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length], L = Math.hypot(bx - ax, by - ay);
    if (L < 0.5) continue;
    const n = Math.max(1, Math.round(L / 3.5));
    for (let k = 0; k < n; k++) {
      const p0: P2 = [ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n], p1: P2 = [ax + ((bx - ax) * (k + 1)) / n, ay + ((by - ay) * (k + 1)) / n];
      const m: P2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      if (plan.gates.some(([gx, gy]) => Math.hypot(gx - m[0], gy - m[1]) < 4)) continue;
      if ([p0, m, p1].some(([x, y]) => blocked(x, y, 0.5))) continue;
      plan.fence.push([p0, p1]);
    }
  }

  return plan;
}

function inRing(x: number, y: number, ring: P2[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** a convex ring grown outwards by d (m) */
function grow(r: P2[], d: number): P2[] {
  const cx = r.reduce((a, p) => a + p[0], 0) / r.length, cy = r.reduce((a, p) => a + p[1], 0) / r.length;
  return r.map(([x, y]) => { const L = Math.hypot(x - cx, y - cy) || 1; return [x + ((x - cx) / L) * d * 1.42, y + ((y - cy) / L) * d * 1.42]; });
}
