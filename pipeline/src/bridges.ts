/**
 * Bridge decks. The terrain (DGM1) is bare earth: under a bridge it holds whatever the bridge spans (the
 * road in a cutting, the river), so a bridge draped on it sags into the gap. A deck instead runs straight
 * between the terrain at its two ends (the abutments), never below the terrain itself. The renderer
 * (page/renderer.ts) builds the deck there and the export (traffic) drives on it; both use this function
 * on the same terrain grid, so cars stay on the drawn deck.
 */
type P2 = [number, number];

type Ground = (x: number, y: number) => number | null;

/**
 * Terrain at the end `p` of a line whose next point is `q`, or a few metres past it on the embankment if
 * that is higher (OSM bridge ends often stop short of the abutment, inside the gap).
 */
function endHeight(p: P2, q: P2, ground: Ground) {
  const dx = p[0] - q[0], dy = p[1] - q[1], d = Math.hypot(dx, dy) || 1;
  let h = -Infinity;
  for (const k of [0, 1.5, 3]) {
    const g = ground(p[0] + (dx / d) * k, p[1] + (dy / d) * k);
    if (g !== null && Number.isFinite(g)) h = Math.max(h, g);
  }
  return h;
}

/**
 * Height (ENU up) along an OSM bridge line `l` (ENU metres), by arc length `s` from l[0] at (x, y).
 * `ends`: the deck height at both ends from bridgeEnds (joints between bridge ways); default the terrain there.
 * With [a, b, extA, extB] the deck runs on past the line's ends by extA and extB metres (its abutments, ground.ts
 * extendBridges), a at the extended start, b at the extended end.
 */
export function deckHeight(l: P2[], ground: Ground, ends?: number[] | null) {
  const cum = [0];
  for (let i = 1; i < l.length; i++) cum.push(cum[i - 1] + Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]));
  const len = cum.at(-1)!, ea = ends?.[2] ?? 0, eb = ends?.[3] ?? 0;
  const a = ends?.[0] ?? endHeight(l[0], l[1], ground), b = ends?.[1] ?? endHeight(l.at(-1)!, l.at(-2)!, ground);
  return {
    len, cum,
    at(s: number, x: number, y: number) {
      const g = ground(x, y);
      const line = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * Math.min(1, Math.max(0, (s + ea) / ((len + ea + eb) || 1))) : -Infinity;
      return Math.max(line, g === null ? -Infinity : g + 0.3);
    },
  };
}

/** Is this OSM way a bridge (deck above the ground)? */
export const isBridge = (t: Record<string, string>) => !!t.bridge && t.bridge !== "no";

/** ext: how far its deck runs on past each end (m, abutment ends only; ground.ts extendBridges) */
export type GraphWay = { id: number; nodes: number[]; l: P2[]; kind: "rail" | "road" | "path"; bridge: boolean; ext?: [number, number]; w?: number };

/** Roof height (ENU up) of the building under (x, y), -Infinity where there is none. */
type Roofs = (x: number, y: number) => number;
/** clearance a deck keeps over a roof it crosses, and the highest roof above the deck it lifts over (a taller one
 *  the line passes beside or under, a tower by a ramp, is not something the deck climbs) */
const CLEAR = 1.5, CLIMB = 2;

/** A line's end point carried on `d` metres along its last segment (i = 1: the far end). */
export function carried(l: P2[], i: 0 | 1, d: number): P2 {
  const p = i ? l.at(-1)! : l[0], q = i ? l.at(-2)! : l[1], L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
  return [p[0] + ((p[0] - q[0]) / L) * d, p[1] + ((p[1] - q[1]) / L) * d];
}

/**
 * Deck heights at both ends of every bridge way (OSM id -> [start, end]). OSM often splits one bridge into
 * several ways; only the real abutments (an end shared with a non-bridge way, or an end no other bridge way
 * touches) stand on the terrain. A joint between bridge ways (often mid-river) gets the abutments' heights
 * weighted by 1 / path distance along the bridge ways, so a chain of ways is one straight deck instead of
 * sagging to the water at every joint. Rails and roads are solved on their own; footpath bridges after
 * them, pinned to a road deck where they meet one (a stair down to the river bank must not pull the road
 * down). `portals`: tunnel end nodes; a deck that runs straight into a tunnel ends at the terrain right there
 * (the look-ahead of endHeight would climb the hill above the tunnel and leave the deck in mid-air).
 * ground.ts computes this once (ground/bridge-ends.json); the renderer, export and scene read it.
 */
