/**
 * Repaint the open-data 3D render into crisp, realistic isometric art with the local Codex CLI
 * (ChatGPT login, built-in image generation; no API key).
 *
 * Painting happens in overlapping 1024px windows on a global grid (stride 896). Each window gets
 * its already-painted neighbours (any side) pasted into the 128 px overlap, then windows are feather-blended
 * into 1024px art tiles aligned with the render tiles.
 *
 *   npm run paint -- tlv-core --plan
 *   npm run paint -- tlv-core --window 4,-3
 *   npm run paint -- tlv-core --near 32.064,34.775 --radius 2   # a patch of windows
 *   npm run paint -- tlv-core -j 3                              # everything, centre first (--center lat,lon)
 *   npm run paint -- tlv-core --parts                           # windows over the buildings scene.ts gave OSM 3D shapes
 */
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp, { type OverlayOptions } from "sharp";
import { AREAS, openArea } from "./areas.ts";
import { CAMERA, llhToPixel } from "./camera.ts";
import { DERIVED, PIPELINE, readJson, writeAtomic } from "./paths.ts";
import { seaH, readHeights } from "./heights.ts";
import { applyRegistration, register } from "./register.ts";

const WIN = 1024, OVERLAP = 128, STRIDE = WIN - OVERLAP, T = CAMERA.tile;
/** Blend band in the middle of each overlap; outside it a window's own pixels win outright. */
const FEATHER = 64;
const STYLE = join(PIPELINE, "style", "reference.png");
const TREES = join(PIPELINE, "style", "trees.png"); // species sheet (painted once with Codex)
const SEA = join(PIPELINE, "style", "sea.png");
/** Minimum edge-map correlation between render and painted window (pilot range 0.58–0.90). */
const MIN_MATCH = 0.45;
/** Below this share of strong edges in the render (sea, sand, empty lots) the match check is skipped. */
const MIN_TEXTURE = 0.05;

const PROMPT = `Use your image generation tool. Four images are attached:
1. input.png: an orthographic aerial render (camera tilted 45° down, no perspective) of a simple 3D model \
of {title}, {country}, built from map data. ~256 m across. {render}
2. height.png: the height map from the SAME camera, pixel-aligned with image 1. Black = ground \
(streets, squares, sea), grey→white = buildings and trees, brighter = taller. Use it to find exact \
building footprints, edges and heights; open black areas are streets/plazas, not trees.
3. style.png: the STYLE REFERENCE.
4. trees.png: what each tree species looks like ({treesOf} street and park trees), in the same style.

Redraw image 1 as detailed isometric pixel-art-style city illustration in EXACTLY the style of image 3: \
clean crisp 3D blocks with straight vertical walls, every facade drawn with regular window grids and \
balconies, flat roofs with rooftop details, saturated but natural colours, realistic varied trees \
drawn as the species of image 4 seen from above{treeHint}, smooth grey asphalt with lane markings, clean pavements, soft even daylight, light ambient \
occlusion, no long shadows, no haze, no photographic noise.

Geometry comes ONLY from images 1 and 2 — this is a tracing job:
- Same orthographic camera, framing and scale: the output overlays image 1 pixel-for-pixel.
- Every building keeps its exact footprint, position, height and roof outline. {materials} \
Do not add, remove, merge or move buildings or trees; do not invent trees over open streets.
- {ground} stay exactly where they are; give them real texture \
(pale grey/cream stone paving — not orange or terracotta —, crosswalks at junctions, grass, sand, water ripples, parked cars along kerbs only, \
no cars in the driving lanes).
- Layering is exactly as in image 1: where a road bridge crosses rail tracks, a river or another road, the \
bridge deck is continuous and on top, and whatever passes underneath is hidden beneath it — never draw \
rails or lane markings across a bridge deck.
- Image 3 is only for style. Do not copy its buildings, layout or architecture.
{continuation}Output: one square 1024x1024 image, no text, no labels, no border, no vignette.

When done, copy the final PNG to {out} and reply only with that path.
`;
/** What differs per region in the prompt (and the tree species sheet). */
interface Local { ground: string; country: string; render: string; treesOf: string; treeHint: string; materials: string; trees: string }
const LOCAL: Record<string, Local> = {
  "israel-center": {
    ground: "Streets, squares, parks, beach and sea",
    country: "Israel",
    render: `The layout is exact; the colours are flat \
placeholders (grey = asphalt with lane markings, pale = pavement/plaza, green = grass/park, sand = beach, \
blue = water, brown dashes = rail, terracotta = bike path) and the window patterns are schematic hints. \
Tree crowns are colour-coded by species (see image 4): dark green = ficus, light green = tipuana, \
lilac = jacaranda in bloom, red-orange = flame tree, grey-green = olive, dark teal = Aleppo pine, \
blue-green tall = eucalyptus, small crown on a thin brown trunk = date palm (shorter) or Washingtonia fan palm (taller).`,
    treesOf: "Tel Aviv",
    treeHint: " (palms as star-shaped frond crowns with a visible trunk)",
    materials: `Draw believable Tel Aviv \
materials: white/cream plaster Bauhaus blocks with rounded balconies, stone public buildings, glass towers, \
real window grids, balconies, shutters, rooftop solar heaters and AC units. Tall towers stay tall.`,
    trees: TREES,
  },
  stuttgart: {
    ground: "Streets, squares, parks, vineyards, rail yards and the river",
    country: "Germany",
    render: `The layout and every roof shape are exact (real \
pitched, hipped and flat roofs from the city's 3D building data); the colours and window patterns are stylised hints \
(grey = asphalt with lane markings, pale = pavement/plaza, green = grass/park, olive with fine stripes = vineyard, \
blue = water, brown lines = rail, terracotta = bike path). Tree crowns are colour-coded by species (see image 4): \
yellow-green = plane tree, lime or maple, dark green = horse chestnut, oak or beech, pale yellow-green small = birch, \
pink = ornamental cherry in bloom, dark blue-green narrow = spruce.`,
    treesOf: "Stuttgart",
    treeHint: " (broad rounded deciduous crowns in late-spring green, spruces as narrow dark cones)",
    materials: `Draw believable Stuttgart \
materials: yellow-beige and red sandstone (Schlossplatz palaces, churches, public buildings), pale plaster \
Gründerzeit and post-war blocks, red and brown clay-tile pitched roofs, grey slate, green copper on churches and \
palaces, glass and concrete offices, dormers, chimneys, real window grids, solar panels where the render shows them. \
Tall towers stay tall.`,
    trees: join(PIPELINE, "style", "trees-stuttgart.png"),
  },
  zagreb: {
    ground: "Streets, squares, the market, parks and tram tracks",
    country: "Croatia",
    render: `The layout and every roof shape are exact (real \
pitched, hipped and flat roofs from the city's 3D building data); the colours and window patterns are a stylised draft \
of the real ones (ochre, yellow, cream and pastel plaster, red-brown tile, green copper). Grey = asphalt, pale = \
pavement/plaza, green = grass/park, brown lines = tram tracks, the rows of red discs = the red market umbrellas of Dolac. \
Tree crowns are round deciduous crowns.`,
    treesOf: "Zagreb",
    treeHint: " (broad rounded deciduous crowns: plane trees, horse chestnuts, limes, in summer green)",
    materials: `Draw believable Zagreb \
materials: Austro-Hungarian blocks in ochre, Maria-Theresa yellow, cream, salmon and pastel plaster with cornices and \
tall windows, red and brown clay-tile roofs with dormers and chimneys, green copper on churches and public buildings. \
Keep every building's colour from image 1, and draw a church, tower or market only where image 1 shows one. Woods, \
parks, fields and water stay exactly that: never add buildings, streets or squares where image 1 shows trees, grass or \
water. Tall towers stay tall. Draw no trains, trams or buses anywhere (they are animated on top of the map): leave rail \
and tram tracks empty.`,
    trees: join(PIPELINE, "style", "trees-stuttgart.png"),
  },
};

