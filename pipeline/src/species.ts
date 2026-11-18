/**
 * Zagreb (sources "zg3d") tree species: the procedural STYLED look colours and shapes each crown by species.
 * scene.ts picks the species per crown (from OSM genus/species tags, or from the place: street, park, wood,
 * hill forest, riverbank, cemetery) and writes its index as the 5th value of the crown; page/renderer.ts
 * draws it. Shared by both, so the indices can't drift apart. Stuttgart and Tel Aviv keep their own tables.
 *
 * Continental Zagreb: plane, horse chestnut, linden and maple on the streets and in the Green Horseshoe
 * parks; pedunculate oak and hornbeam in Maksimir and the lowland woods; beech, sessile oak, sweet chestnut
 * and fir on Medvednica; willow and poplar on the Sava; thuja and cypress in the cemeteries (Mirogoj).
 *
 * [name, crown colour, crown scale xy (cone: width factor, 0 = 1), crown scale z, conifer (cone)?]
 */
export type Species = [string, number[], number, number, boolean];

export const ZG_SPECIES: Species[] = [
  ["plane", [0.42, 0.60, 0.22], 1.05, 0.85, false],
  ["horse chestnut", [0.24, 0.46, 0.14], 1, 0.9, false],
  ["linden", [0.36, 0.58, 0.18], 1, 0.9, false],
  ["maple", [0.46, 0.64, 0.20], 1, 0.85, false],
  ["oak", [0.30, 0.48, 0.16], 1.05, 0.8, false],
  ["hornbeam", [0.35, 0.53, 0.17], 0.95, 0.9, false],
  ["beech", [0.28, 0.50, 0.18], 1, 0.9, false],
  ["birch", [0.56, 0.68, 0.28], 0.75, 1.15, false],
  ["cherry", [0.90, 0.66, 0.72], 0.95, 0.75, false],
  ["black locust", [0.50, 0.65, 0.27], 0.95, 0.8, false],
  ["willow", [0.55, 0.66, 0.38], 1.1, 0.75, false],
  ["poplar", [0.40, 0.58, 0.22], 0.55, 1.7, false],
  ["sweet chestnut", [0.38, 0.54, 0.16], 1.05, 0.85, false],
  ["pine", [0.22, 0.40, 0.27], 0.95, 0.7, false],
  ["spruce", [0.13, 0.33, 0.24], 0, 0, true],
  ["fir", [0.12, 0.30, 0.21], 0, 0, true],
  ["thuja", [0.17, 0.36, 0.21], 0.55, 0, true],
  ["shrub", [0.40, 0.55, 0.22], 1.1, 0.7, false],
  ["fruit tree", [0.50, 0.63, 0.25], 1, 0.8, false],
];

/** Species index by name (throws on a typo, so a mix can't silently lose a species). */
export function zgSpecies(name: string): number {
  const i = ZG_SPECIES.findIndex((s) => s[0] === name);
  if (i < 0) throw new Error(`unknown species ${name}`);
  return i;
}
