/**
 * The map's surface heights (pipeline export.ts exportHeights: the render's height pass, one value per 4 art px,
 * roofs and crowns included) for fly.ts, which lays the biplane's shadow over them. Tiles load as they are asked
 * for; once in, a height reads synchronously (NaN while loading and where there is no surface).
 */
import { CAMERA } from "../../../pipeline/src/camera.ts";

const T = CAMERA.tile, N = 256, PX = T / N;

export class Heights {
  private tiles = new Map<string, Float32Array | null | "loading">();
  private lk = ""; private lh: Float32Array | null = null;

  /** `index`: tile "tx_ty" → content hash; `url`: where that tile is */
  constructor(private index: Record<string, string>, private url: (tx: number, ty: number, v: string) => string) {}

  /** start loading the tiles over [x0, y0, x1, y1] (global art px) */
  want(x0: number, y0: number, x1: number, y1: number) {
    for (let ty = Math.floor(y0 / T); ty <= Math.floor(y1 / T); ty++) for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) {
      const k = `${tx}_${ty}`;
      if (!this.index[k] || this.tiles.has(k)) continue;
      this.tiles.set(k, "loading");
      this.load(tx, ty, k).then((h) => { this.tiles.set(k, h); this.lk = ""; }, () => this.tiles.set(k, null));
    }
  }

  private async load(tx: number, ty: number, k: string) {
    const blob = await (await fetch(this.url(tx, ty, this.index[k]))).blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, N, N).data, h = new Float32Array(N * N);
    // R·256 + G centimetres over the region's height base; no alpha: no surface
    for (let i = 0; i < N * N; i++) h[i] = d[i * 4 + 3] ? (d[i * 4] * 256 + d[i * 4 + 1]) / 100 : NaN;
    return h;
  }

  /** the surface's height (m over the region's base) at global art px */
  at(x: number, y: number): number {
    const tx = Math.floor(x / T), ty = Math.floor(y / T), k = `${tx}_${ty}`;
    if (k !== this.lk) { this.lk = k; const t = this.tiles.get(k); this.lh = t instanceof Float32Array ? t : null; }
    return this.lh ? this.lh[Math.floor((y - ty * T) / PX) * N + Math.floor((x - tx * T) / PX)] : NaN;
  }
}