const CONTINUATION = `- The strip(s) along the {edges} edge(s) of image 1 are ALREADY-PAINTED neighbouring artwork. \
Reproduce them unchanged and continue the same palette and detail seamlessly into the rest.
`;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: "boolean", default: false },
    window: { type: "string" },
    near: { type: "string" },
    radius: { type: "string", default: "1" },
    // repaint the windows over the buildings scene.ts swapped for OSM 3D shapes (data/derived/<area>/osm-parts.json)
    parts: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    // repaint windows painted before this time (e.g. after a style change); runs alongside a normal paint
    older: { type: "string" },
    assemble: { type: "boolean", default: false }, // only rebuild every art tile from the windows
    j: { type: "string", default: "3" },
    center: { type: "string", default: "32.0715,34.7745" }, // lat,lon painted first (Rothschild / Dizengoff / beach)
  },
});
const areaName = positionals[0] ?? "tlv-core";
const base = join(DERIVED, areaName);
const manifest = readJson(join(base, "manifest.json"));
const AREA = openArea(areaName), title = AREA.title;
const local = LOCAL[AREA.region];
if (!local) throw new Error(`paint: no prompt for region ${AREA.region} (LOCAL in paint.ts)`);
const OLDER = args.older ? new Date(args.older).getTime() : 0;
const mtime = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);
/** painted in the current style (with --older, windows painted before the cut-off don't count) */
const current = (i: number, j: number) => existsSync(winFile(i, j)) && mtime(winFile(i, j)) >= OLDER;
const tileSet = new Set<string>(manifest.tiles.map((t: any) => `${t.x}_${t.y}`));
const winDir = join(base, "windows");
mkdirSync(winDir, { recursive: true });

/** A render or height tile of this area, else of any other area of the region (all share the region's grid). */
const SIBLINGS = Object.entries(AREAS).filter(([n, a]) => a.region === AREA.region && n !== areaName).map(([n]) => join(DERIVED, n));
function regionFile(kind: "render" | "height", tx: number, ty: number) {
  const own = join(base, kind, `${tx}_${ty}.png`);
  if (existsSync(own)) return own;
  return SIBLINGS.map((d) => join(d, kind, `${tx}_${ty}.png`)).find((f) => existsSync(f)) ?? own;
}
const renderFile = (tx: number, ty: number) => regionFile("render", tx, ty);
const winFile = (i: number, j: number) => join(winDir, `${i}_${j}.png`);

/** Crop a global-pixel box out of tiles produced by `load(tx, ty)` (1024² PNG buffers or null). */
async function cropGlobal(x: number, y: number, w: number, h: number,
  load: (tx: number, ty: number) => Promise<Buffer | null> = async (tx, ty) =>
    existsSync(renderFile(tx, ty)) ? sharp(renderFile(tx, ty)).png().toBuffer() : null) {
  const comps: OverlayOptions[] = [];
  for (let ty = Math.floor(y / T); ty <= Math.floor((y + h - 1) / T); ty++)
    for (let tx = Math.floor(x / T); tx <= Math.floor((x + w - 1) / T); tx++) {
      const buf = await load(tx, ty);
      if (!buf) continue;
      const left = tx * T - x, top = ty * T - y;
      const sx = Math.max(0, -left), sy = Math.max(0, -top);
      const width = Math.min(T - sx, w - Math.max(0, left)), height = Math.min(T - sy, h - Math.max(0, top));
      comps.push({ input: await sharp(buf).extract({ left: sx, top: sy, width, height }).toBuffer(), left: Math.max(0, left), top: Math.max(0, top) });
    }
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).composite(comps);
}

