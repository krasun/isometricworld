/**
 * The salt mine's levels as their own maps (region `mine`, Wieliczka): one area per level (areas.ts, `mine`), each
 * drawn by the render page as a cutaway (page/mine.ts) under the town, every point under the spot it lies beneath.
 *
 *   npm -w pipeline run mine            # all levels: data/derived/wieliczka-mine-<level>/ground/…
 *
 * What a level holds (minedata.ts has the facts and their sources):
 *   known         the shafts and the mine's outline (OSM), the Groty Kryształowe reserve (GDOŚ via OSM)
 *   approximate   the named chambers of the routes, at their published level, size and order, placed schematically
 *                 round the shaft their route starts from (no open source gives where they lie)
 *   illustrative  galleries and chambers generated to the level's published chamber count inside its span of the
 *                 outline: longitudinal galleries along the deposit's strike, cross-cuts, chambers beside them;
 *                 the cut rock's build (k: mrock, LAYERED) and a few things hidden just for fun (k: megg, EGGS)
 * Everything is rasterised at 0.5 m and its outline traced (marching squares): the walls and the cut edge of the rock.
 *
 * Output per level (the render's usual ground dir, so render.ts and the page need nothing else):
 *   ground/meta.json, ground/height.bin   the town's terrain (wieliczka-town), cropped: the level is draped on it
 *   ground/features.json                  page/mine.ts features (k: mvoid, mfloor, mgal, mroute, mlake, mshaft, …)
 *   mine.json                             labels, the level's facts and its extent (export.ts, web)
 *
 * And the first level as Hondius engraved it in 1645 (area wieliczka-mine-1645): his plan (Commons, public domain,
 * data/raw/mine/hondius/) fitted on the three shafts it shares with today, drawn flat under the town (k: mimg).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AREAS } from "./areas.ts";
import { ecefToEnu, enuToLlh, llhToEcef, useRegion } from "./camera.ts";
import { contours, simplifyRing } from "./lawns.ts";
import sharp from "sharp";
import { CAP, CHAMBERS, COLLAR, EGGS, GROTTO, HONDIUS, LAYERED, LEVELS, SHAFTS, SOURCES, type Confidence, type MineChamber, type MineLevel } from "./minedata.ts";
import { FILTERS, localOsm } from "./osmlocal.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { REGIONS } from "./places.ts";

type P2 = [number, number];
type El = { type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }>; members?: Array<{ role: string; geometry?: Array<{ lat: number; lon: number }> }> };

const REGION = "wieliczka", TOWN = "wieliczka-town";
useRegion(REGION);
const RES = 0.5;
const CODE: Record<Confidence, number> = { illustrative: 1, approximate: 2, known: 3 };
const enu = (lat: number, lon: number): P2 => { const p = ecefToEnu(llhToEcef(lat, lon, 0)); return [p[0], p[1]]; };
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---- OSM: shafts, the outline, the reserve -------------------------------------------------------------
const rawDir = join(RAW, "wieliczka-mine");
mkdirSync(rawDir, { recursive: true });
const osmFile = join(rawDir, "osm-mine.json");
if (!existsSync(osmFile)) {
  const data = await localOsm(REGIONS[REGION].osmExtract!, [49.968, 20.015, 49.995, 20.1], FILTERS.mine);
  writeFileSync(osmFile, JSON.stringify(data));
}
const osm: { elements: El[] } = readJson(osmFile);
const ringOf = (el: El): P2[] => {
  const g = el.geometry ?? (el.members ?? []).filter((m) => m.role !== "inner").flatMap((m) => m.geometry ?? []);
  return g.map((q) => enu(q.lat, q.lon));
};
const centroid = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
const outlineEl = osm.elements.find((e) => e.tags?.historic === "mine" && e.tags?.location === "underground");
if (!outlineEl) throw new Error("no mine outline (historic=mine, location=underground) in OSM");
let outline = ringOf(outlineEl);
if (outline.length > 2 && outline[0][0] === outline.at(-1)![0] && outline[0][1] === outline.at(-1)![1]) outline = outline.slice(0, -1);
const reserveEl = osm.elements.find((e) => e.tags?.leisure === "nature_reserve" && e.tags?.location === "underground");
/** shafts by the name minedata.ts uses: the OSM element whose name shares the distinctive word */
const shaftAt = new Map<string, P2>();
for (const s of SHAFTS) {
  const word = s.name.replace(/^Szyb (św\. )?/, "").slice(0, 6);
  const els = osm.elements.filter((e) => e.tags?.man_made === "mineshaft" && `${e.tags?.name ?? ""} ${e.tags?.alt_name ?? ""}`.includes(word));
  const node = els.find((e) => e.type === "node" && e.lat !== undefined), way = els.find((e) => e.type !== "node");
  const p = node ? enu(node.lat!, node.lon!) : way ? centroid(ringOf(way)) : null;
  if (!p) { console.warn(`  no OSM shaft for ${s.name}`); continue; }
  shaftAt.set(s.name, p);
}

