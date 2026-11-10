import { CAMERA, activeRegion, llhToPixel, useRegion } from "./camera.ts";
import { outlinePixels } from "./outline.ts";
import { REGIONS } from "./places.ts";

/** A rendered patch of a region (see places.ts); all pipeline steps work per area. */
export interface Area {
  title: string;
  region: string;
  /** south, west, north, east (WGS84) */
  bbox: [number, number, number, number];
}

export const AREAS: Record<string, Area> = {
  /** Jaffa → Yarkon Park → Ramat Gan, including the sea off the coast. */
  "tlv-core": {
    title: "Tel Aviv-Yafo · Ramat Gan",
    region: "israel-center",
    bbox: [32.035, 34.735, 32.108, 34.835],
  },
  /** Small test patch around Rothschild Blvd. */
  rothschild: {
    title: "Rothschild Blvd",
    region: "israel-center",
    bbox: [32.0605, 34.7705, 32.0675, 34.7795],
  },
  /** Stuttgart test patch: Schlossplatz, Königstraße, Altes Schloss, Hauptbahnhof's south end (~1 km). */
  schlossplatz: {
    title: "Schlossplatz",
    region: "stuttgart",
    bbox: [48.774, 9.173, 48.783, 9.1865],
  },
  /** The Kessel from Heslach to the Neckar, with Bad Cannstatt. */
  "stuttgart-core": {
    title: "Stuttgart · Kessel · Bad Cannstatt",
    region: "stuttgart",
    bbox: [48.755, 9.145, 48.81, 9.235],
  },
  // The rest of the city limits (+ EDDS) around the core, in boxes of ~150 km² (LoD2 + crowns in memory).
  // Neighbours overlap by ≥ 1 km so the inner seams stay opaque; places.ts `outline` trims them to the city.
  /** Weilimdorf, Feuerbach, Zuffenhausen (west half). */
  "stuttgart-north-west": { title: "Weilimdorf · Feuerbach · Zuffenhausen", region: "stuttgart", bbox: [48.798, 9.035, 48.87, 9.185] },
  /** Zuffenhausen (east), Stammheim, Mühlhausen, Münster. */
  "stuttgart-north-east": { title: "Stammheim · Mühlhausen · Münster", region: "stuttgart", bbox: [48.798, 9.17, 48.87, 9.32] },
  /** Botnang, Rotwildpark. */
  "stuttgart-west": { title: "Botnang", region: "stuttgart", bbox: [48.755, 9.035, 48.81, 9.16] },
  /** Untertürkheim, Wangen, Hedelfingen, Obertürkheim. */
  "stuttgart-east": { title: "Untertürkheim · Hedelfingen", region: "stuttgart", bbox: [48.755, 9.22, 48.81, 9.32] },
  /** Vaihingen, Möhringen. */
  "stuttgart-south-west": { title: "Vaihingen · Möhringen", region: "stuttgart", bbox: [48.668, 9.035, 48.767, 9.185] },
  /** Degerloch, Sillenbuch, Birkach, Plieningen, Stuttgart Airport (EDDS) and the Messe. */
  "stuttgart-south-east": { title: "Degerloch · Plieningen · Stuttgart Airport", region: "stuttgart", bbox: [48.668, 9.17, 48.767, 9.32] },
  // The towns around the city (region outline): a ring of areas around the ones above.
  "metro-north-west": { title: "Ditzingen · Korntal-Münchingen · Kornwestheim", region: "stuttgart", bbox: [48.865, 9.03, 48.935, 9.185] },
  "metro-north-east": { title: "Ludwigsburg · Remseck am Neckar", region: "stuttgart", bbox: [48.865, 9.17, 48.935, 9.33] },
  // the eastern and western strips are split in two: a 17 km tall area's terrain mesh (>20 M vertices) crashes the render page
  "metro-east-north": { title: "Waiblingen", region: "stuttgart", bbox: [48.855, 9.315, 48.935, 9.445] },
  "metro-east-north-2": { title: "Fellbach", region: "stuttgart", bbox: [48.78, 9.315, 48.86, 9.445] },
  "metro-east-south": { title: "Esslingen am Neckar", region: "stuttgart", bbox: [48.70, 9.315, 48.785, 9.445] },
  "metro-east-south-2": { title: "Ostfildern", region: "stuttgart", bbox: [48.62, 9.315, 48.705, 9.445] },
  "metro-south-west": { title: "Leinfelden-Echterdingen (west) · Böblingen (east)", region: "stuttgart", bbox: [48.62, 9.03, 48.673, 9.185] },
  "metro-south-east": { title: "Filderstadt · Leinfelden-Echterdingen", region: "stuttgart", bbox: [48.62, 9.17, 48.673, 9.33] },
  "metro-west-north": { title: "Ditzingen (west)", region: "stuttgart", bbox: [48.85, 8.9, 48.935, 9.04] },
  "metro-west-north-2": { title: "Leonberg · Gerlingen", region: "stuttgart", bbox: [48.77, 8.9, 48.855, 9.04] },
  "metro-west-south": { title: "Sindelfingen", region: "stuttgart", bbox: [48.70, 8.9, 48.775, 9.04] },
  "metro-west-south-2": { title: "Böblingen", region: "stuttgart", bbox: [48.62, 8.9, 48.705, 9.04] },
};

/** Look up an area and switch the camera to its region: call before any projection. */
export function openArea(name: string): Area {
  const area = AREAS[name];
  if (!area) throw new Error(`unknown area ${name}`);
  useRegion(area.region);
  return area;
}

/** Typical ground ellipsoid height of the active region (area outlines, first guess before the terrain). */
export const groundH = () => REGIONS[activeRegion()].groundH;

type Pt = [number, number];

/** Area outline in global art pixels (the bbox projected at ground level: a slanted quad). */
export function areaPolygon(bbox: [number, number, number, number]): Pt[] {
  const [s, w, n, e] = bbox;
  return [[s, w], [s, e], [n, e], [n, w]].map(([lat, lon]) => llhToPixel(lat, lon, groundH()));
}

export function inside([x, y]: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Render tiles whose centre lies inside the area outline (and that touch the region's outline, if it has one). */
export function areaTiles(bbox: [number, number, number, number]) {
  const poly = areaPolygon(bbox), shape = outlinePixels(), T = CAMERA.tile;
  const inShape = (tx: number, ty: number) => !shape || [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]
    .some(([a, b]) => shape.some((r) => inside([(tx + a) * T, (ty + b) * T], r)));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const out: Array<[number, number]> = [];
  for (let ty = Math.floor(Math.min(...ys) / CAMERA.tile); ty <= Math.floor(Math.max(...ys) / CAMERA.tile); ty++)
    for (let tx = Math.floor(Math.min(...xs) / CAMERA.tile); tx <= Math.floor(Math.max(...xs) / CAMERA.tile); tx++)
      if (inside([(tx + 0.5) * CAMERA.tile, (ty + 0.5) * CAMERA.tile], poly) && inShape(tx, ty)) out.push([tx, ty]);
  return out;
}

/** Distance (art px) from a point inside an outline to its nearest edge; 0 outside. */
export function insideDistance([x, y]: Pt, poly: Pt[]) {
  if (!inside([x, y], poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0; // repeated vertex: no 0/0
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}