/** Height pass as a grayscale structure image: black = ground, white = 60 m above `ground`. */
async function heightTile(tx: number, ty: number, ground: number): Promise<Buffer | null> {
  const f = regionFile("height", tx, ty);
  if (!existsSync(f)) return null;
  const h = await readHeights(f);
  const g = Buffer.alloc(h.length);
  for (let i = 0; i < h.length; i++) g[i] = Number.isNaN(h[i]) ? 0 : Math.max(0, Math.min(255, Math.sqrt(Math.max(0, h[i] - ground) / 60) * 255));
  return sharp(g, { raw: { width: 256, height: 256, channels: 1 } }).resize(T, T, { kernel: "cubic" }).png().toBuffer();
}

/** Local ground level of a window: low percentile of all surface heights it covers. */
async function windowGround(x: number, y: number) {
  const all: number[] = [];
  for (let ty = Math.floor(y / T); ty <= Math.floor((y + WIN - 1) / T); ty++)
    for (let tx = Math.floor(x / T); tx <= Math.floor((x + WIN - 1) / T); tx++) {
      const f = regionFile("height", tx, ty);
      if (existsSync(f)) for (const v of await readHeights(f)) if (!Number.isNaN(v) && v > seaH() - 0.5) all.push(v);
    }
  all.sort((a, b) => a - b);
  return all[Math.floor(all.length * 0.05)] ?? seaH();
}

function windows(): Array<[number, number]> {
  const out = new Set<string>();
  for (const k of tileSet) {
    const [tx, ty] = k.split("_").map(Number);
    for (let j = Math.floor((ty * T - WIN) / STRIDE) + 1; j * STRIDE < (ty + 1) * T; j++)
      for (let i = Math.floor((tx * T - WIN) / STRIDE) + 1; i * STRIDE < (tx + 1) * T; i++)
        out.add(`${i}_${j}`);
  }
  return [...out].map((s) => s.split("_").map(Number) as [number, number]);
}

async function composeInput(i: number, j: number, file: string, heightFile: string) {
  const ground = await windowGround(i * STRIDE, j * STRIDE);
  await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN, (tx, ty) => heightTile(tx, ty, ground))).png().toFile(heightFile);
  // lift baked photogrammetry shadows so footprints and streets read clearly
  const lifted = await sharp(await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN)).png().toBuffer())
    .removeAlpha().clahe({ width: 128, height: 128, maxSlope: 2 }).modulate({ saturation: 1.1 }).png().toBuffer();
  const img = sharp(lifted);
  const comps: OverlayOptions[] = [];
  const edges: string[] = [];
  // already-painted neighbours on any side: paste their overlap strip so this window continues them
  const sides: Array<[string, number, number, { left: number; top: number; width: number; height: number }, number, number]> = [
    ["left", i - 1, j, { left: STRIDE, top: 0, width: OVERLAP, height: WIN }, 0, 0],
    ["right", i + 1, j, { left: 0, top: 0, width: OVERLAP, height: WIN }, STRIDE, 0],
    ["top", i, j - 1, { left: 0, top: STRIDE, width: WIN, height: OVERLAP }, 0, 0],
    ["bottom", i, j + 1, { left: 0, top: 0, width: WIN, height: OVERLAP }, 0, STRIDE],
  ];
  for (const [side, ni, nj, box, left, top] of sides) {
    if (!current(ni, nj)) continue; // old-style neighbours are being repainted too: don't continue them
    comps.push({ input: await sharp(winFile(ni, nj)).resize(WIN, WIN).extract(box).toBuffer(), left, top });
    edges.push(side);
  }
  await sharp(await img.png().toBuffer()).composite(comps).png().toFile(file);
  return edges;
}

/** Codex/ChatGPT usage or rate limit: every worker pauses until `resumeAt`, then retries. */
let resumeAt = 0, backoff = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMIT = /usage limit|rate.?limit|too many requests|\b429\b|quota/i;

