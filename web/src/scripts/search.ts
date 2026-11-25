/**
 * Find a street or a place by name (places.ts `effects.search`; the index is export.ts exportSearch's: [name, kind
 * (0 street, 1 settlement or district, 2 place), x, y (global art px), what it is]). A box in the top left corner,
 * "/" focuses it; typing lists the best matches (Polish letters optional: "zamek zupny" finds "Zamek Żupny"), arrows
 * and Enter or a click go there. Every word typed must start a word of the name, or for a word of three letters or
 * more appear inside one.
 */
export type SearchItem = [string, number, number, number, string];

export interface SearchHost {
  /** fly the view to global art px, `widthM` metres across, and mark the spot with its name */
  go(x: number, y: number, widthM: number, label: string): void;
}

const CSS = `
#search { position: fixed; z-index: 11; left: calc(12px + env(safe-area-inset-left, 0px)); top: calc(12px + env(safe-area-inset-top, 0px)); width: 300px;
  font: 500 14px/1.3 ui-sans-serif, system-ui, sans-serif; }
#search input { box-sizing: border-box; width: 100%; height: 40px; padding: 0 12px 0 36px; border: 0; border-radius: 20px; outline: none;
  background: rgba(255,255,255,0.9) no-repeat 12px 50% / 16px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23555' stroke-width='2.4' stroke-linecap='round'%3E%3Ccircle cx='10.5' cy='10.5' r='6.5'/%3E%3Cpath d='M15.5 15.5 21 21'/%3E%3C/svg%3E");
  color: #1f2a37; box-shadow: 0 1px 4px rgba(0,0,0,0.25); font: inherit; }
#search input:focus { background-color: #fff; box-shadow: 0 1px 6px rgba(0,0,0,0.3), 0 0 0 2px rgba(31,42,55,0.25); }
#search ul { list-style: none; margin: 6px 0 0; padding: 4px; border-radius: 12px; background: rgba(255,255,255,0.97); box-shadow: 0 4px 16px rgba(0,0,0,0.25); }
#search ul:empty { display: none; }
#search li { display: flex; justify-content: space-between; gap: 10px; padding: 7px 10px; border-radius: 8px; cursor: pointer; color: #1f2a37; }
#search li span:last-child { color: #8a8f97; font-size: 12px; white-space: nowrap; }
#search li[aria-selected="true"], #search li:hover { background: #eef1f5; }
@media (max-width: 640px) { #search { right: calc(64px + env(safe-area-inset-right, 0px)); width: auto; } }
body.video #search { display: none; }
`;

/** lower case, no accents (ł is not decomposed: by hand) */
const fold = (s: string) => s.toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "");
/** how wide a view each kind opens (m) */
const WIDTH = [500, 1600, 350];

export class Search {
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private items: Array<{ item: SearchItem; words: string[]; name: string }>;
  private shown: SearchItem[] = [];
  private at = 0;

  constructor(items: SearchItem[], private host: SearchHost) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    this.items = items.map((item) => { const name = fold(item[0]); return { item, name, words: name.split(/[\s\-–.,()"„”/]+/).filter(Boolean) }; });
    const form = document.createElement("form");
    form.id = "search";
    form.setAttribute("role", "search");
    form.innerHTML = `<input type="search" placeholder="Search streets and places" aria-label="Search streets and places" autocomplete="off" spellcheck="false"><ul role="listbox"></ul>`;
    this.input = form.querySelector("input")!;
    this.list = form.querySelector("ul")!;
    document.body.appendChild(form);
    document.body.classList.add("has-search");
    form.addEventListener("submit", (e) => { e.preventDefault(); this.choose(this.at); });
    this.input.addEventListener("input", () => this.find());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.select(this.at + (e.key === "ArrowDown" ? 1 : -1)); }
      if (e.key === "Escape") { this.input.value = ""; this.find(); this.input.blur(); }
    });
    this.input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== this.input) this.list.replaceChildren(); }, 150));
    this.input.addEventListener("focus", () => this.find());
    this.list.addEventListener("pointerdown", (e) => {
      const li = (e.target as HTMLElement).closest("li");
      if (li) { e.preventDefault(); this.choose(Number(li.dataset.i)); }
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== this.input && !(e.target as HTMLElement)?.closest?.("input, textarea")) { e.preventDefault(); this.input.focus(); }
    });
  }

  private find() {
    const q = fold(this.input.value.trim()).split(/\s+/).filter(Boolean);
    this.shown = [];
    if (q.length) {
      const scored: Array<[number, SearchItem]> = [];
      for (const { item, words, name } of this.items) {
        let score = 0, ok = true;
        for (const w of q) {
          if (words.some((x) => x.startsWith(w))) continue;
          if (w.length >= 3 && name.includes(w)) { score += 2; continue; }
          ok = false; break;
        }
        if (!ok) continue;
        if (!name.startsWith(q[0])) score += 1;
        scored.push([score * 10 + (item[1] === 0 ? 1 : 0) + name.length / 100, item]); // places a touch before streets
      }
      scored.sort((a, b) => a[0] - b[0]);
      this.shown = scored.slice(0, 8).map((s) => s[1]);
    }
    this.list.replaceChildren(...this.shown.map((it, i) => {
      const li = document.createElement("li");
      li.dataset.i = String(i);
      li.setAttribute("role", "option");
      const a = document.createElement("span"), b = document.createElement("span");
      a.textContent = it[0]; b.textContent = it[4];
      li.append(a, b);
      return li;
    }));
    this.select(0);
  }

  private select(i: number) {
    if (!this.shown.length) return;
    this.at = (i + this.shown.length) % this.shown.length;
    [...this.list.children].forEach((li, k) => li.setAttribute("aria-selected", String(k === this.at)));
  }

  private choose(i: number) {
    const it = this.shown[i];
    if (!it) return;
    this.input.value = it[0];
    this.list.replaceChildren();
    this.input.blur();
    this.host.go(it[2], it[3], WIDTH[it[1]] ?? 500, it[0]);
  }
}
