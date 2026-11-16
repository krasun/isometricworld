/**
 * Social clip: a smooth, deterministic camera flight over the live viewer, rendered frame by frame
 * (no screen recording, so no dropped frames) and encoded with ffmpeg.
 *
 *   npx tsx src/film.ts [url] [out.mp4] [--city tel-aviv-yafo] [--fps 60] [--size 1080 | WxH] [--seconds 14] [--blur 1] [--grain 5] [--preview]
 *
 * - --city picks the shot list (FILMS) and the title; the clip opens /<city> on the site.
 *
 * - The camera follows a Catmull-Rom spline through SHOTS in (x, y, ln scale), resting at each pose
 *   (with a slow push in) and easing between them. Moves advance by *perceived* motion (screen px
 *   panned + zoom), so speed on screen is even whether we are zoomed in close or far out.
 * - Each frame: set the viewport, wait until every tile is loaded (no blur, no level pops), then
 *   hand the page exactly 1/fps of simulation time (cars, cats, parakeets, plane) and capture.
 * - Captured at 2x device pixels and downscaled with lanczos (supersampled, crisp edges).
 * - Crisp by default; --blur 8 averages sub-frames while flying (motion blur). Light film grain
 *   (--grain 5) on top. The city name fades in over the final pose.
 * - --preview: 6 fps, 1x, for checking the path quickly.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { llhToPixel, useRegion } from "./camera.ts";
import { CHROME, CHROME_ARGS, siteUrl } from "./paths.ts";
import { CITIES, DEFAULT_CITY, REGIONS } from "./places.ts";

const args = process.argv.slice(2);
const flag = (name: string, def: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const preview = args.includes("--preview");
const VALUED = ["--fps", "--size", "--seconds", "--blur", "--grain", "--city"];
const pos = args.filter((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));
const SLUG = (() => { const i = args.indexOf("--city"); return i >= 0 ? args[i + 1] : DEFAULT_CITY; })(), CITY = CITIES[SLUG];
if (!CITY) throw new Error(`unknown city ${SLUG}`);
useRegion(CITY.region);
const GROUND_H = REGIONS[CITY.region].groundH; // shots are given at the region's typical ground height
const [urlArg, out = "film.mp4"] = pos, base = siteUrl(urlArg);
// the default city is the site root; any other city is /<slug>
const url = SLUG === DEFAULT_CITY ? base : new URL(SLUG, base.endsWith("/") ? base : `${base}/`).href;
const FPS = preview ? 6 : flag("fps", 60);
// output px = CSS px: --size 1080 (square: shows uncropped in the X feed) or WxH, e.g. 960x540 for the README GIF
const [SIZE, HEIGHT] = (() => { const i = args.indexOf("--size"), v = i >= 0 ? args[i + 1] : "1080", [w, h] = v.split("x").map(Number); return [w, h || w]; })();
const SECONDS = flag("seconds", 14);
const DPR = preview ? 1 : 2;               // capture at 2x, downscale to the output size
const BLUR = preview ? 1 : flag("blur", 1);  // optional motion blur: max sub-frames per output frame (1, 2, 4, 8)
const GRAIN = preview ? 0 : flag("grain", 5); // film grain strength (ffmpeg noise, 0 = off)

/**
 * Camera keyframes: lat/lon (or global art px) + scale (output px per art px; 1 = native detail)
 * + hold (seconds the camera rests there, gently drifting in; omitted = fly through without stopping).
 */
