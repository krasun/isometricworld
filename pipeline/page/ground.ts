/**
 * Ground surface drawn from OSM onto a canvas (top-down, ENU meters) and draped on the terrain:
 * landuse, parks, beach, water and sea, pavements, roads at real widths with lane markings,
 * paths, rail, soft contact shadows of buildings and trees. Flat clean colours: the paint
 * step turns them into textured art.
 */

type P2 = [number, number];
/** b: a bridge with its own deck (bridges.ts): drawn on the deck canvas, not the ground */
/** p, u: pavement sides and surface (src/ground.ts, preset streetDetail); s: a track line's surface kind; ref: a
 *  runway's designators; sh: a sheltered platform */
export interface Feature { k: string; r?: P2[][]; l?: P2[]; w?: number; o?: 1; n?: number; y?: number; j?: number[][]; v?: number; b?: 1; e?: number[]; s?: string; p?: number; u?: string; ref?: string; sh?: 1 }
interface Objects { b: Array<[P2[], number, number, number | null]>; t: Array<[number, number, number, number, number?]> }

const FILL: Record<string, string> = {
  residential: "#dcd5c6", commercial: "#dfdbd2", industrial: "#cfcbc2", railyard: "#cfcbc2", campus: "#e1dacb",
  farm: "#c9cd8c", dirt: "#d2b98f", cemetery: "#b2c798",
  park: "#9dcb6c", wood: "#73a851", scrub: "#adbb7b", sand: "#eedbab", pitch: "#6db35a", track: "#c97a5c",
  playground: "#dccba1", parking: "#bebcb7", paving: "#e6e0d4", water: "#3f95c2", pool: "#5ccbe6",
  vineyard: "#bfc27a", allotments: "#a9c676", orchard: "#b4cc7e", meadow: "#b6cf7e",
  flowerbed: "#86b45a", gravel: "#ddd0b4", lawn: "#a5c972", sandpit: "#efdfb0", wastewater: "#7d9286", drybasin: "#93b968",
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
const AREA_ORDER = ["residential", "commercial", "industrial", "railyard", "campus", "lawn", "farm", "meadow", "orchard", "vineyard", "allotments",
  "dirt", "cemetery", "scrub", "wood", "park", "flowerbed", "fairway", "green", "bunker", "airgrass", "tarmac", "sand", "parking", "paving", "gravel", "pitch", "track", "playground", "sandpit", "playpad", "drybasin", "water", "wastewater", "pool"];
/** rubber safety surface under playground equipment: red-brown, green, blue (v) */
const PADS = ["#b8604c", "#5f9c4c", "#557fb5"];
const BASE = "#d9d3c4";
const SEA = "#2c80b2", SHALLOW = "#4ea6cb";
const ASPHALT: Record<string, string> = { highway: "#6c7077", street: "#7b7e85", lane: "#8b8d91", dirtroad: "#c3ab82" };
const PATHS: Record<string, string> = { path: "#ebe5d6", cycle: "#c98e6c", plaza: "#e6e0d4" };
const SIDEWALK = "#e4ded2", KERB = "#c9c4b9";
/** OSM surfaces (preset streetDetail): of roads, and of paths and pavements */
const ROAD_SURFACE: Record<string, string> = { paving: "#a9a49b", sett: "#988e83", gravel: "#cdbd98", dirt: "#c3ab82", grass: "#a6c27a", concrete: "#a9a9a6" };
const PATH_SURFACE: Record<string, string> = { paving: "#e3dccf", sett: "#d0c7b9", gravel: "#ddd0b4", dirt: "#d6c4a0", grass: "#b9d58c", concrete: "#dddcd7" };
const SHADOW_DIR: P2 = [0.84, 0.54]; // away from the renderer's sun (-0.55, -0.35, 0.76)
/** styled regions (final look, no paint step): gardens and parks green like the painted house style, so grey
 *  streets and light paths stand out (measured from the AI paint over the same render) */
const STYLED_FILL: Record<string, string> = { residential: "#a2bf62", campus: "#acc574", park: "#8fc350" };
const STYLED_BASE = "#a8c06c";
/** styled streets (learned from AI repaints of the render): darker asphalt and lighter pavements for contrast,
 *  an ink line along every kerb, bold markings, and the raised pavement casting a small shadow onto the road */
// one asphalt tone for all paved classes: service lanes merging into streets otherwise read as a patchwork
const STYLED_ASPHALT: Record<string, string> = { highway: "#5f636a", street: "#5f636a", lane: "#5f636a" };
const STYLED_SIDEWALK = "#ede7d9", INK = "#3f4045";
const KERB_SHADOW = { d: 0.6, blur: 0.3, color: "rgba(20,22,30,0.4)" }; // m, m
/** inside-corner radius (m) where ways meet, styled regions */
const FILLET = { path: 1, street: 3, asphalt: 2 };
/** water bodies smaller than this (m²) get a light shore path; rivers and big lakes keep their banks */
const POND = 60000;

/**
 * SVG filter that turns a shape drawn grown by r into the shape with its inside corners rounded: blur by
 * σ = 0.7 r, then cut alpha where a straight edge lies r inside (Φ(1/0.7)), ramped over one pixel.
 * Roughly a morphological closing; done by the GPU, no pixel loop.
 */
function filletFilter(rPx: number) {
  const id = `fillet-${rPx.toFixed(2)}`;
  if (!document.getElementById(id)) {
    const sigma = 0.7 * rPx, t = 0.9234, slope = sigma / 0.1438;
    document.body.insertAdjacentHTML("beforeend", `<svg width="0" height="0" style="position:absolute"><filter id="${id}" filterUnits="userSpaceOnUse" x="-1e5" y="-1e5" width="2e5" height="2e5" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${sigma}"/><feComponentTransfer><feFuncA type="linear" slope="${slope}" intercept="${0.5 - slope * t}"/></feComponentTransfer></filter></svg>`);
  }
  return `url(#${id})`;
}

let waterTile: HTMLCanvasElement | null = null;
/**
 * Ripples and glints on water (preset waterDetail), 256 px square (≈ 38 m at 0.15 m): short light and dark
 * wavelets ~1–3 m long and a few sun glints, drawn wrapped round so the tile repeats without a seam.
 */
function waterTexture(): HTMLCanvasElement {
  if (waterTile) return waterTile;
  const N = 256, c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  g.lineCap = "round";
  for (let i = 0; i < 90; i++) {
    const x = rnd() * N, y = rnd() * N, L = 6 + rnd() * 12, light = rnd() < 0.7;
    g.strokeStyle = light ? "rgba(235,248,255,0.16)" : "rgba(20,60,95,0.12)"; g.lineWidth = 1.2;
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
      g.beginPath(); g.moveTo(x + dx, y + dy); g.quadraticCurveTo(x + dx + L / 2, y + dy - 1.5, x + dx + L, y + dy); g.stroke();
    }
  }
  g.fillStyle = "rgba(255,255,240,0.55)";
  for (let i = 0; i < 18; i++) {
    const x = rnd() * N, y = rnd() * N;
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) g.fillRect(x + dx, y + dy, 1.5, 1.5);
  }
  return (waterTile = c);
}

