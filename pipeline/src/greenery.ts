/**
 * Tree crowns for Zagreb (sources "zg3d"), which has no open canopy layer: generated deterministically from
 * OSM land cover, around the trees OSM maps one by one. Stuttgart finds its crowns in the nDOM surface model
 * and Tel Aviv in the municipal canopy layer; here OSM only maps street and park trees individually, so woods,
 * park interiors, cemeteries, scrub, orchards and tree rows would otherwise stay bare.
 *
 * Method: the land cover is burnt into a 2 m raster (the spatial index for every test): which OSM area each
 * cell is in (smaller areas over larger ones, so a wood inside a park is wood) and what blocks a trunk there
 * (buildings, water, roads, rail, paths, paved and sports ground). Crowns then come from a lattice anchored
 * at the ENU origin, jittered by hashes of the lattice cell, so neighbouring areas generate the same crowns
 * where they overlap and every run is identical:
 *   woods    closed canopy, stands of three ages (young / pole / old), species by altitude and riverbanks
 *   parks    clumps from a smooth noise field (~45 % cover, less on mapped lawns), solitaires on the lawns,
 *            alleys along some paths; gardens, cemeteries and recreation grounds thinner (cemeteries: thuja)
 *   scrub    low small crowns; orchards: fruit trees in rows along the orchard's long side
 *   rows     natural=tree_row: one species per row, every ~8 m
 *   homes    residential land, school and hospital grounds, untagged land: a few garden trees in small clumps,
 *            kept off the walls (the Podsljeme villa gardens; Lower Town courtyards)
 * Areas OSM already maps tree by tree (a third of the area within 10 m of a mapped tree: Zrinjevac,
 * Strossmayer) get nothing, and no crown is generated within a few metres of a mapped tree.
 */
import { ROAD, roadWidth } from "./roadspec.ts";
import { zgSpecies } from "./species.ts";

type P2 = [number, number];
type Tags = Record<string, string>;
/** x, y, crown radius, crown centre above ground, species (species.ts index) */
export type Crown = [number, number, number, number, number];

export interface GreeneryInput {
  ground: any[];                          // ground.json elements (Overpass `out geom` shape)
  rows: any[];                            // natural=tree_row ways
  mapped: P2[];                           // trees OSM maps one by one (natural=tree), ENU
  buildings: P2[][];                      // footprints (ZG3D + OSM), ENU
  box: [number, number, number, number];  // ENU [minx, miny, maxx, maxy] to fill
  toXY: (lon: number, lat: number) => P2;
  msl: (x: number, y: number) => number;  // terrain height above sea level (m)
}

const CELL = 2;
// blocker bits
const BUILD = 1, WATER = 2, PAVED = 4, ROADS = 8, PATHS = 16, LAWN = 32;
const HARD = BUILD | WATER | PAVED | ROADS | PATHS;
// land cover kinds (an area's kind decides density, crown sizes and species)
const WOOD = 1, PARK = 2, GARDEN = 3, CEMETERY = 4, REC = 5, SCRUB = 6, ORCHARD = 7, OPEN = 8, HOMES = 9, CAMPUS = 10, WORK = 11;
const KIND_NAME = ["", "wood", "park", "garden", "cemetery", "recreation", "scrub", "orchard", "", "home gardens", "campus", "", "untagged land"];

