/**
 * High-voltage power lines (preset `powerLines`, scene.ts): pylons at the tower nodes of OSM power=line ways and
 * the conductors sagging between them, as hand-built pieces (landmarks/shapes.ts). The surface model does not see
 * a lattice pylon (the photos look through it), so a pylon's height is its OSM `height`, else the usual Polish
 * design for the line's voltage: ~28 m at 110 kV, ~38 m at 220 kV, ~46 m at 400 kV. Steel lattice by default;
 * structure=tubular or material=concrete: a tapered pole. Cross-arms stand across the line (the bisector at a
 * bend): two circuits (circuits=2, or 6 cables) hang from three arm levels on both sides, one circuit as a delta
 * (two on a lower arm, one on a shorter top arm); an earth wire runs over the peaks. Conductors hang from
 * insulators at the arm tips with a sag of 2.5 % of the span, never nearer than 7 m to the ground: thin
 * (5 cm) and mid grey, a faint line at 0.25 m/px rather than a dark stroke.
 */
import { beam, CLAD, lathe, type P2, type P3, type Piece } from "./landmarks/shapes.ts";

type Tags = Record<string, string>;
type El = { type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Tags };
const STEEL = [0.66, 0.68, 0.7], CONCRETE = [0.75, 0.74, 0.71], WIRE = [0.42, 0.44, 0.47], INSULATOR = [0.3, 0.32, 0.36];
const look = (rgb: number[]) => ({ roof: rgb, wall: rgb, style: CLAD, bare: 3 as const });
const box = (pts: P2[]): P2[] => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]];
};

const volts = (t: Tags) => Math.max(0, ...String(t.voltage ?? "").split(";").map(Number).filter(Number.isFinite));
function heightOf(line: Tags, tower: Tags) {
  const h = parseFloat(tower.height ?? "");
  if (h > 5 && h < 120) return h;
  const v = volts(line);
  return v >= 380000 ? 46 : v >= 200000 ? 38 : v >= 100000 ? 28 : 18;
}
const circuitsOf = (t: Tags) => {
  const c = parseInt(t.circuits ?? "");
  if (c > 0) return Math.min(2, c);
  return Math.max(0, ...String(t.cables ?? "").split(";").map(Number).filter(Number.isFinite)) >= 6 ? 2 : 1;
};

/** Where the conductors hang ([across, + left of the line; height above the base]) and the earth wire. */
function slots(H: number, circuits: number) {
  const s = H / 38, drop = 2.6 * s;
  const arms: Array<[number, number]> = circuits >= 2
    ? [[5.5, 0.64], [7.2, 0.76], [5.5, 0.88]].flatMap(([r, z]) => [[r * s, z * H], [-r * s, z * H]] as Array<[number, number]>)
    : [[5.5 * s, 0.74 * H], [-5.5 * s, 0.74 * H], [3.5 * s, 0.87 * H]];
  return { arms, wires: arms.map(([a, z]) => [a, z - drop] as [number, number]), earth: [0, H + 1.5] as [number, number], drop };
}

/** Four-legged lattice between two squares (legs, a ring of braces at every level, crossed diagonals). */
function lattice(p: Piece, lo: P3[], hi: P3[], n: number, leg: number, brace: number) {
  const lvl = (k: number) => lo.map((a, i) => a.map((v, j) => v + ((hi[i][j] - v) * k) / n) as P3);
  for (let i = 0; i < 4; i++) beam(p, lo[i], hi[i], leg);
  for (let k = 0; k <= n; k++) { const L = lvl(k); for (let i = 0; i < 4; i++) beam(p, L[i], L[(i + 1) % 4], brace); }
  for (let k = 0; k < n; k++) {
    const A = lvl(k), B = lvl(k + 1);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; beam(p, A[i], B[j], brace); beam(p, A[j], B[i], brace); }
  }
}

type Tower = { c: P2; u: P2; v: P2; z0: number; H: number; circuits: number; pole: boolean };
/** a point of tower t: a along the line, b across it (+ left), z above its base (pieces count heights from their base) */
const at = (t: Tower, a: number, b: number, z: number): P3 => [t.c[0] + t.u[0] * a + t.v[0] * b, t.c[1] + t.u[1] * a + t.v[1] * b, z];