/** How long a limit message asks us to wait (ms); falls back to exponential backoff 5 → 60 min. */
function limitWait(log: string) {
  const at = log.match(/try again at ([0-9]{1,2}:[0-9]{2}\s*(?:[AP]M)?)/i);
  if (at) {
    const [, t] = at, [h, m] = t.match(/\d+/g)!.map(Number), pm = /pm/i.test(t), am = /am/i.test(t);
    const d = new Date();
    d.setHours(pm && h < 12 ? h + 12 : am && h === 12 ? 0 : h, m, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime() - Date.now() + 60_000;
  }
  const inMin = log.match(/try again in (\d+)\s*(second|minute|hour)/i);
  if (inMin) return Number(inMin[1]) * ({ second: 1e3, minute: 6e4, hour: 36e5 } as Record<string, number>)[inMin[2].toLowerCase()] + 30_000;
  backoff = Math.min(60, backoff ? backoff * 2 : 5);
  return backoff * 60_000;
}

/**
 * Painter: the Codex CLI (ChatGPT plan, the default) or an image model through fal.ai (PAINT_BACKEND=fal: pay per
 * call, many windows at once). The bake-off on Zagreb (Nov 2026) picked openai/gpt-image-2.6/sunburst/edit at "high".
 * google/nano-banana-2.1/edit changes the layout least (a retouched render more than a painting, ~$0.03): Zagreb's
 * last windows, where gpt-image kept inventing buildings on fields and woods, were filled with it.
 * Every fal call's billed cost (x-fal-billable-units, USD) goes to paint-spend.jsonl; PAINT_BUDGET_USD stops new calls.
 */
const BACKEND = process.env.PAINT_BACKEND ?? "codex";
const FAL_ENDPOINT = process.env.PAINT_FAL_ENDPOINT ?? "openai/gpt-image-2.6/sunburst/edit";
const FAL_QUALITY = process.env.PAINT_QUALITY ?? "high";
/** Google's image models on fal (Nano Banana) take an aspect ratio and a resolution, not a size and a quality */
const GOOGLE = /nano-banana|gemini/.test(FAL_ENDPOINT);
const BUDGET = Number(process.env.PAINT_BUDGET_USD) || Infinity;
const SPEND = join(base, "paint-spend.jsonl");
let spent = existsSync(SPEND) ? readFileSync(SPEND, "utf8").split("\n").filter(Boolean).reduce((a, l) => a + (JSON.parse(l).usd || 0), 0) : 0;
const overBudget = () => BACKEND === "fal" && spent >= BUDGET;

/**
 * USD per billable unit of the endpoint (fal's pricing API): gpt-image-2.6 and Nano Banana 2.1 bill in dollar units,
 * Nano Banana Pro per image ($0.15). Unknown: 1 (the units are logged too, so the ledger can be corrected).
 */
let price: Promise<number> | undefined;
function unitPrice(): Promise<number> {
  price ??= fetch(`https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(FAL_ENDPOINT)}`,
    { headers: { Authorization: `Key ${process.env.FAL_KEY}` }, signal: AbortSignal.timeout(30_000) })
    .then((r) => r.json()).then((j: any) => Number(j.prices?.[0]?.unit_price) || 1).catch(() => 1);
  return price;
}

async function falPaint(cwd: string, prompt: string, id: string): Promise<void> {
  const log = join(cwd, "codex.log");
  if (overBudget()) { writeFileSync(log, `budget of $${BUDGET} reached`); return; }
  // the API gets the images directly: drop the Codex-only instructions (use the tool, copy the file)
  let text = prompt.replace(/^Use your image generation tool\. /, "").replace(/\s*When done, copy[\s\S]*$/, "").trim();
  // Google's models keep the render's own look unless told otherwise: paint like the painted edge strips
  if (GOOGLE && text.includes("ALREADY-PAINTED")) text += "\nRepaint ALL of image 1 in the exact style of its already-painted edge strips: the same small, "
    + "finely drawn tree crowns, the same light ground showing between them, the same colours and brightness. No part of the "
    + "result may keep the flat, chunky look of the 3D render: it must be impossible to tell where the strips end.";
  const uri = (f: string) => `data:image/png;base64,${readFileSync(join(cwd, f)).toString("base64")}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(`https://fal.run/${FAL_ENDPOINT}`, {
        method: "POST", headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, image_urls: ["input.png", "height.png", "style.png", "trees.png"].map(uri),
          num_images: 1, output_format: "png",
          ...(GOOGLE ? { aspect_ratio: "1:1", resolution: "1K", ...(process.env.PAINT_THINKING ? { thinking_level: process.env.PAINT_THINKING } : {}) } : { image_size: { width: WIN, height: WIN }, quality: FAL_QUALITY }) }),
        signal: AbortSignal.timeout(600_000),
      });
      const units = Number(r.headers.get("x-fal-billable-units") ?? 0), usd = units * (await unitPrice());
      spent += usd;
      appendFileSync(SPEND, JSON.stringify({ window: id, usd, units, status: r.status, request: r.headers.get("x-fal-request-id"), at: new Date().toISOString() }) + "\n");
      const j: any = await r.json().catch(() => ({}));
      if (r.status === 429 || r.status >= 500) { writeFileSync(log, JSON.stringify(j)); await sleep(20_000 * attempt); continue; }
      if (!r.ok || !j.images?.[0]?.url) { writeFileSync(log, JSON.stringify(j)); return; }
      const img = Buffer.from(await (await fetch(j.images[0].url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
      // Google's models pick their own pixel size for 1:1 at 1K: back to the window's
      const meta = await sharp(img).metadata();
      writeFileSync(join(cwd, "out.png"), meta.width === WIN && meta.height === WIN ? img : await sharp(img).resize(WIN, WIN, { fit: "fill" }).png().toBuffer());
      writeFileSync(log, `fal ${FAL_ENDPOINT} ${FAL_QUALITY} $${usd} request ${r.headers.get("x-fal-request-id")}`);
      return;
    } catch (err) {
      writeFileSync(log, String(err));
      await sleep(10_000 * attempt);
    }
  }
}

function codex(cwd: string, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const log = openSync(join(cwd, "codex.log"), "w");
    const p = spawn("codex", ["exec", "--skip-git-repo-check", ...(process.env.CODEX_MODEL ? ["-m", process.env.CODEX_MODEL] : []), "-s", "workspace-write", "-C", cwd, "-i", "input.png", "-i", "height.png", "-i", "style.png", "-i", "trees.png", "-"],
      { stdio: ["pipe", log, log] });
    const timer = setTimeout(() => p.kill("SIGTERM"), 900_000);
    p.on("close", () => { clearTimeout(timer); closeSync(log); resolve(); });
    p.stdin!.end(prompt);
  });
}

/** Share of a window's surface at sea level (from the height pass). */
async function seaFraction(i: number, j: number) {
  let wet = 0, n = 0;
  for (let y = j * STRIDE; y < j * STRIDE + WIN; y += 32)
    for (let x = i * STRIDE; x < i * STRIDE + WIN; x += 32) {
      const tx = Math.floor(x / T), ty = Math.floor(y / T), f = regionFile("height", tx, ty);
      if (!existsSync(f)) continue;
      const h = (await readHeights(f))[Math.floor((y - ty * T) / 4) * 256 + Math.floor((x - tx * T) / 4)];
      n++;
      if (h <= seaH() + 0.3) wet++;
    }
  return n ? wet / n : 0;
}

/** Mean brightness of each cell of an 8×8 grid (catches black bands or patches a mean over the image hides). */
async function cells(file: string | Buffer) {
  const d = await sharp(file).removeAlpha().resize(8, 8, { fit: "fill" }).raw().toBuffer();
  return Array.from({ length: 64 }, (_, k) => (d[k * 3] + d[k * 3 + 1] + d[k * 3 + 2]) / 3);
}

/**
 * Share of a painting's area that is roof tile (red/orange, saturated) with no roof in the render within ~16 m:
 * buildings the model invented. Normal paintings stay under ~3 %; invented towns in woods reach 10–16 %.
 */