function kindOf(t: Tags): number {
  const lu = t.landuse ?? "", na = t.natural ?? "", le = t.leisure ?? "";
  if (lu === "forest" || na === "wood") return WOOD;
  if (na === "scrub") return SCRUB;
  if (lu === "orchard") return ORCHARD;
  if (lu === "cemetery" || t.amenity === "grave_yard") return CEMETERY;
  if (le === "park" || lu === "village_green" || t["garden:type"] === "botanical") return PARK;
  if (le === "garden") return GARDEN;
  if (/^(recreation_ground|dog_park|golf_course)$/.test(le) || lu === "recreation_ground") return REC;
  // clearings: a meadow in a wood or a park stays open
  if (/^(meadow|farmland|allotments|vineyard|plant_nursery|greenhouse_horticulture|farmyard)$/.test(lu)
    || /^(grassland|heath|wetland|bare_rock|beach|sand)$/.test(na)) return OPEN;
  // gardens around houses and blocks; school and hospital grounds; none on commercial and industrial land
  if (lu === "residential") return HOMES;
  if (/^(school|university|college|hospital)$/.test(t.amenity ?? "") || lu === "education") return CAMPUS;
  if (/^(commercial|retail|industrial|railway|military|port|depot|garages|construction|brownfield|landfill|quarry)$/.test(lu)) return WORK;
  return 0;
}
function blockOf(t: Tags): number {
  if (t.natural === "water" || t.water || t.waterway === "riverbank" || /^(basin|reservoir)$/.test(t.landuse ?? "")) return WATER;
  if (t.amenity === "parking" || t.amenity === "fountain" || t["area:highway"] || t.place === "square" || (t.highway && t.area === "yes")
    || /^(pitch|playground|track|stadium|swimming_pool)$/.test(t.leisure ?? "")
    || /^(flowerbed|construction|railway|garages|landfill)$/.test(t.landuse ?? "")
    || /^(bunker|green|tee|fairway|driving_range)$/.test(t.golf ?? "") || t.aeroway
    || /^(pier|bridge|breakwater)$/.test(t.man_made ?? "")) return PAVED;
  if (t.landuse === "grass") return LAWN;
  return 0;
}
/** footpath widths (m), as ground.ts draws them */
const PATH: Record<string, number> = { pedestrian: 5, footway: 2.2, path: 1.6, cycleway: 2, steps: 2.5, bridleway: 2, corridor: 2 };

// ---- hashing and noise (deterministic, anchored at the ENU origin) -------------------------------
const h2 = (i: number, j: number, s: number) => {
  let x = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 2 ** 32;
};
/** smooth value noise in [0, 1) with features ~`scale` m apart */
function noise(x: number, y: number, scale: number, seed: number) {
  const fx = x / scale, fy = y / scale, i = Math.floor(fx), j = Math.floor(fy);
  const u = fx - i, v = fy - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = h2(i, j, seed) + (h2(i + 1, j, seed) - h2(i, j, seed)) * su;
  const b = h2(i, j + 1, seed) + (h2(i + 1, j + 1, seed) - h2(i, j + 1, seed)) * su;
  return a + (b - a) * sv;
}
/** park cover field: big groves with ragged edges */
const coverField = (x: number, y: number) => 0.65 * noise(x, y, 46, 11) + 0.35 * noise(x, y, 15, 12);
/** cover -> threshold on coverField (its distribution is not uniform: sampled once) */
const COVER_Q = (() => {
  const v: number[] = [];
  for (let k = 0; k < 8192; k++) v.push(coverField(h2(k, 1, 91) * 1e5, h2(k, 2, 92) * 1e5));
  return v.sort((a, b) => a - b);
})();
const thresholdFor = (cover: number) => COVER_Q[Math.min(COVER_Q.length - 1, Math.floor((1 - cover) * COVER_Q.length))];

