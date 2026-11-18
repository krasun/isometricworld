/**
 * Fetch a region's municipal boundaries (OSM admin_level=8, or the region's adminLevels) from Overpass, or
 * from the region's local extract (osmExtract) when it has one.
 *
 *   npm -w pipeline run boundaries -- israel-center      -> data/raw/boundaries/<region>.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGIONS } from "./places.ts";
import { localOsm } from "./osmlocal.ts";
import { overpass } from "./overpass.ts";
import { RAW } from "./paths.ts";


const id = process.argv[2] ?? "israel-center", region = REGIONS[id];
if (!region) throw new Error(`unknown region ${id}`);
const names = region.municipalities.map((c) => c.replace(/[-]/g, "\\-")).join("|");
const levels = region.adminLevels ?? ["8"];
const { lat: la, lon: lo } = region.origin, reach = 0.6; // ~50 km around the origin: enough for any city's borders
const data = region.osmExtract
  ? await localOsm(region.osmExtract, [la - reach, lo - reach, la + reach, lo + reach], (type, t) =>
    type === "relation" && t.boundary === "administrative" && levels.includes(t.admin_level) && region.municipalities.includes(t.name), ["r/boundary=administrative"])
  : await overpass(`[out:json][timeout:240];
area["name:en"="${region.country}"]["admin_level"="2"]->.il;
relation["boundary"="administrative"]["admin_level"~"^(${levels.join("|")})$"]["name"~"^(${names})$"](area.il);
out body geom;`);
// names repeat across a country (a second Leonberg in Bavaria): keep relations within 150 km of the origin (the flat map's reach)
const { lat: lat0, lon: lon0 } = region.origin;
const near = (q: { lat: number; lon: number }) =>
  Math.hypot((q.lat - lat0) * 111.2, (q.lon - lon0) * 111.2 * Math.cos((lat0 * Math.PI) / 180)) < 150;
data.elements = data.elements.filter((e: any) => e.members?.some((m: any) => m.geometry?.some(near)));
// members outside the extract come without geometry
for (const e of data.elements) e.members = e.members.filter((m: any) => m.type !== "way" || m.geometry?.length);
// a name used twice nearby (Zagreb's "Gradska četvrt Donji grad" and another town's): keep the one nearest the origin
const dist = (e: any) => {
  const ps = e.members.flatMap((m: any) => m.geometry ?? []);
  return Math.hypot(ps.reduce((a: number, q: any) => a + q.lat, 0) / ps.length - lat0, ps.reduce((a: number, q: any) => a + q.lon, 0) / ps.length - lon0);
};
const nearest = new Map<string, any>();
for (const e of data.elements) if (!nearest.has(e.tags.name) || dist(e) < dist(nearest.get(e.tags.name))) nearest.set(e.tags.name, e);
data.elements = [...nearest.values()];
mkdirSync(join(RAW, "boundaries"), { recursive: true });
writeFileSync(join(RAW, "boundaries", `${id}.json`), JSON.stringify(data));
console.log("  boundaries:", data.elements.map((e: any) => e.tags["name:en"] ?? e.tags.name).join(", "));
