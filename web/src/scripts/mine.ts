/**
 * A salt mine's levels under the town (data/mine.<hash>.json from pipeline export.ts; pipeline/src/mine.ts): a lift
 * panel to go down level by level, each level its own transparent tile layer over the dimmed surface, labels for
 * the shafts and the routes' chambers, and what is known, approximate or illustrative on each. ?poziom=III opens a
 * level; PageDown / PageUp go down and up.
 */
type Conf = "known" | "approximate" | "illustrative";
export interface MineLabel { name: string; kind: string; conf: Conf; route: string | null; depth: number | null; height: number | null; src: string; note?: string; x: number; y: number; z: number }
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

const LEVEL_NAMES_PL: Record<string, string> = { IIw: "II wyższy", IIn: "II niższy" };
const ROUTE_PL: Record<string, string> = { tourist: "Trasa Turystyczna", miners: "Trasa Górnicza", museum: "muzeum" };
const KIND_PL: Record<string, string> = { chapel: "kaplica", lake: "jezioro solankowe", hall: "komora", chamber: "komora", museum: "komora muzealna", grotto: "groty", shaft: "szyb" };

const CSS = `
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
#mine-info .legend i { display: inline-block; width: 18px; height: 0; border-top: 2px solid #e2d6bd; }
#mine-info .legend i.a { border-top-style: dashed; }
#mine-info .legend i.i { border-top-style: dotted; opacity: .7; }
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
  /** opacities eased towards their targets each frame (draw): the levels' layers and the surface */
  private shown = new Map<string, { item: Item; now: number }>();
  private surface = 1;
  underground = false;

  constructor(private data: MineData, private host: MineHost) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const panel = document.createElement("nav");
    panel.id = "mine-panel";
    panel.setAttribute("aria-label", "Poziomy kopalni soli");
    panel.innerHTML = `<h3>Kopalnia</h3>`;
    const entries = [{ label: "Powierzchnia", short: "0", depth: "0 m" }, ...data.levels.map((l) => ({
      label: l.historic ? "I · plan z 1645 r." : `${LEVEL_NAMES_PL[l.id] ?? l.id}${l.name ? ` · ${l.name}` : ""}`,
      short: l.historic ? "1645" : l.id,
      depth: l.historic ? "" : `${Math.round(l.tourist ?? l.depth)} m`,
    }))];
    entries.forEach((e, i) => {
      const b = document.createElement("button");
      b.innerHTML = `<span class="l">${e.label}</span><span class="s">${e.short}</span><span class="d">${e.depth}</span>`;
      b.title = !i ? "Miasto" : data.levels[i - 1].historic ? "Poziom I na planie Hondiusa z 1645 r." : `Poziom ${data.levels[i - 1].id}: ${Math.round(data.levels[i - 1].depth)} m pod nadszybiem szybu św. Kingi`;
      b.addEventListener("click", () => this.go(i));
      panel.appendChild(b);
      this.buttons.push(b);
    });
    document.getElementById("map")!.appendChild(panel);
    this.info = document.createElement("aside");
    this.info.id = "mine-info";
    this.info.hidden = true;
    this.info.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("a, details")) this.info.classList.toggle("open"); });
    document.getElementById("map")!.appendChild(this.info);
    window.addEventListener("keydown", (e) => {
      if (e.key === "PageDown") { e.preventDefault(); this.go(Math.min(this.data.levels.length, this.at + 1)); }
      if (e.key === "PageUp") { e.preventDefault(); this.go(Math.max(0, this.at - 1)); }
    });
    const want = new URLSearchParams(location.search).get("poziom");
    const i = want ? this.data.levels.findIndex((l) => l.id.toLowerCase() === want.toLowerCase()) : -1;
    this.go(i >= 0 ? i + 1 : 0, true);
  }

  private layer(i: number) {
    const l = this.data.levels[i - 1];
    if (!this.items.has(l.id)) this.items.set(l.id, this.host.addLayer(l.layer, l.tiles));
    return this.items.get(l.id)!;
  }

  go(i: number, first = false) {
    this.at = i;
    this.underground = i > 0;
    this.buttons.forEach((b, k) => b.setAttribute("aria-pressed", String(k === i)));
    // the chosen level's layer fades in, the others out (draw eases them), the surface dims below ground
    if (i) { const id = this.data.levels[i - 1].id; this.layer(i).then((item) => { if (!this.shown.has(id)) this.shown.set(id, { item, now: 0 }); }); }
    if (first) { this.surface = i ? 0.18 : 1; this.host.dimSurface(this.surface); }
    if (!first) {
      const u = new URL(location.href);
      if (i) u.searchParams.set("poziom", this.data.levels[i - 1].id); else u.searchParams.delete("poziom");
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
        <b>Poziom I na planie z 1645 r.</b> <span class="hint">▸</span><span class="more">, rytowanym przez Willema Hondiusa według pomiarów Marcina Germana z 1638 r. (<a href="${h?.url ?? "#"}" target="_blank" rel="noopener">Wikimedia Commons</a>, domena publiczna).
        <br>Plan jest dopasowany do trzech szybów, które istnieją do dziś: Regis, Daniłowicza i Górsko. Rozbieżność wynosi ${l.fit ? `${Math.round(Math.min(...l.fit.residuals))}–${Math.round(Math.max(...l.fit.residuals))}` : "kilka"} m. Na oryginale północ jest na dole, dlatego napisy są do góry nogami. Szyby oznaczone ≈ już nie istnieją, ich położenie wynika z planu.
        <small>Niezależny projekt, niezwiązany z Kopalnią Soli „Wieliczka” S.A.</small></span>`;
      this.info.hidden = false;
      return;
    }
    this.info.innerHTML = `
      <b>Poziom ${LEVEL_NAMES_PL[l.id] ?? l.id}${l.name ? ` „${l.name}”` : ""}</b> · ${Math.round(l.depth)} m <span class="hint">▸</span><span class="more">pod nadszybiem szybu św. Kingi${l.tourist ? ` (${l.tourist} m według kopalni)` : ""}
      <br>${l.chambers} komór według publikacji${named ? `, ${named} nazwanych na mapie` : ""}. ${l.note.replace(/^./, (c) => c.toUpperCase())}.
      <div class="legend"><span><i></i>znane (OSM)</span><span><i class="a"></i>położenie orientacyjne</span><span><i class="i"></i>ilustracja</span></div>
      <small>Widok poglądowy, nie do nawigacji. Głębokości poziomów, liczby komór i kolejność komór na trasach pochodzą z otwartych źródeł. Położenie komór jest orientacyjne. Pozostałe chodniki i komory są ilustracją, nie planem kopalni. Niezależny projekt, niezwiązany z Kopalnią Soli „Wieliczka” S.A.</small>
      <details><summary>Źródła</summary><ul>${src}</ul></details></span>`;
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
      const gx = m[0][0] * lab.x + m[0][1] * lab.y + m[0][2] * lab.z, gy = m[1][0] * lab.x + m[1][1] * lab.y + m[1][2] * lab.z;
      const [sx, sy] = toScreen(gx, gy);
      if (sx < x0 - 50 || sx > x1 + 50 || sy < y0 - 50 || sy > y1 + 50) continue;
      const shaft = lab.kind === "shaft", approx = lab.conf !== "known";
      const title = `${lab.name}${approx ? " ≈" : ""}`;
      const sub = [lab.depth ? `${lab.depth} m` : null, shaft ? null : KIND_PL[lab.kind], lab.route ? ROUTE_PL[lab.route] : null, lab.note && lab.src === "hondius" ? lab.note : null].filter(Boolean).join(" · ");
      ctx.font = `${shaft ? 700 : 600} ${(shaft ? 13 : 12) * dpr}px ui-sans-serif, system-ui, sans-serif`;
      const w = ctx.measureText(title).width + 10 * dpr, h = (sub ? 30 : 17) * dpr;
      const box = [sx - w / 2, sy - h - 8 * dpr, sx + w / 2, sy - 6 * dpr];
      if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      placed.push(box);
      // pin
      ctx.beginPath(); ctx.arc(sx, sy, (shaft ? 4 : 3) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = shaft ? "#1b1712" : "#f3d9a0"; ctx.fill();
      ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = shaft ? "#f3d9a0" : "#1b1712"; ctx.stroke();
      ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = "rgba(14,12,9,0.85)"; ctx.fillStyle = lab.conf === "illustrative" ? "#cfc6b4" : "#fff6e2";
      ctx.strokeText(title, sx, sy - (sub ? 22 : 10) * dpr); ctx.fillText(title, sx, sy - (sub ? 22 : 10) * dpr);
      if (sub) {
        ctx.font = `500 ${10.5 * dpr}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = "#e7d8b6";
        ctx.strokeText(sub, sx, sy - 9 * dpr); ctx.fillText(sub, sx, sy - 9 * dpr);
      }
    }
    ctx.restore();
  }
}
