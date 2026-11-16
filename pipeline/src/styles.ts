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
}

export const STYLES = {
  /** Stuttgart (the first styled region): contact shadows only. */
  stuttgart: { castShadow: null },
  /** Polish towns (Wieliczka): cool, soft cast shadows, the shade side of a sunny day. */
  poland: { castShadow: [0.60, 0.64, 0.80] },
} satisfies Record<string, StylePreset>;

export type StyleName = keyof typeof STYLES;

/** The preset of a region's `style` (default "stuttgart"). */
export const styleOf = (name: StyleName | undefined): StylePreset => STYLES[name ?? "stuttgart"];
