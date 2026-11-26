#!/usr/bin/env python3
"""
Cut osm.json, osm-building-parts.json, roads.json, rails.json and ground.json of areas out of a local Geofabrik .osm.pbf with pyosmium,
for machines without osmium-tool (Windows). Same shape and selection as fetch.ts (osmlocal.ts FILTERS); then
`npm run fetch -- <area>` finds them and only adds the terrain. Existing files are kept.

  python -I pipeline/extract_areas.py <file.osm.pbf> <out root> <area>=<s>,<w>,<n>,<e> [more areas…]

Not selected: buildings picked only by the names in landmarks.ts (other cities' landmarks).
"""
import json
import os
import re
import sys

import osmium

PBF, ROOT = sys.argv[1:3]
AREAS = {}
for a in sys.argv[3:]:
    k, v = a.split("=")
    AREAS[k] = tuple(float(x) for x in v.split(","))
GM = 0.02   # ground.json reaches this far past the area (fetch.ts)
BUF = 0.15  # ways kept around all areas: relation members reach past them
B = (min(b[0] for b in AREAS.values()) - BUF, min(b[1] for b in AREAS.values()) - BUF,
     max(b[2] for b in AREAS.values()) + BUF, max(b[3] for b in AREAS.values()) + BUF)

ROAD = re.compile(r"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|service)$")
LEISURE = re.compile(r"^(park|garden|pitch|playground|stadium|track|golf_course|swimming_pool|dog_park|nature_reserve|recreation_ground|marina|sports_centre)$")
NATURAL = re.compile(r"^(water|beach|sand|scrub|grassland|wood|wetland|coastline|bare_rock|heath)$")
AMENITY = re.compile(r"^(parking|school|university|college|hospital|grave_yard)$")
PIER = re.compile(r"^(pier|breakwater|groyne|bridge)$")
GOLF = re.compile(r"^(bunker|green|tee|fairway|driving_range|rough)$")
ROUTE = re.compile(r"^(train|light_rail|subway|tram)$")
RAIL = re.compile(r"^(rail|light_rail|subway|tram|narrow_gauge|funicular)$")


def f_osm(ty, t):
    if ty == "node":
        return t.get("natural") == "tree"
    if t.get("building"):
        return True
    return bool(t.get("building:part")) and any(t.get(k) for k in (
        "roof:colour", "roof:material", "building:colour", "building:material", "min_height", "man_made"))


def f_roads(ty, t):
    return ty == "way" and bool(ROAD.match(t.get("highway", ""))) and t.get("area") != "yes"


def f_rails(ty, t):
    return (ty == "relation" and bool(ROUTE.match(t.get("route", "")))) or (ty == "way" and bool(RAIL.match(t.get("railway", ""))))


def f_ground(ty, t):
    if ty == "way":
        if t.get("highway") and not re.search("yes|building_passage", t.get("tunnel", "")):
            return True
        if t.get("area:highway") or t.get("railway") == "platform":
            return True
        if re.match(r"^(rail|light_rail|tram)$", t.get("railway", "")) and t.get("tunnel") != "yes":
            return True
        if re.match(r"^(runway|taxiway|apron|helipad)$", t.get("aeroway", "")):
            return True
    return bool(t.get("landuse") or LEISURE.match(t.get("leisure", "")) or NATURAL.match(t.get("natural", ""))
                or t.get("water") or t.get("waterway") == "riverbank" or AMENITY.match(t.get("amenity", ""))
                or PIER.match(t.get("man_made", "")) or t.get("place") == "square" or GOLF.match(t.get("golf", "")))


def f_parts(ty, t):
    return ty != "node" and bool(t.get("building:part"))


FILES = {"osm.json": (f_osm, 0.0), "osm-building-parts.json": (f_parts, 0.0), "roads.json": (f_roads, 0.0), "rails.json": (f_rails, 0.0), "ground.json": (f_ground, GM)}
TNAME = {"n": "node", "w": "way", "r": "relation"}


