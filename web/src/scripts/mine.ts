/**
 * A salt mine's levels under the town (data/mine.<hash>.json from pipeline export.ts; pipeline/src/mine.ts): a lift
 * panel to go down level by level, each level its own transparent tile layer over the dimmed surface, labels for
 * the shafts and the routes' chambers, and what is known, approximate or illustrative on each. A round button under
 * the tilt-shift one opens the panel (closing it goes back up to the surface); ?level=III opens a level; PageDown /
 * PageUp go down and up.
 */
type Conf = "known" | "approximate" | "illustrative";
export interface MineLabel { name: string; kind: string; conf: Conf; route: string | null; depth: number | null; height: number | null; src: string; note?: string; /** across (m): a thing hidden for fun */ size?: number; x: number; y: number; z: number }
export interface MineLevel {
  id: string; name: string; depth: number; tourist: number | null; elevation: number; chambers: number; generated: number; note: string; layer: string; tiles: string; labels: MineLabel[];
  /** an old plan (Hondius 1645), fitted on the shafts it shares with today */
  historic?: boolean; fit?: { scale: number; turn: number; residuals: number[] };
}
export interface MineData { levels: MineLevel[]; sources: Record<string, { title: string; url: string; licence: string }>; min_zoom: number }
type Item = { setOpacity(o: number): void; getOpacity(): number };

export interface MineHost {
  /** a level's layer, added to the viewer transparent (its tile index file name, its layer name) */
  addLayer(layer: string, indexFile: string): Promise<Item>;
  /** the surface (and anything drawn on it) dimmed while below ground */
  dimSurface(opacity: number): void;
  enu2px: number[][];
}

const LEVEL_NAMES: Record<string, string> = { IIw: "II upper", IIn: "II lower" };
const ROUTES: Record<string, string> = { tourist: "Tourist Route", miners: "Miners' Route", museum: "Museum" };
/** what a chamber is, where its name does not say it */
const KINDS: Record<string, string> = { lake: "brine lake", hall: "hall" };
/** the tiles' confidence colours (pipeline/page/mine.ts CONF) for the pins and the legend */
const CONF: Record<Conf, string> = { known: "#4fc3cc", approximate: "#f1c76c", illustrative: "#a3a19b" };
/** the things hidden in the rock just for fun (pipeline/src/minedata.ts EGGS) */
const FUN = "#c39bff";
/** words into lines of at most n characters */
const wrap = (text: string, n: number) => text.split(" ").reduce<string[]>((lines, word) => {
  if (lines.length && (lines.at(-1)! + " " + word).length <= n) lines[lines.length - 1] += " " + word; else lines.push(word);
  return lines;
}, []);
const NOT_AFFILIATED = "An independent project, not affiliated with the Wieliczka Salt Mine (Kopalnia Soli „Wieliczka” S.A.).";