// ---- species mixes -------------------------------------------------------------------------------
type Mix = Array<[number, number]>; // [species index, cumulative weight 0..1]
function mix(m: Record<string, number>): Mix {
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  let acc = 0;
  return Object.entries(m).map(([n, w]) => [zgSpecies(n), (acc += w) / total]);
}
const pick = (m: Mix, u: number) => (m.find(([, c]) => u < c) ?? m[m.length - 1])[0];
const MIX = {
  // Lower Town streets and squares: plane and horse chestnut avenues, linden, maple
  street: mix({ plane: 24, "horse chestnut": 18, linden: 20, maple: 14, birch: 5, cherry: 4, "black locust": 6, spruce: 4, pine: 5 }),
  park: mix({ plane: 14, "horse chestnut": 14, linden: 14, maple: 13, oak: 12, beech: 6, birch: 7, hornbeam: 6, cherry: 3, spruce: 6, pine: 5 }),
  garden: mix({ "fruit tree": 24, maple: 13, linden: 9, birch: 12, cherry: 4, "black locust": 8, spruce: 10, thuja: 12, pine: 8 }),
  cemetery: mix({ linden: 18, "horse chestnut": 14, maple: 10, birch: 8, thuja: 30, spruce: 10, pine: 10 }),
  // Maksimir and the lowland woods: pedunculate oak and hornbeam
  lowland: mix({ oak: 32, hornbeam: 26, maple: 8, linden: 7, birch: 6, "black locust": 9, beech: 4, pine: 4, spruce: 4 }),
  // Medvednica foothills: sessile oak, hornbeam, beech, sweet chestnut
  hill: mix({ beech: 24, oak: 20, hornbeam: 22, "sweet chestnut": 12, maple: 6, birch: 4, spruce: 6, fir: 4, pine: 2 }),
  // upper Medvednica: beech and fir
  mountain: mix({ beech: 52, fir: 18, spruce: 12, maple: 8, hornbeam: 6, birch: 4 }),
  // Sava and stream banks, ponds
  riparian: mix({ willow: 36, poplar: 24, "black locust": 14, maple: 10, oak: 10, hornbeam: 6 }),
  scrub: mix({ shrub: 74, birch: 10, "black locust": 16 }),
  row: mix({ plane: 22, "horse chestnut": 22, linden: 24, maple: 14, poplar: 10, birch: 4, "black locust": 4 }),
  alley: mix({ plane: 25, "horse chestnut": 30, linden: 30, maple: 15 }),
  cemeteryAlley: mix({ linden: 35, "horse chestnut": 30, thuja: 35 }),
};
/** mostly one species per patch (planted and grown in groups), every 4th tree its own */
const patchPick = (m: Mix, x: number, y: number, size: number, seed: number) =>
  pick(m, h2(Math.round(x * 10), Math.round(y * 10), seed) < 0.25 ? h2(Math.round(y * 10), Math.round(x * 10), seed + 1) : h2(Math.floor(x / size), Math.floor(y / size), seed + 2));

