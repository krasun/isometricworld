/**
 * Presets of the procedural look (places.ts `look: "styled"`): what the renderer (page/renderer.ts) draws
 * for a region, as data. A region picks one by name (`style`, default "stuttgart"). Pure data, shared by
 * the renderer page and the pipeline.
 *
 * A new look feature is a field here whose value in the existing presets keeps their look unchanged (check
 * the Stuttgart test patch pixel for pixel), not a flag on each region. Regions in the same country or
 * climate share a preset.
 */
import type { BuildingKind } from "./lod2.ts";

export interface StylePreset {
  /**
   * Sun shadows cast by buildings and trees onto the ground, roofs and walls: the colour a fully shaded
   * surface is multiplied by. null: no cast shadows, only short soft contact shadows on the ground.
   */
  castShadow: [number, number, number] | null;
  /**
   * Wall colours per building style (scene.ts lod2Style: 0 homes with pitched roofs, 1 flat-roofed homes,
   * 2 public, 3 towers, 4 sheds and halls, 5 offices), RGB 0…1; each building picks one by its seed, so a
   * colour listed twice is twice as common. A style left out (or null) keeps the renderer's own palette.
   */
  walls: Partial<Record<number, number[][]>> | null;
  /**
   * Building kinds (lod2.ts BuildingKind) drawn as monumental walls (façade style 6, page/renderer.ts): laid
   * out on each wall rather than a floor grid: a stone plinth, pilasters at the corners and between bays,
   * one tall round-arched window per bay, a cornice at the eaves, an oculus in the gable, a portal in the
   * gable wall; towers in storeys with a clock and the belfry at the top. Two-tone: pilasters, cornices
   * and surrounds in a cream trim. No roof clutter. Empty: those kinds keep their usual style.
   */
  monumental: BuildingKind[];
  /**
   * Eaves (LoD2 roofs end flush with the walls): each pitched roof plane carried `overhang` m (in plan) past
   * its eaves and `verge` m past its gables, a gutter under the eaves and downpipes at their ends and corners
   * (page/renderer.ts eaves). null: roofs end at the walls.
   */
  eaves: { overhang: number; verge: number; gutters: boolean } | null;
  /** Broadleaf trees stand on a trunk (from the ground up into the crown); false: their crowns float (conifers and
   *  palms always have one). */
  trunks: boolean;
  /** Streets as OSM maps them (ground.ts): pavements only where its `sidewalk*` tags put them (default both),
   *  separately mapped sidewalks drawn as pavement, road and path surfaces (paving, setts, gravel, dirt, grass,
   *  concrete). false: a pavement along both sides of every street, roads asphalt. */
  streetDetail: boolean;
  /** Lawns and gardens where the orthophoto is green (ground.ts, greenery.ts; sources with an orthophoto: gugik),
   *  over the plain residential, commercial and campus land; false: that land is one flat colour. */
  greenery: boolean;
  /** Trees of several lobes, species shapes (birches, poplars, willows, spruces, pines, thujas…) and foliage
   *  shading (page/trees.ts); false: one lumpy ball per broadleaf crown. */
  richTrees: boolean;
}

/** Polish town plaster: mostly white, ecru and beige, some sand, pale yellow, salmon and grey, a little old pale green. */
const PL_HOMES = [
  [0.96, 0.95, 0.93], [0.96, 0.95, 0.93], [0.96, 0.95, 0.93], [0.95, 0.91, 0.82], [0.95, 0.91, 0.82],
  [0.91, 0.86, 0.76], [0.91, 0.86, 0.76], [0.89, 0.82, 0.68], [0.96, 0.90, 0.70], [0.95, 0.83, 0.74],
  [0.86, 0.86, 0.85], [0.86, 0.86, 0.85], [0.80, 0.78, 0.74], [0.92, 0.80, 0.58], [0.86, 0.90, 0.78],
  [0.66, 0.67, 0.69],
];

export const STYLES = {
  /** Stuttgart (the first styled region): contact shadows only. */
  stuttgart: { castShadow: null, walls: null, monumental: [], eaves: null, trunks: false, streetDetail: false, greenery: false, richTrees: false },
  /** Polish towns (Wieliczka): cool, soft cast shadows, the shade side of a sunny day. */
  poland: {
    castShadow: [0.60, 0.64, 0.80],
    walls: {
      0: PL_HOMES,
      1: [[0.95, 0.95, 0.94], [0.88, 0.88, 0.87], [0.94, 0.90, 0.81], [0.95, 0.91, 0.74], [0.84, 0.87, 0.90], [0.90, 0.85, 0.76]],
      // Galician public buildings: ochre yellow (the Habsburg Schönbrunn yellow), cream
      2: [[0.93, 0.80, 0.47], [0.93, 0.80, 0.47], [0.94, 0.89, 0.78], [0.90, 0.78, 0.58], [0.95, 0.94, 0.91]],
      // outbuildings, garages, halls: plaster, red brick, weathered wood, sheet metal
      4: [[0.78, 0.78, 0.76], [0.84, 0.80, 0.72], [0.70, 0.42, 0.33], [0.86, 0.86, 0.84], [0.62, 0.50, 0.38]],
      5: [[0.93, 0.93, 0.92], [0.86, 0.87, 0.88], [0.94, 0.91, 0.84], [0.66, 0.67, 0.69]],
      // churches: white, cream, Galician ochre, salmon pink, pale yellow plaster
      6: [[0.96, 0.95, 0.92], [0.95, 0.91, 0.82], [0.93, 0.82, 0.55], [0.94, 0.82, 0.78], [0.96, 0.90, 0.70]],
    },
    monumental: ["church"],
    eaves: { overhang: 0.5, verge: 0.3, gutters: true },
    trunks: true,
    streetDetail: true,
    greenery: true,
    richTrees: true,
  },
} satisfies Record<string, StylePreset>;

export type StyleName = keyof typeof STYLES;

/** The preset of a region's `style` (default "stuttgart"). */
export const styleOf = (name: StyleName | undefined): StylePreset => STYLES[name ?? "stuttgart"];
