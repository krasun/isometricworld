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
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core          # recompose every cutout (after a re-render)
 *
 * Tiles go to <area>/cutout/<tx>_<ty>.png (render + painted buildings); export layers them as
 * render < cutout < paint, so a painted patch still wins where both exist.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { CAMERA, ecefToEnu, enuToPixel, llhToEcef } from "./camera.ts";
import { lod2Files } from "./lgl.ts";
import { type Lod2Building, parseLod2 } from "./lod2.ts";
import { DERIVED, readJson, writeAtomic } from "./paths.ts";
import { REGIONS } from "./places.ts";

type P2 = [number, number];
interface Cutout { name: string; at: [number, number]; window: [number, number] }

const WIN = 1024, STRIDE = 896, T = CAMERA.tile;
/** silhouette grown by GROW px (outlines, eaves), then feathered over FEATHER px */
const GROW = 3, FEATHER = 4;
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

/** screen triangles (global art px) of the buildings' roofs and walls */
function silhouette(bs: Lod2Building[]): P2[][] {
  const tris: P2[][] = [];
  for (const b of bs) {
    for (let k = 0; k + 9 <= b.roof.length; k += 9)
      tris.push([0, 1, 2].map((v) => enuToPixel([b.roof[k + v * 3], b.roof[k + v * 3 + 1], b.roof[k + v * 3 + 2]])));
    for (let k = 0; k + 15 <= b.wall.length; k += 15)
      tris.push([0, 1, 2].map((v) => enuToPixel([b.wall[k + v * 5], b.wall[k + v * 5 + 1], b.wall[k + v * 5 + 2]])));
  }
  return tris;
}

const bounds = (tris: P2[][]) => {
  const xs = tris.flat().map((p) => p[0]), ys = tris.flat().map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** the grid window that holds the silhouette with the most room to its edges */
function pickWindow(tris: P2[][]): { win: [number, number]; room: number } {
  const [x0, y0, x1, y1] = bounds(tris);
  let best = { win: [0, 0] as [number, number], room: -Infinity };
  for (let i = Math.floor(x1 / STRIDE) - 1; i <= Math.floor(x0 / STRIDE); i++)
    for (let j = Math.floor(y1 / STRIDE) - 1; j <= Math.floor(y0 / STRIDE); j++) {
      const room = Math.min(x0 - i * STRIDE, y0 - j * STRIDE, i * STRIDE + WIN - x1, j * STRIDE + WIN - y1);
      if (room > best.room) best = { win: [i, j], room };
    }
  return best;
}

/** feathered alpha mask of the silhouette in window pixels */
async function mask(tris: P2[][], [i, j]: [number, number]) {
  const ox = i * STRIDE, oy = j * STRIDE;
  const polys = tris.map((t) => `<polygon points="${t.map((p) => `${(p[0] - ox).toFixed(1)},${(p[1] - oy).toFixed(1)}`).join(" ")}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIN}" height="${WIN}"><rect width="100%" height="100%" fill="black"/><g fill="white" stroke="white" stroke-width="${GROW * 2}" stroke-linejoin="round">${polys}</g></svg>`;
  return sharp(Buffer.from(svg)).blur(FEATHER / 2).greyscale().raw().toBuffer();
}

/** rebuild every cutout tile of the area: render + the painted buildings over it */
async function compose() {
  const out = join(base, "cutout");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const tiles = new Map<string, Array<{ c: Cutout; img: Buffer; a: Buffer }>>();
  for (const c of list) {
    const win = join(base, `windows-cutout-${c.name}`, `${c.window[0]}_${c.window[1]}.png`);
    if (!existsSync(win)) { console.warn(`  ${c.name}: not painted yet (${win})`); continue; }
    const tris = silhouette(buildingsAt(...c.at));
    const img = await sharp(win).removeAlpha().resize(WIN, WIN).raw().toBuffer(), a = await mask(tris, c.window);
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
  const [cname, ll] = rest.slice(1);
  const at = ll?.split(",").map(Number) as [number, number];
  if (!cname || !at || at.length !== 2) throw new Error(`usage: cutout.ts <area> ${flag} <name> <lat,lon>`);
  const bs = buildingsAt(...at), tris = silhouette(bs), [x0, y0, x1, y1] = bounds(tris);
  const { win, room } = pickWindow(tris);
  console.log(`  ${cname}: ${bs.length} LoD2 part(s), silhouette ${Math.round(x1 - x0)}×${Math.round(y1 - y0)} px, window ${win.join(",")}, ${Math.round(room)} px to its edge`);
  if (room < MARGIN) throw new Error(`no grid window holds ${cname} with ${MARGIN} px room`);
  if (flag === "--plan") {
    // preview: the render under the window, silhouette tinted (check it sits on the building)
    const ox = win[0] * STRIDE, oy = win[1] * STRIDE, parts = [];
    for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + WIN - 1) / T); tx++)
      for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + WIN - 1) / T); ty++) {
        const f = join(base, "render", `${tx}_${ty}.png`);
        if (existsSync(f)) parts.push({ input: await sharp(f).resize(T, T).toBuffer(), left: tx * T - ox + T, top: ty * T - oy + T });
      }
    const a = await mask(tris, win);
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
    next.push({ name: cname, at, window: win });
    list.splice(0, list.length, ...next);
    writeFileSync(listFile, JSON.stringify(list, null, 2));
    await compose();
  }
} else await compose();
