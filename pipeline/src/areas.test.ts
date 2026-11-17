import assert from "node:assert/strict";
import { test } from "node:test";
import { AREAS, osmExtractFor } from "./areas.ts";
import { REGIONS } from "./places.ts";

test("Herzliya city and test patch use the local Geofabrik route", () => {
  for (const name of ["herzliya", "herzliya-test"]) {
    assert.equal(osmExtractFor(AREAS[name]), "https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf");
    assert.equal(AREAS[name].sources, "hzl");
  }
});

test("Tel Aviv areas still use Overpass, not the Herzliya extract", () => {
  for (const name of ["tlv-core", "rothschild"]) assert.equal(osmExtractFor(AREAS[name]), undefined);
  assert.equal(REGIONS["israel-center"].osmExtract, undefined);
});

test("Stuttgart areas retain their existing regional extract", () => {
  for (const area of Object.values(AREAS).filter((a) => a.region === "stuttgart")) {
    assert.ok(REGIONS.stuttgart.osmExtract);
    assert.equal(osmExtractFor(area), REGIONS.stuttgart.osmExtract);
  }
});

test("an area override takes precedence over a regional extract", () => {
  assert.equal(osmExtractFor({ ...AREAS.schlossplatz, osmExtract: "https://example.invalid/area.osm.pbf" }), "https://example.invalid/area.osm.pbf");
});