const CSS = `
#mine-toggle { position: fixed; z-index: 10; top: calc(60px + env(safe-area-inset-top, 0px)); right: calc(12px + env(safe-area-inset-right, 0px));
  width: 40px; height: 40px; border: 0; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
  background: rgba(255, 255, 255, 0.85); color: #555; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); touch-action: manipulation; }
#mine-toggle.first { top: calc(12px + env(safe-area-inset-top, 0px)); }
#mine-toggle[aria-pressed="true"] { background: #1f2a37; color: #fff; }
#mine-toggle:hover { filter: brightness(1.08); }
#mine-panel[hidden] { display: none; }
body.video #mine-toggle, body.video #mine-panel, body.video #mine-info { display: none; }
#mine-panel { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); z-index: 20; display: flex; flex-direction: column; align-items: stretch;
  gap: 2px; padding: 8px 6px; border-radius: 12px; background: rgba(18,17,15,0.82); backdrop-filter: blur(6px); color: #eee7d6;
  font: 500 12px/1.2 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 4px 18px rgba(0,0,0,0.35); user-select: none; max-height: 86vh; }
#mine-panel h3 { margin: 0 4px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #bfb39a; }
#mine-panel button { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: 10px; padding: 4px 8px; border-radius: 7px; white-space: nowrap; }
#mine-panel button:hover { background: rgba(255,240,210,0.08); }
#mine-panel button[aria-pressed="true"] { background: #d9b26a; color: #1a1712; }
#mine-panel button .d { opacity: .7; font-variant-numeric: tabular-nums; }
#mine-panel .shaft { position: relative; margin: 2px 0; }
#mine-info { position: absolute; left: 14px; bottom: 44px; z-index: 20; max-width: min(380px, calc(100vw - 200px)); padding: 10px 12px; border-radius: 12px;
  background: rgba(18,17,15,0.86); color: #eee7d6; font: 400 12px/1.4 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
#mine-info[hidden] { display: none; }
#mine-info b { color: #f3d9a0; font-weight: 600; }
#mine-info .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 6px 0; }
#mine-info .legend span { display: inline-flex; align-items: center; gap: 5px; }
#mine-info .legend i { display: inline-block; width: 16px; height: 10px; border-radius: 6px 4px 7px 3px; }
#mine-info .legend i.k { width: 10px; border-radius: 50%; background: #2b2824; box-shadow: inset 0 0 0 2.5px #4fc3cc; }
#mine-info .legend i.a { background: #d6b26a; box-shadow: inset 0 0 0 1.5px #f1c76c; }
#mine-info .legend i.i { background: #9a9891; }
#mine-info .legend i.f { width: auto; height: auto; background: none; color: ${FUN}; font-style: normal; }
#mine-info small { display: block; color: #b9ae98; margin-top: 4px; }
#mine-info details { margin-top: 4px; color: #b9ae98; }
#mine-info details a { color: #e7c98a; }
#mine-info summary { cursor: pointer; }
#mine-panel .s { display: none; }
#mine-info .hint { display: none; }
@media (max-width: 640px) {
  #mine-panel { right: 6px; top: 46%; padding: 6px 3px; gap: 1px; }
  #mine-panel h3 { font-size: 9px; margin: 0 2px 3px; text-align: center; }
  #mine-panel button { padding: 4px 7px; justify-content: center; }
  #mine-panel .l, #mine-panel .d { display: none; }
  #mine-panel .s { display: inline; }
  #mine-info { left: 6px; right: 64px; max-width: none; top: 10px; bottom: auto; padding: 8px 10px; cursor: pointer; max-height: 60vh; overflow: auto; }
  #mine-info:not(.open) .more { display: none; }
  #mine-info .hint { display: inline; color: #b9ae98; }
}
`;

export class Mine {
  /** 0: the surface; 1…n: the levels */
  private at = 0;
  private items = new Map<string, Promise<Item>>();
  private buttons: HTMLButtonElement[] = [];
  private info: HTMLElement;
  private panel: HTMLElement;
  private toggleButton: HTMLButtonElement;
  /** opacities eased towards their targets each frame (draw): the levels' layers and the surface */
  private shown = new Map<string, { item: Item; now: number }>();
  private surface = 1;
  underground = false;

