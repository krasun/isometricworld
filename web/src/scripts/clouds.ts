/**
 * Cloud shadows drifting over the map (places.ts `effects.clouds`): soft patches of shade a few hundred metres
 * across, moving with a light west-south-westerly wind, fixed to the ground like everything on the map. Two layers
 * of tileable noise (a cool grey-blue, like the map's shadows) of different sizes and speeds, so the pattern never
 * visibly repeats, each a pattern fill over the screen on the overlay. They fade out when the map is zoomed far out,
 * where they would only speckle it.
 */
type M = number[][];

const N = 256;
/** [metres across one tile of the pattern, wind speed m/s, darkness] per layer */
const LAYERS: Array<[number, number, number]> = [[1100, 6, 0.24], [1750, 4.2, 0.17]];

/** a tileable cloud cover: fractal value noise on a wrapping lattice, only its upper part kept (soft edges) */
function cover(seed: number) {
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!, img = g.createImageData(N, N);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const octaves = [4, 8, 16, 32].map((L) => ({ L, v: Float32Array.from({ length: L * L }, rnd) }));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let f = 0, amp = 0.5, sum = 0;
    for (const { L, v } of octaves) {
      const fx = (x / N) * L, fy = (y / N) * L, i = Math.floor(fx), j = Math.floor(fy), u = smooth(fx - i), w = smooth(fy - j);
      const at = (a: number, b: number) => v[((b % L) * L) + (a % L)];
      f += amp * ((at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - w) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * w);
      sum += amp; amp *= 0.5;
    }
    f /= sum;
    const t = Math.min(1, Math.max(0, (f - 0.5) / 0.2)), a = smooth(t);
    const q = (y * N + x) * 4;
    img.data[q] = 30; img.data[q + 1] = 40; img.data[q + 2] = 72; img.data[q + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class Clouds {
  private layers: Array<{ tile: HTMLCanvasElement; pattern: CanvasPattern | null; artPerTexel: number; vel: [number, number]; alpha: number; off: [number, number] }>;

  constructor(enu2px: M) {
    // the wind from the west-south-west: the clouds move east-north-east
    const w = [Math.cos(0.35), Math.sin(0.35)];
    this.layers = LAYERS.map(([size, speed, alpha], i) => ({
      tile: cover(9241 + i * 7919), pattern: null, artPerTexel: size / 0.25 / N, alpha,
      vel: [(enu2px[0][0] * w[0] + enu2px[0][1] * w[1]) * speed * (1 + 0.15 * i), (enu2px[1][0] * w[0] + enu2px[1][1] * w[1]) * speed * (1 + 0.15 * i)],
      off: [i * 1777, i * 911],
    }));
  }

  step(dt: number) {
    for (const l of this.layers) { l.off[0] += l.vel[0] * dt; l.off[1] += l.vel[1] * dt; }
  }

  /** over the screen (device px w × h); the map's transform: canvas = global art px × k + (tx, ty); px: CSS px per art px */
  draw(ctx: CanvasRenderingContext2D, k: number, tx: number, ty: number, w: number, h: number, px: number) {
    const fade = Math.min(1, Math.max(0, (px - 0.02) / 0.06));
    if (fade <= 0) return;
    for (const l of this.layers) {
      l.pattern ??= ctx.createPattern(l.tile, "repeat");
      if (!l.pattern) continue;
      const s = l.artPerTexel * k;
      l.pattern.setTransform(new DOMMatrix([s, 0, 0, s, l.off[0] * k + tx, l.off[1] * k + ty]));
      ctx.globalAlpha = l.alpha * fade; // the cover's cores are opaque: a layer darkens at most by its darkness
      ctx.fillStyle = l.pattern;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalAlpha = 1;
  }
}
