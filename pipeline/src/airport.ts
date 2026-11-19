/**
 * The airport's taxi network for the ground traffic (web/src/scripts/airport.ts), for a region whose
 * `airport.ground` names a bbox: OSM runway, taxiway and taxilane centre lines and the stands' lead-in
 * lines, from the region's Geofabrik extract. Written by export as data/airport.<hash>.json:
 *   n  nodes [e, n, u] in 0.1 m, flat
 *   w  ways [kind (0 runway, 1 taxiway, 2 taxilane), node indices…]
 *   s  stands { r: ref, p: node indices from the taxi network to the stop point }
 */
import { localOsm } from "./osmlocal.ts";
import type { Region } from "./places.ts";

export interface AirportNetwork { n: number[]; w: number[][]; s: Array<{ r: string; p: number[] }> }
type Place = (lat: number, lon: number) => Promise<ArrayLike<number>>; // ENU on the rendered ground

const KIND: Record<string, number> = { runway: 0, taxiway: 1, taxilane: 2 };

export async function airportNetwork(R: Region, place: Place): Promise<AirportNetwork | null> {
  const g = R.airport?.ground;
  if (!g || !R.osmExtract) return null;
  const osm = await localOsm(R.osmExtract, g.bbox, (type, t) => type === "way" && (t.aeroway in KIND || t.aeroway === "parking_position"));
  const at = new Map<number, { lat: number; lon: number }>();
  for (const w of osm.elements) w.nodes.forEach((id: number, i: number) => at.set(id, w.geometry[i]));
  const index = new Map<number, number>(), n: number[] = [];
  const node = async (id: number) => {
    if (!index.has(id)) {
      const { lat, lon } = at.get(id)!, e = await place(lat, lon);
      index.set(id, n.length / 3);
      n.push(Math.round(e[0] * 10), Math.round(e[1] * 10), Math.round(e[2] * 10));
    }
    return index.get(id)!;
  };
  const w: number[][] = [], net = new Set<number>();
  for (const el of osm.elements) {
    if (!(el.tags.aeroway in KIND)) continue;
    const ids: number[] = [];
    for (const id of el.nodes) { ids.push(await node(id)); net.add(id); }
    w.push([KIND[el.tags.aeroway], ...ids]);
  }
  // a stand line runs from the taxi network to the stop point; a loose one is joined to the nearest node
  const dist = (a: number, b: number) => { const p = at.get(a)!, q = at.get(b)!; return Math.hypot((p.lat - q.lat) * 111320, (p.lon - q.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180)); };
  const s: AirportNetwork["s"] = [];
  for (const el of osm.elements) {
    if (el.tags.aeroway !== "parking_position" || !el.tags.ref || el.nodes.length < 2) continue;
    let ids: number[] = el.nodes;
    if (net.has(ids.at(-1)!) && !net.has(ids[0])) ids = [...ids].reverse();
    if (!net.has(ids[0])) {
      let best = -1, d = 80;
      for (const id of net) { const dd = dist(id, ids[0]); if (dd < d) { d = dd; best = id; } }
      if (best < 0) continue;
      ids = [best, ...ids];
    }
    const p: number[] = [];
    for (const id of ids) p.push(await node(id));
    s.push({ r: el.tags.ref, p });
  }
  return { n, w, s };
}