type Shot = { at: [number, number]; px?: boolean; scale: number; hold?: number; note: string };
/** Per city: the shots, and the shot whose hold an airliner crosses (none: no plane placed). */
const FILMS: Record<string, { shots: Shot[]; planeShot?: number }> = {
  "tel-aviv-yafo": { planeShot: 2, shots: [
  { at: [32.0988, 34.7990], scale: 0.62, hold: 1.1, note: "Yarkon Park: the river bends, jacarandas, flame trees" },
  { at: [10050, -4400], px: true, scale: 0.95, hold: 1.0, note: "Namir Rd crossing the Yarkon: traffic on the bridge and the Rokach junction" },
  { at: [32.0950, 34.7760], scale: 0.26, hold: 0.8, note: "wide: the river mouth, Tel Aviv Port, the sea (airliner passes)" },
  { at: [32.0860, 34.7690], scale: 0.34, note: "down the coast: marina, hotel towers" },
  { at: [32.0795, 34.7672], scale: 0.85, hold: 1.9, note: "Gordon/Frishman beach: surf, sand, cars on the promenade" },
  ] },
  // a short clip for X (--seconds 8)
  stuttgart: { shots: [
    { at: [48.7845, 9.1830], scale: 0.7, hold: 1.5, note: "Hauptbahnhof: the Bonatz building, trains in the tracks, the S21 site" },
    { at: [48.7950, 9.2050], scale: 0.3, note: "wide: Schlossgarten and Rosensteinpark down to the Neckar" },
    { at: [48.8000, 9.2105], scale: 0.6, hold: 1.4, note: "the Neckar: König-Karls-Brücke, the rail bridge, Rosensteinpark, Leuze baths" },
    { at: [48.7965, 9.2230], scale: 0.3, note: "wide: up the river to Bad Cannstatt" },
    { at: [48.7922, 9.2320], scale: 0.6, hold: 2.0, note: "the Neckarpark: the stadium and its pitches (title)" },
  ] },
};
const FILM = FILMS[SLUG];
if (!FILM) throw new Error(`no shots for ${SLUG} (FILMS in film.ts)`);
const SHOTS = FILM.shots;
const HOLD_ZOOM = 0.035;  // ln-scale drift during each hold (a slow push in, so poses never freeze)
const PLANE_SHOT = FILM.planeShot; // the airliner crosses the frame centre during this shot's hold

// ---- camera path ------------------------------------------------------------------------------
type P = [number, number, number]; // x, y (global art px), u = ln scale
// shot scales are for a 1080 px wide frame: other widths keep the same width of city in view
const keys: P[] = SHOTS.map(({ at, px, scale }) => { const [x, y] = px ? at : llhToPixel(at[0], at[1], GROUND_H); return [x, y, Math.log((scale * SIZE) / 1080)]; });
function spline(t: number): P { // uniform Catmull-Rom, t in [0, keys.length - 1]
  const n = keys.length - 1, i = Math.min(Math.floor(t), n - 1), f = t - i;
  const p0 = keys[Math.max(i - 1, 0)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(i + 2, n)];
  const out = [0, 0, 0] as P;
  for (let d = 0; d < 3; d++) {
    const a = p0[d], b = p1[d], c = p2[d], e = p3[d];
    out[d] = 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - e) * f * f + (-a + 3 * b - 3 * c + e) * f * f * f);
  }
  return out;
}
// perceived arc length along the spline: pan in screen widths + zoom in e-folds (weighted)
const ZOOM_W = 0.6, PER = 1000, N = PER * (keys.length - 1);
const S: number[] = [0];
let prev = spline(0);
for (let i = 1; i <= N; i++) {
  const p = spline(i / PER), s = Math.exp((p[2] + prev[2]) / 2);
  const pan = (Math.hypot(p[0] - prev[0], p[1] - prev[1]) * s) / SIZE;
  S.push(S[i - 1] + Math.hypot(pan, ZOOM_W * (p[2] - prev[2])));
  prev = p;
}
const arcToT = (a: number) => { // spline parameter at perceived arc length a
  let lo = 0, hi = N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] < a) lo = m; else hi = m; }
  const f = S[hi] === S[lo] ? 0 : (a - S[lo]) / (S[hi] - S[lo]);
  return (lo + f) / PER;
};
// timeline: hold, move (eased between poses, flying through pass-through shots), hold, …
type Seg = { kind: "hold"; key: number; dur: number } | { kind: "move"; from: number; to: number; dur: number };
const poses = SHOTS.map((s, i) => (s.hold !== undefined ? i : -1)).filter((i) => i >= 0);
const holdTotal = poses.reduce((a, i) => a + SHOTS[i].hold!, 0);
const moveLen = poses.slice(1).map((to, j) => Math.pow(S[to * PER] - S[poses[j] * PER], 0.85)); // longer flights get more time, but not linearly
const moveTime = Math.max(0, SECONDS - holdTotal), lenSum = moveLen.reduce((a, b) => a + b, 0);
const segs: Seg[] = [];
poses.forEach((k, j) => {
  segs.push({ kind: "hold", key: k, dur: SHOTS[k].hold! });
  if (j < poses.length - 1) segs.push({ kind: "move", from: k, to: poses[j + 1], dur: (moveLen[j] / lenSum) * moveTime });
});
const ease = (q: number) => q * q * q * (q * (q * 6 - 15) + 10); // smootherstep: no jolt leaving or reaching a pose
const drift = (q: number) => 0.5 - 0.5 * Math.cos(Math.PI * q);
/** camera at clip time t (seconds) */
function cameraAt(t: number): P {
  let acc = 0, zoomed = 0;
  for (const g of segs) {
    if (t <= acc + g.dur || g === segs.at(-1)) {
      const q = Math.min(1, Math.max(0, (t - acc) / g.dur));
      if (g.kind === "hold") { const p = spline(g.key); return [p[0], p[1], p[2] + zoomed + HOLD_ZOOM * drift(q)]; }
      const a = S[g.from * PER] + (S[g.to * PER] - S[g.from * PER]) * ease(q), p = spline(arcToT(a));
      return [p[0], p[1], p[2] + zoomed];
    }
    if (g.kind === "hold") zoomed += HOLD_ZOOM;
    acc += g.dur;
  }
  return keys.at(-1)!;
}
const holdMid = (() => { let acc = 0; for (const g of segs) { if (g.kind === "hold" && g.key === PLANE_SHOT) return acc + g.dur / 2; acc += g.dur; } return SECONDS / 2; })();

