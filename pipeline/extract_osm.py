#!/usr/bin/env python3
"""
Extract OSM data for tbilisi-pilot from the Georgia PBF extract.
Produces rails.json and ground.json in the Overpass JSON format that fetch.ts writes.

Usage: python extract_osm.py <pbf_path> <output_dir>
"""
import osmium
import json
import os
import sys

PBF_PATH = sys.argv[1]
OUT_DIR = sys.argv[2]

# tbilisi-pilot bbox (from areas.ts)
S, W, N, E = 41.687, 44.788, 41.712, 44.815
# Ground query uses a 0.02° margin (fetch.ts)
GM = 0.02
GS, GW, GN, GE = S - GM, W - GM, N + GM, E + GM
# Buffer for storing way geometries (relation member lookup)
BUF = 0.15
BS, BW, BN, BE = S - BUF, W - BUF, N + BUF, E + BUF


def inbox(lat, lon, s, w, n, e):
    return s <= lat <= n and w <= lon <= e


# --- Filters matching fetch.ts / osmlocal.ts FILTERS ---

RAIL_WAY = frozenset(["rail", "light_rail", "subway", "tram", "narrow_gauge", "funicular"])
RAIL_ROUTE = frozenset(["train", "light_rail", "subway", "tram"])
RAIL_GROUND = frozenset(["rail", "light_rail", "tram"])
LEISURE_SET = frozenset(["park", "garden", "pitch", "playground", "stadium", "track",
                         "golf_course", "swimming_pool", "dog_park", "nature_reserve",
                         "recreation_ground", "marina", "sports_centre"])
NATURAL_SET = frozenset(["water", "beach", "sand", "scrub", "grassland", "wood",
                         "wetland", "coastline", "bare_rock", "heath"])
AMENITY_GR = frozenset(["parking", "school", "university", "college", "hospital", "grave_yard"])
MAN_MADE_GR = frozenset(["pier", "breakwater", "groyne", "bridge"])
GOLF_SET = frozenset(["bunker", "green", "tee", "fairway", "driving_range", "rough"])
AEROWAY_SET = frozenset(["runway", "taxiway", "apron", "helipad"])
TUNNEL_SKIP = frozenset(["yes", "building_passage"])


def is_ground_way(t):
    """Way-only ground filters (highway, area:highway, railway, aeroway)."""
    if t.get("highway") and t.get("tunnel", "") not in TUNNEL_SKIP:
        return True
    if t.get("area:highway"):
        return True
    if t.get("railway", "") in RAIL_GROUND and t.get("tunnel") != "yes":
        return True
    if t.get("railway") == "platform":
        return True
    if t.get("aeroway", "") in AEROWAY_SET:
        return True
    return is_ground_any(t)


def is_ground_any(t):
    """Ground filters shared by ways and relations."""
    if t.get("landuse"):
        return True
    if t.get("leisure", "") in LEISURE_SET:
        return True
    if t.get("natural", "") in NATURAL_SET:
        return True
    if t.get("water"):
        return True
    if t.get("waterway") == "riverbank":
        return True
    if t.get("amenity", "") in AMENITY_GR:
        return True
    if t.get("man_made", "") in MAN_MADE_GR:
        return True
    if t.get("place") == "square":
        return True
    if t.get("golf", "") in GOLF_SET:
        return True
    return False


def tags_dict(obj):
    return {t.k: t.v for t in obj.tags}


def make_way_obj(wid, geom, nids, t):
    """Build an Overpass-format way object."""
    g = [{"lat": la, "lon": lo} for la, lo in geom]
    lats = [la for la, _ in geom]
    lons = [lo for _, lo in geom]
    return {
        "type": "way", "id": wid,
        "bounds": {"minlat": min(lats), "minlon": min(lons),
                   "maxlat": max(lats), "maxlon": max(lons)},
        "nodes": nids, "geometry": g, "tags": t,
    }


