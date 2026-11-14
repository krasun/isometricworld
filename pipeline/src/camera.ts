/**
 * The orthographic isometric camera of a region, shared by the renderer (browser), the pipeline
 * (Node) and the web viewer. Pure math; the only dependency is the region table in places.ts.
 *
 * World frame: local East-North-Up (ENU) tangent plane at the region's origin on the WGS84
 * ellipsoid. Screen: x right, y down, in "art pixels" of MPP meters; tile (tx, ty) covers
 * x ∈ [tx·TILE, (tx+1)·TILE), y ∈ [ty·TILE, (ty+1)·TILE).
 *
 * Every CLI picks its region with useRegion() (from its area) before any projection.
 */
import { REGIONS } from "./places.ts";

/** Fixed for every region: the house style. */
export const CAMERA = {
  /** Tilt below the horizon. 45° shows facades and roofs equally. */
  pitchDeg: 45,
  /** Meters per art pixel (screen-x; ground depth and heights are × 1/√2 on screen). */
  mpp: 0.25,
  tile: 1024,
} as const;

let region = "israel-center";
/** Full camera of the active region (style + origin + heading), as written to manifests/world.json. */
export function camera() {
  const r = REGIONS[region];
  return { region, origin: r.origin, headingDeg: r.headingDeg, ...CAMERA };
}
export function activeRegion() { return region; }

export type Vec3 = [number, number, number];

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const rad = (d: number) => (d * Math.PI) / 180;

export function llhToEcef(lat: number, lon: number, h: number): Vec3 {
  const φ = rad(lat), λ = rad(lon);
  const N = A / Math.sqrt(1 - E2 * Math.sin(φ) ** 2);
  return [
    (N + h) * Math.cos(φ) * Math.cos(λ),
    (N + h) * Math.cos(φ) * Math.sin(λ),
    (N * (1 - E2) + h) * Math.sin(φ),
  ];
}

/** ENU basis vectors (in ECEF) and the origin point. */
function enuFrame() {
  const { lat, lon, h } = REGIONS[region].origin;
  const φ = rad(lat), λ = rad(lon);
  const east: Vec3 = [-Math.sin(λ), Math.cos(λ), 0];
  const north: Vec3 = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  const up: Vec3 = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
  return { east, north, up, o: llhToEcef(lat, lon, h) };
}
let FRAME = enuFrame();

/** Column-major 4x4 matrix taking ECEF -> ENU (for THREE.Matrix4.fromArray). */
export function ecefToEnuMatrix(): number[] {
  const { east: e, north: n, up: u, o } = FRAME;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // rows are e, n, u; translation = -R·o
  return [
    e[0], n[0], u[0], 0,
    e[1], n[1], u[1], 0,
    e[2], n[2], u[2], 0,
    -dot(e, o), -dot(n, o), -dot(u, o), 1,
  ];
}

export function ecefToEnu(p: Vec3): Vec3 {
  const { east: e, north: n, up: u, o } = FRAME;
  const d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return [
    e[0] * d[0] + e[1] * d[1] + e[2] * d[2],
    n[0] * d[0] + n[1] * d[1] + n[2] * d[2],
    u[0] * d[0] + u[1] * d[1] + u[2] * d[2],
  ];
}

/** ENU point -> [lat, lon, ellipsoid height] (exact: ECEF, then Bowring's latitude with two refinements). */
export function enuToLlh([x, y, z]: Vec3): Vec3 {
  const { east: e, north: n, up: u, o } = FRAME;
  const p: Vec3 = [0, 1, 2].map((k) => o[k] + e[k] * x + n[k] * y + u[k] * z) as Vec3;
  const lon = Math.atan2(p[1], p[0]), r = Math.hypot(p[0], p[1]);
  let lat = Math.atan2(p[2], r * (1 - E2)), h = 0;
  for (let i = 0; i < 3; i++) {
    const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = r / Math.cos(lat) - N;
    lat = Math.atan2(p[2], r * (1 - (E2 * N) / (N + h)));
  }
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI, h];
}

/** Camera axes in ENU. */
export function axes() {
  const h = rad(REGIONS[region].headingDeg), p = rad(CAMERA.pitchDeg);
  const fwd: Vec3 = [Math.sin(h), Math.cos(h), 0];
  const right: Vec3 = [Math.cos(h), -Math.sin(h), 0];
  const up: Vec3 = [fwd[0] * Math.sin(p), fwd[1] * Math.sin(p), Math.cos(p)];
  const dir: Vec3 = [fwd[0] * Math.cos(p), fwd[1] * Math.cos(p), -Math.sin(p)];
  return { right, up, dir };
}
let AX = axes();

/** Switch every projection to another region's camera. */
export function useRegion(id: string) {
  if (!REGIONS[id]) throw new Error(`unknown region ${id}`);
  region = id;
  FRAME = enuFrame();
  AX = axes();
}

/** ENU point -> global art pixel. */
export function enuToPixel([e, n, u]: Vec3): [number, number] {
  const { right: r, up: v } = AX;
  return [
    (e * r[0] + n * r[1] + u * r[2]) / CAMERA.mpp,
    -(e * v[0] + n * v[1] + u * v[2]) / CAMERA.mpp,
  ];
}

/** lat/lon/ellipsoid height -> global art pixel. */
export function llhToPixel(lat: number, lon: number, h: number): [number, number] {
  return enuToPixel(ecefToEnu(llhToEcef(lat, lon, h)));
}

/** Ellipsoid height of an ENU point (accurate to ~cm within tens of km). */
export function enuHeight([e, n, u]: Vec3): number {
  return u + (e * e + n * n) / (2 * 6371000);
}

/**
 * Orthographic camera for one tile, in ENU: position (pulled back along -dir),
 * up vector, look direction and half-extent in meters.
 */
export function tileCamera(tx: number, ty: number, backoff = 3000) {
  const T = CAMERA.tile, m = CAMERA.mpp;
  const cx = (tx + 0.5) * T * m; // screen-right meters
  const cy = (ty + 0.5) * T * m; // screen-down meters
  const { right: r, up: v, dir: d } = AX;
  // point on the view ray through the tile center, slid along the ray down to u = 0 so the
  // terrain always sits `backoff` meters in front of the camera (ortho: image is unchanged)
  const p0: Vec3 = [0, 1, 2].map((k) => r[k] * cx - v[k] * cy) as Vec3;
  const t = p0[2] / -d[2];
  const pos: Vec3 = [0, 1, 2].map((k) => p0[k] + d[k] * (t - backoff)) as Vec3;
  return { pos, up: v, dir: d, half: (T * m) / 2, near: 1, far: backoff * 2 };
}
