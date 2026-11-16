// Prints render tiles whose pixels a "restored pitch tree" can touch (for targeted re-render).
import { readFileSync } from "node:fs";
import { CAMERA, enuToPixel, llhToEcef, ecefToEnu } from "../src/camera.ts";
import { join } from "node:path";

const RAW = join(process.cwd(), "..", "data", "raw", "herzliya");
const T = CAMERA.tile;
const toEnu = (lon: number, lat: number) => { const e = ecefToEnu(llhToEcef(lat, lon, 0)); return [e[0], e[1]] as [number, number]; };

const gj = JSON.parse(readFileSync(join(RAW, "ground.json"), "utf8"));
const pitches: [number, number][][] = [];
for (const el of gj.elements)
  if (el.type === "way" && el.tags?.leisure === "pitch" && el.geometry?.length >= 4)
    pitches.push(el.geometry.map((p: any) => toEnu(p.lon, p.lat)));
const inside = ([x, y]: [number, number], poly: [number, number][]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const edgeDist = (x: number, y: number, ring: [number, number][]) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
};
const smallPitch = (ring: [number, number][]) => {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 60;
};
const tiles = new Set<string>();
for (const file of ["hzl_trees.geojson", "hzl_trees2.geojson"]) {
  const d = JSON.parse(readFileSync(join(RAW, file), "utf8"));
  for (const f of d.features) {
    if (!f.geometry || f.geometry.type !== "Point") continue;
    const [x, y] = toEnu(f.geometry.coordinates[0], f.geometry.coordinates[1]);
    for (const ring of pitches) {
      const d = edgeDist(x, y, ring);
      const wasDropped = inside([x, y], ring) && d > 3;
      const isDropped = smallPitch(ring) && wasDropped && d > 6;
      if (smallPitch(ring) && wasDropped && d > 6) {
        const r = 7, h = 28;
        for (const z of [0, h]) {
          const [px, py] = enuToPixel([x, y, z]);
          tiles.add(`${Math.floor((px - r * 3) / T)}_${Math.floor((py - r * 3) / T)}`);
          tiles.add(`${Math.floor((px + r * 3) / T)}_${Math.floor((py + r * 3) / T)}`);
        }
        break;
      }
    }
  }
}
console.log([...tiles].join(" "));
