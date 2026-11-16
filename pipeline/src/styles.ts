/**
 * Presets of the procedural look (places.ts `look: "styled"`): what the renderer (page/renderer.ts) draws
 * for a region, as data. A region picks one by name (`style`, default "stuttgart"). Pure data, shared by
 * the renderer page and the pipeline.
 *
 * A new look feature is a field here whose value in the existing presets keeps their look unchanged (check
 * the Stuttgart test patch pixel for pixel), not a flag on each region. Regions in the same country or
 * climate share a preset.
 */
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
  stuttgart: { castShadow: null, walls: null },
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
    },
  },
} satisfies Record<string, StylePreset>;

export type StyleName = keyof typeof STYLES;

/** The preset of a region's `style` (default "stuttgart"). */
export const styleOf = (name: StyleName | undefined): StylePreset => STYLES[name ?? "stuttgart"];
