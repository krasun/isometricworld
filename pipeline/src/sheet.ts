/**
 * AI texture and sprite sheets for the styled look (pipeline/style/textures), generated with the Codex CLI's image
 * tool (codex.ts): flat-roof textures, construction-site ground, construction-site objects. Each sheet's prompt is in
 * pipeline/style/textures/prompts/<name>.txt; the first lines starting with "ref:" name the attached images
 * (paths relative to pipeline/). Results land in data/derived/sheets/<name>/ for review; `accept` copies one
 * into pipeline/style/textures/ (sprite sheets: magenta key cut out to alpha).
 *
 *   npm -w pipeline exec tsx src/sheet.ts <name> [--n 2]   # generate (n variants: out-1.png …); --model: one with the image tool
 *   npm -w pipeline exec tsx src/sheet.ts <name> accept <k> # copy variant k into style/textures/<name>.png
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { codex } from "./codex.ts";
import { DERIVED } from "./paths.ts";

const PIPE = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXTURES = join(PIPE, "style", "textures");
const { positionals, values: args } = parseArgs({ allowPositionals: true, options: { n: { type: "string", default: "1" }, model: { type: "string" } } });
const [name, cmd, which] = positionals;
if (!name || (cmd && cmd !== "accept")) throw new Error("usage: sheet.ts <name> [accept <k>] [--n 2]");
const promptFile = join(TEXTURES, "prompts", `${name}.txt`);
if (!existsSync(promptFile)) throw new Error(`no prompt: ${promptFile}`);
const text = readFileSync(promptFile, "utf8");
const refs = text.split("\n").filter((l) => l.startsWith("ref:")).map((l) => l.slice(4).trim());
const body = text.split("\n").filter((l) => !l.startsWith("ref:")).join("\n").trim();
const sprites = /sprites/.test(name);
const dir = join(DERIVED, "sheets", name);
mkdirSync(dir, { recursive: true });

if (cmd === "accept") {
  const src = join(dir, `out-${which ?? 1}.png`), dst = join(TEXTURES, `${name}.png`);
  if (!sprites) { copyFileSync(src, dst); console.log(`→ ${dst}`); process.exit(0); }
  // sprites: magenta #FF00FF (and what is near it) to alpha, a 1 px soft edge
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const key = Math.min(r, b) - g; // magenta: red and blue high, green low
    const a = key > 120 ? 0 : key > 60 ? Math.round(255 * (120 - key) / 60) : 255;
    // despill: an edge pixel keeps no more red and blue than its green allows (no pink fringe)
    out[j] = a < 255 ? Math.min(r, g + 30) : r; out[j + 1] = g; out[j + 2] = a < 255 ? Math.min(b, g + 30) : b; out[j + 3] = a;
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(dst);
  // the objects: boxes of the opaque blobs (grown by 12 px so a part with a gap, a crane hook, joins its object)
  const W = info.width, H = info.height, G = 12, seen = new Uint8Array(W * H), boxes: number[][] = [];
  const solid = (x: number, y: number) => out[(y * W + x) * 4 + 3] > 40;
  for (let y0 = 0; y0 < H; y0++) for (let x0 = 0; x0 < W; x0++) {
    if (seen[y0 * W + x0] || !solid(x0, y0)) continue;
    let [bx0, by0, bx1, by1] = [x0, y0, x0, y0], n = 0;
    const stack = [y0 * W + x0]; seen[y0 * W + x0] = 1;
    while (stack.length) {
      const i = stack.pop()!, x = i % W, y = (i - x) / W; n++;
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      for (let dy = -G; dy <= G; dy += G) for (let dx = -G; dx <= G; dx += G) for (let s = 1; s <= G; s++) {
        const u = x + Math.sign(dx) * s, v = y + Math.sign(dy) * s;
        if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
        const j = v * W + u;
        if (!seen[j] && solid(u, v)) { seen[j] = 1; stack.push(j); }
      }
    }
    if (n > 30) boxes.push([bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1]);
  }
  boxes.sort((a, b) => Math.round(a[1] / 150) - Math.round(b[1] / 150) || a[0] - b[0]); // rows, left to right
  writeFileSync(dst.replace(/\.png$/, ".json"), JSON.stringify({ size: [W, H], boxes }));
  console.log(`→ ${dst} (keyed, ${boxes.length} objects: ${dst.replace(/\.png$/, ".json")})`);
  process.exit(0);
}

/** did Codex's image tool write anything since t (ms)? */
function generatedSince(t: number): boolean {
  const walk = (d: string): boolean => existsSync(d) && readdirSync(d).some((f) => {
    const p = join(d, f), st = statSync(p);
    return st.isDirectory() ? walk(p) : st.mtimeMs >= t;
  });
  return walk(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "generated_images"));
}

const images = refs.map((r, k) => { const f = `ref${k + 1}.png`; copyFileSync(join(PIPE, r), join(dir, f)); return f; });
const n = Number(args.n);
await Promise.all(Array.from({ length: n }, async (_, k) => {
  const out = join(dir, `out-${k + 1}.png`), cwd = join(dir, `run-${k + 1}`), local = join(cwd, "out.png"); // the sandbox writes only in cwd
  mkdirSync(cwd, { recursive: true });
  rmSync(local, { force: true }); // a stale result from an earlier run
  for (const f of images) copyFileSync(join(dir, f), join(cwd, f));
  const prompt = `Use your image generation tool.${images.length ? ` ${images.length} image(s) are attached: ${images.join(", ")}.` : ""}\n\n${body}\n\nWhen done, copy the final PNG to ${local} and reply only with that path.`;
  const t = Date.now();
  await codex(cwd, images, prompt, { model: args.model, timeoutMs: 1_200_000 });
  // without the image tool (a plan without image generation) the model draws a stand-in in code: refuse it
  if (!existsSync(local)) return console.log(`${name} ${k + 1}: no image (see ${cwd}/codex.log)`);
  if (!generatedSince(t)) return console.log(`${name} ${k + 1}: REFUSED, not from the image tool (nothing new in ~/.codex/generated_images; see ${cwd}/codex.log)`);
  copyFileSync(local, out);
  console.log(`${name} ${k + 1}: ${((Date.now() - t) / 1000).toFixed(0)}s → ${out}`);
}));
