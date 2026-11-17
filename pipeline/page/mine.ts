/**
 * A salt-mine level as a cutaway (render page, `?mine=<level>`; data from src/mine.ts): the rock cut level CAP
 * metres over the floor, the voids open. Three layers, all draped on the town's terrain so a chamber lies under the
 * spot above it:
 *   floor  the ground mesh with drawMineFloor's canvas: salt floors, chapel tiles, brine lakes, walkways, rails, lamps
 *   cap    the same mesh CAP higher with drawMineCap's canvas: rock, the voids cut out (alpha), their edges
 *   walls  mineObjects: the voids' outlines raised from floor to cap, timber cribs
 * How sure a part is shows in its drawing: known and approximate parts in full colour (approximate edges dashed),
 * illustrative ones paler, hatched, with dotted edges.
 */
import * as THREE from "three";
import { CAP } from "../src/minedata.ts";

type P2 = [number, number];
export type MineFeature = { k: string; r?: P2[][]; l?: P2[]; j?: number[][]; w?: number; v?: number; u?: string; c?: number[]; e?: number[] };

export const MINE_CAP = CAP;
const FLOOR = "#a7a090", FLOOR_ILL = "#b7b2a6";
const ROOM: Record<string, string> = {
  chamber: "#b2ab9b", hall: "#bcb4a2", chapel: "#d8cfb9", museum: "#c3b598", podszybie: "#a29b8b", grotto: "#c8d4d8", lake: "#b2ab9b",
};
const ROCK = "#5e5a52";
const EDGE = "#d4ccbb";

