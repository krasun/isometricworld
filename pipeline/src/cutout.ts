/**
 * Painted landmarks on the procedural map: one window painted around a single building (paint.ts --tag),
 * and only that building, cut out along its exact LoD2 silhouette, goes onto the render. The ground around
 * it stays procedural, so there is no patch edge. Places (airport, stadium, squares) are painted as window
 * patches instead.
 *
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core --plan rosenstein 48.8005,9.2057
 *       → which window to paint, and the paint command (it goes to windows-cutout-rosenstein/)
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core --add rosenstein 48.8005,9.2057
 *       → records the cutout in <area>/cutouts.json and composes the tiles
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-north-east --plan rbk --lot 5385339
 *       → a property instead of one building: the OSM lot polygon on the terrain plus every LoD2 building
 *         standing in it, minus whatever outside the lot stands in front; clipped to one window (--window i,j)
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core          # recompose every cutout (after a re-render)
 *
 * Tiles go to <area>/cutout/<tx>_<ty>.png (render + painted buildings); export layers them as
 * render < cutout < paint, so a painted patch still wins where both exist.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { axes, CAMERA, ecefToEnu, enuHeight, enuToLlh, enuToPixel, llhToEcef } from "./camera.ts";
import { readHeights } from "./heights.ts";
import { lod2Files } from "./lgl.ts";
import { type Lod2Building, parseLod2 } from "./lod2.ts";
import { DERIVED, RAW, readJson, writeAtomic } from "./paths.ts";
import { REGIONS } from "./places.ts";

type P2 = [number, number];
/** a screen triangle: art px x, y and ellipsoid height per vertex */
type Tri = Array<[number, number, number]>;
/** lot: an OSM way id (ground.json): the whole property is painted, cut along its boundary, not along the walls */
interface Cutout { name: string; at: [number, number]; window: [number, number]; lot?: number }

const WIN = 1024, STRIDE = 896, T = CAMERA.tile;
/** silhouette grown by GROW px (the painted outline), anti-aliased over ~1 px */
const GROW = 1.5;
/** the height pass is this much above the building's own surface: something stands in front of it. Small:
 *  a tree a metre in front of a wall is only ~1 m above the wall point behind it on the same line of sight;
 *  both heights are sampled at the same pixel centre, so the building itself matches to centimetres. */
const IN_FRONT = 0.4;
const CELL = 4; // height pass resolution (art px)
/** room a silhouette needs to the window edge (the painter is least reliable at the border) */
const MARGIN = 48;

const [name, ...rest] = process.argv.slice(2);
if (!name) throw new Error("usage: cutout.ts <area> [--plan|--add <name> <lat,lon>]");
const area = openArea(name);
const base = join(DERIVED, name);
const listFile = join(base, "cutouts.json");
const list: Cutout[] = existsSync(listFile) ? readJson(listFile) : [];

/** the LoD2 building at (lat, lon) and every building part touching it (wings, towers) */
function buildingsAt(lat: number, lon: number): Lod2Building[] {
  const m = 0.003, box = [lat - m, lon - m, lat + m, lon + m];
  const all = [...lod2Files(box)].flatMap((f) => parseLod2(f.xml, box, REGIONS[area.region].geoidM));
  const e = ecefToEnu(llhToEcef(lat, lon, 0)), p: P2 = [e[0], e[1]];
  const seed = all.find((b) => inside(p, b.footprint));
  if (!seed) throw new Error(`no LoD2 building at ${lat},${lon}`);
  const picked = [seed];
  for (let grew = true; grew;) {
    grew = false;
    for (const b of all) if (!picked.includes(b) && picked.some((q) => gap(b.footprint, q.footprint) < 1.5)) { picked.push(b); grew = true; }
  }
  return picked;
}

