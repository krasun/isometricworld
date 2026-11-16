#!/usr/bin/env python3
"""Cut a Geofabrik .osm.pbf to a bbox and emit Overpass-JSON (`out body geom` shape)
for the isometricworld pipeline's osm.json / roads.json / rails.json / ground.json,
using the same tag filters as pipeline/src/osmlocal.ts FILTERS.
Usage: pbf_to_overpass.py <pbf> <s> <w> <n> <e> <outdir>
"""
import json, re, sys
import osmium

PBF = sys.argv[1]
S, W, N, E = (float(x) for x in sys.argv[2:6])
OUT = sys.argv[6]
BIG = (S - 0.025, W - 0.025, N + 0.025, E + 0.025)  # superset: ground bbox + margin

ROAD = re.compile(r"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|service)$")
LEISURE = re.compile(r"^(park|garden|pitch|playground|stadium|track|golf_course|swimming_pool|dog_park|nature_reserve|recreation_ground|marina|sports_centre)$")
NATURAL = re.compile(r"^(water|beach|sand|scrub|grassland|wood|wetland|coastline|bare_rock|heath)$")
RAIL_ROUTE = re.compile(r"^(train|light_rail|subway|tram)$")
RAIL_TRACK = re.compile(r"^(rail|light_rail|subway|tram|narrow_gauge)$")
AMENITY_G = re.compile(r"^(parking|school|university|college|hospital|grave_yard)$")
MANMADE_G = re.compile(r"^(pier|breakwater|groyne|bridge)$")
GOLF_G = re.compile(r"^(bunker|green|tee|fairway|driving_range|rough)$")
AERO_G = re.compile(r"^(runway|taxiway|apron|helipad)$")
RAIL_GROUND = re.compile(r"^(rail|light_rail|tram)$")


def in_box(lat, lon, b):
    return b[0] <= lat <= b[2] and b[1] <= lon <= b[3]


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nodes = {}   # id -> (lat, lon) for node members of kept relations
        self.ways = {}    # id -> {nodes, geometry, tags}
        self.rels = []    # {id, tags, members:[(type,ref,role)]}
        self.tree_nodes = []

    def node(self, n):
        lat, lon = n.location.lat, n.location.lon
        if not in_box(lat, lon, BIG):
            return
        t = dict(n.tags)
        self.nodes[n.id] = (lat, lon)
        if t.get("natural") == "tree":
            self.tree_nodes.append({"type": "node", "id": n.id, "lat": lat, "lon": lon, "tags": t})

    def way(self, w):
        pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if not any(in_box(lat, lon, BIG) for lat, lon in pts):
            return
        if len(pts) < 2:
            return
        self.ways[w.id] = {
            "nodes": [nd.ref for nd in w.nodes if nd.location.valid()],
            "geometry": [{"lat": p[0], "lon": p[1]} for p in pts],
            "tags": dict(w.tags),
        }

    def relation(self, r):
        t = dict(r.tags)
        members = [(m.type, m.ref, m.role) for m in r.members]
        self.rels.append({"id": r.id, "tags": t, "members": members})


print("pass 1: collecting…", flush=True)
c = Collector()
c.apply_file(PBF, locations=True)
print(f"  ways in area: {len(c.ways)}, relations seen: {len(c.rels)}, trees: {len(c.tree_nodes)}", flush=True)


def rel_out(rel, keep):
    if not keep(rel["tags"]):
        return None
    mem = []
    for typ, ref, role in rel["members"]:
        m = {"type": {"n": "node", "w": "way", "r": "relation"}[typ], "ref": ref, "role": role}
        if typ == "w" and ref in c.ways:
            m["geometry"] = c.ways[ref]["geometry"]
        elif typ == "n" and ref in c.nodes:
            m["lat"], m["lon"] = c.nodes[ref]
        mem.append(m)
    return {"type": "relation", "id": rel["id"], "tags": rel["tags"], "members": mem}


def way_out(wid, w, keep):
    t = w["tags"]
    if not t or not keep(t):
        return None
    return {"type": "way", "id": wid, "nodes": w["nodes"], "geometry": w["geometry"], "tags": t}


def emit(fname, bbox, way_keep, rel_keep, nodes=None):
    els = []
    if nodes:
        els.extend(nd for nd in nodes if in_box(nd["lat"], nd["lon"], bbox))
    for wid, w in c.ways.items():
        o = way_out(wid, w, way_keep)
        if o and any(in_box(p["lat"], p["lon"], bbox) for p in w["geometry"]):
            els.append(o)
    for rel in c.rels:
        o = rel_out(rel, rel_keep)
        if o:
            els.append(o)
    with open(f"{OUT}/{fname}", "w") as f:
        json.dump({"elements": els}, f, separators=(",", ":"))
    print(f"  {fname}: {len(els)} elements", flush=True)


BB = (S, W, N, E)
GB = (S - 0.02, W - 0.02, N + 0.02, E + 0.02)

emit("osm.json", BB,
     lambda t: bool(t.get("building")),
     lambda t: bool(t.get("building")),
     nodes=c.tree_nodes)
emit("roads.json", BB,
     lambda t: bool(ROAD.match(t.get("highway", ""))) and t.get("area") != "yes",
     lambda t: False)
emit("rails.json", BB,
     lambda t: bool(RAIL_TRACK.match(t.get("railway", ""))),
     lambda t: bool(RAIL_ROUTE.match(t.get("route", ""))))
emit("ground.json", GB,
     lambda t: (bool(t.get("highway")) and not re.match(r"yes|building_passage", t.get("tunnel", "")))
        or bool(t.get("area:highway"))
        or (bool(RAIL_GROUND.match(t.get("railway", ""))) and t.get("tunnel") != "yes")
        or bool(t.get("landuse")) or bool(LEISURE.match(t.get("leisure", "")))
        or bool(NATURAL.match(t.get("natural", ""))) or bool(t.get("water"))
        or t.get("waterway") == "riverbank" or bool(AMENITY_G.match(t.get("amenity", "")))
        or bool(MANMADE_G.match(t.get("man_made", ""))) or t.get("place") == "square"
        or bool(GOLF_G.match(t.get("golf", "")))
        or bool(AERO_G.match(t.get("aeroway", ""))),
     lambda t: bool(t.get("landuse")) or bool(LEISURE.match(t.get("leisure", "")))
        or bool(NATURAL.match(t.get("natural", ""))) or bool(t.get("water"))
        or t.get("waterway") == "riverbank" or bool(AMENITY_G.match(t.get("amenity", "")))
        or bool(MANMADE_G.match(t.get("man_made", ""))) or t.get("place") == "square"
        or bool(GOLF_G.match(t.get("golf", ""))) or bool(t.get("building")))
print("done", flush=True)