export function bridgeEnds(ways: GraphWay[], ground: Ground, portals = new Set<number>(), roofs?: Roofs) {
  const out = new Map<number, number[]>();
  solve(ways, ground, ["rail"], ["rail"], new Map(), out, portals, roofs);
  const road = solve(ways, ground, ["road"], ["road"], new Map(), out, portals, roofs);
  solve(ways, ground, ["path"], ["road", "path"], road, out, portals, roofs);
  return out;
}

/**
 * `roofs`: a deck that runs through a low roof under it (a car park below a viaduct: the straight line between
 * far abutments sags into it) is lifted to clear it by CLEAR across its width. Only joints move, never an
 * abutment on the terrain; the ways meeting at a lifted joint follow it, so a chain becomes a ramp, not a step.
 */
function clearRoofs(bridges: GraphWay[], ground: Ground, out: Map<number, number[]>, fixedEnd: (k: number) => boolean, roofs: Roofs) {
  const endNode = (w: GraphWay, i: 0 | 1) => (i ? w.nodes.at(-1)! : w.nodes[0]);
  const lifted = new Map<number, number>();
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (const w of bridges) {
      const e = out.get(w.id);
      if (!e) continue;
      const dh = deckHeight(w.l, ground, e), half = (w.w ?? (w.kind === "rail" ? 5 : w.kind === "road" ? 7 : 3)) / 2;
      const ea = e[2] ?? 0, eb = e[3] ?? 0, span = dh.len + ea + eb || 1;
      const free = ([0, 1] as const).map((i) => !fixedEnd(endNode(w, i)));
      if (!free[0] && !free[1]) continue;
      let lift = 0;
      for (let i = 1; i < w.l.length; i++) {
        const a = w.l[i - 1], b = w.l[i], L = dh.cum[i] - dh.cum[i - 1], ux = (b[0] - a[0]) / (L || 1), uy = (b[1] - a[1]) / (L || 1);
        for (let s = 0; s <= L; s += 2) {
          const x = a[0] + ux * s, y = a[1] + uy * s, z = dh.at(dh.cum[i - 1] + s, x, y);
          let need = 0;
          for (let o = -half; o <= half; o += 1.5) {
            const r = roofs(x - uy * o, y + ux * o);
            if (r > -Infinity && r < z + CLIMB) need = Math.max(need, r + CLEAR - z);
          }
          if (need <= 0.05) continue;
          // the lift at the free end(s) that raises this point by `need` (the line pivots on a fixed end)
          const t = (dh.cum[i - 1] + s + ea) / span, share = free[0] && free[1] ? 1 : free[1] ? t : 1 - t;
          if (share > 0.05) lift = Math.max(lift, need / share);
        }
      }
      // more than a deck's sag (a roof by a fixed end, which only a steep tilt would clear): not ours to fix
      if (lift <= 0.05 || lift > CLIMB + CLEAR) continue;
      for (const i of [0, 1] as const) if (free[i]) {
        const k = endNode(w, i), h = e[i] + lift;
        if (h > (lifted.get(k) ?? -Infinity) + 0.01) { lifted.set(k, h); moved = true; }
      }
    }
    // every way meeting a lifted joint takes its height there
    for (const w of bridges) {
      const e = out.get(w.id);
      if (e) for (const i of [0, 1] as const) { const h = lifted.get(endNode(w, i)); if (h !== undefined && h > e[i]) e[i] = Math.round(h * 100) / 100; }
    }
    if (!moved) break;
  }
  return lifted.size;
}