/** ENU ground height (ground.ts grid, bilinear) */
const gmeta = readJson(join(base, "ground", "meta.json"));
const gbuf = readFileSync(join(base, "ground", "height.bin")), gh = new Float32Array(gbuf.buffer, gbuf.byteOffset, gbuf.length / 4);
function groundAt(e: number, n: number) {
  const fx = Math.max(0, Math.min(gmeta.nx - 1.001, (e - gmeta.x0) / gmeta.step)), fy = Math.max(0, Math.min(gmeta.ny - 1.001, (n - gmeta.y0) / gmeta.step));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, v = (a: number, b: number) => gh[b * gmeta.nx + a];
  return (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
}

/**
 * the lot ring (ENU) of an OSM way, every LoD2 building whose footprint centre lies in it, and its holes:
 * construction sites in the lot (the aerial shows what is being built, our data doesn't: the painter would
 * invent buildings there), which stay procedural
 */
function lotAt(id: number): { ring: P2[]; bs: Lod2Building[]; holes: P2[][] } {
  type El = { id: number; type: string; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> };
  const els: El[] = readJson(join(RAW, name, "ground.json")).elements, el = els.find((e) => e.id === id && e.type === "way");
  if (!el?.geometry) throw new Error(`no OSM way ${id} in ground.json`);
  const ll = el.geometry;
  const enu = (g: { lat: number; lon: number }): P2 => { const e = ecefToEnu(llhToEcef(g.lat, g.lon, 0)); return [e[0], e[1]]; };
  const ring: P2[] = ll.map(enu);
  const lats = ll.map((g) => g.lat), lons = ll.map((g) => g.lon);
  const box = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  const all = [...lod2Files(box)].flatMap((f) => parseLod2(f.xml, box, REGIONS[area.region].geoidM));
  const centre = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
  const holes = els.filter((e) => e.type === "way" && e.id !== id && e.geometry && e.tags?.landuse === "construction")
    .map((e) => e.geometry!.map(enu)).filter((h) => inside(centre(h), ring));
  return { ring, bs: all.filter((b) => inside(centre(b.footprint), ring)), holes };
}

/** the lot's boundary on the terrain, in global art px (1 m steps) */
function lotScreen(ring: P2[]): P2[] {
  const out: P2[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 0; s < L; s += 1) {
      const e = a[0] + ((b[0] - a[0]) * s) / L, n = a[1] + ((b[1] - a[1]) * s) / L;
      out.push(enuToPixel([e, n, groundAt(e, n)]));
    }
  }
  return out;
}

/** what a cutout covers: its buildings (and lot) */
function shapeOf(c: { at: [number, number]; lot?: number }) {
  if (c.lot) { const { ring, bs, holes } = lotAt(c.lot); return { bs, tris: silhouette(bs), ring, holes }; }
  const bs = buildingsAt(...c.at);
  return { bs, tris: silhouette(bs), ring: undefined as P2[] | undefined, holes: [] as P2[][] };
}

