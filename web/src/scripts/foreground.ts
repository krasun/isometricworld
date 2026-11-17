/**
 * The foreground layer (export.ts "fg", regions with `life.foreground`): what stands higher than a car, tree
 * crowns and the walls and roofs of buildings above ~2.5 m, cut out of the map tiles and transparent elsewhere.
 * Drawn back over the vehicles, and only where they are, so cars pass under crowns and behind houses instead of
 * over them. Tiles come at the level whose pixels are about a screen pixel, are fetched as needed and kept
 * (the last ~160); until one has arrived, the vehicles under it simply show.
 */
/** zoom -> "x_y" (global tile indices) -> content hash */
export type FgIndex = Record<string, Record<string, string>>;

export class Foreground {
  private images = new Map<string, ImageBitmap | null>(); // null: failed, don't retry
  private loading = new Set<string>();

  constructor(private index: FgIndex, private url: (z: number, x: number, y: number, v: string) => string,
    private tileSize: number, private nativeZ: number, private minZ: number) {}

  /** Over `rects` ([x0, y0, x1, y1] canvas px), with canvas px = global art px × k + (tx, ty). */
  draw(ctx: CanvasRenderingContext2D, k: number, tx: number, ty: number, rects: number[][]) {
    if (!rects.length) return;
    // the level whose pixels are about one canvas pixel (k = canvas px per art px)
    const z = Math.max(this.minZ, Math.min(this.nativeZ, this.nativeZ + Math.floor(Math.log2(k * 1.5))));
    const have = this.index[z];
    if (!have) return;
    const span = this.tileSize * 2 ** (this.nativeZ - z), tiles = new Set<string>();
    for (const [x0, y0, x1, y1] of rects)
      for (let gy = Math.floor((y0 - ty) / k / span); gy <= Math.floor((y1 - ty) / k / span); gy++)
        for (let gx = Math.floor((x0 - tx) / k / span); gx <= Math.floor((x1 - tx) / k / span); gx++) tiles.add(`${gx}_${gy}`);
    ctx.save();
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of rects) ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    for (const id of tiles) {
      const v = have[id];
      if (!v) continue; // nothing tall there
      const key = `${z}/${id}`, img = this.images.get(key);
      if (img === undefined) { this.load(key, z, id, v); continue; }
      if (!img) continue;
      this.images.delete(key); this.images.set(key, img); // most recently used last
      const [gx, gy] = id.split("_").map(Number);
      ctx.drawImage(img, gx * span * k + tx, gy * span * k + ty, span * k, span * k);
    }
    ctx.restore();
  }

  private load(key: string, z: number, id: string, v: string) {
    if (this.loading.has(key)) return;
    this.loading.add(key);
    const [x, y] = id.split("_").map(Number);
    fetch(this.url(z, x, y, v))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => createImageBitmap(b))
      .then((img) => {
        this.images.set(key, img);
        while (this.images.size > 160) { const old = this.images.keys().next().value!; this.images.get(old)?.close(); this.images.delete(old); }
      }, () => this.images.set(key, null))
      .finally(() => this.loading.delete(key));
  }
}
