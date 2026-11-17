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
@media (max-width: 640px) { #mine-panel { right: 6px; padding: 6px 4px; } #mine-panel button { padding: 3px 6px; } #mine-info { left: 6px; right: 6px; max-width: none; bottom: 40px; } }
`;

export class Mine {
  /** 0: the surface; 1…n: the levels */
  private at = 0;
  private items = new Map<string, Promise<Item>>();
  private buttons: HTMLButtonElement[] = [];
  private info: HTMLElement;
  private fade = 0; // 0 surface … 1 underground, eased
  underground = false;

  constructor(private data: MineData, private host: MineHost) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const panel = document.createElement("nav");
    panel.id = "mine-panel";
    panel.setAttribute("aria-label", "Poziomy kopalni soli");
    panel.innerHTML = `<h3>Kopalnia</h3>`;
    const entries = [{ label: "Powierzchnia", depth: "0 m" }, ...data.levels.map((l) => ({
      label: `${LEVEL_NAMES_PL[l.id] ?? l.id}${l.name ? ` · ${l.name}` : ""}`,
      depth: `${Math.round(l.tourist ?? l.depth)} m`,
    }))];
    entries.forEach((e, i) => {
      const b = document.createElement("button");
      b.innerHTML = `<span>${e.label}</span><span class="d">${e.depth}</span>`;
      b.title = i ? `Poziom ${data.levels[i - 1].id}: ${Math.round(data.levels[i - 1].depth)} m pod nadszybiem szybu św. Kingi` : "Miasto";
      b.addEventListener("click", () => this.go(i));
      panel.appendChild(b);
      this.buttons.push(b);
    });
    document.getElementById("map")!.appendChild(panel);
    this.info = document.createElement("aside");
    this.info.id = "mine-info";
    this.info.hidden = true;
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
    // show the chosen level's layer, hide the others (already loaded ones only)
    for (const [id, item] of this.items) item.then((it) => it.setOpacity(this.data.levels[i - 1]?.id === id ? 1 : 0));
    if (i) this.layer(i).then((it) => { if (this.at === i) it.setOpacity(1); });
    this.host.dimSurface(i ? 0.18 : 1);
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
    this.info.innerHTML = `
      <b>Poziom ${LEVEL_NAMES_PL[l.id] ?? l.id}${l.name ? ` „${l.name}”` : ""}</b> · ${Math.round(l.depth)} m pod nadszybiem szybu św. Kingi${l.tourist ? ` (${l.tourist} m według kopalni)` : ""}
      <br>${l.chambers} komór według publikacji${named ? `, ${named} nazwanych na mapie` : ""}. ${l.note.replace(/^./, (c) => c.toUpperCase())}.
      <div class="legend"><span><i></i>znane (OSM)</span><span><i class="a"></i>położenie orientacyjne</span><span><i class="i"></i>ilustracja</span></div>
      <small>Widok poglądowy, nie do nawigacji. Głębokości poziomów, liczby komór i kolejność komór na trasach pochodzą z otwartych źródeł. Położenie komór jest orientacyjne. Pozostałe chodniki i komory są ilustracją, nie planem kopalni. Niezależny projekt, niezwiązany z Kopalnią Soli „Wieliczka” S.A.</small>
      <details><summary>Źródła</summary><ul>${src}</ul></details>`;
    this.info.hidden = false;
  }

  /** labels of the current level on the overlay canvas; `px`: screen px per art px */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, dpr: number, [x0, y0, x1, y1]: number[]) {
    this.fade += ((this.underground ? 1 : 0) - this.fade) * 0.2;
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
      const sub = [lab.depth ? `${lab.depth} m` : null, shaft ? null : KIND_PL[lab.kind], lab.route ? ROUTE_PL[lab.route] : null].filter(Boolean).join(" · ");
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