/** OSM genus / species / taxon -> species index (the first word is the genus) */
const GENUS: Record<string, string> = {
  platanus: "plane", aesculus: "horse chestnut", tilia: "linden", acer: "maple", quercus: "oak", carpinus: "hornbeam",
  fagus: "beech", betula: "birch", prunus: "cherry", malus: "fruit tree", pyrus: "fruit tree", robinia: "black locust",
  salix: "willow", populus: "poplar", castanea: "sweet chestnut", pinus: "pine", picea: "spruce", abies: "fir",
  thuja: "thuja", cupressus: "thuja", chamaecyparis: "thuja", juniperus: "thuja", taxus: "thuja", sequoiadendron: "spruce",
  cedrus: "pine", larix: "spruce", celtis: "linden", ulmus: "hornbeam", fraxinus: "maple", gleditsia: "black locust",
  sophora: "black locust", styphnolobium: "black locust", catalpa: "horse chestnut", liriodendron: "plane", ginkgo: "birch",
};
export function osmTreeSpecies(t: Tags, x: number, y: number): number {
  const g = (t.genus ?? t["genus:la"] ?? t.species ?? t["species:la"] ?? t.taxon ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (GENUS[g]) return zgSpecies(GENUS[g]);
  if (t.leaf_type === "needleleaved") return zgSpecies(h2(Math.round(x), Math.round(y), 5) < 0.5 ? "spruce" : "pine");
  return patchPick(MIX.street, x, y, 40, 20);
}
/** A mapped tree's crown: OSM diameter_crown / height where tagged, else a city tree of 5–8 m crown. */
export function osmTreeCrown(t: Tags, x: number, y: number): Crown {
  const sp = osmTreeSpecies(t, x, y), u = h2(Math.round(x * 10), Math.round(y * 10), 6);
  const d = parseFloat(t.diameter_crown), h = parseFloat(t.height);
  const big = sp === zgSpecies("plane") || sp === zgSpecies("horse chestnut") ? 0.6 : 0; // old Lower Town avenues
  const r = d > 1 && d < 40 ? d / 2 : 2.6 + 1.3 * u + big;
  const ch = h > 2 && h < 60 ? Math.max(r * 0.8 + 1, h - r * 0.9) : r * 2 + 0.5 * u;
  return [x, y, r, ch, sp];
}

// ---- geometry ------------------------------------------------------------------------------------
/** Join way pieces sharing endpoints into chains (closed rings where they close); as in ground.ts. */
function joinWays(pieces: P2[][]): P2[][] {
  const key = (p: P2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const left = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const out: P2[][] = [];
  while (left.length) {
    let chain = left.pop()!;
    for (let grown = true; grown && key(chain[0]) !== key(chain.at(-1)!);) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], a = key(p[0]), b = key(p.at(-1)!);
        if (a === key(chain.at(-1)!)) chain = [...chain, ...p.slice(1)];
        else if (b === key(chain.at(-1)!)) chain = [...chain, ...p.slice(0, -1).reverse()];
        else if (b === key(chain[0])) chain = [...p, ...chain.slice(1)];
        else if (a === key(chain[0])) chain = [...p.slice(1).reverse(), ...chain];
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(chain);
  }
  return out;
}
const closed = (c: P2[]) => c.length > 3 && c[0][0] === c.at(-1)![0] && c[0][1] === c.at(-1)![1];
const ringArea = (r: P2[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(a / 2); };

export function greenery(inp: GreeneryInput) {
  const [bx0, by0, bx1, by1] = inp.box;
  const nx = Math.ceil((bx1 - bx0) / CELL), ny = Math.ceil((by1 - by0) / CELL);
  const owner = new Int32Array(nx * ny); // area index + 1
  const bits = new Uint8Array(nx * ny);
  const cellAt = (x: number, y: number) => {
    const i = Math.floor((x - bx0) / CELL), j = Math.floor((y - by0) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  const bitsAt = (x: number, y: number) => { const c = cellAt(x, y); return c < 0 ? 0 : bits[c]; };
  const geom = (g: Array<{ lat: number; lon: number }>) => g.map((q) => inp.toXY(q.lon, q.lat));
  const touches = (rings: P2[][]) => rings.some((r) => r.some(([x, y]) => x > bx0 - 500 && x < bx1 + 500 && y > by0 - 500 && y < by1 + 500))
    || rings.some((r) => { // a big wood around the whole box has no vertex near it
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
      return a < bx1 && c > bx0 && b < by1 && d > by0;
    });

  /** scanline fill (even-odd over all rings) of the cells whose centre is inside */
  function fill(rings: P2[][], cb: (c: number) => void) {
    let y0 = Infinity, y1 = -Infinity;
    for (const r of rings) for (const p of r) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const j0 = Math.max(0, Math.floor((y0 - by0) / CELL)), j1 = Math.min(ny - 1, Math.ceil((y1 - by0) / CELL));
    for (let j = j0; j <= j1; j++) {
      const y = by0 + (j + 0.5) * CELL, xs: number[] = [];
      for (const r of rings)
        for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
          const [xi, yi] = r[i], [xk, yk] = r[k];
          if (yi > y !== yk > y) xs.push(xi + ((y - yi) * (xk - xi)) / (yk - yi));
        }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil((xs[k] - bx0) / CELL - 0.5)), b = Math.min(nx - 1, Math.floor((xs[k + 1] - bx0) / CELL - 0.5));
        for (let i = a; i <= b; i++) cb(j * nx + i);
      }
    }
  }
  /** a line `half` m to either side */
  function stroke(l: P2[], half: number, bit: number) {
    const rc = Math.ceil(half / CELL);
    for (let s = 1; s < l.length; s++) {
      const [ax, ay] = l[s - 1], [bx, by] = l[s], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL * 0.5)));
      for (let k = 0; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
        const ci = Math.floor((x - bx0) / CELL), cj = Math.floor((y - by0) / CELL);
        for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
          if (Math.hypot(bx0 + (i + 0.5) * CELL - x, by0 + (j + 0.5) * CELL - y) <= half) bits[j * nx + i] |= bit;
        }
      }
    }
  }

  // 1. Burn the land cover in.
  const areas: Array<{ kind: number; rings: P2[][]; area: number; id: number }> = [];
  const paths: Array<{ l: P2[]; w: number; id: number }> = [];
  for (const el of inp.ground) {
    const t: Tags = el.tags ?? {};
    let rings: P2[][] | null = null;
    if (el.type === "way" && el.geometry?.length >= 2) {
      const g = geom(el.geometry);
      const line = (t.highway && t.area !== "yes") || t.railway;
      if (line) {
        if (!g.some(([x, y]) => x > bx0 - 50 && x < bx1 + 50 && y > by0 - 50 && y < by1 + 50)) continue;
        if (t.railway) { if (/^(rail|light_rail)$/.test(t.railway)) stroke(g, 3.5, ROADS); continue; } // trams run in the streets
        if (ROAD[t.highway]) stroke(g, roadWidth(t) / 2 + (ROAD[t.highway][1] ? 1.5 : 0.6), ROADS);
        else if (PATH[t.highway]) {
          const w = Number(String(t.width).replace(",", ".")) || PATH[t.highway];
          stroke(g, w / 2 + 0.6, PATHS);
          if (t.highway !== "steps") paths.push({ l: g, w, id: el.id });
        }
        continue;
      }
      if (closed(g)) rings = [g];
    } else if (el.type === "relation" && el.members) {
      const ways = (inner: boolean) => joinWays(el.members.filter((m: any) => m.type === "way" && m.geometry?.length >= 2 && (m.role === "inner") === inner).map((m: any) => geom(m.geometry)));
      rings = [...ways(false), ...ways(true)].filter(closed);
    }
    if (!rings?.length || !touches(rings)) continue;
    const kind = kindOf(t), block = blockOf(t);
    if (block) fill(rings, (c) => { bits[c] |= block; });
    if (kind) areas.push({ kind, rings, area: rings.reduce((a, r) => a + ringArea(r), 0), id: el.id });
  }
  areas.sort((a, b) => b.area - a.area); // smaller areas paint over the larger ones they lie in
  areas.forEach((a, k) => fill(a.rings, (c) => { owner[c] = k + 1; }));
  for (const r of inp.buildings) if (r.some(([x, y]) => x > bx0 - 50 && x < bx1 + 50 && y > by0 - 50 && y < by1 + 50)) fill([r], (c) => { bits[c] |= BUILD; });
  const kindAt = (x: number, y: number) => { const c = cellAt(x, y); return c < 0 || !owner[c] ? 0 : areas[owner[c] - 1].kind; };

  // mapped trees: 20 m grid
  const treeGrid = new Map<string, P2[]>();
  const gk = (x: number, y: number) => `${Math.floor(x / 20)}_${Math.floor(y / 20)}`;
  for (const p of inp.mapped) { const k = gk(p[0], p[1]); (treeGrid.get(k) ?? treeGrid.set(k, []).get(k)!).push(p); }
  const nearGrid = (grid: Map<string, P2[]>, x: number, y: number, d: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const p of grid.get(`${Math.floor(x / 20) + dx}_${Math.floor(y / 20) + dy}`) ?? []) if (Math.hypot(p[0] - x, p[1] - y) < d) return true;
    return false;
  };
  const nearMapped = (x: number, y: number, d: number) => nearGrid(treeGrid, x, y, d);
  // generated crowns so far (alleys, rows), so the lattice doesn't stack crowns on them
  const madeGrid = new Map<string, P2[]>();
  const crowns: Crown[] = [];
  const stats: Record<string, number> = {};
  const put = (c: Crown, what: string) => {
    crowns.push(c);
    const k = gk(c[0], c[1]);
    (madeGrid.get(k) ?? madeGrid.set(k, []).get(k)!).push([c[0], c[1]]);
    stats[what] = (stats[what] ?? 0) + 1;
  };
  /** the trunk's cell is free of `mask`, and no building within ~0.6 r (crowns may overhang a little) */
  const free = (x: number, y: number, r: number, mask: number) => {
    if (bitsAt(x, y) & mask) return false;
    const d = Math.min(3, r * 0.6);
    return !((bitsAt(x + d, y) | bitsAt(x - d, y) | bitsAt(x, y + d) | bitsAt(x, y - d)) & BUILD);
  };
  const nearWater = (x: number, y: number) => {
    for (const d of [12, 28]) for (let a = 0; a < 8; a++) if (bitsAt(x + d * Math.cos(a * Math.PI / 4), y + d * Math.sin(a * Math.PI / 4)) & WATER) return true;
    return false;
  };

  // 2. Areas OSM maps tree by tree: a third or more of their lattice points within 10 m of a mapped tree.
  const STEP = 6;
  const lattice = (step: number, seed: number, fn: (x: number, y: number, u: number, i: number, j: number) => void) => {
    for (let j = Math.floor(by0 / step); j <= Math.ceil(by1 / step); j++)
      for (let i = Math.floor(bx0 / step); i <= Math.ceil(bx1 / step); i++) {
        const x = (i + 0.5 + (h2(i, j, seed) - 0.5) * 0.7) * step, y = (j + 0.5 + (h2(j, i, seed + 1) - 0.5) * 0.7) * step;
        if (x >= bx0 && x < bx1 && y >= by0 && y < by1) fn(x, y, h2(i, j, seed + 2), i, j);
      }
  };
  const seen = new Uint32Array(areas.length), near = new Uint32Array(areas.length);
  if (inp.mapped.length) lattice(STEP, 1, (x, y) => {
    const c = cellAt(x, y);
    if (!owner[c]) return;
    seen[owner[c] - 1]++;
    if (nearMapped(x, y, 10)) near[owner[c] - 1]++;
  });
  const mappedArea = areas.map((_, k) => seen[k] > 0 && near[k] / seen[k] > 0.33);
  stats["areas mapped tree by tree (skipped)"] = mappedArea.filter(Boolean).length;
  const areaAt = (x: number, y: number) => { const c = cellAt(x, y); return c < 0 ? -1 : owner[c] - 1; };

  // 3. Alleys along park and cemetery paths (one species per path), and tree rows.
  for (const p of paths) {
    const u = h2(p.id, 7, 30);
    let s = 0, along = 4;
    const sp = (k: number) => pick(k === CEMETERY ? MIX.cemeteryAlley : MIX.alley, h2(p.id, 8, 31));
    for (let k = 1; k < p.l.length; k++) {
      const [ax, ay] = p.l[k - 1], [bx, by] = p.l[k], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      const nxv = -(by - ay) / L, nyv = (bx - ax) / L;
      for (; along <= s + L; along += 8.5) {
        const f = (along - s) / L, cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f;
        for (const side of [-1, 1]) {
          const off = p.w / 2 + 2.4, x = cx + nxv * off * side, y = cy + nyv * off * side;
          const a = areaAt(x, y);
          if (a < 0 || mappedArea[a]) continue;
          const kind = areas[a].kind;
          if (!(kind === PARK && u < 0.3) && !(kind === CEMETERY && u < 0.4)) continue;
          const r = 3.2 + 1.2 * h2(Math.round(x * 10), Math.round(y * 10), 32), species = sp(kind);
          if (!free(x, y, r, HARD) || nearMapped(x, y, 5) || nearGrid(madeGrid, x, y, 4)) continue;
          const thuja = species === zgSpecies("thuja");
          put([x, y, thuja ? 1.8 : r, thuja ? 3.5 : r * 2.4, species], "alley");
        }
      }
      s += L;
    }
  }
  for (const w of inp.rows) {
    if (!(w.geometry?.length >= 2)) continue;
    const l = geom(w.geometry), species = pick(MIX.row, h2(w.id, 9, 40));
    let s = 0, along = 4;
    for (let k = 1; k < l.length; k++) {
      const [ax, ay] = l[k - 1], [bx, by] = l[k], L = Math.hypot(bx - ax, by - ay);
      for (; along <= s + L; along += 8) {
        const f = (along - s) / L, x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
        if (x < bx0 || x >= bx1 || y < by0 || y >= by1) continue;
        const r = 2.9 + 1.1 * h2(Math.round(x * 10), Math.round(y * 10), 41);
        // rows stand on verges and in car parks: only buildings and water rule a trunk out
        if (!free(x, y, r, BUILD | WATER) || nearMapped(x, y, 4) || nearGrid(madeGrid, x, y, 3)) continue;
        put([x, y, r, species === zgSpecies("poplar") ? r * 3.2 : r * 2.3, species], "tree row");
      }
      s += L;
    }
  }

  // 4. The lattice: woods, parks, gardens, cemeteries, recreation grounds.
  const T_PARK = thresholdFor(0.45), T_LAWN = thresholdFor(0.16), T_GARDEN = thresholdFor(0.35), T_CEM = thresholdFor(0.22), T_REC = thresholdFor(0.2);
  const T_HOMES = thresholdFor(0.28), T_CAMPUS = thresholdFor(0.16), T_UNTAGGED = thresholdFor(0.12);
  lattice(STEP, 1, (x, y, u) => {
    const a = areaAt(x, y);
    if (a >= 0 && mappedArea[a]) return;
    const kind = a < 0 ? 12 : areas[a].kind;
    if (kind === HOMES || kind === CAMPUS || kind === 12) {
      // small clumps (half the park scale), garden trees, at least a crown's width from the walls
      if (coverField(x * 2, y * 2) <= (kind === HOMES ? T_HOMES : kind === CAMPUS ? T_CAMPUS : T_UNTAGGED)) return;
      const v = h2(Math.round(x * 10), Math.round(y * 10), 56), r = 2.4 + 1.6 * v;
      if (!free(x, y, r, HARD) || (bitsAt(x, y) & LAWN && kind === 12) || nearMapped(x, y, 7) || nearGrid(madeGrid, x, y, 4)) return;
      for (let k = 0; k < 8; k++) if (bitsAt(x + (r + 1) * Math.cos(k * Math.PI / 4), y + (r + 1) * Math.sin(k * Math.PI / 4)) & BUILD) return;
      const species = patchPick(kind === CAMPUS ? MIX.park : MIX.garden, x, y, 18, 57), thuja = species === zgSpecies("thuja");
      put([x, y, thuja ? 1.4 + 0.6 * v : r, thuja ? 2.6 + 2 * v : r * 2.2, species], KIND_NAME[kind]);
      return;
    }
    if (kind < WOOD || kind > REC) return;
    const v = h2(Math.round(x * 10), Math.round(y * 10), 50);
    if (kind === WOOD) {
      if (u < 0.04) return; // a gap now and then
      // stands of one age: young (dense, low), pole, old (big crowns)
      const stand = noise(x, y, 70, 51), r = stand < 0.3 ? 2.6 + 0.9 * v : stand < 0.68 ? 3.5 + 1.2 * v : 4.5 + 1.5 * v;
      if (!free(x, y, r, HARD) || nearMapped(x, y, 6) || nearGrid(madeGrid, x, y, 3.5)) return;
      const ch = stand < 0.3 ? 2.2 * r + 0.8 : 2.6 * r + 1;
      put([x, y, r, ch, woodSpecies(x, y)], "wood");
      return;
    }
    const lawn = bitsAt(x, y) & LAWN, cov = coverField(x, y);
    const thr = kind === PARK ? (lawn ? T_LAWN : T_PARK) : kind === GARDEN ? T_GARDEN : kind === CEMETERY ? T_CEM : T_REC;
    const solitaire = cov <= thr && u < (kind === CEMETERY ? 0.06 : 0.025);
    if (cov <= thr && !solitaire) return;
    let r = kind === GARDEN ? 2.6 + 1.4 * v : 3.4 + 1.6 * v;
    if (solitaire) r += 1; // a lawn's lone tree spreads wide
    if (!free(x, y, r, HARD) || nearMapped(x, y, 8) || nearGrid(madeGrid, x, y, 4.5)) return;
    let species = nearWater(x, y) ? pick(MIX.riparian, v) : patchPick(kind === GARDEN ? MIX.garden : kind === CEMETERY ? MIX.cemetery : MIX.park, x, y, 25, 52);
    if (kind === PARK && areas[a].area > 50_000 && woodsy(x, y)) species = woodSpecies(x, y); // a big park's groves (Maksimir) are oak woods
    const thuja = species === zgSpecies("thuja");
    put([x, y, thuja ? 1.6 + 0.6 * v : r, thuja ? 3 + 2 * v : r * 2.4, species], KIND_NAME[kind]);
  });
  /** species of a wood: by altitude (lowland oak-hornbeam, hill beech-oak-chestnut, mountain beech-fir), willows by water */
  function woodSpecies(x: number, y: number) {
    if (nearWater(x, y)) return pick(MIX.riparian, h2(Math.floor(x / 20), Math.floor(y / 20), 53));
    const h = inp.msl(x, y) + (noise(x, y, 150, 54) - 0.5) * 80;
    return patchPick(h < 200 ? MIX.lowland : h < 480 ? MIX.hill : MIX.mountain, x, y, 35, 55);
  }
  /** park cells deep in a grove (well above the cover threshold) */
  function woodsy(x: number, y: number) { return coverField(x, y) > thresholdFor(0.12); }

  // 5. Scrub: low, small, dense; orchards: fruit trees in rows along the orchard's long side.
  const T_SCRUB = thresholdFor(0.7);
  lattice(3.5, 60, (x, y, u) => {
    const a = areaAt(x, y);
    if (a < 0 || mappedArea[a] || areas[a].kind !== SCRUB) return;
    if (coverField(x * 1.7, y * 1.7) <= T_SCRUB) return;
    const v = h2(Math.round(x * 10), Math.round(y * 10), 61), species = pick(MIX.scrub, u);
    const r = species === zgSpecies("shrub") ? 1.3 + 1.0 * v : 2 + 0.8 * v;
    if (!free(x, y, r, HARD) || nearMapped(x, y, 4) || nearGrid(madeGrid, x, y, 2.5)) return;
    put([x, y, r, species === zgSpecies("shrub") ? r * 0.8 + 0.3 : r * 1.8, species], "scrub");
  });
  const fruit = zgSpecies("fruit tree");
  areas.forEach((ar, k) => {
    if (ar.kind !== ORCHARD || mappedArea[k]) return;
    const ring = ar.rings[0];
    let best = 0, ang = 0;
    for (let i = 1; i < ring.length; i++) {
      const L = Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
      if (L > best) { best = L; ang = Math.atan2(ring[i][1] - ring[i - 1][1], ring[i][0] - ring[i - 1][0]); }
    }
    const ca = Math.cos(ang), sa = Math.sin(ang), [ox, oy] = ring[0];
    const loc = ar.rings.flat().map(([x, y]) => [(x - ox) * ca + (y - oy) * sa, -(x - ox) * sa + (y - oy) * ca]);
    const u0 = Math.min(...loc.map((p) => p[0])), u1 = Math.max(...loc.map((p) => p[0])), v0 = Math.min(...loc.map((p) => p[1])), v1 = Math.max(...loc.map((p) => p[1]));
    for (let pv = v0 + 2.5; pv < v1; pv += 5.5) for (let pu = u0 + 2.5; pu < u1; pu += 5) {
      const x = ox + pu * ca - pv * sa, y = oy + pu * sa + pv * ca;
      if (x < bx0 || x >= bx1 || y < by0 || y >= by1 || areaAt(x, y) !== k) continue;
      const v = h2(Math.round(x * 10), Math.round(y * 10), 70);
      if (v < 0.08) continue; // a missing tree
      const r = 1.8 + 0.6 * v;
      if (!free(x, y, r, HARD) || nearMapped(x, y, 3)) continue;
      put([x, y, r, r * 1.4 + 0.2, fruit], "orchard");
    }
  });
  return { crowns, stats };
}