// ---- the outline's frame: s along the deposit's strike (its long axis), t across ---------------------
const C = centroid(outline);
let sxx = 0, syy = 0, sxy = 0;
for (const [x, y] of outline) { sxx += (x - C[0]) ** 2; syy += (y - C[1]) ** 2; sxy += (x - C[0]) * (y - C[1]); }
const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), U: P2 = [Math.cos(ang), Math.sin(ang)], V: P2 = [-U[1], U[0]];
const toST = ([x, y]: P2): P2 => [(x - C[0]) * U[0] + (y - C[1]) * U[1], (x - C[0]) * V[0] + (y - C[1]) * V[1]];
const fromST = ([s, t]: P2): P2 => [C[0] + U[0] * s + V[0] * t, C[1] + U[1] * s + V[1] * t];
const ss = outline.map((p) => toST(p)[0]), S0 = Math.min(...ss), S1 = Math.max(...ss);
const strike = Math.atan2(U[1], U[0]);

function inside([x, y]: P2, r: P2[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
/** the outline cut to s in [a, b] (Sutherland–Hodgman against two half-planes) */
function span(a: number, b: number): P2[] {
  const clip = (poly: P2[], keep: (p: P2) => number) => {
    const out: P2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], dp = keep(p), dq = keep(q);
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const k = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]); }
    }
    return out;
  };
  const sa = S0 + (S1 - S0) * a, sb = S0 + (S1 - S0) * b;
  return clip(clip(outline, (p) => toST(p)[0] - sa), (p) => sb - toST(p)[0]);
}

