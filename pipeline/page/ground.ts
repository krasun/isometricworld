/**
 * Ground surface drawn from OSM onto a canvas (top-down, ENU meters) and draped on the terrain:
 * landuse, parks, beach, water and sea, pavements, roads at real widths with lane markings,
 * paths, rail, soft contact shadows of buildings and trees. Flat clean colours: the paint
 * step turns them into textured art.
 */

type P2 = [number, number];
/** b: a bridge with its own deck (bridges.ts): drawn on the deck canvas, not the ground */
export interface Feature { k: string; r?: P2[][]; l?: P2[]; w?: number; o?: 1; n?: number; y?: number; j?: number[][]; v?: number; b?: 1 }
interface Objects { b: Array<[P2[], number, number, number | null]>; t: Array<[number, number, number, number]> }

const FILL: Record<string, string> = {
  residential: "#dcd5c6", commercial: "#dfdbd2", industrial: "#cfcbc2", campus: "#e1dacb",
  farm: "#c9cd8c", dirt: "#d2b98f", cemetery: "#b2c798",
  park: "#9dcb6c", wood: "#73a851", scrub: "#adbb7b", sand: "#eedbab", pitch: "#6db35a", track: "#c97a5c",
  playground: "#dccba1", parking: "#bebcb7", paving: "#e6e0d4", water: "#3f95c2", pool: "#5ccbe6",
  vineyard: "#bfc27a", allotments: "#a9c676", orchard: "#b4cc7e", meadow: "#b6cf7e",
  flowerbed: "#86b45a", gravel: "#ddd0b4",
  fairway: "#8fca62", green: "#76c158", bunker: "#f0e2b4", airgrass: "#a8cf78", tarmac: "#8e9196",
};
/** field shades (ground.ts fieldShade): wheat, maize, grass, vegetables, rapeseed, then unmapped fields by id */
const FIELD = ["#d8c983", "#a9c26a", "#b8cf7f", "#bcc48c", "#e0d66c",
  "#c9cd8c", "#d3cd91", "#bcc983", "#cdc489", "#b3c67c", "#d8d1a0", "#c6b892"];
/** Lawns, beds and paved or gravel squares nest in each other both ways (lawns in a square, a plaza in a park):
 *  drawn together, largest first, so whatever lies inside another polygon ends up on top. */
const NESTED = new Set(["park", "flowerbed", "paving", "gravel"]);
const BLOOM = ["#e0525e", "#f2c94c", "#f4f1ea", "#c86bb0"];
/** paint order of area kinds: broad landuse first, details on top */
const AREA_ORDER = ["residential", "commercial", "industrial", "campus", "farm", "meadow", "orchard", "vineyard", "allotments",
  "dirt", "cemetery", "scrub", "wood", "park", "flowerbed", "fairway", "green", "bunker", "airgrass", "tarmac", "sand", "parking", "paving", "gravel", "pitch", "track", "playground", "water", "pool"];
const BASE = "#d9d3c4";
const SEA = "#2c80b2", SHALLOW = "#4ea6cb";
const ASPHALT: Record<string, string> = { highway: "#6c7077", street: "#7b7e85", lane: "#8b8d91", dirtroad: "#c3ab82" };
const PATHS: Record<string, string> = { path: "#ebe5d6", cycle: "#c98e6c", plaza: "#e6e0d4" };
const SIDEWALK = "#e4ded2", KERB = "#c9c4b9";
const SHADOW_DIR: P2 = [0.84, 0.54]; // away from the renderer's sun (-0.55, -0.35, 0.76)

