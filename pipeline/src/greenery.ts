/**
 * Lawns and gardens from an orthophoto (ground.ts, preset `greenery`): where the photo is green, the ground is
 * drawn as grass. OSM maps parks and some gardens; the yards between houses it mostly leaves as plain
 * residential land, which the map drew as one beige colour.
 *
 * Per 1024 m chunk of the photo (0.25 m pixels): at 0.5 m, the share of green pixels (excess green
 * (2G − R − B) / (R + G + B) > 0.06) among those not in deep shadow; a normalised blur (~1 m) fills the
 * shadows from around them. The lawn (share ≥ 0.45) is closed by ~2 m (grown, then shrunk back): the photo
 * leaves narrow strips round every house (its roof leans over the garden, its wall casts a shadow) and along
 * kerbs, and the ground under a house is hidden by it anyway. Marching squares on the closed mask, lightly
 * blurred, traces a smooth outline per 128 m block (each reaching 0.5 m into its neighbours, so filled blocks
 * overlap and leave no seam), simplified to 0.4 m; holes under 40 m² are filled, specks under 12 m² dropped.
 * Green under tree crowns stays: there is mostly grass under them too.
 */
import sharp from "sharp";

type P2 = [number, number];
const CELL = 0.5, BLOCK = 128;

/** Douglas-Peucker on an open line. */
function simplifyLine(r: P2[], tol: number): P2[] {
  if (r.length < 3) return r;
  const [a, b] = [r[0], r[r.length - 1]], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
  let far = 0, fd = -1;
  for (let i = 1; i < r.length - 1; i++) {
    const d = Math.abs((r[i][0] - a[0]) * dy - (r[i][1] - a[1]) * dx) / L;
    if (d > fd) { fd = d; far = i; }
  }
  if (fd <= tol) return [a, b];
  return [...simplifyLine(r.slice(0, far + 1), tol).slice(0, -1), ...simplifyLine(r.slice(far), tol)];
}
export function simplifyRing(r: P2[], tol: number): P2[] {
  let far = 0, fd = -1;
  for (let i = 1; i < r.length; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
  if (far === 0) return [];
  return [...simplifyLine(r.slice(0, far + 1), tol).slice(0, -1), ...simplifyLine([...r.slice(far), r[0]], tol).slice(0, -1)];
}
const area = (r: P2[]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

/** Box blur (radius R cells), in place via a scratch row/column. */
function blur(v: Float32Array, W: number, H: number, R = 2) {
  const tmp = new Float32Array(Math.max(W, H)), n = 2 * R + 1;
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = -R; x <= R; x++) s += v[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[x] = s / n;
      s += v[y * W + Math.min(W - 1, x + R + 1)] - v[y * W + Math.max(0, x - R)];
    }
    v.set(tmp.subarray(0, W), y * W);
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = -R; y <= R; y++) s += v[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      tmp[y] = s / n;
      s += v[Math.min(H - 1, y + R + 1) * W + x] - v[Math.max(0, y - R) * W + x];
    }
    for (let y = 0; y < H; y++) v[y * W + x] = tmp[y];
  }
}

/**
 * Marching squares at `iso` over a W × H grid (values at cell centres, row 0 south) in the window [i0, i1) ×
 * [j0, j1) and one cell round it (the grid's edge cell repeated past its edge), everything further out taken
 * as 0, so every outline closes and neighbouring windows overlap. Rings in grid units (cell centres at
 * integers), the inside on their left.
 */
