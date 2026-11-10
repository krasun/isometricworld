/**
 * OpenStreetMap from a local extract instead of the Overpass API, for regions with `osmExtract` (a Geofabrik
 * .osm.pbf URL): same data (ODbL), no rate limits or 504s. Needs osmium-tool (`brew install osmium-tool`).
 *
 * The result has the shape of Overpass `out body geom`: nodes with lat/lon, ways with node ids + geometry,
 * relations with members (+ member geometry), so every consumer of osm.json / roads.json / ground.json
 * reads it unchanged. Filters are plain predicates on (type, tags), mirroring the Overpass queries in fetch.ts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAW } from "./paths.ts";

type Tags = Record<string, string>;
export type OsmFilter = (type: "node" | "way" | "relation", tags: Tags) => boolean;
interface LatLon { lat: number; lon: number }

const DIR = join(RAW, "osm");

/** Download the extract once (re-download: delete the file). */
async function extract(url: string) {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, url.split("/").pop()!);
  if (existsSync(file)) return file;
  console.log(`  downloading ${url}`);
  const r = await fetch(url, { headers: { "User-Agent": "isometric-world/0.3 (open-data isometric map)" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  writeFileSync(`${file}.tmp`, Buffer.from(await r.arrayBuffer()));
  renameSync(`${file}.tmp`, file);
  return file;
}

/** OPL tag/value unescaping: %<hex>% is a code point. */
const unesc = (s: string) => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
function tagsOf(s: string): Tags {
  const t: Tags = {};
  if (!s) return t;
  for (const kv of s.split(",")) { const i = kv.indexOf("="); t[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1)); }
  return t;
}

/** Every element of the extract inside bbox [s, w, n, e] that passes the filter, as Overpass JSON. */
export async function localOsm(url: string, [s, w, n, e]: number[], filter: OsmFilter) {
  const pbf = await extract(url);
  const cut = join(DIR, `cut-${process.pid}.osm.pbf`);
  // smart: complete ways and multipolygon members, like Overpass returns them with `geom`
  execFileSync("osmium", ["extract", "-b", `${w},${s},${e},${n}`, "--strategy", "smart", "-O", "-o", cut, pbf], { stdio: "ignore" });
  const opl = execFileSync("osmium", ["add-locations-to-ways", "--keep-untagged-nodes", "-f", "opl,add_metadata=false", "-o", "-", cut],
    { maxBuffer: 2 ** 31 - 1 }).toString("utf8");
  rmSync(cut);

  const nodes = new Map<number, LatLon>();
  const ways = new Map<number, { nodes: number[]; geometry: LatLon[]; tags: Tags }>();
  const rels: Array<{ id: number; tags: Tags; members: Array<{ type: string; ref: number; role: string }> }> = [];
  const out: any[] = [];
  for (const line of opl.split("\n")) {
    if (!line) continue;
    const f: Record<string, string> = {};
    for (const part of line.split(" ")) f[part[0]] = part.slice(1);
    const id = Number(line.slice(1, line.indexOf(" ")));
    const tags = tagsOf(f.T);
    if (line[0] === "n") {
      const p = { lat: Number(f.y), lon: Number(f.x) };
      nodes.set(id, p);
      if (f.T && filter("node", tags)) out.push({ type: "node", id, ...p, tags });
    } else if (line[0] === "w") {
      const ids: number[] = [], geometry: LatLon[] = [];
      for (const ref of f.N ? f.N.split(",") : []) {
        const m = /^n(\d+)x([-\d.]+)y([-\d.]+)$/.exec(ref);
        if (!m) continue; // node outside the extract: no location
        ids.push(Number(m[1])); geometry.push({ lat: Number(m[3]), lon: Number(m[2]) });
      }
      ways.set(id, { nodes: ids, geometry, tags });
      if (f.T && geometry.length >= 2 && filter("way", tags)) out.push({ type: "way", id, nodes: ids, geometry, tags });
    } else if (line[0] === "r") {
      const members = (f.M ? f.M.split(",") : []).map((m) => {
        const at = m.indexOf("@");
        return { type: { n: "node", w: "way", r: "relation" }[m[0]]!, ref: Number(m.slice(1, at)), role: unesc(m.slice(at + 1)) };
      });
      if (f.T && filter("relation", tags)) rels.push({ id, tags, members });
    }
  }
  for (const r of rels) {
    out.push({
      type: "relation", id: r.id, tags: r.tags,
      members: r.members.map((m) => m.type === "way" ? { ...m, geometry: ways.get(m.ref)?.geometry ?? [] }
        : m.type === "node" && nodes.has(m.ref) ? { ...m, ...nodes.get(m.ref) } : m),
    });
  }
  return { elements: out };
}

/** The Overpass queries of fetch.ts as filters. */
const ROAD = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|service)$/;
const LEISURE = /^(park|garden|pitch|playground|stadium|track|golf_course|swimming_pool|dog_park|nature_reserve|recreation_ground|marina|sports_centre)$/;
const NATURAL = /^(water|beach|sand|scrub|grassland|wood|wetland|coastline|bare_rock|heath)$/;
export const FILTERS = {
  trees: ((type, t) => type === "node" && t.natural === "tree") as OsmFilter,
  /** trees + buildings (and parts) tagged with roof/wall colour or material (LoD2 regions take only the looks from OSM) */
  treesAndLooks: ((type, t) => (type === "node" && t.natural === "tree") || (type !== "node" && !!(t.building || t["building:part"])
    && !!(t["roof:colour"] || t["roof:material"] || t["building:colour"] || t["building:material"] || t.min_height || /tower/.test(t.man_made ?? "")))) as OsmFilter,
  buildingsAndTrees: ((type, t) => (type !== "node" && !!t.building) || (type === "node" && t.natural === "tree")) as OsmFilter,
  roads: ((type, t) => type === "way" && ROAD.test(t.highway ?? "") && t.area !== "yes") as OsmFilter,
  ground: ((type, t) =>
    (type === "way" && !!t.highway && !/yes|building_passage/.test(t.tunnel ?? ""))
    || (type === "way" && !!t["area:highway"])
    || (type === "way" && /^(rail|light_rail|tram)$/.test(t.railway ?? "") && t.tunnel !== "yes")
    || !!t.landuse || LEISURE.test(t.leisure ?? "") || NATURAL.test(t.natural ?? "") || !!t.water
    || t.waterway === "riverbank" || /^(parking|school|university|college|hospital|grave_yard)$/.test(t.amenity ?? "")
    || /^(pier|breakwater|groyne|bridge)$/.test(t.man_made ?? "") || t.place === "square"
    || /^(bunker|green|tee|fairway|driving_range|rough)$/.test(t.golf ?? "")
    || (type === "way" && /^(runway|taxiway|apron|helipad)$/.test(t.aeroway ?? ""))) as OsmFilter,
};