/** deck heights of the bridge ways of `kinds` into `out`; returns the height at each bridge way end node */
function solve(ways: GraphWay[], ground: Ground, kinds: GraphWay["kind"][], groundKinds: GraphWay["kind"][], pinned: Map<number, number>, out: Map<number, number[]>, portals: Set<number>, roofs?: Roofs) {
  const fixed = new Set<number>(), uses = new Map<number, number>(), adj = new Map<number, Array<[number, number]>>();
  const bridges = ways.filter((w) => w.bridge && kinds.includes(w.kind) && w.nodes.length >= 2 && w.nodes.length === w.l.length);
  for (const w of ways) if (!w.bridge && groundKinds.includes(w.kind)) for (const n of w.nodes) fixed.add(n);
  for (const w of bridges) {
    for (const k of new Set(w.nodes)) uses.set(k, (uses.get(k) ?? 0) + 1);
    for (let i = 1; i < w.nodes.length; i++) {
      const a = w.nodes[i - 1], b = w.nodes[i], d = Math.hypot(w.l[i][0] - w.l[i - 1][0], w.l[i][1] - w.l[i - 1][1]);
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push([b, d]); adj.get(b)!.push([a, d]);
    }
  }
  const endNode = (w: GraphWay, i: 0 | 1) => (i ? w.nodes.at(-1)! : w.nodes[0]);
  const own = (w: GraphWay, i: 0 | 1) => {
    const p = i ? w.l.at(-1)! : w.l[0];
    const g = portals.has(endNode(w, i)) ? ground(p[0], p[1]) : null;
    if (g !== null && Number.isFinite(g)) return g;
    return w.ext ? endHeight(carried(w.l, i, w.ext[i]), i ? w.l.at(-2)! : w.l[1], ground) // at the abutment it runs on to
      : i ? endHeight(p, w.l.at(-2)!, ground) : endHeight(p, w.l[1], ground);
  };
  // abutments: a deck of another kind it meets, else the highest terrain any way ending there finds
  const abut = new Map<number, number>();
  for (const w of bridges) for (const i of [0, 1] as const) {
    const k = endNode(w, i);
    if (pinned.has(k)) { abut.set(k, pinned.get(k)!); continue; }
    if (!fixed.has(k) && uses.get(k)! > 1) continue;
    const h = own(w, i);
    if (Number.isFinite(h)) abut.set(k, Math.max(abut.get(k) ?? -Infinity, h));
  }
  // joints: inverse path distance to every abutment of the bridge (shortest paths, up to 3 km)
  const sum = new Map<number, [number, number]>();
  for (const [a, h] of abut) {
    const dist = new Map<number, number>([[a, 0]]), queue: Array<[number, number]> = [[a, 0]];
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i][1] < queue[bi][1]) bi = i;
      const [k, d] = queue.splice(bi, 1)[0];
      if (d > dist.get(k)!) continue;
      if (k !== a && abut.has(k)) continue; // a path ends at the next abutment
      if (k !== a) { const s = sum.get(k) ?? [0, 0]; s[0] += h / d; s[1] += 1 / d; sum.set(k, s); }
      for (const [n, l] of adj.get(k) ?? []) {
        const nd = d + l;
        if (nd < 3000 && nd < (dist.get(n) ?? Infinity)) { dist.set(n, nd); queue.push([n, nd]); }
      }
    }
  }
  const at = (k: number) => { if (abut.has(k)) return abut.get(k)!; const s = sum.get(k); return s && s[1] > 0 ? s[0] / s[1] : null; };
  for (const w of bridges) {
    const z = ([0, 1] as const).map((i) => at(endNode(w, i)) ?? own(w, i));
    if (z.every(Number.isFinite)) out.set(w.id, [Math.round(z[0] * 100) / 100, Math.round(z[1] * 100) / 100, ...(w.ext ? w.ext.map((e) => Math.round(e * 10) / 10) : [])]);
  }
  if (roofs) {
    const n = clearRoofs(bridges, ground, out, (k) => abut.has(k), roofs);
    if (n) console.log(`  bridge decks lifted over roofs: ${n} joint(s) (${kinds.join("/")})`);
  }
  // every node of these bridges (a footpath may meet a road deck mid-way)
  const nodes = new Map<number, number>();
  for (const w of bridges) {
    const e = out.get(w.id);
    if (!e) continue;
    const dh = deckHeight(w.l, ground, e);
    w.nodes.forEach((n, i) => { const p = w.l[i]; nodes.set(n, dh.at(dh.cum[i], p[0], p[1])); });
  }
  return nodes;
}