/** Grass kinds that get the grass texture (preset `lawns`). */
const GRASSY = new Set(["lawn", "park", "meadow", "scrub", "orchard", "cemetery", "allotments", "airgrass", "drybasin"]);
let grassTile: HTMLCanvasElement | null = null;
/**
 * The grass texture, 384 px square (≈ 58 m at the ground's 0.15 m): soft lighter and darker patches about 10 m
 * and 3.5 m across (value noise that wraps round, so the tile repeats without a seam) and a fine grain of tufts.
 */
function grassTexture(): HTMLCanvasElement {
  if (grassTile) return grassTile;
  const N = 384, c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!, img = g.createImageData(N, N);
  const hash = (i: number, j: number, s: number) => { const h = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); };
  const ease = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, cells: number, seed: number) => {
    const fx = (x / N) * cells, fy = (y / N) * cells, i = Math.floor(fx), j = Math.floor(fy), u = ease(fx - i), v = ease(fy - j);
    const h = (a: number, b: number) => hash(a % cells, b % cells, seed);
    return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const n = 0.6 * noise(x, y, 6, 1) + 0.4 * noise(x, y, 16, 2) - 0.5, tuft = hash(x, y, 3), q = (y * N + x) * 4;
    const light = n > 0, a = Math.min(0.3, Math.abs(n) * 0.32 + (tuft > 0.9 ? 0.07 : 0));
    img.data[q] = light ? 250 : 45; img.data[q + 1] = light ? 246 : 92; img.data[q + 2] = light ? 205 : 30;
    img.data[q + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return (grassTile = c);
}

export function drawGround(
  ctx: CanvasRenderingContext2D, features: Feature[], [x0, y0, x1, y1]: number[], mpt: number,
  objects: Objects, ground: (x: number, y: number) => number, shadowDir: P2 = SHADOW_DIR, grass = false,
  detailBridges = false, // preset bridgeDetail: on the deck canvas, a concrete cornice band instead of painted parapets
  water = false, // preset waterDetail: depth, banks, ripples; watercourses
  styled = false, // preset repaintGround: the ground as the AI repaints draw it (greens, ink kerbs, runways, gravel beds…)
) {
  const CORNICE = "#cbc6bd";
  const SHADOW_DIR = shadowDir;
  const FILL_ = styled ? { ...FILL, ...STYLED_FILL } : FILL;
  const ASPHALT_ = styled ? { ...ASPHALT, ...STYLED_ASPHALT } : ASPHALT;
  const SIDEWALK_ = styled ? STYLED_SIDEWALK : SIDEWALK, KERB_ = styled ? INK : KERB;
  const MARK = styled ? { line: 0.3, lane: 0.25, dash: [4, 4] } : { line: 0.15, lane: 0.12, dash: [3, 6] };
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = styled ? STYLED_BASE : BASE;
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(1 / mpt, 0, 0, -1 / mpt, -x0 / mpt, y1 / mpt); // ENU meters -> canvas px (north up)
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // dc: where the helpers draw (ctx, or the fillet mask while one is being built)
  let dc = ctx;
  const path = (rings: P2[][]) => {
    dc.beginPath();
    for (const r of rings) { r.forEach(([x, y], i) => (i ? dc.lineTo(x, y) : dc.moveTo(x, y))); dc.closePath(); }
  };
  const line = (l: P2[]) => { dc.beginPath(); l.forEach(([x, y], i) => (i ? dc.lineTo(x, y) : dc.moveTo(x, y))); };
  const stroke = (l: P2[], w: number, c: string, dash?: number[]) => {
    line(l); dc.lineWidth = w; dc.strokeStyle = c; dc.setLineDash(dash ?? []); dc.stroke();
  };
  /** draw(grow) strokes shapes grown by `grow` m; styled: drawn grown by r and closed (inside corners rounded) */
  const canvases: Record<string, HTMLCanvasElement> = {};
  const scratch = (name: string) => {
    const c = (canvases[name] ??= document.createElement("canvas"));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = "source-over"; g.filter = "none"; g.clearRect(0, 0, W, H);
    return g;
  };
  /** the filleted shape as a pixel canvas (overwritten by the next call) */
  const shapeOf = (r: number, draw: (grow: number) => void) => {
    const m = scratch("mask");
    m.setTransform(ctx.getTransform()); m.lineJoin = "round"; m.lineCap = ctx.lineCap;
    dc = m; draw(r); dc = ctx;
    const out = scratch("shape"); out.filter = filletFilter(r / mpt); out.drawImage(canvases.mask, 0, 0); out.filter = "none";
    return canvases.shape;
  };
  const fillet = (r: number, draw: (grow: number) => void) => {
    if (!styled) { draw(0); return; }
    const s = shapeOf(r, draw);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(s, 0, 0); ctx.restore();
  };
  const of = (k: string) => features.filter((f) => f.k === k);
  const inView = (p: number[]) => p[0] > x0 - 50 && p[0] < x1 + 50 && p[1] > y0 - 50 && p[1] < y1 + 50;
  const junctions = (of("junctions")[0]?.j ?? []).filter(inView);
  const zebras = (of("zebras")[0]?.j ?? []).filter(inView);

  // 1. areas
  let yardGravel: CanvasPattern | undefined;
  const ringArea = (r: P2[]) => Math.abs(r.reduce((a, [x, y], i) => { const [u, v] = r[(i + 1) % r.length]; return a + x * v - u * y; }, 0)) / 2;
  const areas: Feature[] = [];
  for (const k of AREA_ORDER) {
    if (!NESTED.has(k)) areas.push(...of(k));
    else if (k === "park") areas.push(...features.filter((f) => NESTED.has(f.k)).sort((a, b) => ringArea(b.r![0]) - ringArea(a.r![0])));
  }
  // watercourses (preset waterDetail): a muddy bank, then the water; drawn just before the lakes and ponds, so a
  // stream running through one is hidden by it, and under paths and roads (bridges, culverts)
  let streams = !water;
  const drawStreams = () => {
    for (const f of of("stream")) stroke(f.l!, f.w! + 1.2, "rgba(95,115,80,0.7)");
    for (const f of of("stream")) stroke(f.l!, f.w!, "#4c97c3");
    streams = true;
  };
  for (const f of areas) {
    const k = f.k;
    if (!streams && (k === "water" || k === "wastewater" || k === "pool")) drawStreams();
    path(f.r!); ctx.fillStyle = k === "playpad" ? PADS[f.v ?? 0] : water && k === "water" ? "#3786b5" : (k === "farm" || k === "meadow") && f.v !== undefined ? FIELD[f.v] ?? FILL_[k] : FILL_[k];
    if (k === "railyard" && styled) ctx.fillStyle = yardGravel ??= gravelPattern(mpt, "#c2bcb0", "#aaa499", "#d4cfc4"); // lighter than the beds
    ctx.fill("evenodd");
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
    if (grass && GRASSY.has(k)) { // grass texture, fixed to the map (no seams between tiles), over this tile only
      ctx.save(); ctx.clip("evenodd");
      const pattern = ctx.createPattern(grassTexture(), "repeat")!;
      pattern.setTransform(new DOMMatrix().scale(mpt));
      const [bx0, by0, bx1, by1] = bounds(f.r!), ax = Math.max(bx0, x0), ay = Math.max(by0, y0);
      ctx.fillStyle = pattern;
      ctx.fillRect(ax, ay, Math.min(bx1, x1) - ax, Math.min(by1, y1) - ay);
      ctx.restore();
    }
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
    if ((k === "water" || k === "wastewater") && water) {
      // depth: lighter shallows along the shore fading inwards (the outline's strokes, their inner halves inside),
      // a muddy edge, then ripples and glints fixed to the map
      ctx.save(); ctx.clip("evenodd");
      const shallow = k === "water" ? [[14, "rgba(110,180,205,0.18)"], [8, "rgba(120,188,210,0.22)"], [4, "rgba(135,198,215,0.3)"]] : [[6, "rgba(150,160,140,0.25)"]];
      for (const [w, c] of [...shallow, [1.6, "rgba(90,112,88,0.45)"]] as Array<[number, string]>) { ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke(); }
      const pattern = ctx.createPattern(waterTexture(), "repeat")!;
      pattern.setTransform(new DOMMatrix().scale(mpt));
      const [bx0, by0, bx1, by1] = bounds(f.r!), ax = Math.max(bx0, x0), ay = Math.max(by0, y0);
      ctx.fillStyle = pattern; ctx.fillRect(ax, ay, Math.min(bx1, x1) - ax, Math.min(by1, y1) - ay);
      ctx.restore();
      path(f.r!); ctx.lineWidth = 0.8; ctx.strokeStyle = "rgba(95,115,80,0.55)"; ctx.stroke(); // the bank, just outside
    } else if (k === "water" && styled) {
      // ponds: a light shore path (stroke over the edge, the water refilled over its inner half)
      if (ringArea(f.r![0]) < POND) { ctx.lineWidth = 5; ctx.strokeStyle = PATHS.path; ctx.stroke(); path(f.r!); ctx.fillStyle = FILL.water; ctx.fill("evenodd"); }
      // inner shadow under the sunward bank, then a thin darker rim
      ctx.save(); ctx.clip("evenodd");
      ctx.filter = `blur(${1.4 / mpt}px)`;
      ctx.translate(SHADOW_DIR[0] * 0.5, SHADOW_DIR[1] * 0.5);
      path(f.r!); ctx.lineWidth = 3; ctx.strokeStyle = "rgba(12,48,78,0.25)"; ctx.stroke();
      ctx.restore();
      path(f.r!); ctx.lineWidth = 0.5; ctx.strokeStyle = "rgba(20,70,100,0.6)"; ctx.stroke();
    } else if (k === "water") { ctx.lineWidth = 1; ctx.strokeStyle = "rgba(220,235,240,0.5)"; ctx.stroke(); }
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

  /** styled paved runway (ICAO-like, simplified): edge lines, threshold piano keys, designators, aiming points,
   *  centre line, edge lights and green threshold lights. Runways are straight: first to last point. */
  const runway = (f: Feature) => {
    const w = f.w!, A = f.l![0], B = f.l!.at(-1)!, L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (L < 100) { stroke(f.l!, w, ASPHALT_.street); return; }
    const ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L, nx = -uy, ny = ux;
    const at = (s: number, o = 0): P2 => [A[0] + ux * s + nx * o, A[1] + uy * s + ny * o];
    const WHITE = "rgba(255,255,255,0.92)";
    const bar = (s0: number, s1: number, o: number, bw: number) => stroke([at(s0, o), at(s1, o)], bw, WHITE);
    stroke([A, B], w, "#5c5f66");
    for (const sd of [-1, 1]) bar(0, L, sd * (w / 2 - 0.9), 0.6);           // edge lines
    // designators: OSM ref "10/28" (first number for A→B if it matches the heading), else magnetic heading
    const bearing = ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360, MAG = 4; // declination ~4° E (Stuttgart)
    const num = (deg: number) => String(Math.round((((deg - MAG) % 360) + 360) % 360 / 10) || 36).padStart(2, "0");
    const refs = (f.ref ?? "").split("/").map((r) => r.trim().replace(/[LRC]$/, "")).filter((r) => /^\d{1,2}$/.test(r));
    const diff = (r: string, deg: number) => Math.abs(((Number(r) * 10 - deg + 540) % 360) - 180);
    const ids = refs.length === 2
      ? (diff(refs[0], bearing) <= diff(refs[1], bearing) ? [refs[0], refs[1]] : [refs[1], refs[0]])
      : [num(bearing), num(bearing + 180)];
    const T = ctx.getTransform();
    for (const [e, dir] of [[0, 1], [L, -1]] as const) {
      const s = (x: number) => e + dir * x;
      const keys = Math.max(4, Math.floor((w - 4) / 3.6)), sp = (w - 4) / keys;
      for (let k = 0; k < keys; k++) bar(s(6), s(36), -w / 2 + 2 + (k + 0.5) * sp, sp * 0.5); // piano keys
      if (L >= 600) for (const sd of [-1, 1]) bar(s(150), s(195), sd * w * 0.28, Math.max(2, w * 0.18)); // aiming points
      // designator, 9 m tall, read by a pilot landing from this end (glyph "up" = direction of travel)
      const id = ids[e === 0 ? 0 : 1].padStart(2, "0"), [cx, cy] = at(s(46)), p = T.transformPoint({ x: cx, y: cy });
      ctx.save(); ctx.setTransform(1, 0, 0, 1, p.x, p.y); ctx.rotate(Math.atan2(dir * ux, dir * uy)); ctx.scale(0.75, 1);
      ctx.fillStyle = WHITE; ctx.font = `bold ${9 / mpt}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(id, 0, 0); ctx.restore();
    }
    stroke([at(60), at(L - 60)], 0.9, WHITE, [20, 15]);                    // centre line
    ctx.setLineDash([]);
    const dot = ([x, y]: P2, r: number, c: string) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); };
    for (let s = 0; s <= L + 0.1; s += Math.min(50, L / Math.ceil(L / 50))) for (const sd of [-1, 1]) {
      dot(at(s, sd * (w / 2 + 0.8)), 0.55, "rgba(40,40,40,0.5)"); dot(at(s, sd * (w / 2 + 0.8)), 0.38, "#fff4c2"); // edge lights
    }
    for (const e of [-1.2, L + 1.2]) for (let o = -w / 2; o <= w / 2 + 0.01; o += w / Math.round(w / 3)) {
      dot(at(e, o), 0.55, "rgba(20,60,30,0.5)"); dot(at(e, o), 0.4, "#45d36f");   // threshold lights
    }
  };

  // 2b. airfields: runway and taxiway centre lines at their width (paved: markings; grass: a mown strip)
  ctx.lineCap = "butt";
  for (const f of of("grassway")) {
    if (!styled) { stroke(f.l!, f.w!, "#b3d684"); stroke(f.l!, f.w! - 2, "#a8cf78"); continue; }
    // mown grass runway: the field's own green a touch lighter, lengthwise mowing stripes, white edge markers
    // every 50 m and a threshold bar at each end (a flat pale band read as a glitch)
    const w = f.w!, n = 6;
    stroke(f.l!, w, "rgba(255,255,240,0.10)");
    for (let i = 0; i < n; i += 2) stroke(offset(f.l!, -w / 2 + (i + 0.5) * (w / n)), w / n, "rgba(255,255,240,0.07)");
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    const l = f.l!;
    let run = 0, next = 0;
    for (let i = 1; i < l.length; i++) {
      const [ax, ay] = l[i - 1], [bx, by] = l[i], len = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / len, uy = (by - ay) / len;
      for (; next <= run + len; next += 50) {
        const t = next - run, cx = ax + ux * t, cy = ay + uy * t;
        for (const sd of [-1, 1]) { // a 3 × 1 m marker on each edge, along the runway
          const ex = cx - uy * sd * (w / 2 - 0.5), ey = cy + ux * sd * (w / 2 - 0.5);
          ctx.beginPath(); ctx.moveTo(ex - ux * 1.5 - uy * 0.5, ey - uy * 1.5 + ux * 0.5); ctx.lineTo(ex + ux * 1.5 - uy * 0.5, ey + uy * 1.5 + ux * 0.5);
          ctx.lineTo(ex + ux * 1.5 + uy * 0.5, ey + uy * 1.5 - ux * 0.5); ctx.lineTo(ex - ux * 1.5 + uy * 0.5, ey - uy * 1.5 - ux * 0.5); ctx.fill();
        }
      }
      run += len;
    }
    for (const [p, q] of [[l[0], l[1]], [l[l.length - 1], l[l.length - 2]]]) { // threshold: a bar across, 1.5 m in
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]), ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
      const cx = p[0] + ux * 1.5, cy = p[1] + uy * 1.5;
      stroke([[cx + uy * (w / 2 - 0.5), cy - ux * (w / 2 - 0.5)], [cx - uy * (w / 2 - 0.5), cy + ux * (w / 2 - 0.5)]], 1, "rgba(255,255,255,0.9)");
    }
  }
  for (const f of of("taxiway")) { stroke(f.l!, f.w!, FILL.tarmac); stroke(f.l!, 0.3, "#e8c547"); }
  for (const f of of("runway")) if (styled) runway(f);
  for (const f of of("runway")) {
    if (styled) continue;
    stroke(f.l!, f.w!, "#7f8288");
    for (const s of [-1, 1]) stroke(offset(f.l!, s * (f.w! / 2 - 1)), 0.5, "rgba(255,255,255,0.9)");
    stroke(f.l!, 0.9, "rgba(255,255,255,0.9)", [20, 15]);
  }
  ctx.lineCap = "round";
  // 2c. tracks mapped as lines with a width (a racecourse's training track): a band in their surface's colour
  for (const f of of("trackline")) stroke(f.l!, f.w!, FILL[f.s ?? "track"] ?? FILL.track);

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

  if (!streams) drawStreams(); // no lake in this tile
  // parking stall lines (preset parkedCars)
  for (const f of of("stalls")) { path(f.r!); ctx.lineWidth = 0.12; ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.setLineDash([]); ctx.stroke(); }
  // 4. paths and plazas, then pavements under streets
  if (detailBridges) for (const f of [...of("path"), ...of("cycle"), ...of("sidewalk")]) stroke(f.l!, f.w! + 2.2, CORNICE);
  // styled (preset repaintGround): inside corners where paths meet rounded
  for (const k of ["path", "plaza", "cycle"]) fillet(FILLET.path, (g) => {
    for (const f of of(k)) stroke(f.l!, f.w! + 2 * g, (f.u && PATH_SURFACE[f.u]) || (detailBridges && f.k !== "plaza" ? "#b8b7b3" : PATHS[f.k]));
  });
  // pavements OSM maps as their own ways: a kerbed strip
  for (const f of of("sidewalk")) stroke(f.l!, f.w! + 0.3, KERB);
  for (const f of of("sidewalk")) stroke(f.l!, f.w!, (f.u && PATH_SURFACE[f.u]) || SIDEWALK);
  for (const f of of("pier")) stroke(f.l!, f.w!, "#d8d2c4");
  // Roads have butt ends: a round cap on a bridge end or a wide road's end bulges over whatever it
  // meets. Joins between ways are filled by junction disks instead, drawn in the junction's layer.
  ctx.lineCap = "butt";
  const roads = features.filter((f) => ASPHALT_[f.k]).sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || order(a) - order(b));
  const rails = of("rail");
  const layers = [...new Set([...roads, ...rails].map((f) => f.y ?? 0))].sort((a, b) => a - b);
  const disks = (js: number[][], grow: number, c?: string) => {
    for (const [x, y, r, , k] of js) {
      dc.beginPath(); dc.arc(x, y, r - 3 + grow, 0, Math.PI * 2);
      dc.fillStyle = c ?? ASPHALT_[CLASS[k] ?? "street"]; dc.fill();
    }
  };
  for (const layer of layers) {
    const rs = roads.filter((f) => (f.y ?? 0) === layer);
    const js = junctions.filter((j) => (j[3] ?? 0) === layer);
    if (layer > 0 && detailBridges) for (const f of rs) stroke(f.l!, f.w! + 2.2, CORNICE); // the deck's own parapets stand on it
    else if (layer > 0) {
      // a bridge must read as passing OVER what's below: cast shadow, dark outline, concrete parapets
      for (const f of rs) stroke(f.l!.map(([x, y]) => [x + SHADOW_DIR[0] * 4, y + SHADOW_DIR[1] * 4] as P2), f.w! + 3, "rgba(40,40,48,0.35)");
      for (const f of rs) stroke(f.l!, f.w! + 3, "#55565c");
      for (const f of rs) stroke(f.l!, f.w! + 2.4, "#e2ddd2");
    }
    const streets = rs.filter((f) => f.k === "street");
    const streetJs = layer === 0 ? js.filter((j) => CLASS[j[4]] === "street" && j[5] !== 0) : []; // pavements round street corners
    let shadow: HTMLCanvasElement | null = null;
    let roadShape: HTMLCanvasElement | null = null; // this layer's asphalt as pixels (styled, ground level)
    if (!styled) {
      // pavements: both sides, or the sides OSM puts them on (p: bit 1 left, 2 right; 0 none)
      const sides = (f: Feature, w: number, c: string) => {
        if (f.p === undefined) stroke(f.l!, f.w! + 2 * w, c);
        else for (const [bit, side] of [[1, 1], [2, -1]]) if (f.p & bit) stroke(offset(f.l!, side * (f.w! / 2 + w / 2)), w, c);
      };
      for (const f of streets) sides(f, 3, KERB);
      disks(streetJs, 3, KERB);
      for (const f of streets) sides(f, 2.7, SIDEWALK);
      disks(streetJs, 2.7, SIDEWALK);
      for (const f of rs) stroke(f.l!, f.w!, (f.u && ROAD_SURFACE[f.u]) || ASPHALT[f.k]);
      disks(js, 0);
    } else {
          const r = layer === 0 ? FILLET.street : 0, ra = layer === 0 ? FILLET.asphalt : 0;
      const filleted = (r: number, draw: (g: number) => void) => (r ? fillet(r, draw) : draw(0));
      const kerb = styled ? 5.8 : 6; // styled: a thin ink line round the pavement
      filleted(r, (g) => { for (const f of streets) stroke(f.l!, f.w! + kerb + 2 * g, KERB_); disks(streetJs, kerb / 2 + g, KERB_); });
      filleted(r, (g) => { for (const f of streets) stroke(f.l!, f.w! + 5.4 + 2 * g, SIDEWALK_); disks(streetJs, 2.7 + g, SIDEWALK_); });
      if (styled && ra) {
        // styled, ground level: all asphalt in ONE filleted pass (per-class passes leave slivers between classes),
        // then everything derived from that exact shape
        const shape = shapeOf(ra, (g) => {
          for (const k of CLASS) { for (const f of rs) if (f.k === k) stroke(f.l!, f.w! + 2 * g, ASPHALT_[k]); disks(js.filter((j) => (CLASS[j[4]] ?? "street") === k), g); }
        });
        const asphalt = scratch("asphalt"); asphalt.drawImage(shape, 0, 0);
        // ink kerb line: the asphalt shape grown by 1 px (8 shifted copies), inked, under the asphalt
        const ink = scratch("ink");
        for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) ink.drawImage(canvases.asphalt, dx, dy);
        ink.globalCompositeOperation = "source-in"; ink.fillStyle = INK; ink.fillRect(0, 0, W, H);
        // kerb shadow: what lies outside the road, shifted down-sun and blurred, kept on the road
        const sh = scratch("shadow");
        sh.fillStyle = KERB_SHADOW.color; sh.fillRect(0, 0, W, H);
        sh.globalCompositeOperation = "destination-out"; sh.filter = `blur(${KERB_SHADOW.blur / mpt}px)`;
        sh.drawImage(canvases.asphalt, (SHADOW_DIR[0] * KERB_SHADOW.d) / mpt, (-SHADOW_DIR[1] * KERB_SHADOW.d) / mpt);
        sh.filter = "none"; sh.globalCompositeOperation = "destination-in"; sh.drawImage(canvases.asphalt, 0, 0);
        shadow = canvases.shadow;
        roadShape = canvases.asphalt;
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(canvases.ink, 0, 0); ctx.drawImage(canvases.asphalt, 0, 0); ctx.restore();
      } else if (ra) for (const k of CLASS) filleted(ra, (g) => {
        for (const f of rs) if (f.k === k) stroke(f.l!, f.w! + 2 * g, ASPHALT_[k]);
        disks(js.filter((j) => (CLASS[j[4]] ?? "street") === k), g);
      });
      else { for (const f of rs) stroke(f.l!, f.w!, ASPHALT_[f.k]); disks(js, 0); }
      if (shadow) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(shadow, 0, 0); ctx.restore(); }
    }
    // 5. markings, kept out of junctions (lines of crossing roads would scribble over each other)
    // styled: drawn on a scratch canvas with the junctions (+4 m) cut out; an even-odd clip would let marks
    // through where junction circles overlap
    let marks: CanvasRenderingContext2D | null = null;
    if (styled) { marks = scratch("marks"); marks.setTransform(ctx.getTransform()); marks.lineCap = ctx.lineCap; dc = marks; }
    else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 - 1e4, y1 - 1e5, 2e5, 2e5);
      for (const [x, y, r] of junctions) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
      ctx.clip("evenodd");
    }
    for (const f of rs) {
      if ((f.k !== "street" && f.k !== "highway") || f.u) continue; // no lines on setts, gravel…
      // styled: no markings on short pieces (turn links and stubs inside big junctions scribble at bold widths)
      if (styled && f.l!.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - f.l![i - 1][0], p[1] - f.l![i - 1][1]) : 0), 0) < 25) continue;
      const w = f.w!;
      if (f.k === "highway") { for (const s of [-1, 1]) stroke(offset(f.l!, s * (w / 2 - 0.5)), MARK.line, "rgba(255,255,255,0.9)"); }
      const lanes = f.n ?? Math.max(1, Math.round(w / 3.3));
      if (!f.o && w >= 7) stroke(f.l!, MARK.line, "rgba(255,255,255,0.9)", lanes >= 4 ? undefined : styled ? MARK.dash : [3, 5]);
      const per = f.o ? lanes : Math.floor(lanes / 2);
      for (let k = 1; k < per; k++) {
        const d = -w / 2 + (k * w) / lanes;
        if (f.o) stroke(offset(f.l!, d), MARK.lane, "rgba(255,255,255,0.85)", MARK.dash);
        else for (const s of [-1, 1]) stroke(offset(f.l!, (s * k * w) / lanes), MARK.lane, "rgba(255,255,255,0.85)", MARK.dash);
      }
    }
    if (marks) {
      dc = ctx; marks.setLineDash([]);
      marks.globalCompositeOperation = "destination-out"; marks.beginPath();
      for (const [x, y, r] of junctions) { marks.moveTo(x + r + 4, y); marks.arc(x, y, r + 4, 0, Math.PI * 2); }
      marks.fill("nonzero");
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(canvases.marks, 0, 0); ctx.restore();
    } else ctx.restore();
    // 6. rail of this layer: ballast, sleepers, two rails (a road bridge above covers it)
    ctx.lineCap = "round";
    const rl = rails.filter((f) => (f.y ?? 0) === layer);
    if (styled) {
      // styled (learned from AI repaints): each pass over all tracks of the layer, so parallel tracks share one
      // gravel bed with a dark edge only outside, and crossings stay clean; few, bold sleepers; rails as a dark
      // line under a white top, which reads zoomed in and out
      // where track crosses or runs in a road, only the rails show on the asphalt: bed and sleepers go on a
      // scratch canvas with the road shape cut out
      const bed = roadShape && rl.length ? scratch("railbed") : null;
      if (bed) { bed.setTransform(ctx.getTransform()); bed.lineCap = "round"; dc = bed; }
      if (layer > 0) for (const f of rl) { stroke(f.l!, 6, "#55565c"); stroke(f.l!, 5.4, "#cfcac0"); }
      for (const f of rl) stroke(f.l!, 5.3, "#706c65");
      const gravel = gravelPattern(mpt);
      for (const f of rl) { line(f.l!); dc.lineWidth = 4.7; dc.strokeStyle = gravel; dc.setLineDash([]); dc.stroke(); }
      dc.lineCap = "butt";
      for (const f of rl) stroke(f.l!, 3.1, "#57504a", [0.45, 0.75]);
      dc.setLineDash([]);
      if (bed && roadShape) {
        bed.setTransform(1, 0, 0, 1, 0, 0); bed.globalCompositeOperation = "destination-out"; bed.drawImage(roadShape, 0, 0);
        dc = ctx; ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(canvases.railbed, 0, 0); ctx.restore();
      }
      ctx.lineCap = "butt";
      // rails at 0.25 m/px: a ~2 px bright top on a dark body showing ~1 px each side (like the ink round houses)
      for (const f of rl) for (const s of [-0.85, 0.85]) stroke(offset(f.l!, s), 0.95, "#26272b");
      for (const f of rl) for (const s of [-0.85, 0.85]) stroke(offset(f.l!, s), 0.45, "#ffffff");
      ctx.lineCap = "round";
    } else for (const f of rl) {
      if (layer > 0 && detailBridges) stroke(f.l!, 5, CORNICE);
      else if (layer > 0) { stroke(f.l!, 5, "#55565c"); stroke(f.l!, 4.4, "#cfcac0"); } // deck edge and parapets, like road bridges
      stroke(f.l!, 3.4, "#a9a49a");
      stroke(f.l!, 2.6, "#7d6a58", [0.25, 0.4]);
      ctx.setLineDash([]);
      for (const s of [-0.72, 0.72]) stroke(offset(f.l!, s), 0.12, "#4b4d52");
    }
    ctx.setLineDash([]);
    // 6b. platforms beside open-air track (ground.ts): light concrete, a white safety line 0.6 m in, dark edge
    if (layer === 0 && styled) for (const f of of("platform")) {
      const PLAT = "#dcd6ca", LINE = "#fbf9f3", EDGE = styled ? INK : "#7d7a74";
      if (f.r) {
        const path = () => { ctx.beginPath(); for (const q of f.r!) q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
        path(); ctx.fillStyle = PLAT; ctx.fill();
        ctx.save(); path(); ctx.clip(); ctx.lineJoin = "round";
        path(); ctx.lineWidth = 1.5; ctx.strokeStyle = LINE; ctx.stroke();
        path(); ctx.lineWidth = 1.1; ctx.strokeStyle = PLAT; ctx.stroke();
        ctx.restore();
        path(); ctx.lineWidth = 0.22; ctx.strokeStyle = EDGE; ctx.stroke();
      } else {
        const w = f.w!;
        stroke(f.l!, w + 0.22, EDGE); stroke(f.l!, w, PLAT);
        for (const sd of [-1, 1]) stroke(offset(f.l!, sd * (w / 2 - 0.65)), 0.2, LINE);
      }
    }
    ctx.lineCap = "butt";
  }
  ctx.setLineDash([]);
  // zebra crossings: bars parallel to the street, across its full width
  ctx.fillStyle = styled ? "#f4f2ec" : "rgba(255,255,255,0.92)";
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

/** styled track bed: grey gravel, a deterministic light/dark speckle of 2 canvas px, anchored to the ENU
 *  origin so it continues across tiles */
function gravelPattern(mpt: number, base = "#a29d94", dark = "#87827a", light = "#bdb8ae"): CanvasPattern {
  const N = 64, c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!;
  g.fillStyle = base; g.fillRect(0, 0, N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const h = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
    if (h < 0.16) { g.fillStyle = dark; g.fillRect(x, y, 1, 1); } else if (h > 0.86) { g.fillStyle = light; g.fillRect(x, y, 1, 1); }
  }
  const p = g.createPattern(c, "repeat")!;
  p.setTransform(new DOMMatrix([2 * mpt, 0, 0, 2 * mpt, 0, 0]));
  return p;
}

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