async function inventedRoofs(out: string, input: string) {
  const mask = async (f: string) => {
    const d = await sharp(f).removeAlpha().resize(128, 128, { fit: "fill" }).raw().toBuffer(), m = new Uint8Array(128 * 128);
    for (let k = 0; k < m.length; k++) { const r = d[k * 3], g = d[k * 3 + 1], b = d[k * 3 + 2]; m[k] = r > 120 && r > g * 1.35 && r > b * 1.6 ? 1 : 0; }
    return m;
  };
  const [pm, rm] = [await mask(out), await mask(input)];
  let invented = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    if (!pm[y * 128 + x]) continue;
    let near = false;
    for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3 && !near; dx++) {
      const yy = y + dy, xx = x + dx;
      near = yy >= 0 && xx >= 0 && yy < 128 && xx < 128 && rm[yy * 128 + xx] === 1;
    }
    if (!near) invented++;
  }
  return invented / (128 * 128);
}
const MAX_INVENTED = 0.04;

/** Share of pixels with a strong edge (256 px greyscale): good paintings stay within ~1.0–1.4× their render's. */
async function edgeDensity(f: string) {
  const N = 256, g = await sharp(f).removeAlpha().greyscale().resize(N, N, { fit: "fill" }).raw().toBuffer();
  let e = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++)
    if (Math.hypot(g[y * N + x + 1] - g[y * N + x - 1], g[(y + 1) * N + x] - g[(y - 1) * N + x]) > 40) e++;
  return e / ((N - 2) * (N - 2));
}
/** Structure invented on a nearly blank render (fields, tracks, squares): much busier painting than render. */
async function inventedStructure(out: string, input: string) {
  const [p, r] = [await edgeDensity(out), await edgeDensity(input)];
  return p - r > 0.15 && p > 2 * r;
}

/** Codex sometimes returns black bands or near-black images: any cell much darker than the render. */
async function hasDarkPatch(out: string | Buffer, input: string | Buffer) {
  const [o, n] = [await cells(out), await cells(input)];
  return o.some((v, k) => v < 40 && v < 0.5 * n[k]);
}

/** Blue everywhere and not dark (checked per cell). */
async function looksLikeSea(file: string) {
  const d = await sharp(file).removeAlpha().resize(8, 8, { fit: "fill" }).raw().toBuffer();
  for (let k = 0; k < 64; k++) if (d[k * 3 + 2] < 80 || d[k * 3 + 2] < d[k * 3] + 25) return false;
  return true;
}

/** Delete finished windows with a black band or patch the render doesn't have, so they get repainted. */
async function dropDarkWindows(wins: Array<[number, number]>) {
  let n = 0;
  for (const [i, j] of wins) {
    if (!existsSync(winFile(i, j))) continue;
    const render = await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN)).png().toBuffer();
    if (await hasDarkPatch(winFile(i, j), render)) { rmSync(winFile(i, j)); n++; console.warn(`  ${i}_${j}: black patch, will repaint`); }
  }
  if (n) console.log(`  dropped ${n} windows with black patches`);
}

async function paintWindow(i: number, j: number) {
  if (existsSync(winFile(i, j)) && !args.force && !(OLDER && !current(i, j))) return;
  // open sea: reuse the painted sea texture (mirrored per window so repeats don't line up)
  if (existsSync(SEA) && (await seaFraction(i, j)) >= 0.995) {
    let img = sharp(SEA).resize(WIN, WIN);
    if ((i + j) & 1) img = img.flop();
    if (j & 1) img = img.flip();
    await writeAtomic(img.png(), winFile(i, j));
    console.log(`  ${i}_${j}: sea texture`);
    return;
  }
  const work = join(base, "work", `${i}_${j}`);
  mkdirSync(work, { recursive: true });
  const edges = await composeInput(i, j, join(work, "input.png"), join(work, "height.png"));
  copyFileSync(STYLE, join(work, "style.png"));
  copyFileSync(local.trees, join(work, "trees.png"));
  const prompt = PROMPT.replace("{title}", title).replace("{country}", local.country).replace("{render}", local.render)
    .replace("{treesOf}", local.treesOf).replace("{treeHint}", local.treeHint).replace("{materials}", local.materials).replace("{ground}", local.ground).replace("{out}", join(work, "out.png"))
    .replace("{continuation}", edges.length ? CONTINUATION.replace("{edges}", edges.join(" and ")) : "");
  for (let attempt = 1; attempt <= 3; attempt++) {
    while (Date.now() < resumeAt) await sleep(Math.min(60_000, resumeAt - Date.now()));
    if (overBudget()) { console.warn(`  ${i}_${j}: paint budget of $${BUDGET} reached ($${spent.toFixed(2)} spent), skipped`); return; }
    rmSync(join(work, "out.png"), { force: true });
    const t0 = Date.now();
    if (BACKEND === "fal") await falPaint(work, prompt, `${i}_${j}`);
    else await codex(work, prompt);
    if (!existsSync(join(work, "out.png"))) {
      const log = readFileSync(join(work, "codex.log"), "utf8").slice(-4000);
      if (LIMIT.test(log)) {
        const wait = limitWait(log);
        resumeAt = Math.max(resumeAt, Date.now() + wait);
        console.warn(`  ${i}_${j}: Codex limit reached, pausing all workers until ${new Date(resumeAt).toLocaleTimeString()}`);
        attempt--; // a limit is not the window's fault: retry without using up an attempt
        continue;
      }
    } else backoff = 0;
    if (existsSync(join(work, "out.png"))) {
      // geometric QA: undo any shift/scale drift; repaint if the output doesn't follow the render
      const r = await register(join(work, "input.png"), join(work, "out.png"));
      writeFileSync(join(work, "qa.json"), JSON.stringify(r));
      if ((await hasDarkPatch(join(work, "out.png"), join(work, "input.png"))) && attempt < 3) {
        console.warn(`  ${i}_${j}: black band or patch in the paint, repainting`);
        continue;
      }
      const invented = await inventedRoofs(join(work, "out.png"), join(work, "input.png"));
      if (invented > MAX_INVENTED && attempt < 3) {
        console.warn(`  ${i}_${j}: ${(invented * 100).toFixed(1)} % invented roofs (buildings the render doesn't have), repainting`);
        continue;
      }
      if (invented > MAX_INVENTED) { console.warn(`  ${i}_${j}: still inventing buildings after 3 attempts, left unpainted`); return; }
      if (await inventedStructure(join(work, "out.png"), join(work, "input.png"))) {
        if (attempt < 3) { console.warn(`  ${i}_${j}: painting far busier than its render (invented structure), repainting`); continue; }
        console.warn(`  ${i}_${j}: still inventing structure after 3 attempts, left unpainted`); return;
      }
      const structured = r.texture >= MIN_TEXTURE; // open sea / empty land: correlation is meaningless
      if (structured && r.score < MIN_MATCH && attempt < 3) {
        console.warn(`  ${i}_${j}: match ${r.score.toFixed(2)} < ${MIN_MATCH}, repainting`);
        continue;
      }
      const warp = structured && r.score > r.identity + 0.01;
      await applyRegistration(join(work, "out.png"), winFile(i, j), warp ? r : { ...r, scale: 1, dx: 0, dy: 0 });
      console.log(`  ${i}_${j}: ${((Date.now() - t0) / 1000).toFixed(0)}s edges=${edges.join("+") || "-"} match=${r.score.toFixed(2)}`
        + (structured ? "" : " (low texture)") + (warp ? ` shift=(${r.dx},${r.dy}) scale=${r.scale.toFixed(2)}` : ""));
      // keep qa.json + codex.log for debugging; the images are ~6 MB per window
      for (const f of ["input.png", "height.png", "style.png", "trees.png", "out.png"]) rmSync(join(work, f), { force: true });
      return;
    }
    console.error(`  ${i}_${j}: attempt ${attempt} failed, see ${join(work, "codex.log")}`);
  }
}

