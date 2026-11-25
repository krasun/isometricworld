/**
 * The cut rock of a mine level between its workings (page/mine.ts, drawMineCap), illustrative and quiet (a background
 * in the old rock's tones, a few per cent apart, so the workings stay what one looks at): the deposit's build
 * (src/minedata.ts LAYERED) and the things hidden in it just for fun (EGGS). Everything is a function of the place
 * (hashes of world cells), so neighbouring tiles join without seams.
 *
 *   layered deposit (south, below)  folded beds along the strike: green, spiza and shaft salt, clay, thin anhydrite
 *   block deposit (north, above)    green salt boulders, translucent, in dark clay and zuber
 *   both                            pockets of salt crystals (cubes, as in the Crystal Grottoes)
 */
type P2 = [number, number];

/** a number in [0, 1) for integer coordinates (and a salt telling uses apart) */
function hash(a: number, b: number, c = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) ^ 0xc2b2ae35, 0x27d4eb2f) ^ Math.imul((c | 0) + 0x165667b1, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const BEDS = [
  { p: 0.32, c: "#4c5047" }, // green salt
  { p: 0.58, c: "#514a40" }, // spiza salt (sandy, brownish)
  { p: 0.82, c: "#56534d" }, // shaft salt (the purest, pale)
  { p: 1, c: "#46423c" }, //    clay
];

/**
 * The rock's build over rect. e: [cx, cy, ux, uy, tb, level]: the strike frame (s along U, t across, positive north)
 * and tb, the t where the layered deposit gives way to the block deposit (wavy).
 */
export function drawRock(ctx: CanvasRenderingContext2D, e: number[], rect: number[]) {
  const [cx, cy, ux, uy, tb, li] = e;
  const st = (x: number, y: number): P2 => [(x - cx) * ux + (y - cy) * uy, -(x - cx) * uy + (y - cy) * ux];
  const cs = [st(rect[0], rect[1]), st(rect[2], rect[1]), st(rect[2], rect[3]), st(rect[0], rect[3])];
  const s0 = Math.min(...cs.map((p) => p[0])) - 40, s1 = Math.max(...cs.map((p) => p[0])) + 40;
  const t0 = Math.min(...cs.map((p) => p[1])) - 40, t1 = Math.max(...cs.map((p) => p[1])) + 40;
  const B = (s: number) => tb + 20 * Math.sin(s / 95 + li * 1.7) + 8 * Math.sin(s / 33 + li);
  // folds: the beds' boundaries move together (slowly with t, so they never cross)
  const F = (s: number, t: number) => 16 * Math.sin(s / 75 + t / 170 + li) + 6 * Math.sin(s / 26 + t / 60);
  const S: number[] = [];
  for (let s = Math.floor(s0 / 4) * 4; s <= s1 + 4; s += 4) S.push(s);

  ctx.save();
  ctx.transform(ux, uy, -uy, ux, cx, cy); // drawing in (s, t) from here on

  // ---- layered deposit: south of the boundary -------------------------------------------------------
  ctx.save();
  ctx.beginPath(); S.forEach((s, i) => (i ? ctx.lineTo(s, B(s)) : ctx.moveTo(s, B(s)))); ctx.lineTo(S.at(-1)!, t0 - 60); ctx.lineTo(S[0], t0 - 60); ctx.closePath();
  ctx.clip();
  const P = 8, edge = (k: number) => (s: number) => k * P + (hash(k, 1, li) - 0.5) * 5 + F(s, k * P);
  for (let k = Math.floor((t0 - 30) / P); k <= Math.ceil((t1 + 30) / P); k++) {
    const lo = edge(k), hi = edge(k + 1), h = hash(k, 2, li);
    ctx.beginPath(); S.forEach((s, i) => (i ? ctx.lineTo(s, lo(s)) : ctx.moveTo(s, lo(s)))); for (let i = S.length - 1; i >= 0; i--) ctx.lineTo(S[i], hi(S[i])); ctx.closePath();
    ctx.fillStyle = BEDS.find((b) => h < b.p)!.c; ctx.fill();
    if (hash(k, 3, li) < 0.22) { // a thin anhydrite bed on this boundary
      ctx.beginPath(); S.forEach((s, i) => (i ? ctx.lineTo(s, lo(s)) : ctx.moveTo(s, lo(s))));
      ctx.lineWidth = 0.5 + hash(k, 4, li); ctx.strokeStyle = "rgba(200,194,180,0.1)"; ctx.stroke();
    }
  }
  ctx.restore();

  // ---- block deposit: green salt boulders in clay, north of the boundary --------------------------------
  ctx.save();
  ctx.beginPath(); S.forEach((s, i) => (i ? ctx.lineTo(s, B(s)) : ctx.moveTo(s, B(s)))); ctx.lineTo(S.at(-1)!, t1 + 60); ctx.lineTo(S[0], t1 + 60); ctx.closePath();
  ctx.fillStyle = "#4a4640"; ctx.fill();
  ctx.clip();
  const G = 18;
  for (let i = Math.floor((s0 - 14) / G); i <= Math.ceil((s1 + 14) / G); i++) for (let j = Math.floor((t0 - 14) / G); j <= Math.ceil((t1 + 14) / G); j++) {
    const n = hash(i, j, 5) < 0.35 ? 0 : hash(i, j, 6) < 0.75 ? 1 : 2;
    for (let m = 0; m < n; m++) {
      const q = 10 + m * 7, bx = (i + hash(i, j, q)) * G, by = (j + hash(i, j, q + 1)) * G;
      // mostly small, now and then a big one; broken, angular
      const r = 1.5 + Math.pow(hash(i, j, q + 2), 2.2) * 9, stretch = 1 + hash(i, j, q + 3) * 0.6, rot = (hash(i, j, q + 4) - 0.5) * 0.8;
      ctx.beginPath();
      for (let v = 0; v < 7; v++) {
        const th = ((v + hash(i * 17 + v, j, q + 6) * 0.5) / 7) * 2 * Math.PI, rr = r * (0.7 + 0.45 * hash(i * 31 + v, j, q + 5)), x = rr * stretch * Math.cos(th), y = rr * Math.sin(th);
        const px = bx + x * Math.cos(rot) - y * Math.sin(rot), py = by + x * Math.sin(rot) + y * Math.cos(rot);
        if (v) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      // green salt, polished by the cut: lit from one side, translucent towards it
      const g = ctx.createRadialGradient(bx - r * 0.3, by + r * 0.3, 0, bx, by, r * stretch * 1.1);
      g.addColorStop(0, "#575d50"); g.addColorStop(1, "#4d5148");
      ctx.fillStyle = g; ctx.fill();
    }
  }
  ctx.restore();
  // where the two meet: a seam of clay
  ctx.beginPath(); S.forEach((s, i) => (i ? ctx.lineTo(s, B(s)) : ctx.moveTo(s, B(s))));
  ctx.lineWidth = 1.4; ctx.strokeStyle = "rgba(34,30,25,0.25)"; ctx.stroke();

  // ---- pockets of salt crystals ----------------------------------------------------------------------
  const K = 40;
  for (let i = Math.floor((s0 - 6) / K); i <= Math.ceil((s1 + 6) / K); i++) for (let j = Math.floor((t0 - 6) / K); j <= Math.ceil((t1 + 6) / K); j++) {
    if (hash(i, j, 7) > 0.2) continue;
    const px = (i + hash(i, j, 8)) * K, py = (j + hash(i, j, 9)) * K;
    const glow = ctx.createRadialGradient(px, py, 0, px, py, 4.5);
    glow.addColorStop(0, "rgba(255,250,240,0.2)"); glow.addColorStop(1, "rgba(255,250,240,0)");
    ctx.fillStyle = glow; ctx.fillRect(px - 4.5, py - 4.5, 9, 9);
    const n = 6 + Math.floor(hash(i, j, 10) * 9), pink = hash(i, j, 11) > 0.6;
    for (let m = 0; m < n; m++) {
      const a = hash(i, j, 20 + m) * 2 * Math.PI, d = Math.sqrt(hash(i, j, 40 + m)) * 2.6, z = 0.35 + Math.pow(hash(i, j, 60 + m), 2) * 1.1;
      const x = px + d * Math.cos(a), y = py + d * Math.sin(a), rot = hash(i, j, 80 + m) * 0.6;
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      ctx.fillStyle = pink ? "rgba(236,218,212,0.92)" : "rgba(238,234,226,0.92)"; ctx.fillRect(-z / 2, -z / 2, z, z);
      ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.fillRect(-z / 2, z / 2 - z * 0.22, z, z * 0.22); // the lit face
      ctx.lineWidth = 0.06; ctx.strokeStyle = "rgba(90,82,74,0.6)"; ctx.strokeRect(-z / 2, -z / 2, z, z);
      ctx.restore();
    }
  }
  ctx.restore();
}

// ---- the eggs ------------------------------------------------------------------------------------------
const INK = "rgba(22,17,12,0.9)";
const poly = (ctx: CanvasRenderingContext2D, pts: number[][]) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
/** a stroke with a dark outline under it */
function inked(ctx: CanvasRenderingContext2D, pts: number[][], w: number, colour: string) {
  poly(ctx, pts); ctx.lineWidth = w + 0.35; ctx.strokeStyle = INK; ctx.stroke();
  poly(ctx, pts); ctx.lineWidth = w; ctx.strokeStyle = colour; ctx.stroke();
}
function filled(ctx: CanvasRenderingContext2D, pts: number[][], colour: string, outline = 0.14) {
  poly(ctx, pts); ctx.closePath(); ctx.fillStyle = colour; ctx.fill(); ctx.lineWidth = outline; ctx.strokeStyle = INK; ctx.stroke();
}
function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string, outline = 0.1) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = colour; ctx.fill();
  if (outline) { ctx.lineWidth = outline; ctx.strokeStyle = INK; ctx.stroke(); }
}
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

