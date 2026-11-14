/**
 * Tunnel portals for the procedural look. Fetch keeps tunnel ways out of the ground (roads simply end
 * where they go underground), so without a portal a road looks cut off. Every end of an OSM tunnel way
 * (`tunnel=yes`) that meets a surface road or track gets a concrete headwall: dark openings, lintels,
 * and wing walls along the approach. Tubes and tracks that go in side by side share one headwall.
 * Service roads (garage ramps), foot passages and `tunnel=covered` galleries get none.
 */
import type { Piece } from "./landmarks.ts";
import { frame } from "./frame.ts";
import { roadWidth } from "./roadspec.ts";

type P2 = [number, number];
type Way = { type: string; nodes?: number[]; geometry?: Array<{ lat: number; lon: number }>; tags?: Record<string, string> };
/** one tunnel end: where it is, the direction into the tunnel, the opening's width and clear height */
type End = { p: P2; d: P2; w: number; h: number; name: string };

const CONCRETE = [0.8, 0.79, 0.76], WHITE = [0.93, 0.93, 0.91], VOID = [0.07, 0.07, 0.08];
const tunnel = (t: Record<string, string>) => t.tunnel === "yes";
const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$/;

/** Tunnel ends that meet a surface road or track, from the raw OSM files of an area. */
export function tunnelEnds(ways: Way[], toEnu: (lon: number, lat: number) => P2): End[] {
  const surface = new Set<number>();
  for (const e of ways) {
    const t = e.tags ?? {};
    if ((t.highway || t.railway) && !(t.tunnel && t.tunnel !== "no")) for (const n of e.nodes ?? []) surface.add(n);
  }
  const ends: End[] = [], seen = new Set<string>();
  for (const e of ways) {
    const t = e.tags ?? {}, g = e.geometry, nodes = e.nodes;
    if (!tunnel(t) || !g || !nodes || g.length < 2 || nodes.length !== g.length) continue;
    const rail = /^(rail|light_rail|subway|narrow_gauge)$/.test(t.railway ?? "");
    if (!rail && !ROADS.test(t.highway ?? "")) continue;
    const pts = g.map((q) => toEnu(q.lon, q.lat));
    for (const [i, step] of [[0, 1], [pts.length - 1, -1]]) {
      if (!surface.has(nodes[i]) || seen.has(`${e.tags?.railway ?? "r"}${nodes[i]}`)) continue;
      seen.add(`${e.tags?.railway ?? "r"}${nodes[i]}`);
      // direction into the tunnel over its first ~15 m
      const p = pts[i];
      let j = i + step;
      while (j + step >= 0 && j + step < pts.length && Math.hypot(pts[j][0] - p[0], pts[j][1] - p[1]) < 15) j += step;
      const dx = pts[j][0] - p[0], dy = pts[j][1] - p[1], L = Math.hypot(dx, dy);
      if (L < 1) continue;
      const w = rail ? (t.railway === "rail" ? 4.8 : 4.2) : roadWidth(t) + 1.5;
      const h = rail ? (t.railway === "rail" ? 6.5 : 5) : 5;
      ends.push({ p, d: [dx / L, dy / L], w, h, name: t["tunnel:name"] ?? t.name ?? "" });
    }
  }
  return ends;
}

/** Ends that go in side by side (within 25 m across, 12 m along, same direction) form one portal. */
export function groupEnds(ends: End[]): End[][] {
  const groups: End[][] = [];
  for (const e of ends) {
    const g = groups.find((gr) => gr.some((o) => {
      if (o.d[0] * e.d[0] + o.d[1] * e.d[1] < 0.8) return false;
      const rx = e.p[0] - o.p[0], ry = e.p[1] - o.p[1];
      return Math.abs(rx * o.d[0] + ry * o.d[1]) < 12 && Math.abs(-rx * o.d[1] + ry * o.d[0]) < 25;
    }));
    if (g) g.push(e); else groups.push([e]);
  }
  return groups;
}

/**
 * One portal: a 1 m concrete headwall across the approach at the tunnel mouth, an opening per tube
 * (overlapping openings merge) with a dark void just inside, a lintel over each, and wing walls as high as
 * the ground beside the approach, down to road level. Named tunnels get their own look (see below).
 * `ground(x, y)` is the terrain height.
 */
