/**
 * LoD2 buildings (CityGML 1.0, AdV profile, as LGL Baden-Württemberg publishes them) -> triangle
 * meshes in the camera's ENU frame. Real roof shapes (gable, hip, mansard…), walls with facade
 * coordinates for the renderer's window patterns, and a footprint for contact shadows.
 *
 * Coordinates are ETRS89/UTM32 + NHN; NHN + the region's geoid = ellipsoid height.
 */
import * as THREE from "three";
import { ecefToEnu, llhToEcef } from "./camera.ts";
import { fromUtm } from "./utm.ts";

type V3 = [number, number, number];
type P2 = [number, number];

export interface Lod2Building {
  id: string;
  /** ALKIS building function (e.g. 31001_1010 Wohnhaus) and AdV roof type (1000 flat, 3100 gable…). */
  fn: string;
  roofType: string;
  /** Measured height (m, eaves… ridge above ground) and ground elevation (ENU up). */
  height: number;
  base: number;
  /** Roof triangles (x, y, z per vertex). */
  roof: number[];
  /** Wall triangles (x, y, z, along, above base per vertex). */
  wall: number[];
  /** Largest ground polygon (ENU xy, CCW) and the building's centre (lat, lon). */
  footprint: P2[];
  center: [number, number];
  /** Footprints in UTM (ground polygons, else roof outlines): where the nDOM shows roofs, not trees. */
  utm: P2[][];
}

const POLY = /<gml:Polygon[^>]*>([\s\S]*?)<\/gml:Polygon>/g;
const POS = /<gml:posList[^>]*>([^<]*)<\/gml:posList>/g;
const SURF = /<bldg:(RoofSurface|WallSurface|GroundSurface)\b[\s\S]*?<\/bldg:\1>/g;

/** ALKIS functions that are traffic structures (bridges, tunnels…): the road or rail is drawn on the ground instead. */
const isTrafficStructure = (fn: string) => fn.startsWith("53001_") || fn.startsWith("52003_");

/** Split a CityGML document into its top-level buildings (with their parts). */
function* buildings(xml: string): Generator<string> {
  const re = /<bldg:Building\s+gml:id="/g;
  let m = re.exec(xml);
  while (m) {
    const next = re.exec(xml);
    yield xml.slice(m.index, next ? next.index : xml.length);
    m = next;
  }
}

/**
 * Parse every building in a CityGML document whose centre lies in `bbox` ([s, w, n, e]).
 * `geoid` turns NHN into ellipsoid heights.
 */