export function contours(v: Float32Array, W: number, Hg: number, i0: number, j0: number, i1: number, j1: number, iso: number): P2[][] {
  const at = (i: number, j: number) => (i < i0 - 1 || j < j0 - 1 || i > i1 || j > j1 ? 0
    : v[Math.min(Hg - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))]);
  const next = new Map<number, number>(), point = new Map<number, P2>();
  const SW = i1 - i0 + 5; // edge ids over the padded window
  const H = (i: number, j: number) => 2 * ((j - j0 + 2) * SW + (i - i0 + 2)), V = (i: number, j: number) => H(i, j) + 1;
  const cut = (a: number, b: number) => (iso - a) / (b - a);
  for (let j = j0 - 2; j <= j1; j++) for (let i = i0 - 2; i <= i1; i++) {
    const v0 = at(i, j), v1 = at(i + 1, j), v2 = at(i + 1, j + 1), v3 = at(i, j + 1);
    const c = (v0 >= iso ? 1 : 0) | (v1 >= iso ? 2 : 0) | (v2 >= iso ? 4 : 0) | (v3 >= iso ? 8 : 0);
    if (c === 0 || c === 15) continue;
    const e = [H(i, j), V(i + 1, j), H(i, j + 1), V(i, j)];
    const p: P2[] = [[i + cut(v0, v1), j], [i + 1, j + cut(v1, v2)], [i + cut(v3, v2), j + 1], [i, j + cut(v0, v3)]];
    const seg = (a: number, b: number) => { next.set(e[a], e[b]); point.set(e[a], p[a]); point.set(e[b], p[b]); };
    const mid = (v0 + v1 + v2 + v3) / 4 >= iso;
    switch (c) {
      case 1: seg(0, 3); break; case 2: seg(1, 0); break; case 4: seg(2, 1); break; case 8: seg(3, 2); break;
      case 14: seg(3, 0); break; case 13: seg(0, 1); break; case 11: seg(1, 2); break; case 7: seg(2, 3); break;
      case 3: seg(1, 3); break; case 12: seg(3, 1); break; case 6: seg(2, 0); break; case 9: seg(0, 2); break;
      case 5: if (mid) { seg(0, 1); seg(2, 3); } else { seg(0, 3); seg(2, 1); } break;
      case 10: if (mid) { seg(3, 0); seg(1, 2); } else { seg(1, 0); seg(3, 2); } break;
    }
  }
  const rings: P2[][] = [], seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const r: P2[] = [];
    for (let k: number | undefined = start; k !== undefined && !seen.has(k); k = next.get(k)) { seen.add(k); r.push(point.get(k)!); }
    if (r.length >= 3) rings.push(r);
  }
  return rings;
}

/**
 * Lawn outlines from the photo chunks (south-west corner and side in projected metres, pixel size, file) inside
 * the projected box [e0, n0, e1, n1]: per 128 m block, rings in the frame `to` maps projected metres into.
 */
export async function lawns(chunks: Array<{ e: number; n: number; size: number; px: number; file: string }>, box: number[],
  to: (e: number, n: number) => P2): Promise<P2[][][]> {
  const out: P2[][][] = [];
  for (const ch of chunks) {
    const { data, info } = await sharp(ch.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const step = Math.round(CELL / ch.px), W = Math.floor(info.width / step), H = Math.floor(info.height / step);
    const green = new Float32Array(W * H), known = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let g = 0, k = 0;
      for (let y = 0; y < step; y++) for (let x = 0; x < step; x++) {
        // photo rows run north to south; grid rows south to north
        const q = ((info.height - 1 - (j * step + y)) * info.width + i * step + x) * 3, R = data[q], G = data[q + 1], B = data[q + 2], s = R + G + B;
        if (s < 0.12 * 3 * 255) continue; // deep shadow: unknown
        k++;
        if ((2 * G - R - B) / s > 0.06) g++;
      }
      green[j * W + i] = g; known[j * W + i] = k;
    }
    blur(green, W, H); blur(known, W, H);
    // lawn where at least 0.45 of the known pixels around are green, closed by ~2 m, then softened for the outline
    for (let q = 0; q < W * H; q++) green[q] = known[q] > 0.05 && green[q] / known[q] >= 0.45 ? 1 : 0;
    blur(green, W, H); blur(green, W, H);
    for (let q = 0; q < W * H; q++) green[q] = green[q] > 0.12 ? 1 : 0;
    blur(green, W, H); blur(green, W, H);
    for (let q = 0; q < W * H; q++) green[q] = green[q] > 0.88 ? 1 : 0;
    blur(green, W, H, 1);
    // 128 m blocks of the box inside this chunk, each traced with 0.5 m of its neighbours
    const n = BLOCK / CELL;
    for (let bj = 0; bj < H; bj += n) for (let bi = 0; bi < W; bi += n) {
      const e = ch.e + bi * CELL, nn = ch.n + bj * CELL;
      if (e > box[2] || e + BLOCK < box[0] || nn > box[3] || nn + BLOCK < box[1]) continue;
      const rings: P2[][] = [];
      for (const r of contours(green, W, H, bi, bj, Math.min(W, bi + n), Math.min(H, bj + n), 0.5)) {
        const m = simplifyRing(r.map(([i, j]) => [ch.e + (i + 0.5) * CELL, ch.n + (j + 0.5) * CELL] as P2), 0.4);
        const a = m.length >= 3 ? area(m) : 0; // lawns counter-clockwise, holes clockwise
        if (a >= 12 || a <= -40) rings.push(m.map(([x, y]) => to(x, y)));
      }
      if (rings.length) out.push(rings);
    }
  }
  return out;
}
