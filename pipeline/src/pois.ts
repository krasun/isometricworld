/**
 * What a building is used for (OpenStreetMap amenity/shop/tourism/… tags), so the painter can give a
 * McDonald's, a petrol station or a church the look it has in reality instead of a generic block.
 * Cut once per area from the region's local extract (`osmExtract`) into data/raw/<area>/pois.json.
 * Only uses that change what a building looks like from the air or on its facades; ordinary shops and
 * restaurants on ground floors are left out (there are hundreds and nothing shows from above).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Area } from "./areas.ts";
import { localOsm } from "./osmlocal.ts";
import { RAW, readJson } from "./paths.ts";
import { REGIONS } from "./places.ts";

type Tags = Record<string, string>;
export interface Poi { lat: number; lon: number; what: string; rank: number }

/** Recognised uses, most distinctive first (rank = index). Each returns a description or null. */
const KINDS: Array<(t: Tags) => string | null> = [
  (t) => (t.amenity === "fast_food" && t.brand ? `a ${t.brand} fast-food restaurant${t.drive_through === "yes" ? " with a drive-through lane" : ""}` : null),
  (t) => (t.amenity === "fuel" ? `a petrol station${t.brand ? ` (${t.brand})` : ""} with its flat canopy over the pumps` : null),
  (t) => (t.amenity === "place_of_worship" ? (t.religion === "christian" ? "a church" : t.religion === "muslim" ? "a mosque" : t.religion === "jewish" ? "a synagogue" : "a place of worship") : null),
  (t) => (t.railway === "station" || t.public_transport === "station" && t.train === "yes" ? "a railway station" : null),
  (t) => (t.leisure === "stadium" ? "a stadium" : null),
  (t) => (t.amenity === "marketplace" ? "a market square with stalls" : null),
  (t) => (t.amenity === "parking" && t.parking === "multi-storey" ? "a multi-storey car park" : null),
  (t) => (t.shop === "supermarket" && t.brand ? `a ${t.brand} supermarket with its car park` : null),
  (t) => (t.shop === "mall" || t.shop === "department_store" ? "a department store / shopping centre" : null),
  (t) => (t.shop === "car" ? "a car dealership with cars lined up outside" : null),
  (t) => (t.amenity === "hospital" ? "a hospital" : null),
  (t) => (t.amenity === "fire_station" ? "a fire station with its engine bays" : null),
  (t) => (t.amenity === "police" ? "a police station" : null),
  (t) => (t.amenity === "bus_station" ? "a bus station with platforms" : null),
  (t) => (t.amenity === "school" ? "a school with its schoolyard" : null),
  (t) => (t.amenity === "kindergarten" ? "a kindergarten with a play yard" : null),
  (t) => (t.amenity === "university" || t.amenity === "college" ? "a university building" : null),
  (t) => (t.amenity === "townhall" ? "a town hall" : null),
  (t) => (t.amenity === "theatre" || t.amenity === "cinema" || t.amenity === "arts_centre" ? `a ${t.amenity === "arts_centre" ? "arts centre" : t.amenity}` : null),
  (t) => (t.tourism === "museum" ? "a museum" : null),
  (t) => (t.tourism === "hotel" ? "a hotel" : null),
  (t) => (t.amenity === "biergarten" ? "a beer garden with tables under trees" : null),
  (t) => (t.leisure === "sports_centre" ? "a sports hall" : null),
  (t) => (t.leisure === "playground" ? "a playground" : null),
];

function classify(t: Tags): { what: string; rank: number } | null {
  for (let rank = 0; rank < KINDS.length; rank++) {
    const what = KINDS[rank](t);
    if (what) return { what: t.name && !t.brand ? `${what} (${t.name})` : what, rank };
  }
  return null;
}

/** POIs of an area (cached; delete pois.json to re-cut). Empty for regions without a local extract. */
export async function areaPois(name: string, area: Area): Promise<Poi[]> {
  const file = join(RAW, name, "pois.json");
  if (existsSync(file)) return readJson(file);
  const url = REGIONS[area.region].osmExtract;
  if (!url) return [];
  const osm = await localOsm(url, area.bbox, (type, t) => type !== "relation" && !!classify(t));
  const out: Poi[] = [];
  for (const e of osm.elements) {
    const c = classify(e.tags);
    if (!c) continue;
    const pts: Array<{ lat: number; lon: number }> = e.type === "node" ? [e] : e.geometry;
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
    out.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), ...c });
  }
  mkdirSync(join(RAW, name), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  return out;
}