const BONE = "#ece2c8";
/** a theropod's skeleton on its side, 30 units from tail to snout */
function dino(ctx: CanvasRenderingContext2D) {
  const spine = [[-15, 1.5], [-10, 2.6], [-5, 4.2], [-1, 5.2], [3, 5.6], [6, 6.2], [8, 7.4], [9.5, 9], [10.5, 9.6]];
  // the far legs first, darker
  for (const [dx, shade] of [[1.1, "#bdb39b"], [0, BONE]] as Array<[number, string]>) {
    inked(ctx, [[-2 + dx, 4.4], [-1.2 + dx, 1.6]], 0.75, shade);
    inked(ctx, [[-1.2 + dx, 1.6], [-2.2 + dx, -1.6]], 0.6, shade);
    inked(ctx, [[-2.2 + dx, -1.6], [-1.4 + dx, -3.4]], 0.45, shade);
    inked(ctx, [[-1.4 + dx, -3.4], [0.3 + dx, -3.6]], 0.3, shade);
    inked(ctx, [[-1.4 + dx, -3.4], [-0.3 + dx, -4.0]], 0.3, shade);
    inked(ctx, [[-1.4 + dx, -3.4], [-2.4 + dx, -3.7]], 0.25, shade);
  }
  // ribs hanging from the back
  for (let u = -0.5; u <= 6.6; u += 0.8) {
    const top = 5.2 + (u + 1) * 0.12, len = 3.6 - Math.abs(u - 2.5) * 0.35;
    inked(ctx, [[u, top], [u + 0.5, top - len * 0.55], [u + 0.2, top - len]], 0.22, BONE);
  }
  // the spine with its vertebrae, thinner towards the tail
  inked(ctx, spine, 0.5, BONE);
  for (let i = 0; i < spine.length - 1; i++) {
    const [a, b] = [spine[i], spine[i + 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d < L; d += 0.7) {
      const k = d / L, x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
      const h = 0.25 + Math.max(0, Math.min(1, (x + 15) / 14)) * 0.55;
      inked(ctx, [[x, y], [x + nx * h, y + ny * h]], 0.16, BONE);
    }
  }
  // hips
  ctx.beginPath(); ctx.ellipse(-2.2, 5.1, 1.9, 0.9, 0.1, 0, 2 * Math.PI); ctx.fillStyle = BONE; ctx.fill(); ctx.lineWidth = 0.14; ctx.strokeStyle = INK; ctx.stroke();
  inked(ctx, [[-1.6, 4.4], [-0.6, 2.3]], 0.35, BONE);
  inked(ctx, [[-2.6, 4.4], [-3.8, 2.8]], 0.3, BONE);
  // little arms
  inked(ctx, [[7.2, 5.9], [8.1, 4.6], [8.9, 4.8]], 0.22, BONE);
  // the skull, jaw and teeth
  filled(ctx, [[10.2, 10.3], [12.2, 10.4], [14, 9.8], [15.1, 8.9], [14.7, 8.3], [12.6, 8.5], [10.5, 8.6]], BONE);
  filled(ctx, [[10.8, 8.4], [12.6, 8.1], [14.5, 7.6], [14.9, 8.05], [12.6, 8.5]], BONE);
  for (let x = 11.6; x < 14.6; x += 0.45) { poly(ctx, [[x, 8.5], [x + 0.12, 8.15], [x + 0.24, 8.48]]); ctx.fillStyle = "#fffaf0"; ctx.fill(); }
  disc(ctx, 11.5, 9.5, 0.45, "#2a221a", 0);
  disc(ctx, 13.2, 9.5, 0.3, "#2a221a", 0);
}

/** St. Kinga's ring in a lump of green salt, 9 units across */
function ring(ctx: CanvasRenderingContext2D) {
  const lump = Array.from({ length: 13 }, (_, i) => { const a = (i / 13) * 2 * Math.PI, r = 4.1 + 0.5 * Math.sin(3 * a) + 0.3 * Math.cos(5 * a + 1); return [r * 1.08 * Math.cos(a), r * Math.sin(a)]; });
  poly(ctx, lump); ctx.closePath();
  const g = ctx.createRadialGradient(-0.6, 0.6, 0, 0, 0, 4.6); g.addColorStop(0, "#a2ae97"); g.addColorStop(1, "#66725f");
  ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 0.18; ctx.strokeStyle = INK; ctx.stroke();
  glow(ctx, 0, -0.1, 3, "255,226,140", 0.45);
  ctx.beginPath(); ctx.ellipse(0, -0.3, 1.7, 1.15, -0.2, 0, 2 * Math.PI); ctx.lineWidth = 0.75; ctx.strokeStyle = "#4e3a12"; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, -0.3, 1.7, 1.15, -0.2, 0, 2 * Math.PI); ctx.lineWidth = 0.48; ctx.strokeStyle = "#e3b947"; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, -0.3, 1.7, 1.15, -0.2, 3.6, 5.2); ctx.lineWidth = 0.14; ctx.strokeStyle = "#fff1b0"; ctx.stroke();
  filled(ctx, [[-0.05, 1.45], [0.5, 0.95], [0.1, 0.45], [-0.45, 0.9]], "#c62c43", 0.1);
  disc(ctx, 0.05, 1.05, 0.12, "#ffe3e8", 0);
  for (const [x, y, r] of [[2.2, 1.6, 0.45], [-2.3, -1.4, 0.35], [1.7, -2.0, 0.3]]) { // glints
    inked(ctx, [[x - r, y], [x + r, y]], 0.07, "#fffbe8"); inked(ctx, [[x, y - r], [x, y + r]], 0.07, "#fffbe8");
  }
}