// ---- browser ----------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await browser.newPage({ viewport: { width: SIZE, height: HEIGHT }, deviceScaleFactor: DPR });
await page.addInitScript("window.__name = (f) => f;");
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(e.message));
await page.goto(`${url}?video`);
await page.waitForFunction(() => (window as any).__viewer?.world.getItemCount() > 0 && (window as any).__traffic);
await page.waitForTimeout(4000); // let traffic spread out in real time before freezing the clock
await page.addStyleTag({ content: `
  astro-dev-toolbar { display: none !important; }
  #video-credit { font-size: ${Math.round(SIZE * 0.016)}px !important; bottom: 4.5vh !important; }
  #film-title { position: fixed; z-index: 11; left: 0; right: 0; top: 7vh; text-align: center; color: #fff; opacity: 0;
    font: 800 ${Math.round(SIZE * 0.064)}px/1.1 ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -0.015em;
    text-shadow: 0 1px 1px rgba(0,0,0,.55), 0 3px 6px rgba(0,0,0,.45), 0 10px 28px rgba(0,0,0,.45); pointer-events: none; }
  #film-shade { position: fixed; z-index: 10; left: 0; right: 0; top: 0; height: 28vh; pointer-events: none; opacity: 0;
    background: linear-gradient(rgba(8,10,14,.45), rgba(8,10,14,.2) 55%, rgba(8,10,14,0)); }
` });
await page.evaluate((title) => {
  const d = document.createElement("div");
  d.id = "film-title";
  d.textContent = title;
  document.body.appendChild(d);
  const shade = document.createElement("div");
  shade.id = "film-shade";
  document.body.appendChild(shade);
  const v = (window as any).__viewer, item = v.world.getItemAt(0);
  item.blendTime = 0;          // no cross-fades between frames
  item.minPixelRatio = 1.1;    // always the sharper level
  item.immediateRender = false;
  (window as any).__film = { dt: 0 };
}, CITY.title);

// put an airliner over the frame centre mid-way through the wide pose (planes fly 75 m/s along the approach)
const mid = cameraAt(holdMid);
if (PLANE_SHOT !== undefined) await page.evaluate(([cx, cy, tAt]) => {
  const w = window as any, M: number[][] = w.__world.enu2px, planes = w.__planes;
  if (!planes || !w.__world.airport) return;
  const ap = w.__world.airport, O = [w.__world.camera.origin.lat, w.__world.camera.origin.lon], enu = (lat: number, lon: number) => [(lon - O[1]) * 111320 * Math.cos((O[0] * Math.PI) / 180), (lat - O[0]) * 110574];
  const B = enu(ap.lat, ap.lon), A = (ap.runwayHeadingDeg * Math.PI) / 180, D = [Math.sin(A), Math.cos(A)];
  let best = 0, bd = Infinity;
  for (let s = 0; s < 15000; s += 5) {
    const left = 22000 - s, p = [B[0] - D[0] * left, B[1] - D[1] * left, 30 + left * Math.tan((3 * Math.PI) / 180)];
    const x = M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2] + (M[0][3] ?? 0), y = M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2] + (M[1][3] ?? 0);
    const d = Math.hypot(x - cx, y - cy);
    if (d < bd) { bd = d; best = s; }
  }
  planes.flights = [Math.max(0, best - 75 * tAt)];
  planes.t = 0;
}, [mid[0], mid[1], holdMid]);