export function parseLod2(xml: string, bbox: number[], geoid: number): Lod2Building[] {
  const out: Lod2Building[] = [];
  const [S, W, N, E] = bbox;
  for (const b of buildings(xml)) {
    const id = b.match(/gml:id="([^"]+)"/)![1];
    const fn = b.match(/<bldg:function>([^<]*)/)?.[1] ?? "";
    if (isTrafficStructure(fn)) continue;
    const roofType = b.match(/<bldg:roofType>([^<]*)/)?.[1] ?? "";
    const heights = [...b.matchAll(/<bldg:measuredHeight[^>]*>([^<]*)/g)].map((x) => Number(x[1]));
    // surfaces in UTM first: the centre test is cheap there, and most of a 1 km file lies outside small areas
    const surfaces: Array<{ kind: string; rings: number[][] }> = [];
    let se = 0, sn = 0, cnt = 0;
    for (const s of b.matchAll(SURF)) {
      for (const p of s[0].matchAll(POLY)) {
        const rings = [...p[1].matchAll(POS)].map((q) => q[1].trim().split(/\s+/).map(Number));
        if (!rings.length || rings[0].length < 9) continue;
        surfaces.push({ kind: s[1], rings });
        if (s[1] === "GroundSurface") for (let i = 0; i < rings[0].length; i += 3) { se += rings[0][i]; sn += rings[0][i + 1]; cnt++; }
      }
    }
    if (!surfaces.length) continue;
    if (!cnt) for (const s of surfaces) for (let i = 0; i < s.rings[0].length; i += 3) { se += s.rings[0][i]; sn += s.rings[0][i + 1]; cnt++; }
    const center = fromUtm(se / cnt, sn / cnt);
    if (center[0] < S || center[0] > N || center[1] < W || center[1] > E) continue;

    const toEnu = (e: number, n: number, h: number): V3 => {
      const [lat, lon] = fromUtm(e, n);
      return ecefToEnu(llhToEcef(lat, lon, h + geoid));
    };
    const roof: number[] = [], wall: number[] = [];
    let base = Infinity, footprint: P2[] = [], bestArea = 0;
    const polys = surfaces.map((s) => ({ kind: s.kind, rings: s.rings.map((r) => {
      const pts: V3[] = [];
      for (let i = 0; i + 2 < r.length; i += 3) pts.push(toEnu(r[i], r[i + 1], r[i + 2]));
      if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-3) pts.pop();
      return pts;
    }) }));
    for (const p of polys) for (const v of p.rings[0]) if (p.kind !== "RoofSurface") base = Math.min(base, v[2]);
    if (!Number.isFinite(base)) base = Math.min(...polys.flatMap((p) => p.rings[0].map((v) => v[2])));
    for (const p of polys) {
      if (p.kind === "GroundSurface") {
        const ring: P2[] = p.rings[0].map((v) => [v[0], v[1]]);
        const a = Math.abs(THREE.ShapeUtils.area(ring.map(([x, y]) => new THREE.Vector2(x, y))));
        if (a > bestArea) { bestArea = a; footprint = THREE.ShapeUtils.isClockWise(ring.map(([x, y]) => new THREE.Vector2(x, y))) ? ring.reverse() : ring; }
        continue;
      }
      const tris = triangulate(p.rings);
      if (!tris) continue;
      if (p.kind === "RoofSurface") { for (const v of tris.flat()) roof.push(...v); continue; }
      // walls: facade coordinates = metres along the wall's horizontal direction, metres above the building's base
      const n = tris.normal, hx = -n[1], hy = n[0], hl = Math.hypot(hx, hy) || 1;
      const o = p.rings[0][0];
      for (const v of tris.flat()) wall.push(v[0], v[1], v[2], ((v[0] - o[0]) * hx + (v[1] - o[1]) * hy) / hl + hashAlong(o), v[2] - base);
    }
    if (!roof.length && !wall.length) continue;
    const ground = surfaces.filter((x) => x.kind === "GroundSurface");
    const utm = (ground.length ? ground : surfaces.filter((x) => x.kind === "RoofSurface")).map((x) => {
      const r: P2[] = [];
      for (let i = 0; i + 2 < x.rings[0].length; i += 3) r.push([x.rings[0][i], x.rings[0][i + 1]]);
      return r;
    });
    out.push({ id, fn, roofType, height: Math.max(0, ...heights), base, roof, wall, footprint, center, utm });
  }
  return out;
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** offsets the window grid per wall so neighbouring walls don't line up perfectly */
const hashAlong = (o: V3) => ((Math.abs(Math.sin(o[0] * 12.9898 + o[1] * 78.233)) * 43758.5453) % 1) * 3;

/** Triangulate a planar 3D polygon with holes (projected onto its own plane). */
function triangulate(rings: V3[][]): (V3[][] & { normal: V3 }) | null {
  const ext = rings[0];
  if (ext.length < 3) return null;
  // Newell normal
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < ext.length; i++) {
    const a = ext[i], b = ext[(i + 1) % ext.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const L = Math.hypot(...n);
  if (L < 1e-6) return null;
  n[0] /= L; n[1] /= L; n[2] /= L;
  // in-plane basis
  const ref: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u: V3 = cross(ref, n), ul = Math.hypot(...u);
  u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const v = cross(n, u);
  const o = ext[0];
  const to2 = (p: V3) => new THREE.Vector2((p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2], (p[0] - o[0]) * v[0] + (p[1] - o[1]) * v[1] + (p[2] - o[2]) * v[2]);
  const contour = ext.map(to2), holes = rings.slice(1).filter((r) => r.length >= 3).map((r) => r.map(to2));
  const all = [...ext, ...rings.slice(1).filter((r) => r.length >= 3).flat()];
  let faces: number[][];
  try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { return null; }
  // keep the winding facing along the normal (outward for CityGML surfaces)
  const tris = faces.map((f) => {
    const [a, b, c] = f.map((i) => all[i]);
    const fn = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    return fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] < 0 ? [a, c, b] : [a, b, c];
  }) as V3[][] & { normal: V3 };
  tris.normal = n;
  return tris;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