def inbox(p, b):
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def crosses(geom, b):
    """Does a polyline touch the box: a vertex inside it, or a segment through it (Liang–Barsky)?"""
    if any(inbox(p, b) for p in geom):
        return True
    for (a0, a1), (c0, c1) in zip(geom, geom[1:]):
        d0, d1, lo, hi, ok = c0 - a0, c1 - a1, 0.0, 1.0, True
        for p, q in ((-d0, a0 - b[0]), (d0, b[2] - a0), (-d1, a1 - b[1]), (d1, b[3] - a1)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                r = q / p
                if p < 0:
                    lo = max(lo, r)
                else:
                    hi = min(hi, r)
                if lo > hi:
                    ok = False
                    break
        if ok:
            return True
    return False


class Load(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nodes = {}  # tagged nodes: id -> (lat, lon, tags)
        self.ways = {}   # every way in B, untagged ones too (rings of multipolygons): id -> (geometry, node ids, tags)
        self.rels = []

    def node(self, n):
        if len(n.tags) and n.location.valid() and inbox((n.location.lat, n.location.lon), B):
            self.nodes[n.id] = (n.location.lat, n.location.lon, {t.k: t.v for t in n.tags})

    def way(self, w):
        geom, ids = [], []
        for nd in w.nodes:
            if nd.location.valid():
                geom.append((nd.location.lat, nd.location.lon))
                ids.append(nd.ref)
        if len(geom) >= 2 and any(inbox(p, B) for p in geom):
            self.ways[w.id] = (geom, ids, {t.k: t.v for t in w.tags})

    def relation(self, r):
        t = {x.k: x.v for x in r.tags}
        if t and any(f("relation", t) for f, _ in FILES.values()):
            self.rels.append((r.id, t, [(TNAME[m.type], m.ref, m.role) for m in r.members]))


L = Load()
L.apply_file(PBF, locations=True, idx="flex_mem")
print(f"{len(L.nodes)} tagged nodes, {len(L.ways)} ways, {len(L.rels)} relations")


def pts(geom):
    return [{"lat": round(a, 7), "lon": round(b, 7)} for a, b in geom]


def way_el(i):
    g, ids, t = L.ways[i]
    return {"type": "way", "id": i, "nodes": ids, "geometry": pts(g), "tags": t}


for name, box in AREAS.items():
    os.makedirs(os.path.join(ROOT, name), exist_ok=True)
    for file, (flt, m) in FILES.items():
        path = os.path.join(ROOT, name, file)
        if os.path.exists(path):
            print(f"{name}/{file}: kept")
            continue
        b = (box[0] - m, box[1] - m, box[2] + m, box[3] + m)
        out = []
        out += [{"type": "node", "id": i, "lat": la, "lon": lo, "tags": t}
                for i, (la, lo, t) in L.nodes.items() if flt("node", t) and inbox((la, lo), b)]
        hit = {i for i, (g, _, t) in L.ways.items() if flt("way", t) and crosses(g, b)}
        out += [way_el(i) for i in hit]
        stops = set()
        for i, t, ms in L.rels:
            if not flt("relation", t):
                continue
            if not any((ty == "way" and r in L.ways and crosses(L.ways[r][0], b))
                       or (ty == "node" and r in L.nodes and inbox(L.nodes[r][:2], b)) for ty, r, _ in ms):
                continue
            mem = []
            for ty, r, role in ms:
                e = {"type": ty, "ref": r, "role": role}
                if file != "rails.json" and ty == "way":  # routes come without member geometry
                    e["geometry"] = pts(L.ways[r][0]) if r in L.ways else []
                elif file == "rails.json" and ty == "node" and role == "stop":
                    stops.add(r)
                mem.append(e)
            out.append({"type": "relation", "id": i, "tags": t, "members": mem})
        for r in stops:
            if r in L.nodes and inbox(L.nodes[r][:2], b):
                la, lo, t = L.nodes[r]
                out.append({"type": "node", "id": r, "lat": la, "lon": lo, "tags": t})
        with open(path + ".tmp", "w", encoding="utf-8") as fh:
            json.dump({"elements": out}, fh, ensure_ascii=False)
        os.replace(path + ".tmp", path)
        print(f"{name}/{file}: {len(out)} elements")