// ---- shapes -------------------------------------------------------------------------------------------
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** a chamber's floor: a rounded rectangle (a × b, turned by `rot`), its sides wavy when `wild` (the old irregular workings) */
function blob(c: P2, a: number, b: number, rot: number, wild: number, rnd: () => number): P2[] {
  const n = 28, out: P2[] = [], ph = [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * 2 * Math.PI, ct = Math.cos(th), st = Math.sin(th);
    // superellipse (exponent 4: a rectangle with rounded corners), radius modulated
    const e = 4, rr = 1 / Math.pow(Math.pow(Math.abs(ct), e) + Math.pow(Math.abs(st), e), 1 / e);
    const k = 1 + wild * (0.12 * Math.sin(3 * th + ph[0]) + 0.07 * Math.sin(5 * th + ph[1]) + 0.05 * Math.sin(7 * th + ph[2]));
    const x = (a / 2) * ct * rr * k, y = (b / 2) * st * rr * k;
    out.push([c[0] + x * Math.cos(rot) - y * Math.sin(rot), c[1] + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}
const scaleRing = (r: P2[], k: number): P2[] => { const c = centroid(r); return r.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]); };

type Room = { ring: P2[]; c: P2; rad: number; conf: Confidence; kind: string; name?: string; route?: string };
type Gallery = { line: P2[]; w: number; conf: Confidence; kind: "gallery" | "route" | "stub" };

// ---- the town's terrain, cropped round the mine --------------------------------------------------------
const townMeta = readJson(join(DERIVED, TOWN, "ground", "meta.json")) as { x0: number; y0: number; nx: number; ny: number; step: number };
const townH = new Float32Array(readFileSync(join(DERIVED, TOWN, "ground", "height.bin")).buffer.slice(0));
const oxs = outline.map((p) => p[0]), oys = outline.map((p) => p[1]), M = 500;
const cx0 = Math.max(0, Math.floor((Math.min(...oxs) - M - townMeta.x0) / townMeta.step)), cy0 = Math.max(0, Math.floor((Math.min(...oys) - M - townMeta.y0) / townMeta.step));
const cx1 = Math.min(townMeta.nx - 1, Math.ceil((Math.max(...oxs) + M - townMeta.x0) / townMeta.step)), cy1 = Math.min(townMeta.ny - 1, Math.ceil((Math.max(...oys) + M - townMeta.y0) / townMeta.step));
const meta = { x0: townMeta.x0 + cx0 * townMeta.step, y0: townMeta.y0 + cy0 * townMeta.step, nx: cx1 - cx0 + 1, ny: cy1 - cy0 + 1, step: townMeta.step };
const height = new Float32Array(meta.nx * meta.ny);
for (let j = 0; j < meta.ny; j++) for (let i = 0; i < meta.nx; i++) height[j * meta.nx + i] = townH[(cy0 + j) * townMeta.nx + cx0 + i];
const terrain = (x: number, y: number) => {
  const fx = Math.min(meta.nx - 1.001, Math.max(0, (x - meta.x0) / meta.step)), fy = Math.min(meta.ny - 1.001, Math.max(0, (y - meta.y0) / meta.step));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * meta.nx + ix;
  return (height[i] * (1 - ax) + height[i + 1] * ax) * (1 - ay) + (height[i + meta.nx] * (1 - ax) + height[i + meta.nx + 1] * ax) * ay;
};

// ---- one level -----------------------------------------------------------------------------------------
const levelIndex = (id: string) => LEVELS.findIndex((l) => l.id === id);
function build(level: MineLevel, li: number) {
  const rnd = rng(7919 * (li + 1));
  const ext = span(level.span[0], level.span[1]);
  const inExt = (p: P2) => inside(p, ext);
  const rooms: Room[] = [], gals: Gallery[] = [];
  const zones: Array<{ ring: P2[]; name: string }> = [];
  const upper = li <= 3; // levels I–III: the old, irregular workings in the salt boulders

  // known and schematic: shafts with their shaft-bottom chambers, the routes' chambers, the grotto
  const shafts = SHAFTS.filter((s) => shaftAt.has(s.name) && levelIndex(s.to) >= li);
  for (const s of shafts) {
    const p = shaftAt.get(s.name)!;
    rooms.push({ ring: blob(p, 22, 11, strike, 0.15, rnd), c: p, rad: 11, conf: "approximate", kind: "podszybie", name: s.name });
  }
  const mine = CHAMBERS.filter((c) => c.level === level.id && shaftAt.has(c.at.shaft));
  const placeOf = (c: MineChamber): P2 => { const s = shaftAt.get(c.at.shaft)!; return [s[0] + c.at.e, s[1] + c.at.n]; };
  for (const c of mine) {
    const p = placeOf(c), rot = strike + ((c.at.turn ?? 0) * Math.PI) / 180;
    rooms.push({ ring: blob(p, c.size[0], c.size[1], rot, 0.35, rnd), c: p, rad: Math.hypot(c.size[0], c.size[1]) / 2, conf: c.conf, kind: c.kind, name: c.name, route: c.route });
  }
  if (level.id === GROTTO.level && reserveEl) {
    const ring = ringOf(reserveEl), c = centroid(ring);
    zones.push({ ring, name: GROTTO.name });
    rooms.push({ ring: blob(c, 26, 12, strike + 0.4, 0.6, rnd), c, rad: 14, conf: "approximate", kind: "grotto", name: GROTTO.en });
  }
  // the routes through this level, in their published order, from/to their shafts
  const D = "Szyb Daniłowicza", R = "Szyb Regis";
  const routeLine = (route: "tourist" | "miners" | "museum") => {
    const pts = mine.filter((c) => c.route === route).map(placeOf);
    if (!pts.length) return;
    const start = route === "tourist" && level.id === "I" ? shaftAt.get(D) : route === "miners" && level.id === "I" ? shaftAt.get(R) : route === "museum" ? shaftAt.get(D) : null;
    const end = route === "tourist" && level.id === "III" ? shaftAt.get(D) : route === "miners" && level.id === "IIn" ? shaftAt.get(R) : null;
    const all = [...(start ? [start] : []), ...pts, ...(end ? [end] : [])];
    const line: P2[] = [all[0]];
    for (let i = 1; i < all.length; i++) { // a slight bend between two chambers, like a gallery following the salt
      const a = all[i - 1], b = all[i], m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const k = (rnd() - 0.5) * 0.25 * L;
      line.push([m[0] - ((b[1] - a[1]) / L) * k, m[1] + ((b[0] - a[0]) / L) * k], b);
    }
    gals.push({ line, w: 5, conf: "approximate", kind: "route" });
  };
  routeLine("tourist"); routeLine("miners"); if (level.id === "III") routeLine("museum");

  // illustrative: longitudinal galleries along the strike, cross-cuts between them, chambers beside them
  const st = ext.map(toST), es0 = Math.min(...st.map((p) => p[0])), es1 = Math.max(...st.map((p) => p[0]));
  const et0 = Math.min(...st.map((p) => p[1])), et1 = Math.max(...st.map((p) => p[1]));
  const lanes = Math.max(level.chambers < 10 ? 1 : 2, Math.min(6, Math.round((et1 - et0) / 210)));
  const longs: P2[][] = [];
  for (let k = 0; k < lanes; k++) {
    const t0 = et0 + ((k + 0.5) / lanes) * (et1 - et0) + (rnd() - 0.5) * 60, ph = rnd() * 6.3, ph2 = rnd() * 6.3;
    let run: P2[] = [];
    const flush = () => { if (run.length * 6 > 40) longs.push(run); run = []; };
    for (let s = es0; s <= es1; s += 6) {
      const p = fromST([s, t0 + 22 * Math.sin(s / 190 + ph) + 8 * Math.sin(s / 57 + ph2)]);
      if (inExt(p)) run.push(p); else flush();
    }
    flush();
  }
  for (const l of longs) gals.push({ line: l, w: 5, conf: "illustrative", kind: "gallery" });
  const tOf = (s: number) => longs.map((l) => { let best: P2 | null = null, bd = Infinity; for (const p of l) { const d = Math.abs(toST(p)[0] - s); if (d < bd) { bd = d; best = p; } } return bd < 8 ? toST(best!)[1] : null; }).filter((t): t is number => t !== null).sort((a, b) => a - b);
  // cross-cuts: between two neighbouring longitudinal galleries (or out to the edge), each on its own, staggered
  const density = Math.min(1, level.chambers / 160);
  const cut = (s: number, lo: number, hi: number, w: number) => {
    const tilt = (rnd() - 0.5) * 0.9, bow = (rnd() - 0.5) * 16;
    let run: P2[] = [];
    for (let t = lo; t <= hi; t += 5) {
      const u = (t - lo) / Math.max(1, hi - lo), p = fromST([s + (t - lo) * tilt + bow * Math.sin(u * Math.PI), t]);
      if (inExt(p)) run.push(p); else if (run.length) { if (run.length > 3) gals.push({ line: run, w, conf: "illustrative", kind: "gallery" }); run = []; }
    }
    if (run.length > 3) gals.push({ line: run, w, conf: "illustrative", kind: "gallery" });
  };
  for (let s = es0 + 20 + rnd() * 50; s < es1 - 20; s += 45 + rnd() * 90) {
    const ts = tOf(s);
    if (!ts.length || rnd() > 0.35 + 0.65 * density) continue;
    const edges = [rnd() < 0.3 ? et0 : null, ...ts, rnd() < 0.3 ? et1 : null].filter((t): t is number => t !== null);
    for (let k = 0; k + 1 < edges.length; k++) if (rnd() < 0.55) cut(s + (rnd() - 0.5) * 50, edges[k], edges[k + 1], 4);
  }
  // dead-end drifts off the galleries, at a slant
  const drifts = Math.round(level.chambers * 0.35);
  for (let i = 0; i < drifts; i++) {
    const g = gals[Math.floor(rnd() * gals.length)];
    if (g.conf !== "illustrative" || g.line.length < 2) continue;
    const p = g.line[Math.floor(rnd() * g.line.length)], th = strike + Math.PI / 2 + (rnd() - 0.5) * 1.6 + (rnd() < 0.5 ? Math.PI : 0), L = 25 + rnd() * 90;
    const line: P2[] = [p];
    for (let d = 6; d <= L; d += 6) { const q: P2 = [p[0] + Math.cos(th) * d + Math.sin(d / 9) * 1.5, p[1] + Math.sin(th) * d]; if (!inExt(q)) break; line.push(q); }
    if (line.length > 3) gals.push({ line, w: 3.5, conf: "illustrative", kind: "gallery" });
  }
  // chambers beside the galleries, up to the level's published count
  const want = Math.max(0, level.chambers - mine.length - (level.id === GROTTO.level ? 1 : 0));
  const spots = gals.filter((g) => g.conf === "illustrative").flatMap((g) => g.line.map((p, i) => [p, g.line[Math.min(g.line.length - 1, i + 1)], g.line[Math.max(0, i - 1)]] as [P2, P2, P2]));
  const near = (p: P2, r: number) => rooms.some((q) => Math.hypot(q.c[0] - p[0], q.c[1] - p[1]) < q.rad + r + (q.conf === "illustrative" ? 4 : 18));
  let placed = 0;
  for (let tries = 0; placed < want && tries < want * 40 && spots.length; tries++) {
    const [p, a, b] = spots[Math.floor(rnd() * spots.length)];
    const dx = a[0] - b[0], dy = a[1] - b[1], L = Math.hypot(dx, dy) || 1, side = rnd() < 0.5 ? -1 : 1;
    const area = Math.exp(Math.log(upper ? 230 : 340) + (rnd() + rnd() + rnd() - 1.5) * 1.1);
    const aspect = upper ? 1 + rnd() * 1.6 : 1.8 + rnd() * 2.4;
    const A = Math.sqrt(area * aspect), B = area / A;
    const rot = upper ? rnd() * Math.PI : strike + (rnd() - 0.5) * 0.4;
    const off = 2 + Math.min(A, B) / 2 + rnd() * 4, c: P2 = [p[0] - (dy / L) * off * side, p[1] + (dx / L) * off * side];
    const rad = Math.max(A, B) / 2;
    if (!inExt(c) || near(c, rad)) continue;
    const ring = blob(c, A, B, rot, upper ? 0.8 : 0.3, rnd);
    if (!ring.every(inExt)) continue;
    rooms.push({ ring, c, rad, conf: "illustrative", kind: rnd() < (upper ? 0.04 : 0.015) ? "lake" : "chamber" });
    gals.push({ line: [p, c], w: 3, conf: "illustrative", kind: "stub" });
    placed++;
  }
  // the named chambers, shaft bottoms and the grotto joined to the nearest illustrative gallery
  const galPts = gals.filter((g) => g.conf === "illustrative" && g.kind === "gallery").flatMap((g) => g.line);
  for (const r of rooms.filter((q) => q.conf !== "illustrative")) {
    if (r.route && rnd() < 0.7) continue; // the route already reaches most
    let best: P2 | null = null, bd = Infinity;
    for (const p of galPts) { const d = Math.hypot(p[0] - r.c[0], p[1] - r.c[1]); if (d < bd) { bd = d; best = p; } }
    if (best && bd < 400) gals.push({ line: [r.c, best], w: 3.5, conf: "illustrative", kind: "stub" });
  }
  // a little life: lamps along the routes and in their chambers, chandeliers in chapels, timber cribs, rails, lakes
  const lamps: number[][] = [], cribs: Array<{ ring: P2[]; h: number }> = [], rails: P2[][] = [], lakes: P2[][] = [];
  for (const g of gals.filter((q) => q.kind === "route")) {
    let carry = 0;
    for (let i = 1; i < g.line.length; i++) {
      const [a, b] = [g.line[i - 1], g.line[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let d = 9 - carry; d < L; d += 9) { const k = d / L; lamps.push([r2(a[0] + (b[0] - a[0]) * k + ((a[1] - b[1]) / L) * 1.3), r2(a[1] + (b[1] - a[1]) * k + ((b[0] - a[0]) / L) * 1.3), 0]); }
      carry = (L + carry) % 9;
    }
  }
  for (const r of rooms) {
    if (r.kind === "lake") lakes.push(scaleRing(r.ring, 0.78));
    if (r.kind === "chapel") for (const k of [-0.25, 0.25]) lamps.push([r2(r.c[0] + Math.cos(strike) * k * r.rad), r2(r.c[1] + Math.sin(strike) * k * r.rad), 1]);
    else if (r.conf !== "illustrative" && r.kind !== "lake") for (let i = 0; i < 3; i++) { const q = r.ring[Math.floor((i / 3) * r.ring.length)]; lamps.push([r2(r.c[0] + (q[0] - r.c[0]) * 0.6), r2(r.c[1] + (q[1] - r.c[1]) * 0.6), 0]); }
    const timber = r.name === "Komora Michałowice" || r.name === "Komora Boczaniec" || (r.conf === "illustrative" && upper && r.kind === "chamber" && rnd() < 0.22);
    if (timber) {
      const n = r.name ? 4 : 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const q = r.ring[Math.floor(rnd() * r.ring.length)], k = 0.2 + rnd() * 0.35, c: P2 = [r.c[0] + (q[0] - r.c[0]) * k, r.c[1] + (q[1] - r.c[1]) * k];
        const w = 1.6 + rnd() * 1.4, d = 1.6 + rnd() * 1.4, rot = strike + rnd() * 0.3;
        cribs.push({ ring: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [r2(c[0] + (u * w * Math.cos(rot) - v * d * Math.sin(rot)) / 2), r2(c[1] + (u * w * Math.sin(rot) + v * d * Math.cos(rot)) / 2)] as P2), h: r2(1.4 + rnd() * 0.9) });
      }
    }
  }
  if (li >= 3) for (const l of longs) if (rnd() < 0.5) rails.push(l);

  // ---- rasterise the voids, trace their outline ------------------------------------------------------
  const all = [...rooms.flatMap((r) => r.ring), ...gals.flatMap((g) => g.line)];
  const bx0 = Math.min(...all.map((p) => p[0])) - 12, by0 = Math.min(...all.map((p) => p[1])) - 12;
  const W = Math.ceil((Math.max(...all.map((p) => p[0])) + 12 - bx0) / RES), H = Math.ceil((Math.max(...all.map((p) => p[1])) + 12 - by0) / RES);
  const code = new Uint8Array(W * H);
  const mark = (i: number, j: number, v: number) => { if (i >= 0 && j >= 0 && i < W && j < H) { const k = j * W + i; if (code[k] < v) code[k] = v; } };
  for (const r of rooms) { // scanline fill at cell centres
    const v = CODE[r.conf], ys = r.ring.map((p) => p[1]);
    for (let j = Math.floor((Math.min(...ys) - by0) / RES); j <= Math.ceil((Math.max(...ys) - by0) / RES); j++) {
      const y = by0 + (j + 0.5) * RES, xs: number[] = [];
      for (let a = 0, b = r.ring.length - 1; a < r.ring.length; b = a++) {
        const [xa, ya] = r.ring[a], [xb, yb] = r.ring[b];
        if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let i = Math.ceil((xs[k] - bx0) / RES - 0.5); i <= Math.floor((xs[k + 1] - bx0) / RES - 0.5); i++) mark(i, j, v);
    }
  }
  for (const g of gals) {
    const v = CODE[g.conf], h = g.w / 2;
    for (let s = 1; s < g.line.length; s++) {
      const [a, b] = [g.line[s - 1], g.line[s]], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
      const i0 = Math.floor((Math.min(a[0], b[0]) - h - bx0) / RES), i1 = Math.ceil((Math.max(a[0], b[0]) + h - bx0) / RES);
      const j0 = Math.floor((Math.min(a[1], b[1]) - h - by0) / RES), j1 = Math.ceil((Math.max(a[1], b[1]) + h - by0) / RES);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = bx0 + (i + 0.5) * RES, y = by0 + (j + 0.5) * RES, k = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
        if (Math.hypot(x - a[0] - k * dx, y - a[1] - k * dy) <= h) mark(i, j, v);
      }
    }
  }
  const f = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) f[k] = code[k] ? 1 : 0;
  const rings = contours(f, W, H, 0, 0, W, H, 0.5).map((r) => r.map(([i, j]) => [bx0 + (i + 0.5) * RES, by0 + (j + 0.5) * RES] as P2))
    .map((r) => simplifyRing(r, 0.12)).filter((r) => r.length >= 3);
  const codeAt = ([x, y]: P2) => {
    for (const d of [0, 1, 2, 3]) for (const [u, v] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = Math.floor((x - bx0) / RES) + u * d, j = Math.floor((y - by0) / RES) + v * d;
      if (i >= 0 && j >= 0 && i < W && j < H && code[j * W + i]) return code[j * W + i];
    }
    return 1;
  };

  // ---- features for the page (page/mine.ts) -----------------------------------------------------------
  const rr = (r: P2[]) => r.map(([x, y]) => [r2(x), r2(y)]);
  const feats: unknown[] = [];
  for (const r of rings) feats.push({ k: "mvoid", r: [rr(r)], c: r.map(codeAt) });
  for (const r of rooms) feats.push({ k: "mfloor", r: [rr(r.ring)], u: r.kind, v: CODE[r.conf] });
  for (const g of gals) feats.push({ k: g.kind === "route" ? "mroute" : "mgal", l: rr(g.line), w: g.w, v: CODE[g.conf] });
  for (const l of lakes) feats.push({ k: "mlake", r: [rr(l)] });
  for (const c of cribs) feats.push({ k: "mcrib", r: [rr(c.ring)], w: c.h });
  for (const l of rails) feats.push({ k: "mrail", l: rr(l) });
  for (const z of zones) feats.push({ k: "mzone", r: [rr(z.ring)] });
  for (const s of shafts) { const p = shaftAt.get(s.name)!; feats.push({ k: "mshaft", l: [[r2(p[0]), r2(p[1])]], w: 2.4, v: CODE[s.conf] }); }
  if (lamps.length) feats.push({ k: "mlamp", j: lamps });

  // ---- the rock: its build (page/mine.ts draws the beds and boulders) and the things hidden in it ------------
  // e: the strike frame (centre, long axis U; t across, positive north) and where the layered deposit ends, t
  const ts = outline.map((p) => toST(p)[1]), T0 = Math.min(...ts), T1 = Math.max(...ts);
  feats.push({ k: "mrock", e: [r2(C[0]), r2(C[1]), +U[0].toFixed(6), +U[1].toFixed(6), r2(T0 + (T1 - T0) * (LAYERED[level.id] ?? 0.5)), li] });
  // each egg on solid rock: no void within its size and a margin, inside the level's extent, as near its anchor as that allows
  const solid = (p: P2, r: number) => {
    for (let a = 0; a < 16; a++) if (!inExt([p[0] + r * Math.cos(a * 0.3927), p[1] + r * Math.sin(a * 0.3927)])) return false;
    for (let y = p[1] - r; y <= p[1] + r; y += RES) for (let x = p[0] - r; x <= p[0] + r; x += RES) {
      const i = Math.floor((x - bx0) / RES), j = Math.floor((y - by0) / RES);
      if (i >= 0 && j >= 0 && i < W && j < H && code[j * W + i] && Math.hypot(x - p[0], y - p[1]) <= r) return false;
    }
    return true;
  };
  const eggRnd = rng(104729 * (li + 1)), eggs: Array<{ egg: (typeof EGGS)[number]; p: P2; turn: number }> = [];
  for (const egg of EGGS.filter((e) => e.level === level.id)) {
    const from = (egg.near && (rooms.find((r) => r.name === egg.near)?.c ?? shaftAt.get(egg.near))) || centroid(ext);
    let at: P2 | null = null;
    for (let d = 0; d < 600 && !at; d += 4) for (let a = 0, n = Math.max(1, Math.round(d / 3)); a < n && !at; a++) {
      const th = (a / n) * 2 * Math.PI + eggRnd(), q: P2 = [from[0] + d * Math.cos(th), from[1] + d * Math.sin(th)];
      if (solid(q, egg.size / 2 + 4)) at = q;
    }
    if (!at) { console.warn(`  ${level.id}: no room for ${egg.name}`); continue; }
    const turn = Math.round((eggRnd() - 0.5) * 50);
    eggs.push({ egg, p: at, turn });
    feats.push({ k: "megg", u: egg.kind, l: [[r2(at[0]), r2(at[1])]], w: egg.size, v: turn });
  }

  // ---- labels and facts (export.ts → web) ----------------------------------------------------------------
  const at = (p: P2) => { const z = terrain(p[0], p[1]) + CAP; const [lat, lon] = enuToLlh([p[0], p[1], 0]); return { x: r2(p[0]), y: r2(p[1]), z: r2(z), lat: +lat.toFixed(6), lon: +lon.toFixed(6) }; };
  // labels by the names on the map (English); minedata.ts keys them by their Polish (OSM) names
  const labels = [
    ...rooms.filter((r) => r.name && r.kind !== "podszybie").map((r) => {
      const c = CHAMBERS.find((q) => q.name === r.name);
      return { name: c?.en ?? r.name!, kind: r.kind, conf: r.conf, route: r.route ?? null, depth: c?.depth ?? null, height: c?.height ?? null, src: c?.src ?? "osm", ...at(r.c) };
    }),
    ...shafts.map((s) => ({ name: s.en, kind: "shaft", conf: s.conf, route: null, depth: s.depth ?? null, height: null, src: "osm", note: s.note, ...at(shaftAt.get(s.name)!) })),
    ...eggs.map(({ egg, p }) => ({ name: egg.name, kind: "egg", conf: "illustrative", route: null, depth: null, height: null, src: "fun", note: egg.note, size: egg.size, ...at(p) })),
  ];
  const info = {
    id: level.id, name: level.name, depth: level.depth, tourist: level.tourist ?? null, elevation: r2(COLLAR - level.depth),
    chambers: level.chambers, note: level.note, generated: placed, cap: CAP,
    extent: ext.map((p) => [r2(p[0]), r2(p[1])]), labels,
  };
  const dir = join(DERIVED, `wieliczka-mine-${level.id}`), gdir = join(dir, "ground");
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(gdir, "height.bin"), Buffer.from(height.buffer));
  writeFileSync(join(gdir, "features.json"), JSON.stringify(feats));
  writeFileSync(join(dir, "mine.json"), JSON.stringify(info));
  const galLen = gals.reduce((a, g) => a + g.line.slice(1).reduce((b, p, i) => b + Math.hypot(p[0] - g.line[i][0], p[1] - g.line[i][1]), 0), 0);
  console.log(`  ${level.id.padEnd(4)} ${level.depth} m: ${rooms.length} chambers (${placed} illustrative of ${level.chambers}), ${(galLen / 1000).toFixed(1)} km of galleries, ${rings.length} outlines, ${shafts.length} shafts`);
}