/** the Skarbnik's chest, its lid open, gold spilling out, 10 units across */
function chest(ctx: CanvasRenderingContext2D) {
  glow(ctx, 0, 1.5, 5.5, "255,214,120", 0.35);
  filled(ctx, [[-3, -2.2], [3, -2.2], [3, 1], [-3, 1]], "#7b4a26");
  for (const y of [-1.4, -0.6, 0.2]) inked(ctx, [[-2.9, y], [2.9, y]], 0.06, "#5e3818");
  // the open lid, leaning back, and the heap of gold in it
  filled(ctx, [[-3, 1], [3, 1], [2.6, 3.4], [-2.6, 3.4]], "#5e3818");
  ctx.beginPath(); ctx.moveTo(-2.8, 1); ctx.quadraticCurveTo(0, 2.6, 2.8, 1); ctx.closePath(); ctx.fillStyle = "#f0c64a"; ctx.fill(); ctx.lineWidth = 0.1; ctx.strokeStyle = INK; ctx.stroke();
  for (const x of [-2.2, 2.2]) filled(ctx, [[x - 0.25, -2.2], [x + 0.25, -2.2], [x + 0.25, 1], [x - 0.25, 1]], "#d6a23a", 0.08);
  filled(ctx, [[-0.45, -0.1], [0.45, -0.1], [0.45, 0.8], [-0.45, 0.8]], "#d6a23a", 0.08);
  disc(ctx, 0, 0.42, 0.13, "#2a1d10", 0);
  for (const [x, y] of [[3.6, -1.9], [4.2, -2.6], [3.4, -2.9], [-3.7, -2.4], [-4.3, -1.7], [2.6, -3.1], [-2.8, -3.3], [4.6, -1.4], [1.2, -3.0]]) disc(ctx, x, y, 0.33, "#f0c94a", 0.07);
  for (const [x, y, c] of [[-1.2, 1.7, "#d0304a"], [0.9, 1.9, "#2f9e6a"], [0.1, 2.1, "#3b6fd0"]] as Array<[number, number, string]>) filled(ctx, [[x, y + 0.3], [x + 0.25, y], [x, y - 0.3], [x - 0.25, y]], c, 0.06);
}

