/**
 * Tbilisi's landmarks (registries merged in landmarks.ts). Their shapes are OSM building:parts (preset osmParts);
 * here only the colours OSM does not tag, as rendered.
 */
export const PAINT: Record<string, { wall?: number[]; roof?: number[]; style?: number }> = {
  // Sameba (Holy Trinity Cathedral): warm yellow stone
  "წმინდა სამების საკათედრო ტაძარი": { wall: [0.91, 0.79, 0.55] },
};
