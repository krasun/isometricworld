/**
 * Bridge decks. The terrain (DGM1) is bare earth: under a bridge it holds whatever the bridge spans (the
 * road in a cutting, the river), so a bridge draped on it sags into the gap. A deck instead runs straight
 * between the terrain at its two ends (the abutments), never below the terrain itself. The renderer
 * (page/renderer.ts) builds the deck there and the export (traffic) drives on it; both use this function
 * on the same terrain grid, so cars stay on the drawn deck.
 */
type P2 = [number, number];

/** Height (ENU up) along an OSM bridge line `l` (ENU metres), by arc length `s` from l[0] at (x, y). */
export function deckHeight(l: P2[], ground: (x: number, y: number) => number | null) {
  const cum = [0];
  for (let i = 1; i < l.length; i++) cum.push(cum[i - 1] + Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]));
  const len = cum.at(-1)!;
  // the end of the way, or a few metres past it on the embankment if that is higher (OSM bridge ends
  // often stop short of the abutment, inside the gap)
  const end = (p: P2, q: P2) => {
    const dx = p[0] - q[0], dy = p[1] - q[1], d = Math.hypot(dx, dy) || 1;
    let h = -Infinity;
    for (const k of [0, 1.5, 3]) {
      const g = ground(p[0] + (dx / d) * k, p[1] + (dy / d) * k);
      if (g !== null && Number.isFinite(g)) h = Math.max(h, g);
    }
    return h;
  };
  const a = end(l[0], l[1]), b = end(l.at(-1)!, l.at(-2)!);
  return {
    len, cum,
    at(s: number, x: number, y: number) {
      const g = ground(x, y);
      const line = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * Math.min(1, Math.max(0, s / (len || 1))) : -Infinity;
      return Math.max(line, g === null ? -Infinity : g + 0.3);
    },
  };
}

/** Is this OSM way a bridge (deck above the ground)? */
export const isBridge = (t: Record<string, string>) => !!t.bridge && t.bridge !== "no";