let noiseTile: HTMLCanvasElement | null = null;
/** 256 px of soft mottling and salt specks, wrapped (fixed to the map: no seams between tiles) */
function noise(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  let s = 12345;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 260; i++) { // blotches
    const x = rnd() * 256, y = rnd() * 256, r = 6 + rnd() * 26, a = 0.035 + rnd() * 0.05, light = rnd() < 0.5;
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      gr.addColorStop(0, light ? `rgba(255,252,240,${a})` : `rgba(30,25,20,${a})`); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    }
  }
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(255,255,250,${0.08 + rnd() * 0.16})`; g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd(), 1 + rnd()); }
  return (noiseTile = c);
}

const bounds = (r: P2[]) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); } return [a, b, c, d]; };
/** features overlapping [x0, y0, x1, y1] (+ m) */
export function mineVisible(feats: MineFeature[], [x0, y0, x1, y1]: number[], m = 10) {
  return feats.filter((f) => {
    if (f.j) return true;
    const b = bounds(f.r ? f.r.flat() : f.l!);
    return b[0] < x1 + m && b[2] > x0 - m && b[1] < y1 + m && b[3] > y0 - m;
  });
}

function begin(ctx: CanvasRenderingContext2D, [x0, , , y1]: number[], mpt: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(1 / mpt, 0, 0, -1 / mpt, -x0 / mpt, y1 / mpt);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
}
const path = (ctx: CanvasRenderingContext2D, rings: P2[][]) => {
  ctx.beginPath();
  for (const r of rings) { r.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
};
const line = (ctx: CanvasRenderingContext2D, l: P2[]) => { ctx.beginPath(); l.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
function texture(ctx: CanvasRenderingContext2D, rect: number[], mpt: number, scale = 0.12) {
  const p = ctx.createPattern(noise(), "repeat")!;
  p.setTransform(new DOMMatrix().scale(scale)); // pattern px → metres: 256 px ≈ 31 m
  ctx.fillStyle = p;
  ctx.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
}
/** diagonal hatching over the current path (illustrative parts) */
function hatch(ctx: CanvasRenderingContext2D, rings: P2[][], gap: number, colour: string, w: number) {
  ctx.save(); path(ctx, rings); ctx.clip("evenodd");
  const [a, b, c, d] = bounds(rings.flat());
  ctx.beginPath();
  for (let k = Math.floor((a + b) / gap) * gap; k < c + d; k += gap) { ctx.moveTo(k - b, b); ctx.lineTo(k - d, d); }
  ctx.strokeStyle = colour; ctx.lineWidth = w; ctx.stroke(); ctx.restore();
}
/** a stroke along a polyline offset sideways by d (left of its direction) */
function offset(l: P2[], d: number): P2[] {
  return l.map((p, i) => {
    const a = l[Math.max(0, i - 1)], b = l[Math.min(l.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / L) * d, p[1] + (dx / L) * d];
  });
}

const images = new Map<string, HTMLImageElement>();
/** Load the level's images (an old plan: k mimg, u its file in the ground dir) before the first tile. */
export async function preloadMine(feats: MineFeature[]) {
  for (const f of feats) if (f.k === "mimg" && !images.has(f.u!)) {
    const img = new Image();
    img.src = `/ground/${f.u}`;
    await img.decode();
    images.set(f.u!, img);
  }
}

/** The floor: what shows through the voids. */
export function drawMineFloor(ctx: CanvasRenderingContext2D, feats: MineFeature[], rect: number[], mpt: number) {
  begin(ctx, rect, mpt);
  const of = (k: string) => feats.filter((f) => f.k === k);
  const plans = of("mimg");
  if (plans.length) { // an old plan, as engraved: drawn flat (its own transform: image px → ENU)
    ctx.fillStyle = "#6b5a43"; ctx.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    for (const f of plans) { const img = images.get(f.u!); if (!img) continue; ctx.save(); ctx.transform(...(f.e as [number, number, number, number, number, number])); ctx.drawImage(img, 0, 0); ctx.restore(); }
    return;
  }
  ctx.fillStyle = FLOOR; ctx.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
  // galleries and chambers (illustrative ones paler and hatched)
  for (const g of of("mgal")) { line(ctx, g.l!); ctx.strokeStyle = g.v === 1 ? FLOOR_ILL : FLOOR; ctx.lineWidth = g.w! + 1; ctx.stroke(); }
  for (const f of of("mfloor")) {
    path(ctx, f.r!); ctx.fillStyle = f.v === 1 ? "#bbb6aa" : ROOM[f.u ?? "chamber"] ?? ROOM.chamber; ctx.fill("evenodd");
    if (f.u === "chapel") { // salt floor tiles: a 1.2 m grid, every other one lighter
      ctx.save(); path(ctx, f.r!); ctx.clip("evenodd");
      const [a, b, c, d] = bounds(f.r!.flat());
      for (let y = Math.floor(b / 1.2) * 1.2; y < d; y += 1.2) for (let x = Math.floor(a / 1.2) * 1.2; x < c; x += 1.2)
        if ((Math.round(x / 1.2) + Math.round(y / 1.2)) % 2) { ctx.fillStyle = "rgba(255,250,235,0.35)"; ctx.fillRect(x, y, 1.2, 1.2); }
      ctx.restore();
    }
    if (f.u === "grotto") { ctx.save(); path(ctx, f.r!); ctx.clip("evenodd"); const [a, b, c, d] = bounds(f.r!.flat()); for (let i = 0; i < 160; i++) { const h = Math.abs(Math.sin(i * 12.9898 + a) * 43758.5453) % 1, k = Math.abs(Math.sin(i * 78.233 + b) * 12345.678) % 1; ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(a + h * (c - a), b + k * (d - b), 0.35, 0.35); } ctx.restore(); }
    if (f.v === 1) hatch(ctx, f.r!, 1.4, "rgba(90,80,66,0.16)", 0.12);
  }
  ctx.save(); ctx.globalCompositeOperation = "multiply"; texture(ctx, rect, mpt); ctx.restore();
  // brine lakes: deep green water, a pale rim of salt crust, glints
  for (const f of of("mlake")) {
    path(ctx, f.r!); ctx.fillStyle = "#3b7a7c"; ctx.fill("evenodd");
    ctx.save(); ctx.clip("evenodd");
    ctx.lineWidth = 2.2; ctx.strokeStyle = "rgba(160,215,205,0.35)"; ctx.stroke();
    const [a, b, c, d] = bounds(f.r!.flat());
    ctx.strokeStyle = "rgba(220,245,240,0.35)"; ctx.lineWidth = 0.18;
    for (let y = b + 1.5; y < d; y += 2.3) { ctx.beginPath(); ctx.moveTo(a + ((y * 7.1) % 3), y); ctx.lineTo(a + ((y * 7.1) % 3) + 1.6, y); ctx.moveTo((a + c) / 2 + ((y * 3.7) % 4), y + 0.8); ctx.lineTo((a + c) / 2 + ((y * 3.7) % 4) + 1.2, y + 0.8); ctx.stroke(); }
    ctx.restore();
    path(ctx, f.r!); ctx.lineWidth = 0.6; ctx.strokeStyle = "#e6e2d4"; ctx.stroke();
  }
  // rails along the main galleries: two rails 0.6 m apart on sleepers
  for (const f of of("mrail")) {
    ctx.setLineDash([0.25, 0.55]); line(ctx, f.l!); ctx.strokeStyle = "#6b5640"; ctx.lineWidth = 1.1; ctx.stroke(); ctx.setLineDash([]);
    for (const s of [-0.3, 0.3]) { line(ctx, offset(f.l!, s)); ctx.strokeStyle = "#4a4640"; ctx.lineWidth = 0.09; ctx.stroke(); }
  }
  // the routes: a walkway of boards with a handrail line
  for (const f of of("mroute")) {
    line(ctx, f.l!); ctx.strokeStyle = "#a58861"; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.setLineDash([0.08, 0.5]); line(ctx, f.l!); ctx.strokeStyle = "rgba(70,50,30,0.55)"; ctx.lineWidth = 1.8; ctx.stroke(); ctx.setLineDash([]);
  }
  // the reserve's boundary (GDOŚ via OSM)
  for (const f of of("mzone")) { path(ctx, f.r!); ctx.setLineDash([3, 2]); ctx.strokeStyle = "rgba(90,150,175,0.9)"; ctx.lineWidth = 0.6; ctx.stroke(); ctx.setLineDash([]); }
  // shafts: a dark pit in a timber collar
  for (const f of of("mshaft")) {
    const [[x, y]] = f.l!, r = f.w!;
    ctx.beginPath(); ctx.arc(x, y, r + 0.7, 0, 2 * Math.PI); ctx.fillStyle = "#6a4f33"; ctx.fill();
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, "#050404"); gr.addColorStop(1, "#2b2420");
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = gr; ctx.fill();
  }
  // lamps: warm pools of light (chandeliers bigger, with a bright heart)
  for (const f of of("mlamp")) for (const [x, y, kind] of f.j!) {
    if (x < rect[0] - 8 || x > rect[2] + 8 || y < rect[1] - 8 || y > rect[3] + 8) continue;
    const r = kind ? 7 : 3.6, gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, kind ? "rgba(255,228,160,0.75)" : "rgba(255,214,140,0.55)"); gr.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    if (kind) { ctx.beginPath(); ctx.arc(x, y, 0.5, 0, 2 * Math.PI); ctx.fillStyle = "#fff6d8"; ctx.fill(); }
  }
}

/** The cap: rock cut CAP above the floor, the voids cut out (transparent), their edges drawn by confidence. */
export function drawMineCap(ctx: CanvasRenderingContext2D, feats: MineFeature[], rect: number[], mpt: number) {
  begin(ctx, rect, mpt);
  if (feats.some((f) => f.k === "mimg")) return; // an old plan has no rock over it: all transparent
  ctx.fillStyle = ROCK; ctx.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
  ctx.save(); ctx.globalCompositeOperation = "multiply"; texture(ctx, rect, mpt, 0.2); ctx.restore();
  // strata: faint wavy bands along the deposit (roughly east–west), every 7 m
  ctx.lineWidth = 1.6;
  for (let y = Math.floor(rect[1] / 7) * 7 - 7; y < rect[3] + 7; y += 7) {
    const k = Math.round(y / 7);
    ctx.strokeStyle = k % 3 === 0 ? "rgba(255,250,235,0.06)" : "rgba(15,14,10,0.08)";
    ctx.beginPath();
    for (let i = 0, x = rect[0] - 6; x <= rect[2] + 6; i++, x += 4) {
      const yy = y + 2.2 * Math.sin(x / 37 + k * 1.7) + 1.1 * Math.sin(x / 11 + k);
      if (i) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
    }
    ctx.stroke();
  }
  const voids = feats.filter((f) => f.k === "mvoid");
  ctx.save(); ctx.globalCompositeOperation = "destination-out";
  path(ctx, voids.flatMap((f) => f.r!)); ctx.fillStyle = "#000"; ctx.fill("evenodd");
  ctx.restore();
  // the cut edge: crisp where known, dashed where approximate, dotted where illustrative
  const style: Record<number, [string, number, number[]]> = { 3: [EDGE, 0.45, []], 2: [EDGE, 0.45, [1.6, 0.9]], 1: ["rgba(212,204,187,0.55)", 0.3, [0.35, 0.65]] };
  for (const f of voids) {
    const r = f.r![0], c = f.c ?? [];
    for (const code of [1, 2, 3]) {
      const [col, w, dash] = style[code];
      ctx.beginPath();
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        if ((c[i] ?? 1) !== code) continue;
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

// ---- walls and props -----------------------------------------------------------------------------------
const rawMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `attribute vec3 color; varying vec3 vColor; void main() { vColor = color; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `varying vec3 vColor; void main() { gl_FragColor = vec4(vColor, 1.0); }`,
  side: THREE.DoubleSide,
});
const hex = (h: string) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** Walls along the voids' outlines and timber cribs, inside [x0, y0, x1, y1] (+ margin). */
export function mineObjects(feats: MineFeature[], [x0, y0, x1, y1]: number[], ground: (x: number, y: number) => number, sun: THREE.Vector3) {
  const pos: number[] = [], col: number[] = [];
  const m = 6, inRect = (p: P2) => p[0] > x0 - m && p[0] < x1 + m && p[1] > y0 - m && p[1] < y1 + m;
  const quad = (a: number[], b: number[], c: number[], d: number[], rgb: number[]) => { for (const p of [a, b, c, a, c, d]) { pos.push(p[0], p[1], p[2]); col.push(rgb[0], rgb[1], rgb[2]); } };
  const lit = (n: [number, number, number], base: number[]) => {
    const k = 0.62 + 0.5 * Math.max(0, n[0] * sun.x + n[1] * sun.y + n[2] * sun.z);
    return base.map((v) => Math.min(1, v * k));
  };
  const WALL = hex("#948c7c"), WALL_ILL = hex("#a29d92");
  for (const f of feats) {
    if (f.k !== "mvoid") continue;
    const r = f.r![0], c = f.c ?? [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if (!inRect(a) && !inRect(b)) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 1e-3) continue;
      const n: [number, number, number] = [-dy / L, dx / L, 0]; // the void lies left of the outline: the face looks into it
      const ga = ground(a[0], a[1]), gb = ground(b[0], b[1]);
      // a little roughness: the wall leans and darkens towards its foot (ambient)
      quad([a[0], a[1], ga], [b[0], b[1], gb], [b[0], b[1], gb + MINE_CAP], [a[0], a[1], ga + MINE_CAP], lit(n, (c[i] ?? 1) === 1 ? WALL_ILL : WALL));
    }
  }
  const WOOD = hex("#7a5a3b"), WOOD_TOP = hex("#9a7650");
  for (const f of feats) {
    if (f.k !== "mcrib") continue;
    const ring = f.r![0];
    if (!ring.some(inRect)) continue;
    const h = f.w ?? 2, g = Math.min(...ring.map(([x, y]) => ground(x, y)));
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      // logs: alternating bands up the side
      for (let z = 0; z < h; z += 0.3) {
        const t = Math.min(h, z + 0.3), shade = (Math.round(z / 0.3) % 2 ? 0.9 : 1);
        quad([a[0], a[1], g + z], [b[0], b[1], g + z], [b[0], b[1], g + t], [a[0], a[1], g + t], lit([dy / L, -dx / L, 0], WOOD.map((v) => v * shade)));
      }
    }
    quad([...ring[0], g + h], [...ring[1], g + h], [...ring[2], g + h], [...ring[3], g + h], lit([0, 0, 1], WOOD_TOP));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Mesh(geo, rawMaterial);
}

/** The ground's texture as it is (no hillshade: the floor is level, only draped on the terrain to sit under its spot). */
export function flatMaterial(map: THREE.Texture, cutout: boolean) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform sampler2D map; varying vec2 vUv;
      void main() { vec4 c = texture2D(map, vUv); ${cutout ? "if (c.a < 0.5) discard;" : ""} gl_FragColor = vec4(c.rgb, 1.0); }`,
    uniforms: { map: { value: map } },
  });
}