// ---- encoder ----------------------------------------------------------------------------------
const ff = spawn("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS * BLUR), "-i", "-",
  "-vf", `${BLUR > 1 ? `tmix=frames=${BLUR},framestep=${BLUR},` : ""}scale=${SIZE}:${HEIGHT}:flags=lanczos${GRAIN ? `,noise=c0s=${GRAIN}:c0f=t+u` : ""},format=yuv420p`,
  "-c:v", "libx264", "-preset", preview ? "veryfast" : "slow", "-crf", preview ? "28" : "15", "-maxrate", "22M", "-bufsize", "44M", "-profile:v", "high", // X caps uploads at 25 Mb/s
  "-tune", "film", "-x264-params", "keyint=" + FPS * 2, "-r", String(FPS), "-movflags", "+faststart", out,
], { stdio: ["pipe", "inherit", "inherit"] });

const frames = Math.round(SECONDS * FPS);
/** screen motion between two camera states, in output px (pan + zoom at the frame edge) */
const motion = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]) * Math.exp(a[2]) + Math.abs(a[2] - b[2]) * SIZE / 2;
{ // timeline + peak on-screen speed per move (px per frame at 60 fps), for tuning
  let acc = 0;
  for (const g of segs) {
    let peak = 0;
    for (let t = acc; t < acc + g.dur; t += 1 / 60) peak = Math.max(peak, motion(cameraAt(t), cameraAt(t + 1 / 60)));
    console.log(`${acc.toFixed(2)}s ${g.kind} ${g.dur.toFixed(2)}s${g.kind === "move" ? ` peak ${peak.toFixed(0)} px/frame` : ""}`);
    acc += g.dur;
  }
}
async function render(cam: P, dt: number, title: number) {
  const [cx, cy, u] = cam;
  await page.evaluate(([gx, gy, s, ti]) => {
    const w = window as any, v = w.__viewer, item = v.world.getItemAt(0), world = w.__world;
    v.viewport.zoomTo((item.getContentSize().x / v.container.clientWidth) * s, undefined, true);
    v.viewport.panTo(item.imageToViewportCoordinates(gx - world.origin[0], gy - world.origin[1]), true);
    // title rises 1.5% of the frame while fading in
    const t = document.getElementById("film-title")!, e = ti * ti * (3 - 2 * ti);
    t.style.opacity = String(e);
    t.style.transform = `translateY(${(1 - e) * 1.5}vh)`;
    document.getElementById("film-shade")!.style.opacity = String(e);
  }, [cx, cy, Math.exp(u), title]);
  // two animation frames for the viewer to pick tiles, then wait until all are in and drawn
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForFunction(() => { const v = (window as any).__viewer; return v.world.getItemAt(0).getFullyLoaded() && !v.world.needsDraw(); }, null, { timeout: 60_000, polling: "raf" })
    .catch(() => problems.push(`tiles not loaded at ${cx.toFixed(0)},${cy.toFixed(0)}`));
  // dt of simulation time, consumed by the overlay on the next animation frame
  await page.evaluate((d) => new Promise((r) => { (window as any).__film.dt = d; requestAnimationFrame(() => requestAnimationFrame(r)); }), dt);
  return page.screenshot({ type: "png" });
}
const put = async (png: Buffer) => { if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r)); };
// Optional motion blur: every output frame is the average of BLUR sub-frames spread over the frame
// interval (360° shutter). Fewer distinct captures when the camera moves slowly (each repeated so
// ffmpeg still averages BLUR), a single one while it rests.
const TITLE_IN = SECONDS - SHOTS.at(-1)!.hold! - 0.15, TITLE_FADE = 0.7; // during the arrival at the last pose
const t0 = Date.now();
let rendered = 0;
for (let f = 0; f < frames; f++) {
  const T = (f / (frames - 1)) * (SECONDS - 1 / FPS);
  const m = motion(cameraAt(T), cameraAt(T + 1 / FPS)); // px per frame
  const K = Math.min(BLUR, m < 0.6 ? 1 : m < 3 ? 2 : m < 8 ? 4 : 8);
  for (let j = 0; j < K; j++) {
    const png = await render(cameraAt(T + j / (K * FPS)), 1 / (K * FPS), Math.min(1, Math.max(0, (T - TITLE_IN) / TITLE_FADE)));
    rendered++;
    for (let r = 0; r < BLUR / K; r++) await put(png);
  }
  if (f % 30 === 0) process.stdout.write(`\r${f}/${frames} frames (${rendered} captures) · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log(`\n${problems.length ? `PROBLEMS:\n  ${[...new Set(problems)].slice(0, 10).join("\n  ")}\n` : ""}-> ${out}`);