/** Feather-blend painted windows into 1024 art tiles; only tiles fully covered are written. */
// ---- sea colour harmonisation -------------------------------------------------------------------
// Codex paints open water in slightly different blues per window, which shows as window-sized
// rectangles. In each window, deep water (sea level, far from land) is shifted to the median
// deep-water colour of all windows, fading in from the shore so surf and harbours keep their colours.
const CELL = 8, PAD = 256, NEAR = 12, FULL = 28; // 8 px cells; fade from 12 to 28 cells (24 → 56 m) off the coast
const heightCache = new Map<string, Float32Array | null>();
async function heightAt(x: number, y: number) {
  const tx = Math.floor(x / T), ty = Math.floor(y / T), k = `${tx}_${ty}`;
  if (!heightCache.has(k)) {
    const f = regionFile("height", tx, ty);
    heightCache.set(k, existsSync(f) ? await readHeights(f) : null);
  }
  const h = heightCache.get(k);
  return h ? h[Math.floor((y - ty * T) / 4) * 256 + Math.floor((x - tx * T) / 4)] : NaN;
}

/** Per window cell (WIN/CELL)²: 0 on land or near the coast → 1 in open water. Null if no open water. */
async function deepWater(i: number, j: number) {
  const n = (WIN + 2 * PAD) / CELL, x0 = i * STRIDE - PAD, y0 = j * STRIDE - PAD;
  const d = new Float32Array(n * n);
  let any = false;
  for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
    const h = await heightAt(x0 + cx * CELL + CELL / 2, y0 + cy * CELL + CELL / 2);
    const land = !Number.isNaN(h) && h > seaH() + 0.3;
    d[cy * n + cx] = land ? 0 : 1e9;
    if (!land && !Number.isNaN(h)) any = true;
  }
  if (!any) return null;
  // chamfer distance to land, in cells
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = d[y * n + x];
    if (x) v = Math.min(v, d[y * n + x - 1] + 1);
    if (y) v = Math.min(v, d[(y - 1) * n + x] + 1);
    if (x && y) v = Math.min(v, d[(y - 1) * n + x - 1] + 1.414);
    if (y && x < n - 1) v = Math.min(v, d[(y - 1) * n + x + 1] + 1.414);
    d[y * n + x] = v;
  }
  for (let y = n - 1; y >= 0; y--) for (let x = n - 1; x >= 0; x--) {
    let v = d[y * n + x];
    if (x < n - 1) v = Math.min(v, d[y * n + x + 1] + 1);
    if (y < n - 1) v = Math.min(v, d[(y + 1) * n + x] + 1);
    if (x < n - 1 && y < n - 1) v = Math.min(v, d[(y + 1) * n + x + 1] + 1.414);
    if (y < n - 1 && x) v = Math.min(v, d[(y + 1) * n + x - 1] + 1.414);
    d[y * n + x] = v;
  }
  const m = WIN / CELL, w = new Float32Array(m * m), p = PAD / CELL;
  let deep = 0;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const h = await heightAt(i * STRIDE + x * CELL + CELL / 2, j * STRIDE + y * CELL + CELL / 2);
    if (Number.isNaN(h)) continue;
    const v = Math.min(1, Math.max(0, (d[(y + p) * n + x + p] - NEAR) / (FULL - NEAR)));
    w[y * m + x] = v;
    if (v >= 1) deep++;
  }
  return deep >= 64 ? w : null;
}