  constructor(private data: MineData, private host: MineHost) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const panel = (this.panel = document.createElement("nav"));
    panel.id = "mine-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Salt mine levels");
    panel.innerHTML = `<h3>Salt mine</h3>`;
    const entries = [{ label: "Surface", short: "0", depth: "0 m" }, ...data.levels.map((l) => ({
      label: l.historic ? "I · 1645 plan" : `${LEVEL_NAMES[l.id] ?? l.id}${l.name ? ` · ${l.name}` : ""}`,
      short: l.historic ? "1645" : l.id,
      depth: l.historic ? "" : `${Math.round(l.tourist ?? l.depth)} m`,
    }))];
    entries.forEach((e, i) => {
      const b = document.createElement("button");
      b.innerHTML = `<span class="l">${e.label}</span><span class="s">${e.short}</span><span class="d">${e.depth}</span>`;
      b.title = !i ? "The town" : data.levels[i - 1].historic ? "Level I on Hondius's 1645 plan" : `Level ${data.levels[i - 1].id}: ${Math.round(data.levels[i - 1].depth)} m below the St. Kinga shaft collar`;
      b.addEventListener("click", () => this.go(i));
      panel.appendChild(b);
      this.buttons.push(b);
    });
    document.getElementById("map")!.appendChild(panel);
    // the button: crossed hammer and pick, the miners' sign; under the tilt-shift button where there is one
    const t = (this.toggleButton = document.createElement("button"));
    t.id = "mine-toggle";
    t.type = "button";
    t.title = t.ariaLabel = "Salt mine levels";
    t.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
      <g transform="rotate(45 12 12)"><rect x="11.15" y="6" width="1.7" height="15.5" rx="0.85"/><rect x="8.2" y="2.6" width="7.6" height="4.2" rx="0.9"/></g>
      <g transform="rotate(-45 12 12)"><rect x="11.15" y="5" width="1.7" height="16.5" rx="0.85"/><path d="M5.6 6.6 Q12 1.8 18.4 6.6 L18.4 7.4 Q12 4.6 5.6 7.4 Z"/></g></svg>`;
    if (!document.getElementById("tilt-toggle")) t.classList.add("first");
    t.addEventListener("click", () => this.open(!this.isOpen));
    document.body.appendChild(t);
    this.info = document.createElement("aside");
    this.info.id = "mine-info";
    this.info.hidden = true;
    this.info.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("a, details")) this.info.classList.toggle("open"); });
    document.getElementById("map")!.appendChild(this.info);
    window.addEventListener("keydown", (e) => {
      if (e.key === "PageDown") { e.preventDefault(); this.open(true); this.go(Math.min(this.data.levels.length, this.at + 1)); }
      if (e.key === "PageUp") { e.preventDefault(); this.go(Math.max(0, this.at - 1)); }
    });
    const want = new URLSearchParams(location.search).get("level");
    const i = want ? this.data.levels.findIndex((l) => l.id.toLowerCase() === want.toLowerCase()) : -1;
    this.go(i >= 0 ? i + 1 : 0, true);
  }

  private get isOpen() { return !this.panel.hidden; }

  /** shows or hides the lift panel; hidden, the map goes back up to the surface */
  open(on: boolean) {
    this.panel.hidden = !on;
    this.toggleButton.setAttribute("aria-pressed", String(on));
    if (!on && this.at) this.go(0);
  }

  private layer(i: number) {
    const l = this.data.levels[i - 1];
    if (!this.items.has(l.id)) this.items.set(l.id, this.host.addLayer(l.layer, l.tiles));
    return this.items.get(l.id)!;
  }

  go(i: number, first = false) {
    this.at = i;
    this.underground = i > 0;
    if (i && !this.isOpen) this.open(true);
    this.buttons.forEach((b, k) => b.setAttribute("aria-pressed", String(k === i)));
    // the chosen level's layer fades in, the others out (draw eases them), the surface dims below ground
    if (i) { const id = this.data.levels[i - 1].id; this.layer(i).then((item) => { if (!this.shown.has(id)) this.shown.set(id, { item, now: 0 }); }); }
    if (first) { this.surface = i ? 0.18 : 1; this.host.dimSurface(this.surface); }
    if (!first) {
      const u = new URL(location.href);
      if (i) u.searchParams.set("level", this.data.levels[i - 1].id); else u.searchParams.delete("level");
      history.replaceState(null, "", u);
    }
    this.renderInfo();
  }

  private renderInfo() {
    if (!this.at) { this.info.hidden = true; return; }
    const l = this.data.levels[this.at - 1];
    const named = l.labels.filter((x) => x.kind !== "shaft").length;
    const src = Object.values(this.data.sources).map((s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.title}</a> (${s.licence})</li>`).join("");
    if (l.historic) {
      const h = this.data.sources.hondius;
      this.info.innerHTML = `
        <b>Level I on the 1645 plan</b><span class="hint"> ▸</span><span class="more">, engraved by Willem Hondius after Marcin German's survey of 1638 (<a href="${h?.url ?? "#"}" target="_blank" rel="noopener">Wikimedia Commons</a>, public domain).
        <br>The plan is fitted on the three shafts that still stand: Regis, Daniłowicz and Górsko. They match within ${l.fit ? `${Math.round(Math.min(...l.fit.residuals))}–${Math.round(Math.max(...l.fit.residuals))}` : "a few"} m. North is at the bottom of the original, so its lettering is upside down. The shafts marked ≈ are gone; their places come from the plan.
        <small>${NOT_AFFILIATED}</small></span>`;
      this.info.hidden = false;
      return;
    }
    this.info.innerHTML = `
      <b>Level ${LEVEL_NAMES[l.id] ?? l.id}${l.name ? ` “${l.name}”` : ""}</b> · ${Math.round(l.depth)} m<span class="hint"> ▸</span><span class="more"> below the St. Kinga shaft collar${l.tourist ? ` (${l.tourist} m as the mine gives it)` : ""}
      <br>${l.chambers} ${l.chambers === 1 ? "chamber" : "chambers"} as published${named ? `, ${named} named on the map` : ""}. ${l.note.replace(/^./, (c) => c.toUpperCase())}.
      <div class="legend"><span><i class="k"></i>known (OSM)</span><span><i class="a"></i>approximate position</span><span><i class="i"></i>illustration</span><span><i class="f">✦</i>just for fun</span></div>
      <small>An overview, not for finding your way. The levels' depths, the chamber counts and the order of the chambers along the routes come from open sources. Where the chambers lie is approximate. The other galleries and chambers are an illustration, not a plan of the mine. The rock between them shows the deposit's general build (green salt boulders in clay above, folded beds below), not its mapped geology. ${NOT_AFFILIATED}</small>
      <details><summary>Sources</summary><ul>${src}</ul></details></span>`;
    this.info.hidden = false;
  }

  /** labels of the current level on the overlay canvas; `px`: screen px per art px */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, dpr: number, [x0, y0, x1, y1]: number[]) {
    const ease = (now: number, to: number) => (Math.abs(to - now) < 0.01 ? to : now + (to - now) * 0.18);
    const want = this.at ? this.data.levels[this.at - 1].id : null;
    for (const [id, s] of this.shown) {
      const to = id === want ? 1 : 0, next = ease(s.now, to);
      if (next !== s.now) { s.now = next; s.item.setOpacity(next); }
    }
    const dim = ease(this.surface, this.at ? 0.18 : 1);
    if (dim !== this.surface) { this.surface = dim; this.host.dimSurface(dim); }
    if (!this.at || px < 0.06) return;
    const l = this.data.levels[this.at - 1], m = this.host.enu2px;
    ctx.save();
    ctx.textAlign = "center";
    const placed: number[][] = [];
    // shafts first (they matter most), then the named chambers once zoomed in
    const order = [...l.labels].sort((a, b) => (a.kind === "shaft" ? 0 : 1) - (b.kind === "shaft" ? 0 : 1));
    for (const lab of order) {
      if (lab.kind !== "shaft" && px < 0.22) continue;
      if (lab.kind === "egg" && px < 0.8) continue; // the things hidden for fun: only close up
      const gx = m[0][0] * lab.x + m[0][1] * lab.y + m[0][2] * lab.z, gy = m[1][0] * lab.x + m[1][1] * lab.y + m[1][2] * lab.z;
      let [sx, sy] = toScreen(gx, gy);
      // a thing hidden for fun: its label over it, not on it (the projected half-height of its size)
      if (lab.kind === "egg") sy -= ((lab.size ?? 0) / 2) * Math.hypot(m[1][0], m[1][1]) * px * dpr;
      if (sx < x0 - 50 || sx > x1 + 50 || sy < y0 - 50 || sy > y1 + 50) continue;
      const shaft = lab.kind === "shaft", egg = lab.kind === "egg", approx = lab.conf !== "known" && !egg;
      const title = egg ? `✦ ${lab.name}` : `${lab.name}${approx ? " ≈" : ""}`;
      // the things hidden just for fun say so, over a few short lines
      const subs = egg ? wrap(lab.note ?? "", 38) : [[lab.depth ? `${lab.depth} m` : null, shaft ? null : KINDS[lab.kind], lab.route ? ROUTES[lab.route] : null, lab.note && lab.src === "hondius" ? lab.note : null].filter(Boolean).join(" · ")].filter(Boolean);
      const n = subs.length, titleFont = `${shaft ? 700 : 600} ${(shaft ? 13 : 12) * dpr}px ui-sans-serif, system-ui, sans-serif`, subFont = `500 ${10.5 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      ctx.font = subFont;
      const subW = Math.max(0, ...subs.map((t) => ctx.measureText(t).width));
      ctx.font = titleFont;
      const w = Math.max(ctx.measureText(title).width, egg ? subW : 0) + 10 * dpr, h = (17 + 13 * n) * dpr;
      const box = [sx - w / 2, sy - h - 8 * dpr, sx + w / 2, sy - 6 * dpr];
      if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      placed.push(box);
      // pin (none on the things hidden for fun: the label stands over them)
      if (!egg) {
        ctx.beginPath(); ctx.arc(sx, sy, (shaft ? 4 : 3) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = shaft ? "#1b1712" : CONF[lab.conf]; ctx.fill();
        ctx.lineWidth = (shaft ? 2 : 1.5) * dpr; ctx.strokeStyle = shaft ? CONF[lab.conf] : "#1b1712"; ctx.stroke();
      }
      ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = "rgba(14,12,9,0.85)"; ctx.fillStyle = egg ? "#ead9ff" : lab.conf === "illustrative" ? "#cfc6b4" : "#fff6e2";
      ctx.strokeText(title, sx, sy - (10 + 12 * n) * dpr); ctx.fillText(title, sx, sy - (10 + 12 * n) * dpr);
      ctx.font = subFont;
      ctx.fillStyle = egg ? "#d9c8f2" : "#e7d8b6";
      subs.forEach((t, i) => { const y = sy - (9 + 12 * (n - 1 - i)) * dpr; ctx.strokeText(t, sx, y); ctx.fillText(t, sx, y); });
    }
    ctx.restore();
  }
}