export function portal(group: End[], ground: (x: number, y: number) => number): Piece[] {
  let dx = 0, dy = 0;
  for (const e of group) { dx += e.d[0]; dy += e.d[1]; }
  const dl = Math.hypot(dx, dy) || 1, d: P2 = [dx / dl, dy / dl], v: P2 = [-d[1], d[0]];
  const o: P2 = [group.reduce((a, e) => a + e.p[0], 0) / group.length, group.reduce((a, e) => a + e.p[1], 0) / group.length];
  const name = group.find((e) => e.name)?.name ?? "";
  if (name.startsWith("Schwabtunnel")) return schwabtunnel(o, d, ground);
  // headwall plane through the mean end; openings as [b0, b1] across it (b along v, left of d)
  const spans = group.map((e) => { const b = (e.p[0] - o[0]) * v[0] + (e.p[1] - o[1]) * v[1]; return [b - e.w / 2, b + e.w / 2]; })
    .sort((a, b) => a[0] - b[0]);
  const open: number[][] = [];
  for (const s of spans) { const last = open.at(-1); if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]); else open.push([...s]); }
  const H = Math.max(...group.map((e) => e.h));
  const at0 = (a: number, b: number): P2 => [o[0] + d[0] * a + v[0] * b, o[1] + d[1] * a + v[1] * b];
  // the approach is the floor: lowest ground 2–4 m in front of the openings
  const base = Math.min(...open.flatMap(([b0, b1]) => [b0, (b0 + b1) / 2, b1].flatMap((b) => [2, 4].map((a) => ground(...at0(-a, b))))));
  // the wall reaches the terrain behind it (the tunnel lid), at least 1.2 m above the openings; no rise
  // behind (an underpass under an embankment or a bridge) gets no portal
  const behind = open.flatMap(([b0, b1]) => [b0, (b0 + b1) / 2, b1].flatMap((b) => [6, 8, 10].map((a) => ground(...at0(a, b))))).sort((x, y) => x - y);
  const rise = behind[Math.floor(behind.length / 2)] - base;
  if (rise < 3) return [];
  const top = Math.min(H + 8, Math.max(H + 1.2, rise + 0.4));
  const B0 = open[0][0] - 1.6, B1 = open.at(-1)![1] + 1.6;
  const { at, piece, block } = frame(o, d, base);
  // Rosensteintunnel (B10, 2022): white concrete portals and trough walls
  const concrete = piece(-14, 5, B0, B1, top, name.startsWith("Rosensteintunnel") ? WHITE : CONCRETE);
  const dark = piece(-14, 5, B0, B1, H, VOID);
  // headwall: piers between and beside the openings, a lintel over each, dark void recessed 0.15 m
  let b = B0;
  for (const [b0, b1] of open) {
    block(concrete, 0, 1, b, b0, 0, top);
    block(concrete, 0, 1, b0, b1, H, top);
    block(dark, 0.15, 0.95, b0, b1, 0, H);
    b = b1;
  }
  block(concrete, 0, 1, b, B1, 0, top);
  // coping along the top edge, 0.3 m proud
  block(concrete, -0.3, 1, B0 - 0.3, B1 + 0.3, top, top + 0.4);
  // lid behind the headwall: hides the terrain step where the road texture climbs onto it
  block(concrete, 1, 5, B0, B1, top - 0.6, top);
  wings(concrete, block, at, ground, base, B0, B1, top, 0.6);
  return [concrete, dark];
}

/** wing walls along the approach (a < 0), retaining the ground beside the trough: their top follows it */
function wings(p: Piece, block: ReturnType<typeof frame>["block"], at: (a: number, b: number) => P2, ground: (x: number, y: number) => number,
  base: number, B0: number, B1: number, top: number, t: number) {
  for (const [b0, b1, out] of [[B0, B0 + t, B0 - 2], [B1 - t, B1, B1 + 2]]) {
    const hz = (a: number) => Math.max(0.8, Math.min(top, ground(...at(a, out)) - base + 0.3));
    for (let a = 0; a > -30; a -= 2) {
      block(p, a - 2, a, b0, b1, 0, (x) => hz(x));
      if (hz(a - 2) <= 0.8) break;
    }
  }
}