class Extractor(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        # Tagged node cache (for rail stop nodes and relation node members)
        self.tagged_nodes = {}  # id -> (lat, lon, tags)
        # All node locations within buffer (for untagged relation node members)
        self.node_locs = {}  # id -> (lat, lon)
        # Way data within buffer (for relation member geometry lookup)
        self.way_data = {}  # id -> (geom_tuples, node_ids, tags)

        self.rail_elements = []
        self.ground_elements = []
        self.route_rels = []  # (rel_id, raw_members) for stop-node collection

        self._n_nodes = 0
        self._n_ways = 0

    def node(self, n):
        self._n_nodes += 1
        if self._n_nodes % 500_000 == 0:
            print(f"\r  nodes: {self._n_nodes // 1000}k ...", end="", flush=True)
        if not n.location.valid:
            return
        lat, lon = n.location.lat, n.location.lon
        # Store location if within buffer (for relation node member lookup)
        if inbox(lat, lon, BS, BW, BN, BE):
            self.node_locs[n.id] = (lat, lon)
        t = tags_dict(n)
        if t:
            self.tagged_nodes[n.id] = (lat, lon, t)

    def way(self, w):
        self._n_ways += 1
        if self._n_ways % 50_000 == 0:
            print(f"\r  ways: {self._n_ways // 1000}k, stored: {len(self.way_data)} ...", end="", flush=True)
        t = tags_dict(w)
        if not t:
            return

        geom = []
        nids = []
        for nd in w.nodes:
            try:
                loc = nd.location
                if loc.valid:
                    geom.append((loc.lat, loc.lon))
                    nids.append(nd.ref)
                else:
                    nids.append(nd.ref)
            except osmium.InvalidLocationError:
                nids.append(nd.ref)

        if len(geom) < 2:
            return

        # Only process ways intersecting the buffer bbox
        in_buf = any(inbox(la, lo, BS, BW, BN, BE) for la, lo in geom)
        if not in_buf:
            return

        # Store for relation member geometry lookup
        self.way_data[w.id] = (geom, nids, t)

        in_pilot = any(inbox(la, lo, S, W, N, E) for la, lo in geom)
        in_ground = any(inbox(la, lo, GS, GW, GN, GE) for la, lo in geom)

        # Rail ways (pilot bbox)
        if in_pilot and t.get("railway", "") in RAIL_WAY:
            self.rail_elements.append(make_way_obj(w.id, geom, nids, t))

        # Ground ways (ground bbox)
        if in_ground and is_ground_way(t):
            self.ground_elements.append(make_way_obj(w.id, geom, nids, t))

    def relation(self, r):
        t = tags_dict(r)
        if not t:
            return

        members_raw = [(m.type, m.ref, m.role) for m in r.members]

        # --- Rail route relations (pilot bbox) ---
        if t.get("route", "") in RAIL_ROUTE:
            in_pilot = False
            for mtype, mref, _ in members_raw:
                if mtype == "w" and mref in self.way_data:
                    geom = self.way_data[mref][0]
                    if any(inbox(la, lo, S, W, N, E) for la, lo in geom):
                        in_pilot = True
                        break
            if in_pilot:
                members = []
                for mtype, mref, mrole in members_raw:
                    mtype_str = {"n": "node", "w": "way", "r": "relation"}[mtype]
                    members.append({"type": mtype_str, "ref": mref, "role": mrole})
                self.rail_elements.append(
                    {"type": "relation", "id": r.id, "tags": t, "members": members})
                self.route_rels.append((r.id, members_raw))

        # --- Ground relations (ground bbox) ---
        if is_ground_any(t):
            members = []
            in_ground = False
            for mtype, mref, mrole in members_raw:
                mtype_str = {"n": "node", "w": "way", "r": "relation"}[mtype]
                m = {"type": mtype_str, "ref": mref, "role": mrole}
                if mtype == "w" and mref in self.way_data:
                    geom = self.way_data[mref][0]
                    m["geometry"] = [{"lat": la, "lon": lo} for la, lo in geom]
                    if any(inbox(la, lo, GS, GW, GN, GE) for la, lo in geom):
                        in_ground = True
                elif mtype == "n":
                    loc = self.node_locs.get(mref)
                    if loc:
                        m["lat"] = loc[0]
                        m["lon"] = loc[1]
                        if inbox(loc[0], loc[1], GS, GW, GN, GE):
                            in_ground = True
                members.append(m)

            if in_ground:
                self.ground_elements.append(
                    {"type": "relation", "id": r.id, "tags": t, "members": members})


def dedup(elems):
    seen = set()
    out = []
    for e in elems:
        k = (e["type"], e["id"])
        if k not in seen:
            seen.add(k)
            out.append(e)
    return out


# --- Main ---
print(f"Processing {PBF_PATH} ...")
handler = Extractor()
handler.apply_file(PBF_PATH, locations=True)
print(f"\n  Indexed {len(handler.node_locs)} node locs, {len(handler.way_data)} ways in buffer")

# Add rail stop nodes (nodes with role "stop" in the route relations, within pilot bbox)
stop_ids = set()
for _, members_raw in handler.route_rels:
    for mtype, mref, mrole in members_raw:
        if mtype == "n" and mrole == "stop":
            stop_ids.add(mref)

for nid in stop_ids:
    if nid in handler.tagged_nodes:
        la, lo, t = handler.tagged_nodes[nid]
        if inbox(la, lo, S, W, N, E):
            handler.rail_elements.append(
                {"type": "node", "id": nid, "lat": la, "lon": lo, "tags": t})

# Deduplicate and write
rails = {"elements": dedup(handler.rail_elements)}
ground = {"elements": dedup(handler.ground_elements)}

os.makedirs(OUT_DIR, exist_ok=True)

rails_path = os.path.join(OUT_DIR, "rails.json")
with open(rails_path, "w") as f:
    json.dump(rails, f)
print(f"  rails.json: {len(rails['elements'])} elements -> {rails_path}")

ground_path = os.path.join(OUT_DIR, "ground.json")
with open(ground_path, "w") as f:
    json.dump(ground, f)
print(f"  ground.json: {len(ground['elements'])} elements -> {ground_path}")

print("Done.")