const inside = (p: P2, ring: P2[]) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    if (ring[i][1] > p[1] !== ring[j][1] > p[1] && p[0] < ((ring[j][0] - ring[i][0]) * (p[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
  return c;
};
const segDist = (p: P2, a: P2, b: P2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const gap = (r: P2[], s: P2[]) => Math.min(
  ...r.flatMap((p) => s.map((_, i) => segDist(p, s[i], s[(i + 1) % s.length]))),
  ...s.flatMap((p) => r.map((_, i) => segDist(p, r[i], r[(i + 1) % r.length]))),
);

/** screen triangles (global art px + height) of the buildings' roofs and walls */
function silhouette(bs: Lod2Building[]): Tri[] {
  const tris: Tri[] = [];
  const at = (e: number, n: number, u: number): [number, number, number] => [...enuToPixel([e, n, u]), enuHeight([e, n, u])];
  for (const b of bs) {
    for (let k = 0; k + 9 <= b.roof.length; k += 9) tris.push([0, 1, 2].map((v) => at(b.roof[k + v * 3], b.roof[k + v * 3 + 1], b.roof[k + v * 3 + 2])));
    for (let k = 0; k + 15 <= b.wall.length; k += 15) tris.push([0, 1, 2].map((v) => at(b.wall[k + v * 5], b.wall[k + v * 5 + 1], b.wall[k + v * 5 + 2])));
  }
  return tris;
}

/** ENU ground position of the surface seen at global art pixel (x, y) with ellipsoid height h */
function pixelToEnu(x: number, y: number, h: number): P2 {
  const { right: r, up: v } = axes();
  let e = 0, n = 0;
  for (let it = 0; it < 3; it++) { // enuHeight adds the earth's curvature: solve for u, then e, n again
    const u = h - (e * e + n * n) / (2 * 6371000), a = x * CAMERA.mpp, b = -y * CAMERA.mpp - u * v[2], det = r[0] * v[1] - r[1] * v[0];
    e = (a * v[1] - b * r[1]) / det; n = (r[0] * b - v[0] * a) / det;
  }
  return [e, n];
}

/**
 * Cells (CELL px, window grid) where something stands in front of the building: along a pixel's line of sight
 * everything nearer the camera is higher, so a height pass well above the building's own surface there
 * (the highest of its triangles at that pixel) is a tree, mast or other building in front. Grown by a cell.
 */
async function inFront(tris: Tri[], [i, j]: [number, number], bs: Lod2Building[], ring?: P2[], left: Lod2Building[] = [], holes: P2[][] = []) {
  // the renderer's own roof furniture (plant rooms, solar, AC units, eaves) stands on the footprint: not in front
  const on = (list: Lod2Building[]) => (p: P2) => list.some((b) => inside(p, b.footprint) || b.footprint.some((q, k) => segDist(p, q, b.footprint[(k + 1) % b.footprint.length]) < 1));
  const onBuilding = on(bs), onLeft = on(left);
  const ox = i * STRIDE, oy = j * STRIDE, n = WIN / CELL;
  const own = new Float32Array(n * n).fill(-Infinity);
  for (const t of tris) {
    const [a, b, c] = t.map(([x, y, h]) => [(x - ox) / CELL - 0.5, (y - oy) / CELL - 0.5, h]);
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-9) continue;
    for (let cy = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))); cy <= Math.min(n - 1, Math.ceil(Math.max(a[1], b[1], c[1]))); cy++)
      for (let cx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))); cx <= Math.min(n - 1, Math.ceil(Math.max(a[0], b[0], c[0]))); cx++) {
        const w0 = ((b[1] - c[1]) * (cx - c[0]) + (c[0] - b[0]) * (cy - c[1])) / d, w1 = ((c[1] - a[1]) * (cx - c[0]) + (a[0] - c[0]) * (cy - c[1])) / d, w2 = 1 - w0 - w1;
        if (w0 < -0.05 || w1 < -0.05 || w2 < -0.05) continue;
        const k = cy * n + cx;
        own[k] = Math.max(own[k], w0 * a[2] + w1 * b[2] + w2 * c[2]);
      }
  }
  const front = new Uint8Array(n * n);
  for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + WIN - 1) / T); tx++)
    for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + WIN - 1) / T); ty++) {
      const f = join(base, "height", `${tx}_${ty}.png`);
      if (!existsSync(f)) continue;
      const hp = await readHeights(f), m = T / CELL;
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const cx = (tx * T - ox) / CELL + x, cy = (ty * T - oy) / CELL + y;
        if (cx < 0 || cy < 0 || cx >= n || cy >= n) continue;
        const k = cy * n + cx, v = hp[y * m + x];
        const p = pixelToEnu(ox + (cx + 0.5) * CELL, oy + (cy + 0.5) * CELL, v);
        if (ring) { // lot: anything raised (tree, building, mast) seen here that stands outside the lot, or on a building left out, is cut
          if (!onBuilding(p) && (!inside(p, ring) || onLeft(p) || holes.some((h) => inside(p, h))) && v > enuHeight([p[0], p[1], groundAt(p[0], p[1])]) + 1.5) front[k] = 1;
        } else if (own[k] > -Infinity && v > own[k] + IN_FRONT && !onBuilding(p)) front[k] = 1;
      }
    }
  const grown = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (front[y * n + x])
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < n && y + dy < n) grown[(y + dy) * n + x + dx] = 255;
  return grown;
}