export function drawGround(
  ctx: CanvasRenderingContext2D, features: Feature[], [x0, y0, x1, y1]: number[], mpt: number,
  objects: Objects, ground: (x: number, y: number) => number, shadowDir: P2 = SHADOW_DIR,
) {
  const SHADOW_DIR = shadowDir;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BASE;
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(1 / mpt, 0, 0, -1 / mpt, -x0 / mpt, y1 / mpt); // ENU meters -> canvas px (north up)
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const path = (rings: P2[][]) => {
    ctx.beginPath();
    for (const r of rings) { r.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
  };
  const line = (l: P2[]) => { ctx.beginPath(); l.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
  const stroke = (l: P2[], w: number, c: string, dash?: number[]) => {
    line(l); ctx.lineWidth = w; ctx.strokeStyle = c; ctx.setLineDash(dash ?? []); ctx.stroke();
  };
  const of = (k: string) => features.filter((f) => f.k === k);
  const inView = (p: number[]) => p[0] > x0 - 50 && p[0] < x1 + 50 && p[1] > y0 - 50 && p[1] < y1 + 50;
  const junctions = (of("junctions")[0]?.j ?? []).filter(inView);
  const zebras = (of("zebras")[0]?.j ?? []).filter(inView);

  // 1. areas
  const ringArea = (r: P2[]) => Math.abs(r.reduce((a, [x, y], i) => { const [u, v] = r[(i + 1) % r.length]; return a + x * v - u * y; }, 0)) / 2;
  const areas: Feature[] = [];
  for (const k of AREA_ORDER) {
    if (!NESTED.has(k)) areas.push(...of(k));
    else if (k === "park") areas.push(...features.filter((f) => NESTED.has(f.k)).sort((a, b) => ringArea(b.r![0]) - ringArea(a.r![0])));
  }
  for (const f of areas) {
    const k = f.k;
    path(f.r!); ctx.fillStyle = (k === "farm" || k === "meadow") && f.v !== undefined ? FIELD[f.v] ?? FILL[k] : FILL[k]; ctx.fill("evenodd");
    if (k === "farm" && f.v !== undefined) { // tramlines / furrows: faint parallel lines, own angle per field
      ctx.save(); ctx.clip("evenodd");
      const [bx0, by0, bx1, by1] = bounds(f.r!), cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, R = Math.hypot(bx1 - bx0, by1 - by0) / 2;
      const a = ((f.v * 0.37) % 1) * Math.PI, ux = Math.cos(a), uy = Math.sin(a), gap = f.v === 2 ? 9 : 3;
      ctx.lineWidth = 0.5; ctx.strokeStyle = "rgba(90,80,40,0.10)"; ctx.setLineDash([]);
      ctx.beginPath();
      for (let s = -R; s < R; s += gap) { ctx.moveTo(cx - uy * s - ux * R, cy + ux * s - uy * R); ctx.lineTo(cx - uy * s + ux * R, cy + ux * s + uy * R); }
      ctx.stroke(); ctx.restore();
    }
    if (k === "fairway") {    // mowing stripes, 6 m wide
      ctx.save(); ctx.clip("evenodd");
      const [bx0, by0, bx1, by1] = bounds(f.r!);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      for (let x = Math.floor(bx0 / 12) * 12; x < bx1; x += 12) ctx.fillRect(x, by0, 6, by1 - by0);
      ctx.restore();
    }
    if (k === "bunker") { ctx.lineWidth = 0.4; ctx.strokeStyle = "#cdbb88"; ctx.stroke(); }
    if (k === "flowerbed") { // blossoms: a deterministic speckle every ~1 m
      ctx.save(); ctx.clip("evenodd");
      const [bx0, by0, bx1, by1] = bounds(f.r!);
      for (let y = Math.floor(by0); y < by1; y += 0.9) for (let x = Math.floor(bx0); x < bx1; x += 0.9) {
        const h = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
        if (h > 0.55) continue;
        ctx.fillStyle = BLOOM[Math.floor(h * 7.27) % BLOOM.length];
        ctx.fillRect(x + h * 0.5, y + (h * 3.1) % 0.5, 0.45, 0.45);
      }
      ctx.restore();
    }
    if (k === "pitch") { ctx.lineWidth = 0.25; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.stroke(); }
    if (k === "vineyard") {   // vine rows ~2 m apart, up and down the slope (drawn north-south: most Stuttgart slopes face south)
      ctx.save(); ctx.clip("evenodd");
      const [bx0, by0, bx1, by1] = bounds(f.r!);
      ctx.lineWidth = 0.7; ctx.strokeStyle = "#6f8a3a"; ctx.setLineDash([]);
      ctx.beginPath();
      for (let x = Math.floor(bx0 / 2) * 2; x < bx1; x += 2) { ctx.moveTo(x, by0); ctx.lineTo(x, by1); }
      ctx.stroke(); ctx.restore();
    }
    if (k === "allotments") { // garden plots: a loose grid of hedges
      ctx.save(); ctx.clip("evenodd");
      const [bx0, by0, bx1, by1] = bounds(f.r!);
      ctx.lineWidth = 0.5; ctx.strokeStyle = "#7f9e52"; ctx.setLineDash([]);
      ctx.beginPath();
      for (let x = Math.floor(bx0 / 14) * 14; x < bx1; x += 14) { ctx.moveTo(x, by0); ctx.lineTo(x, by1); }
      for (let y = Math.floor(by0 / 18) * 18; y < by1; y += 18) { ctx.moveTo(bx0, y); ctx.lineTo(bx1, y); }
      ctx.stroke(); ctx.restore();
    }
    if (k === "pool") { ctx.lineWidth = 0.6; ctx.strokeStyle = "#e9ecee"; ctx.stroke(); }
    if (k === "water") { ctx.lineWidth = 1; ctx.strokeStyle = "rgba(220,235,240,0.5)"; ctx.stroke(); }
  }

  // 2. sea: deep, shallows along the shore (clipped to the water), surf line
  for (const f of of("sea")) {
    path(f.r!); ctx.fillStyle = SEA; ctx.fill("evenodd");
    ctx.save(); path(f.r!); ctx.clip("evenodd");
    for (const s of of("shore")) {
      stroke(s.l!, 90, "rgba(78,166,203,0.45)");
      stroke(s.l!, 36, SHALLOW);
      stroke(s.l!, 10, "#78c0d8");
      stroke(s.l!, 3, "rgba(255,255,255,0.75)");
    }
    ctx.restore();
  }

  // 2b. airfields: runway and taxiway centre lines at their width (paved: markings; grass: a mown strip)
  ctx.lineCap = "butt";
  for (const f of of("grassway")) { stroke(f.l!, f.w!, "#b3d684"); stroke(f.l!, f.w! - 2, "#a8cf78"); }
  for (const f of of("taxiway")) { stroke(f.l!, f.w!, FILL.tarmac); stroke(f.l!, 0.3, "#e8c547"); }
  for (const f of of("runway")) {
    stroke(f.l!, f.w!, "#7f8288");
    for (const s of [-1, 1]) stroke(offset(f.l!, s * (f.w! / 2 - 1)), 0.5, "rgba(255,255,255,0.9)");
    stroke(f.l!, 0.9, "rgba(255,255,255,0.9)", [20, 15]);
  }
  ctx.lineCap = "round";

  // 3. soft contact shadows (short: the art has no long shadows)
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#3a3a40";
  for (const [ring, h] of objects.b) {
    const L = Math.min(9, h * 0.35), dx = SHADOW_DIR[0] * L, dy = SHADOW_DIR[1] * L;
    ctx.beginPath();
    // swept footprint = footprint ∪ shifted footprint ∪ every edge's sweep
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(bx + dx, by + dy); ctx.lineTo(ax + dx, ay + dy); ctx.closePath();
    }
    ring.forEach(([x, y], i) => (i ? ctx.lineTo(x + dx, y + dy) : ctx.moveTo(x + dx, y + dy)));
    ctx.closePath();
    ctx.fill("nonzero");
  }
  for (const [x, y, r, ch] of objects.t) {
    const L = Math.min(6, ch * 0.3);
    ctx.beginPath(); ctx.arc(x + SHADOW_DIR[0] * L, y + SHADOW_DIR[1] * L, r * 0.95, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  void ground;

  // 4. paths and plazas, then pavements under streets
  for (const f of [...of("path"), ...of("plaza"), ...of("cycle")]) stroke(f.l!, f.w!, PATHS[f.k]);
  for (const f of of("pier")) stroke(f.l!, f.w!, "#d8d2c4");
  // Roads have butt ends: a round cap on a bridge end or a wide road's end bulges over whatever it
  // meets. Joins between ways are filled by junction disks instead, drawn in the junction's layer.
  ctx.lineCap = "butt";
  const roads = features.filter((f) => ASPHALT[f.k]).sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || order(a) - order(b));
  const rails = of("rail");
  const layers = [...new Set([...roads, ...rails].map((f) => f.y ?? 0))].sort((a, b) => a - b);
  const disks = (js: number[][], grow: number, c?: string) => {
    for (const [x, y, r, , k] of js) {
      ctx.beginPath(); ctx.arc(x, y, r - 3 + grow, 0, Math.PI * 2);
      ctx.fillStyle = c ?? ASPHALT[CLASS[k] ?? "street"]; ctx.fill();
    }
  };
  for (const layer of layers) {
    const rs = roads.filter((f) => (f.y ?? 0) === layer);
    const js = junctions.filter((j) => (j[3] ?? 0) === layer);
    if (layer > 0) {
      // a bridge must read as passing OVER what's below: cast shadow, dark outline, concrete parapets
      for (const f of rs) stroke(f.l!.map(([x, y]) => [x + SHADOW_DIR[0] * 4, y + SHADOW_DIR[1] * 4] as P2), f.w! + 3, "rgba(40,40,48,0.35)");
      for (const f of rs) stroke(f.l!, f.w! + 3, "#55565c");
      for (const f of rs) stroke(f.l!, f.w! + 2.4, "#e2ddd2");
    }
    const streets = rs.filter((f) => f.k === "street");
    for (const f of streets) stroke(f.l!, f.w! + 6, KERB);
    const streetJs = layer === 0 ? js.filter((j) => CLASS[j[4]] === "street") : []; // pavements round street corners
    disks(streetJs, 3, KERB);
    for (const f of streets) stroke(f.l!, f.w! + 5.4, SIDEWALK);
    disks(streetJs, 2.7, SIDEWALK);
    for (const f of rs) stroke(f.l!, f.w!, ASPHALT[f.k]);
    disks(js, 0);
    // 5. markings, kept out of junctions (lines of crossing roads would scribble over each other)
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - 1e4, y1 - 1e5, 2e5, 2e5);
    for (const [x, y, r] of junctions) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.clip("evenodd");
    for (const f of rs) {
      if (f.k !== "street" && f.k !== "highway") continue;
      const w = f.w!;
      if (f.k === "highway") { for (const s of [-1, 1]) stroke(offset(f.l!, s * (w / 2 - 0.5)), 0.15, "rgba(255,255,255,0.9)"); }
      const lanes = f.n ?? Math.max(1, Math.round(w / 3.3));
      if (!f.o && w >= 7) stroke(f.l!, 0.15, "rgba(255,255,255,0.9)", lanes >= 4 ? undefined : [3, 5]);
      const per = f.o ? lanes : Math.floor(lanes / 2);
      for (let k = 1; k < per; k++) {
        const d = -w / 2 + (k * w) / lanes;
        if (f.o) stroke(offset(f.l!, d), 0.12, "rgba(255,255,255,0.85)", [3, 6]);
        else for (const s of [-1, 1]) stroke(offset(f.l!, (s * k * w) / lanes), 0.12, "rgba(255,255,255,0.85)", [3, 6]);
      }
    }
    ctx.restore();
    // 6. rail of this layer: ballast, sleepers, two rails (a road bridge above covers it)
    ctx.lineCap = "round";
    for (const f of rails.filter((f) => (f.y ?? 0) === layer)) {
      if (layer > 0) { stroke(f.l!, 5, "#55565c"); stroke(f.l!, 4.4, "#cfcac0"); } // deck edge and parapets, like road bridges
      stroke(f.l!, 3.4, "#a9a49a");
      stroke(f.l!, 2.6, "#7d6a58", [0.25, 0.4]);
      ctx.setLineDash([]);
      for (const s of [-0.72, 0.72]) stroke(offset(f.l!, s), 0.12, "#4b4d52");
    }
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
  }
  ctx.setLineDash([]);
  // zebra crossings: bars parallel to the street, across its full width
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  for (const [x, y, dx, dy, w] of zebras) {
    const nx = -dy, ny = dx;
    for (let o = -w / 2 + 0.4; o <= w / 2 - 0.4; o += 1.0) {
      const cx = x + nx * o, cy = y + ny * o;
      ctx.beginPath();
      ctx.moveTo(cx - dx * 1.5 - nx * 0.25, cy - dy * 1.5 - ny * 0.25);
      ctx.lineTo(cx + dx * 1.5 - nx * 0.25, cy + dy * 1.5 - ny * 0.25);
      ctx.lineTo(cx + dx * 1.5 + nx * 0.25, cy + dy * 1.5 + ny * 0.25);
      ctx.lineTo(cx - dx * 1.5 + nx * 0.25, cy - dy * 1.5 + ny * 0.25);
      ctx.fill();
    }
  }

  ctx.setLineDash([]);
}

const CLASS = ["dirtroad", "lane", "street", "highway"];
const order = (f: Feature) => CLASS.indexOf(f.k) * 100 + (f.w ?? 0);

/** Parallel polyline at signed distance d (left > 0). */
function offset(l: P2[], d: number): P2[] {
  return l.map((p, i) => {
    const a = l[Math.max(0, i - 1)], b = l[Math.min(l.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / L) * d, p[1] + (dx / L) * d];
  });
}

function bounds(rings: P2[][]) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}
