/**
 * Ink outline for animated things (cars, trains, aircraft) so they match the painted map's line style:
 * a dark line ~0.3 m wide, i.e. the same weight as the painting's outlines at every zoom, dropped when the
 * object is only a few screen pixels big (a dark rim would swallow its colour).
 */
const INK = "rgba(34,36,42,0.85)";
const WORLD_WIDTH = 0.3; // m
const MIN_PX = 0.4, MAX_PX = 2.5;

/** Stroke the current path. `pxPerM`: screen px per metre of the drawn object (default: the transform's scale,
 *  for shapes drawn in metres under a transform). */
export function ink(ctx: CanvasRenderingContext2D, pxPerM?: number) {
  const t = ctx.getTransform(), unit = Math.hypot(t.a, t.b) || 1; // screen px per path unit
  const px = Math.min(MAX_PX, WORLD_WIDTH * (pxPerM ?? unit));
  if (px < MIN_PX) return;
  ctx.lineWidth = px / unit;
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.stroke();
}