const bounds = (tris: Tri[]) => {
  const xs = tris.flat().map((p) => p[0]), ys = tris.flat().map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** the grid window that holds the silhouette with the most room to its edges */
function pickWindow(tris: Tri[]): { win: [number, number]; room: number } {
  const [x0, y0, x1, y1] = bounds(tris);
  let best = { win: [0, 0] as [number, number], room: -Infinity };
  // half steps too: a cutout window is painted alone (its own --tag folder, no neighbours), so it needn't sit
  // on the patch grid, and a building that straddles two grid rows still gets a window with room round it
  for (let i = Math.floor(x1 / STRIDE) - 1; i <= x0 / STRIDE; i += 0.5)
    for (let j = Math.floor(y1 / STRIDE) - 1; j <= y0 / STRIDE; j += 0.5) {
      const room = Math.min(x0 - i * STRIDE, y0 - j * STRIDE, i * STRIDE + WIN - x1, j * STRIDE + WIN - y1);
      if (room > best.room) best = { win: [i, j], room };
    }
  return best;
}

/** alpha mask in window pixels: the silhouette (anti-aliased edge) minus whatever stands in front of it */
async function mask(tris: Tri[], win: [number, number], bs: Lod2Building[], ring?: P2[], holes: P2[][] = []) {
  const ox = win[0] * STRIDE, oy = win[1] * STRIDE, pt = (p: number[]) => `${(p[0] - ox).toFixed(1)},${(p[1] - oy).toFixed(1)}`;
  // a lot: only buildings wholly inside the window's inner part are painted; one the window edge would slice
  // through stays procedural as a whole (the cut then runs through ground only)
  let left: Lod2Building[] = [];
  if (ring) {
    const fits = (b: Lod2Building) => { const [x0, y0, x1, y1] = bounds(silhouette([b])); return x0 >= ox + MARGIN && y0 >= oy + MARGIN && x1 < ox + WIN - MARGIN && y1 < oy + WIN - MARGIN; };
    left = bs.filter((b) => !fits(b)); bs = bs.filter(fits); tris = silhouette(bs);
  }
  const g = (ts: Tri[], fill: string) => `<g fill="${fill}" stroke="${fill}" stroke-width="${GROW * 2}" stroke-linejoin="round">${ts.map((t) => `<polygon points="${t.map(pt).join(" ")}"/>`).join("")}</g>`;
  const lot = ring ? `<polygon fill="white" points="${lotScreen(ring).map(pt).join(" ")}"/>${holes.map((h) => `<polygon fill="black" points="${lotScreen(h).map(pt).join(" ")}"/>`).join("")}${g(silhouette(left), "black")}` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIN}" height="${WIN}"><rect width="100%" height="100%" fill="black"/>${lot}${g(tris, "white")}</svg>`;
  const sil = await sharp(Buffer.from(svg)).extractChannel(0).raw().toBuffer();
  const n = WIN / CELL, front = await sharp(await inFront(tris, win, bs, ring, left, holes), { raw: { width: n, height: n, channels: 1 } })
    .resize(WIN, WIN, { kernel: "nearest" }).extractChannel(0).raw().toBuffer();
  if (sil.length !== WIN * WIN || front.length !== WIN * WIN) throw new Error("cutout mask: expected one channel");
  // hard edges for now (no feathering): every pixel is painting or render, nothing in between
  const m = ring ? MARGIN : 0; // a lot is clipped to the window's inner part (the painter is least reliable at the border)
  for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) {
    const k = y * WIN + x, edge = x < m || y < m || x >= WIN - m || y >= WIN - m;
    sil[k] = !edge && sil[k] >= 128 && front[k] < 128 ? 255 : 0;
  }
  return sil;
}

/** rebuild every cutout tile of the area: render + the painted buildings over it */
async function compose() {
  const out = join(base, "cutout");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const tiles = new Map<string, Array<{ c: Cutout; img: Buffer; a: Buffer }>>();
  for (const c of [...list].sort((a, b) => (b.lot ? 1 : 0) - (a.lot ? 1 : 0))) { // lots first: buildings go on top
    const win = join(base, `windows-cutout-${c.name}`, `${c.window[0]}_${c.window[1]}.png`);
    if (!existsSync(win)) { console.warn(`  ${c.name}: not painted yet (${win})`); continue; }
    const { bs, tris, ring, holes } = shapeOf(c);
    const img = await sharp(win).removeAlpha().resize(WIN, WIN).raw().toBuffer(), a = await mask(tris, c.window, bs, ring, holes);
    const ox = c.window[0] * STRIDE, oy = c.window[1] * STRIDE;
    for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + WIN - 1) / T); tx++)
      for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + WIN - 1) / T); ty++)
        tiles.set(`${tx}_${ty}`, [...(tiles.get(`${tx}_${ty}`) ?? []), { c, img, a }]);
  }
  for (const [k, cuts] of tiles) {
    const [tx, ty] = k.split("_").map(Number), render = join(base, "render", `${k}.png`);
    if (!existsSync(render)) continue;
    const px = await sharp(render).removeAlpha().resize(T, T).raw().toBuffer();
    let used = 0;
    for (const { c, img, a } of cuts) {
      const dx = tx * T - c.window[0] * STRIDE, dy = ty * T - c.window[1] * STRIDE; // tile origin in window px
      for (let y = 0; y < T; y++) {
        const wy = y + dy;
        if (wy < 0 || wy >= WIN) continue;
        for (let x = 0; x < T; x++) {
          const wx = x + dx;
          if (wx < 0 || wx >= WIN) continue;
          const al = a[wy * WIN + wx] / 255;
          if (!al) continue;
          used++;
          for (let ch = 0; ch < 3; ch++) px[(y * T + x) * 3 + ch] = Math.round(px[(y * T + x) * 3 + ch] * (1 - al) + img[(wy * WIN + wx) * 3 + ch] * al);
        }
      }
    }
    if (used) await writeAtomic(sharp(px, { raw: { width: T, height: T, channels: 3 } }).png(), join(out, `${k}.png`));
  }
  console.log(`  ${list.length} cutouts -> ${out}`);
}

