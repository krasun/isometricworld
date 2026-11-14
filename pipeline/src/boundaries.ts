/**
 * Fetch a region's municipal boundaries (OSM admin_level=8, or the region's adminLevels) from Overpass.
 *
 *   npm -w pipeline run boundaries -- israel-center      -> data/raw/boundaries/<region>.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGIONS } from "./places.ts";
import { overpass } from "./overpass.ts";
import { RAW } from "./paths.ts";


const id = process.argv[2] ?? "israel-center", region = REGIONS[id];
if (!region) throw new Error(`unknown region ${id}`);
const names = region.municipalities.map((c) => c.replace(/[-]/g, "\\-")).join("|");
const data = await overpass(`[out:json][timeout:240];
area["name:en"="${region.country}"]["admin_level"="2"]->.il;
relation["boundary"="administrative"]["admin_level"~"^(${(region.adminLevels ?? ["8"]).join("|")})$"]["name"~"^(${names})$"](area.il);
out body geom;`);
// names repeat across a country (a second Leonberg in Bavaria): keep relations within 150 km of the origin (the flat map's reach)
const { lat: lat0, lon: lon0 } = region.origin;
const near = (q: { lat: number; lon: number }) =>
  Math.hypot((q.lat - lat0) * 111.2, (q.lon - lon0) * 111.2 * Math.cos((lat0 * Math.PI) / 180)) < 150;
data.elements = data.elements.filter((e: any) => e.members?.some((m: any) => m.geometry?.some(near)));
mkdirSync(join(RAW, "boundaries"), { recursive: true });
writeFileSync(join(RAW, "boundaries", `${id}.json`), JSON.stringify(data));
console.log("  boundaries:", data.elements.map((e: any) => e.tags["name:en"] ?? e.tags.name).join(", "));
