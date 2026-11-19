/**
 * Before/after clip: two renders of the same film.ts path (production and the dev cache), wiped into each other.
 *
 *   npx tsx src/film.ts https://isometricworld.dmytrokrasun.com/ before.mp4 --city stuttgart --film stuttgart-before-after --seconds 24 --grain 0
 *   npx tsx src/film.ts http://localhost:<port>/ after.mp4 --city stuttgart --film stuttgart-before-after --seconds 24 --grain 0
 *   npx tsx src/beforeafter.ts before.mp4 after.mp4 ../video/stuttgart-before-after.mp4 --holds 0,7.35,19 [--hold 5]
 *
 * --holds: the start (s) of each hold, as film.ts prints them ("7.35s hold 5.00s"). Per hold: 1 s of before, a 2.3 s
 * full-width wipe (smootherstep) to after, after for the rest; during each flight it wipes back to before.
 * "Before"/"After" pills top left/right; the credit strip always comes from the after render (it carries every
 * credit, e.g. "Painted with AI"); light grain on top (render both with --grain 0).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { holds: { type: "string" }, hold: { type: "string", default: "5" }, size: { type: "string", default: "1080" } },
});
const [before, after, out] = positionals;
if (!before || !after || !out || !args.holds) throw new Error("usage: beforeafter.ts before.mp4 after.mp4 out.mp4 --holds 0,7.35,19 [--hold 5]");
const holds = args.holds.split(",").map(Number), HOLD = Number(args.hold), N = Number(args.size);

// divider position (fraction of the width) over time: just off-screen right = all before, off-screen left = all after
const B = 1.01, A = -0.01;
const keys: Array<[number, number]> = [];
holds.forEach((h, i) => {
  keys.push([h + 1, B], [h + 3.3, A]);
  const next = holds[i + 1];
  if (next !== undefined) { const end = h + HOLD; keys.push([end + 0.1, A], [next - 0.1, B]); } // wipe back during the flight
});
let expr = String(keys[keys.length - 1][1]);
for (let k = keys.length - 2; k >= 0; k--) {
  const [t0, p0] = keys[k], [t1, p1] = keys[k + 1], q = `((T-${t0})/${(t1 - t0).toFixed(3)})`;
  expr = `if(lt(T,${t1}),${p0}+(${(p1 - p0).toFixed(2)})*(${q}*${q}*${q}*(${q}*(${q}*6-15)+10)),${expr})`;
}
expr = `if(lt(T,${keys[0][0]}),${keys[0][1]},${expr})`;
const P = `W*(${expr})`;

const tmp = mkdtempSync(join(tmpdir(), "beforeafter-"));
const s = N / 1080;
const pill = (t: string, file: string) => {
  const w = Math.round((t.length * 19 + 44) * s), h = Math.round(46 * s);
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${h / 2}" fill="rgba(20,24,32,0.72)"/>`
    + `<text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial" font-weight="700" font-size="${26 * s}" fill="#fff">${t}</text></svg>`)).png().toFile(join(tmp, file));
};
await pill("Before", "before.png");
await pill("After", "after.png");
const M = Math.round(28 * s), CB = Math.round(150 * s);
const graph = [
  "[0:v]format=gbrp[b]", "[1:v]format=gbrp,split[a][a2]",
  `[b][a]blend=all_expr='if(lt(abs(X-${P}),2*W/1080),255,if(lt(X,${P}),A,B))'[w]`,
  `[a2]crop=iw:${CB}:0:ih-${CB}[cb]`, `[w][cb]overlay=0:H-${CB}[w2]`,
  `[w2][2:v]overlay=${M}:${M}[w3]`, `[w3][3:v]overlay=W-w-${M}:${M},format=yuv420p,noise=alls=5:allf=t[v]`,
].join(";");
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", before, "-i", after, "-i", join(tmp, "before.png"), "-i", join(tmp, "after.png"),
  "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: "inherit" });
console.log(`-> ${out}`);