/** a lost miner's lamp, still burning, and a pick, 7 units across */
function tools(ctx: CanvasRenderingContext2D) {
  glow(ctx, -1.6, 1.6, 3.6, "255,200,110", 0.55);
  inked(ctx, [[-2.6, -2.4], [1.8, 2.0]], 0.3, "#8a6238");
  ctx.beginPath(); ctx.moveTo(0.1, 3.5); ctx.quadraticCurveTo(1.9, 2.4, 3.4, 0.4);
  ctx.lineWidth = 0.75; ctx.strokeStyle = INK; ctx.stroke(); ctx.lineWidth = 0.45; ctx.strokeStyle = "#9aa0a6"; ctx.stroke();
  filled(ctx, [[-2.1, 0.6], [-1.1, 0.6], [-1.0, 1.9], [-2.2, 1.9]], "#b98a3a");
  filled(ctx, [[-2.0, 1.9], [-1.2, 1.9], [-1.35, 2.5], [-1.85, 2.5]], "rgba(255,244,210,0.85)", 0.08);
  disc(ctx, -1.6, 2.15, 0.16, "#fff3c0", 0);
  inked(ctx, [[-1.9, 2.5], [-1.6, 2.9], [-1.3, 2.5]], 0.08, "#6b5326");
}

/** a salt gnome with his lantern, 9 units tall */
function gnome(ctx: CanvasRenderingContext2D) {
  glow(ctx, 1.7, -0.5, 2.2, "255,210,120", 0.5);
  filled(ctx, [[-1.7, -3.2], [1.7, -3.2], [0.9, 0.3], [-0.9, 0.3]], "#3d6fb6");
  inked(ctx, [[-1.35, -1.5], [1.35, -1.5]], 0.25, "#3a2a1a");
  for (const x of [-0.8, 0.8]) { ctx.beginPath(); ctx.ellipse(x, -3.35, 0.65, 0.35, 0, 0, 2 * Math.PI); ctx.fillStyle = "#4a3020"; ctx.fill(); ctx.lineWidth = 0.1; ctx.strokeStyle = INK; ctx.stroke(); }
  inked(ctx, [[-1.0, -0.1], [-1.6, -1.1]], 0.32, "#3d6fb6");
  inked(ctx, [[1.0, -0.1], [1.6, -0.9]], 0.32, "#3d6fb6");
  filled(ctx, [[1.45, -0.9], [1.95, -0.9], [1.9, -0.2], [1.5, -0.2]], "#ffe39a", 0.08);
  disc(ctx, 0, 1.05, 0.85, "#f0c4a4", 0.1);
  filled(ctx, [[-0.9, 0.85], [-0.4, 0.6], [0.4, 0.6], [0.9, 0.85], [0.5, -0.5], [0, -1.1], [-0.5, -0.5]], "#f4f1ea", 0.1);
  disc(ctx, 0, 1.0, 0.22, "#e39a85", 0.06);
  disc(ctx, -0.3, 1.38, 0.08, "#2a221a", 0);
  disc(ctx, 0.3, 1.38, 0.08, "#2a221a", 0);
  filled(ctx, [[-1.05, 1.6], [1.05, 1.6], [0.45, 4.3]], "#c8382e");
}

const EGG: Record<string, { draw: (ctx: CanvasRenderingContext2D) => void; units: number }> = {
  dino: { draw: dino, units: 30 }, ring: { draw: ring, units: 9 }, chest: { draw: chest, units: 10 }, tools: { draw: tools, units: 7 }, gnome: { draw: gnome, units: 9 },
};

/** an egg at l[0], w across, turned v degrees: dug out of the rock (a paler patch), then the thing itself */
export function drawEgg(ctx: CanvasRenderingContext2D, kind: string, [x, y]: P2, w: number, turn: number) {
  const egg = EGG[kind];
  if (!egg) return;
  ctx.save();
  ctx.translate(x, y); ctx.rotate((turn * Math.PI) / 180);
  glow(ctx, 0, 0, w * 0.7, "236,222,196", 0.16);
  const k = w / egg.units;
  ctx.scale(k, k);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  egg.draw(ctx);
  ctx.restore();
}