const SANDSTONE = [0.62, 0.33, 0.27], RUBBLE = [0.6, 0.56, 0.51], STEPS = [0.7, 0.67, 0.62], IRON = [0.2, 0.21, 0.22];
/**
 * Schwabtunnel (1896), both portals: a basket arch 10.5 m wide and 6.5 m high in a red-sandstone voussoir
 * ring with a lion-head keystone, rubble-granite spandrels up to ~8.5 m, a sandstone balcony with the coat of
 * arms over the crown, iron railings along the top, red-sandstone pilasters at both sides and stair flights
 * that climb the face from the street to the top on both sides.
 */
function schwabtunnel(o: P2, d: P2, ground: (x: number, y: number) => number): Piece[] {
  const base0 = frame(o, d, 0).at;
  const base = Math.min(...[-4, 0, 4].map((b) => ground(...base0(-3, b))));
  const { at, piece, block } = frame(o, d, base);
  const R = 5.25, SPRING = 2.6, RISE = 3.9, TOP = 8.6, HALF = 9.5, RING = 0.9;
  const zo = (b: number) => SPRING + RISE * Math.sqrt(Math.max(0, 1 - (b / R) ** 2));
  const rubble = piece(-14, 5, -HALF, HALF, TOP, RUBBLE), sand = piece(-14, 5, -HALF, HALF, TOP, SANDSTONE);
  const dark = piece(-14, 5, -HALF, HALF, TOP, VOID), steps = piece(-14, 5, -HALF, HALF, TOP, STEPS), iron = piece(-14, 5, -HALF, HALF, TOP, IRON);
  // the arch, in slices across the opening: void, voussoir ring 0.15 m proud, rubble above
  const N = 16;
  for (let i = 0; i < N; i++) {
    const b0 = -R + (2 * R * i) / N, b1 = -R + (2 * R * (i + 1)) / N;
    block(dark, 0.3, 1.2, b0, b1, 0, (_, b) => zo(b));
    block(sand, -0.15, 1.2, b0, b1, (_, b) => zo(b), (_, b) => zo(b) + RING);
    block(rubble, 0, 1.2, b0, b1, (_, b) => zo(b) + RING, TOP);
  }
  for (const s of [-1, 1]) {
    const [j0, j1] = s < 0 ? [-R - RING, -R] : [R, R + RING];
    block(sand, -0.15, 1.2, j0, j1, 0, SPRING + 0.3);                                   // jambs
    const [r0, r1] = s < 0 ? [-HALF + 1.4, -R - RING] : [R + RING, HALF - 1.4];
    block(rubble, 0, 1.2, r0, r1, 0, TOP);                                              // spandrel walls
    const [p0, p1] = s < 0 ? [-HALF, -HALF + 1.4] : [HALF - 1.4, HALF];
    block(sand, -0.4, 1.2, p0, p1, 0, TOP + 1.2);                                       // pilasters
    // stair flight: from the street at the pilaster up to the balcony, 11 steps 2 m deep in front of the face
    for (let k = 0; k < 11; k++) {
      const f0 = HALF - 1.4 - (k * (HALF - 1.4 - 2.4)) / 11, f1 = HALF - 1.4 - ((k + 1) * (HALF - 1.4 - 2.4)) / 11;
      const z = 0.8 + ((TOP - 0.8) * (k + 1)) / 11;
      const [q0, q1] = s < 0 ? [-f0, -f1] : [f1, f0];
      block(steps, -2.2, 0, q0, q1, 0, z);
      block(iron, -2.2, -2.05, q0, q1, z, z + 1);                                       // railing
    }
  }
  block(sand, -0.4, 1.2, -0.6, 0.6, zo(0) - 0.3, zo(0) + RING + 0.6);                  // keystone (lion head)
  block(sand, -0.7, 1.2, -2.4, 2.4, TOP - 1.2, TOP + 1.6);                             // balcony with the coat of arms
  block(iron, -0.1, 0.05, -HALF + 1.4, -2.4, TOP, TOP + 1);                             // railings along the top
  block(iron, -0.1, 0.05, 2.4, HALF - 1.4, TOP, TOP + 1);
  block(rubble, 1.2, 6, -HALF, HALF, TOP - 0.6, TOP);                                  // lid
  wings(rubble, block, at, ground, base, -HALF - 0.6, HALF + 0.6, TOP, 0.6);
  return [rubble, sand, dark, steps, iron];
}