const flag = rest[0];
if (flag === "--plan" || flag === "--add") {
  const cname = rest[1], opt = (k: string) => { const i = rest.indexOf(k); return i > 0 ? rest[i + 1] : undefined; };
  const lotId = opt("--lot") ? Number(opt("--lot")) : undefined, ll = lotId ? undefined : rest[2];
  if (!cname || (!lotId && !ll)) throw new Error(`usage: cutout.ts <area> ${flag} <name> <lat,lon> | --lot <osm way id> [--window i,j]`);
  let at = ll?.split(",").map(Number) as [number, number];
  const { bs, tris, ring, holes } = shapeOf({ at, lot: lotId });
  if (ring) { const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]); const g = enuToLlh([c[0], c[1], 0]); at = [+g[0].toFixed(5), +g[1].toFixed(5)]; }
  const [x0, y0, x1, y1] = bounds(tris);
  const picked = pickWindow(tris), win = (opt("--window")?.split(",").map(Number) as [number, number]) ?? picked.win;
  const room = Math.min(x0 - win[0] * STRIDE, y0 - win[1] * STRIDE, win[0] * STRIDE + WIN - x1, win[1] * STRIDE + WIN - y1);
  console.log(`  ${cname}: ${bs.length} LoD2 part(s)${ring ? ` on lot ${lotId}` : ""}, silhouette ${Math.round(x1 - x0)}×${Math.round(y1 - y0)} px, window ${win.join(",")}, ${Math.round(room)} px to its edge`);
  if (room < MARGIN && !ring) throw new Error(`no grid window holds ${cname} with ${MARGIN} px room`);
  if (flag === "--plan") {
    // preview: the render under the window, silhouette tinted (check it sits on the building)
    const ox = win[0] * STRIDE, oy = win[1] * STRIDE, parts = [];
    for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + WIN - 1) / T); tx++)
      for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + WIN - 1) / T); ty++) {
        const f = join(base, "render", `${tx}_${ty}.png`);
        if (existsSync(f)) parts.push({ input: await sharp(f).resize(T, T).toBuffer(), left: tx * T - ox + T, top: ty * T - oy + T });
      }
    const a = await mask(tris, win, bs, ring, holes);
    const tint = await sharp({ create: { width: WIN, height: WIN, channels: 3, background: { r: 255, g: 0, b: 160 } } })
      .joinChannel(Buffer.from(a.map((v) => v * 0.45)), { raw: { width: WIN, height: WIN, channels: 1 } }).png().toBuffer();
    const under = await sharp({ create: { width: WIN + 2 * T, height: WIN + 2 * T, channels: 3, background: "#000" } }).composite(parts).png().toBuffer();
    const preview = join(base, `cutout-${cname}-plan.png`);
    await writeAtomic(sharp(await sharp(under).extract({ left: T, top: T, width: WIN, height: WIN }).toBuffer()).composite([{ input: tint }]), preview);
    console.log(`  preview: ${preview}`);
    console.log(`  aerial: npm -w pipeline exec tsx src/aerial.ts ${name} --near ${at.join(",")} --radius 1 --source lgl`);
    console.log(`  paint: npm run paint -- ${name} --window ${win.join(",")} --tag cutout-${cname} --aerial lgl --aerial-input --look simple`);
  } else {
    const next = list.filter((c) => c.name !== cname);
    next.push({ name: cname, at, window: win, ...(lotId ? { lot: lotId } : {}) });
    list.splice(0, list.length, ...next);
    writeFileSync(listFile, JSON.stringify(list, null, 2));
    await compose();
  }
} else await compose();