/** A pylon: the structure, and its insulators (a separate darker piece). */
function pylon(t: Tower): Piece[] {
  const { H } = t, s = H / 38, sl = slots(H, t.circuits);
  const body: Piece = { roof: [], wall: [], footprint: [], height: H + 1.5, base: t.z0, look: look(t.pole ? CONCRETE : STEEL) };
  const ins: Piece = { roof: [], wall: [], footprint: [], height: H, base: t.z0, look: look(INSULATOR) };
  // half-width of the body at a height
  const b0 = H * 0.105, waist = 0.62 * H, bw = Math.max(0.8, H * 0.024), tw = bw * 0.7;
  const half = (z: number) => (t.pole ? 0.45 - 0.15 * (z / H) : z < waist ? b0 + ((bw - b0) * z) / waist : bw + ((tw - bw) * (z - waist)) / (H - 1 - waist));
  if (t.pole) lathe(body, t.c, [[0, 0.6], [H, 0.3]], 10);
  else {
    const sq = (h: number, z: number) => [at(t, -h, -h, z), at(t, h, -h, z), at(t, h, h, z), at(t, -h, h, z)];
    lattice(body, sq(b0, 0), sq(bw, waist), 6, 0.32 * s, 0.12);
    lattice(body, sq(bw, waist), sq(tw, H - 1), 4, 0.26 * s, 0.1);
  }
  beam(body, at(t, 0, 0, H - 1), at(t, 0, 0, sl.earth[1]), 0.25); // the earth wire's peak
  // cross-arms: two members from the body's front and back corners to the tip, braced from above
  for (const [a, z] of sl.arms) {
    const hw = half(z), side = Math.sign(a) || 1, root = side * hw;
    for (const f of [-hw, hw]) {
      beam(body, at(t, f, root, z), at(t, 0, a, z), 0.2 * s);
      beam(body, at(t, f, root, z + 1.6 * s), at(t, 0, a, z), 0.14 * s);
    }
    beam(ins, at(t, 0, a, z), at(t, 0, a, z - sl.drop), 0.28);
  }
  const fp = box([at(t, -b0, -b0, 0), at(t, b0, b0, 0), ...sl.arms.map(([a, z]) => at(t, 0, a, z))].map((q) => [q[0], q[1]] as P2));
  body.footprint = fp; ins.footprint = fp;
  return [body, ins];
}

/** A conductor from a to b (heights above the piece's base), sagging by `sag` × its length, kept `clear` m over the ground. */
function wire(p: Piece, a: P3, b: P3, sag: number, w: number, ground: (x: number, y: number) => number, clear: number) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(6, Math.ceil(L / 25)), dip = sag * L;
  let prev: P3 = a;
  for (let k = 1; k <= n; k++) {
    const f = k / n, x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
    const z = Math.max(a[2] + (b[2] - a[2]) * f - 4 * dip * f * (1 - f), k < n ? ground(x, y) - p.base + clear : -Infinity);
    const q: P3 = [x, y, z];
    beam(p, prev, q, w);
    prev = q;
  }
}

/**
 * Pylons and conductors of the power lines in `osm` (osm-power.json: power=line ways, their tower and portal nodes)
 * within `inBox` (ENU); `toEnu` maps lon, lat to ENU metres, `ground` gives the terrain height.
 */
export function powerLines(osm: { elements: El[] }, toEnu: (lon: number, lat: number) => P2, ground: (x: number, y: number) => number,
  inBox: (p: P2) => boolean): { pieces: Piece[]; towers: P2[] } {
  const nodes = new Map<number, { p: P2; t: Tags }>();
  for (const el of osm.elements) if (el.type === "node" && el.lat !== undefined) nodes.set(el.id, { p: toEnu(el.lon!, el.lat), t: el.tags ?? {} });
  const towers = new Map<number, Tower>(), pieces: Piece[] = [];
  for (const el of osm.elements) {
    if (el.type !== "way" || el.tags?.power !== "line") continue;
    const ids = (el.nodes ?? []).filter((n) => nodes.has(n));
    if (ids.length < 2) continue;
    const line = el.tags, circuits = circuitsOf(line);
    // each tower once, turned across the line (the bisector of its spans)
    ids.forEach((id, i) => {
      if (towers.has(id)) return;
      const { p, t } = nodes.get(id)!, a = nodes.get(ids[Math.max(0, i - 1)])!.p, b = nodes.get(ids[Math.min(ids.length - 1, i + 1)])!.p;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      const portal = t.power === "portal";
      towers.set(id, { c: p, u, v: [-u[1], u[0]], z0: ground(p[0], p[1]), H: portal ? 14 : heightOf(line, t), circuits, pole: portal || t.structure === "tubular" || t.material === "concrete" });
    });
    // conductors span by span, slot to slot (the across axis keeps its side along the way)
    for (let i = 1; i < ids.length; i++) {
      const A = towers.get(ids[i - 1])!, B = towers.get(ids[i])!;
      if (!inBox(A.c) && !inBox(B.c)) continue;
      const span: Piece = { roof: [], wall: [], footprint: box([A.c, B.c]), height: Math.max(A.H, B.H), base: Math.min(A.z0, B.z0), look: look(WIRE) };
      const sa = slots(A.H, circuits), sb = slots(B.H, circuits), flipA = A.v[0] * B.v[0] + A.v[1] * B.v[1] < 0 ? -1 : 1;
      const onA = (b: number, z: number) => at(A, 0, b * flipA, A.z0 + z - span.base), onB = (b: number, z: number) => at(B, 0, b, B.z0 + z - span.base);
      sa.wires.forEach(([a, z], k) => wire(span, onA(a, z), onB(sb.wires[k][0], sb.wires[k][1]), 0.025, 0.05, ground, 7));
      wire(span, onA(0, sa.earth[1]), onB(0, sb.earth[1]), 0.02, 0.035, ground, 9);
      pieces.push(span);
    }
  }
  for (const t of towers.values()) if (inBox(t.c)) pieces.push(...pylon(t));
  return { pieces, towers: [...towers.values()].filter((t) => inBox(t.c)).map((t) => t.c) };
}