/** window -> [cell weights, RGB offset to the reference deep-water colour] */
const seaFix = new Map<string, [Float32Array, number[]]>();
async function harmoniseSea(saved?: number[]) {
  const means: Array<[string, Float32Array, number[]]> = [];
  for (const [i, j] of windows()) {
    if (!existsSync(winFile(i, j))) continue;
    const w = await deepWater(i, j);
    if (!w) continue;
    const m = WIN / CELL, px = await sharp(winFile(i, j)).removeAlpha().resize(m, m, { kernel: "cubic" }).raw().toBuffer();
    const sum = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < m * m; k++) if (w[k] >= 1) { for (let c = 0; c < 3; c++) sum[c] += px[k * 3 + c]; n++; }
    means.push([`${i}_${j}`, w, sum.map((v) => v / n)]);
  }
  const ref = saved ?? [0, 1, 2].map((c) => means.map((m) => m[2][c]).sort((a, b) => a - b)[Math.floor(means.length / 2)]);
  for (const [k, w, mean] of means) seaFix.set(k, [w, mean.map((v, c) => ref[c] - v)]);
  console.log(`  sea: ${means.length} windows with open water, ${saved ? "saved " : ""}reference rgb(${ref.map(Math.round).join(",")})`);
  return ref;
}

/** Rebuild art tiles: every one (all), those under the given windows (only), else those a newer window covers. */
async function assemble(all = false, only?: Set<string>) {
  const ramp = new Float32Array(WIN);
  // 0 → 1 across a FEATHER-wide band centred in the overlap (complementary for neighbours)
  const edge = (k: number) => Math.min(1, Math.max(0, (k + 0.5 - (OVERLAP - FEATHER) / 2) / FEATHER));
  for (let k = 0; k < WIN; k++) ramp[k] = Math.min(edge(k), edge(WIN - 1 - k));
  mkdirSync(join(base, "paint"), { recursive: true });
  let written = 0;
  for (const k of tileSet) {
    const [tx, ty] = k.split("_").map(Number);
    const covering: Array<[number, number]> = [];
    for (let j = Math.floor((ty * T - WIN) / STRIDE) + 1; j * STRIDE < (ty + 1) * T; j++)
      for (let i = Math.floor((tx * T - WIN) / STRIDE) + 1; i * STRIDE < (tx + 1) * T; i++) covering.push([i, j]);
    // a tile is painted as soon as one window covers it; where windows are missing the render shows through,
    // faded in across the window feather (no hard edge between the painted and the unpainted map)
    const have = covering.filter(([i, j]) => existsSync(winFile(i, j)));
    const tile = join(base, "paint", `${tx}_${ty}.png`);
    if (!have.length) { if (existsSync(tile)) rmSync(tile); continue; } // windows withdrawn: back to the render
    const partial = have.length < covering.length;
    // rebuilt when any covering window was (re)painted since, or (only) when it lies under the given windows
    if (only && !covering.some(([i, j]) => only.has(`${i}_${j}`))) continue;
    if (!only && existsSync(tile) && !args.force && !all && have.every(([i, j]) => mtime(winFile(i, j)) <= mtime(tile))) continue;
    const acc = new Float32Array(T * T * 3), wsum = new Float32Array(T * T);
    for (const [i, j] of have) {
      const px = await sharp(winFile(i, j)).resize(WIN, WIN).removeAlpha().raw().toBuffer();
      const fix = seaFix.get(`${i}_${j}`);
      if (fix) { // bilinear cell weights × colour offset
        const [w, off] = fix, m = WIN / CELL;
        for (let y = 0; y < WIN; y++) {
          const fy = Math.min(m - 1, Math.max(0, (y + 0.5) / CELL - 0.5)), y0 = Math.floor(fy), y1 = Math.min(m - 1, y0 + 1), ay = fy - y0;
          for (let x = 0; x < WIN; x++) {
            const fx = Math.min(m - 1, Math.max(0, (x + 0.5) / CELL - 0.5)), x0 = Math.floor(fx), x1 = Math.min(m - 1, x0 + 1), ax = fx - x0;
            const a = (w[y0 * m + x0] * (1 - ax) + w[y0 * m + x1] * ax) * (1 - ay) + (w[y1 * m + x0] * (1 - ax) + w[y1 * m + x1] * ax) * ay;
            if (a <= 0) continue;
            const s = (y * WIN + x) * 3;
            for (let c = 0; c < 3; c++) px[s + c] = Math.max(0, Math.min(255, px[s + c] + off[c] * a));
          }
        }
      }
      const ox = i * STRIDE - tx * T, oy = j * STRIDE - ty * T;
      for (let y = Math.max(0, oy); y < Math.min(T, oy + WIN); y++)
        for (let x = Math.max(0, ox); x < Math.min(T, ox + WIN); x++) {
          const wx = x - ox, wy = y - oy, w = ramp[wx] * ramp[wy], s = (wy * WIN + wx) * 3, d = y * T + x;
          acc[d * 3] += px[s] * w; acc[d * 3 + 1] += px[s + 1] * w; acc[d * 3 + 2] += px[s + 2] * w;
          wsum[d] += w;
        }
    }
    const out = Buffer.alloc(T * T * 3);
    const render = partial && existsSync(renderFile(tx, ty)) ? await sharp(renderFile(tx, ty)).removeAlpha().raw().toBuffer() : null;
    for (let d = 0; d < T * T; d++) {
      const w = wsum[d];
      for (let c = 0; c < 3; c++)
        out[d * 3 + c] = render && w < 1 ? acc[d * 3 + c] + render[d * 3 + c] * (1 - w) : acc[d * 3 + c] / Math.max(w, 1e-6);
    }
    await writeAtomic(sharp(out, { raw: { width: T, height: T, channels: 3 } }).png(), join(base, "paint", `${tx}_${ty}.png`));
    written++;
  }
  console.log(`  assembled ${written} art tiles`);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()!); }));
}

