import type { Road } from "./traffic.ts";

/** roads.<hash>.json as written by encodeRoads (pipeline/src/export.ts): columnar, delta-coded. */
interface Encoded { v: 2; c: number[]; o: number[]; l: number[]; w: number[]; a: number[]; b: number[]; n: number[]; s: number[]; vis: number[] }

/** Roads in the viewer's shape (one object per way, s = [e, n, u, visible] × samples); the old
 *  roads.json (already that shape) passes through. `legacy`: exported before road heights came from
 *  the terrain grid (see flattenRoofs). */
export function decodeRoads(data: Encoded | Road[], legacy = false): Road[] {
  if (Array.isArray(data)) return legacy ? data.map(flattenRoofs) : data;
  const roads: Road[] = [];
  let p = 0, q = 0; // read positions in s and vis
  for (let i = 0; i < data.n.length; i++) {
    const n = data.n[i], s = new Array<number>(n * 4);
    let e = 0, no = 0, u = 0;
    for (let k = 0; k < n; k++, p += 3) {
      e += data.s[p]; no += data.s[p + 1]; u += data.s[p + 2];
      s[k * 4] = e / 10; s[k * 4 + 1] = no / 10; s[k * 4 + 2] = u / 10;
    }
    const runs = data.vis[q++];
    for (let r = 0, k = 0; r < runs; r++) {
      const len = data.vis[q++], vis = r % 2 === 0 ? 1 : 0;
      for (let j = 0; j < len; j++, k++) s[k * 4 + 3] = vis;
    }
    const road = { c: data.c[i], o: data.o[i], l: data.l[i], w: data.w[i], a: data.a[i], b: data.b[i], s };
    roads.push(legacy ? flattenRoofs(road) : road);
  }
  return roads;
}

/** steepest climb a road takes (rise per metre) and how far a sample may drop before it counts as under a building */
const GRADE = 0.1, ROOF = 2;
/**
 * Older exports took road heights from the height pass, so where a road runs under or beside a tall
 * building some samples sit on its roof (up to ~300 m up), and cars hopped onto it. No road climbs
 * that steeply: cut every rise steeper than GRADE back down (the lower envelope, forward and back),
 * and hide the samples that dropped (the road there is under or behind the building). Data exported
 * with terrain heights (it also has trains) doesn't need this.
 */
function flattenRoofs(r: Road): Road {
  const s = r.s.slice(), n = s.length / 4;
  const step = (k: number, j: number) => GRADE * Math.hypot(s[k * 4] - s[j * 4], s[k * 4 + 1] - s[j * 4 + 1]);
  for (let k = 1; k < n; k++) s[k * 4 + 2] = Math.min(s[k * 4 + 2], s[(k - 1) * 4 + 2] + step(k, k - 1));
  for (let k = n - 2; k >= 0; k--) s[k * 4 + 2] = Math.min(s[k * 4 + 2], s[(k + 1) * 4 + 2] + step(k, k + 1));
  for (let k = 0; k < n; k++) if (r.s[k * 4 + 2] - s[k * 4 + 2] > ROOF) s[k * 4 + 3] = 0;
  return { ...r, s };
}