/** Hondius's 1645 plan of the first level, fitted on its three surviving shafts (similarity, least squares). */
async function build1645() {
  const file = join(RAW, "wieliczka-mine", "hondius", HONDIUS.file);
  const alt = join(RAW, "mine", "hondius", HONDIUS.file);
  const src = existsSync(file) ? file : alt;
  if (!existsSync(src)) { console.warn(`  1645: no ${HONDIUS.file} (download ${HONDIUS.url} into data/raw/mine/hondius/)`); return; }
  // (u, -v): the image's rows run down; a similarity on the flipped frame keeps the plan unmirrored
  const P = Object.entries(HONDIUS.control).filter(([n]) => shaftAt.has(n)).map(([n, [u, v]]) => ({ n, u, w: -v, xy: shaftAt.get(n)! }));
  const k = P.length, mu = P.reduce((a, q) => a + q.u, 0) / k, mw = P.reduce((a, q) => a + q.w, 0) / k;
  const mx = P.reduce((a, q) => a + q.xy[0], 0) / k, my = P.reduce((a, q) => a + q.xy[1], 0) / k;
  let s2 = 0, sa = 0, sb = 0;
  for (const q of P) { const du = q.u - mu, dw = q.w - mw, dx = q.xy[0] - mx, dy = q.xy[1] - my; s2 += du * du + dw * dw; sa += du * dx + dw * dy; sb += du * dy - dw * dx; }
  const p = sa / s2, q = sb / s2, tx = mx - p * mu + q * mw, ty = my - q * mu - p * mw;
  const toEnu = ([u, v]: [number, number]): P2 => [p * u + q * v + tx, q * u - p * v + ty];
  const res = P.map((c) => Math.hypot(toEnu([c.u, -c.w])[0] - c.xy[0], toEnu([c.u, -c.w])[1] - c.xy[1]));
  // the plan, halved (0.31 m per pixel: the render's ground is 0.15 m, the engraving's lines are ~5 px)
  const [u0, v0, u1, v1] = HONDIUS.crop, F = 2;
  const dir = join(DERIVED, "wieliczka-mine-1645"), gdir = join(dir, "ground");
  mkdirSync(gdir, { recursive: true });
  await sharp(src, { limitInputPixels: false }).extract({ left: u0, top: v0, width: u1 - u0, height: v1 - v0 })
    .resize(Math.round((u1 - u0) / F)).jpeg({ quality: 86 }).toFile(join(gdir, "hondius-I.jpg"));
  // canvas transform: downscaled image px (u', v') → ENU
  const e = [F * p, F * q, F * q, -F * p, p * u0 + q * v0 + tx, q * u0 - p * v0 + ty].map((v) => Math.round(v * 1e6) / 1e6);
  const corners = ([[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as Array<[number, number]>).map(toEnu);
  writeFileSync(join(gdir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(gdir, "height.bin"), Buffer.from(height.buffer));
  writeFileSync(join(gdir, "features.json"), JSON.stringify([{ k: "mimg", u: "hondius-I.jpg", e, r: [corners.map(([x, y]) => [r2(x), r2(y)])] }]));
  const at = (pt: P2) => { const z = terrain(pt[0], pt[1]); return { x: r2(pt[0]), y: r2(pt[1]), z: r2(z) }; };
  const labels = [
    ...Object.keys(HONDIUS.control).filter((n) => shaftAt.has(n)).map((n) => ({ name: SHAFTS.find((s) => s.name === n)?.en ?? n, kind: "shaft", conf: "known", route: null, depth: null, height: null, src: "osm", ...at(shaftAt.get(n)!) })),
    ...Object.entries(HONDIUS.gone).map(([n, uv]) => ({ name: n, kind: "shaft", conf: "approximate", route: null, depth: null, height: null, src: "hondius", note: "1645; gone today", ...at(toEnu(uv)) })),
    ...Object.entries(HONDIUS.chambers).map(([n, uv]) => ({ name: n, kind: "chamber", conf: "approximate", route: null, depth: null, height: null, src: "hondius", ...at(toEnu(uv)) })),
  ];
  const lev = LEVELS[0];
  writeFileSync(join(dir, "mine.json"), JSON.stringify({
    id: "1645", name: "1645 plan", depth: lev.depth + 0.1, tourist: lev.tourist, elevation: r2(COLLAR - lev.depth), chambers: 234, generated: 0, cap: 0, historic: true,
    note: "level I on Willem Hondius's 1645 plan after Marcin German's 1638 survey, fitted on the Regis, Daniłowicz and Górsko shafts",
    fit: { scale: r2(Math.hypot(p, q)), turn: r2((Math.atan2(q, p) * 180) / Math.PI), residuals: res.map(r2) },
    extent: corners.map(([x, y]) => [r2(x), r2(y)]), labels,
  }));
  console.log(`  1645: Hondius plan fitted on ${k} shafts, ${Math.hypot(p, q).toFixed(3)} m/px, turned ${((Math.atan2(q, p) * 180) / Math.PI).toFixed(1)}°, residuals ${res.map((r) => r.toFixed(1)).join(", ")} m`);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!only.length || only.includes("1645")) await build1645();
for (const [i, level] of LEVELS.entries()) {
  if (only.length && !only.includes(level.id)) continue;
  if (!AREAS[`wieliczka-mine-${level.id}`]) throw new Error(`areas.ts lacks wieliczka-mine-${level.id}`);
  build(level, i);
}
console.log(`  sources: ${Object.keys(SOURCES).join(", ")}`);