async function main() {
  let wins = windows();
  if (args.near) {
    const [lat, lon] = args.near.split(",").map(Number);
    const [x, y] = llhToPixel(lat, lon, 25);
    const ci = Math.floor(x / STRIDE), cj = Math.floor(y / STRIDE), r = Number(args.radius);
    wins = wins.filter(([i, j]) => Math.abs(i - ci) <= r && Math.abs(j - cj) <= r);
  }
  if (args.window) wins = [args.window.split(",").map(Number) as [number, number]];
  if (args.parts) {
    const boxes: number[][] = readJson(join(base, "osm-parts.json")).map((p: { px: number[] }) => p.px), m = 16;
    wins = wins.filter(([i, j]) => boxes.some(([x0, y0, x1, y1]) => i * STRIDE < x1 + m && i * STRIDE + WIN > x0 - m && j * STRIDE < y1 + m && j * STRIDE + WIN > y0 - m));
  }
  if (OLDER) { // only land windows (sea-texture windows have no trees) painted before the cut-off
    const old: Array<[number, number]> = [];
    for (const [i, j] of wins) if (existsSync(winFile(i, j)) && !current(i, j) && !(await looksLikeSea(winFile(i, j)))) old.push([i, j]);
    wins = old;
  }
  if (args.plan) return console.log(`${wins.length} windows`);
  if (args.parts) { // the old paintings move aside (not deleted), so neighbours in the set don't continue them
    const keep = join(base, "windows-replaced", new Date().toISOString().slice(0, 19).replace(/:/g, "-"));
    mkdirSync(keep, { recursive: true });
    for (const [i, j] of wins) if (existsSync(winFile(i, j))) renameSync(winFile(i, j), join(keep, `${i}_${j}.png`));
    console.log(`  ${wins.length} windows over OSM 3D buildings; old paintings in ${keep}`);
  }
  if (!args.window && !OLDER && !args.assemble && !args.parts) {
    // reuse what other areas of the region painted: this area's windows and their neighbours (for continuation)
    const want = new Set<string>();
    for (const [i, j] of wins) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) want.add(`${i + di}_${j + dj}`);
    let linked = 0;
    for (const k of want) {
      const own = join(winDir, `${k}.png`);
      if (existsSync(own)) continue;
      const sib = SIBLINGS.map((d) => join(d, "windows", `${k}.png`)).find((f) => existsSync(f));
      if (!sib) continue;
      try { linkSync(sib, own); } catch { copyFileSync(sib, own); }
      linked++;
    }
    if (linked) console.log(`  reused ${linked} windows painted by other areas of the region`);
  }
  if (args.assemble) {
    const seaRef = await harmoniseSea();
    await assemble(true);
    return writeFileSync(join(base, "paint.json"), JSON.stringify({ updated: new Date().toISOString(), seaRef }));
  }
  // centre first: square rings around the city centre. Each ring runs in two passes over its
  // perimeter (even, then odd positions) so every window continues its painted inner/ring neighbours.
  const [cx, cy] = args.center.split(",").map(Number);
  const [px, py] = llhToPixel(cx, cy, 25);
  const ci = Math.floor(px / STRIDE), cj = Math.floor(py / STRIDE);
  const have = new Set(wins.map(([i, j]) => `${i}_${j}`));
  const maxR = Math.max(...wins.map(([i, j]) => Math.max(Math.abs(i - ci), Math.abs(j - cj))));
  console.log(`${wins.length} windows in ${maxR + 1} rings around ${ci}_${cj}`);
  // first: paint one open-sea window and keep it as the reusable sea texture
  // (validated: a bad paint would otherwise be stamped over every open-sea window)
  // a bad sea texture (or windows painted with black bands) never survives a restart: drop and redo them
  if (existsSync(SEA) && !(await looksLikeSea(SEA))) { console.warn("  sea texture is bad, repainting it"); rmSync(SEA); }
  if (!args.window && !OLDER) await dropDarkWindows(wins);
  if (!existsSync(SEA) && !args.window && !OLDER) {
    const open = [];
    for (const [i, j] of windows()) if ((await seaFraction(i, j)) >= 0.995) open.push([i, j]);
    for (const [i, j] of open.slice(0, 3)) {
      rmSync(winFile(i, j), { force: true });
      await paintWindow(i, j);
      if (existsSync(winFile(i, j)) && (await looksLikeSea(winFile(i, j)))) {
        copyFileSync(winFile(i, j), SEA);
        console.log(`  sea texture from ${i}_${j}`);
        break;
      }
      console.warn(`  ${i}_${j}: painted sea doesn't look like sea, trying another window`);
      rmSync(winFile(i, j), { force: true });
    }
  }
  for (let r = 0; r <= maxR; r++) {
    const ring: Array<[number, number]> = [];
    if (r === 0) ring.push([ci, cj]);
    else {
      for (let k = 0; k < 2 * r; k++) ring.push([ci - r + k, cj - r]);  // top, left → right
      for (let k = 0; k < 2 * r; k++) ring.push([ci + r, cj - r + k]);  // right, top → bottom
      for (let k = 0; k < 2 * r; k++) ring.push([ci + r - k, cj + r]);  // bottom, right → left
      for (let k = 0; k < 2 * r; k++) ring.push([ci - r, cj + r - k]);  // left, bottom → top
    }
    for (const pass of [0, 1]) {
      const todo = ring.filter(([i, j], k) => k % 2 === pass && have.has(`${i}_${j}`));
      await pool(todo, Number(args.j), ([i, j]) => paintWindow(i, j));
    }
    await assemble(); // finished tiles become visible ring by ring
  }
  // then the tiles are rebuilt with the harmonised sea: all of them after a full run; after a partial one
  // (--window, --near, --parts) only those under its windows, with the saved sea colour, so nothing else changes
  const partial = !!(args.window || args.near || args.parts);
  const prev = existsSync(join(base, "paint.json")) ? readJson(join(base, "paint.json")) : {};
  const seaRef = await harmoniseSea(partial ? prev.seaRef : undefined);
  await assemble(!partial, partial ? new Set(wins.map(([i, j]) => `${i}_${j}`)) : undefined);
  writeFileSync(join(base, "paint.json"), JSON.stringify({ updated: new Date().toISOString(), seaRef }));
}

main();
