/**
 * Tilt-shift (places.ts `effects.tiltShift`): the map as a miniature. A sharp band across the middle of the
 * screen, the map blurring more and more towards the top and bottom edges: layers of backdrop blur over the
 * tiles and the overlay, each covering what lies further than its distance from the middle and fading in over
 * a ramp, so the blur grows in steps too soft to see. A button (top right, #corner-buttons) and the M key switch it on and off;
 * the choice is remembered in this browser.
 */
/** [blur in CSS px, where it starts (share of the screen height from the middle), its ramp (share)] */
const LAYERS: Array<[number, number, number]> = [[0.8, 0.12, 0.10], [1.6, 0.20, 0.12], [2.8, 0.30, 0.14], [4.2, 0.42, 0.16]];
const KEY = "tiltShift";

export class TiltShift {
  private parts: Array<{ top: HTMLDivElement; bottom: HTMLDivElement; start: number; ramp: number }> = [];
  private on = true;
  private height = 0;
  private button: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    for (const [blur, start, ramp] of LAYERS) {
      const make = (dir: "bottom" | "top") => {
        const d = document.createElement("div");
        // the edge towards the middle fades out over the ramp
        const mask = `linear-gradient(to ${dir}, #000 calc(100% - var(--ramp)), transparent 100%)`;
        Object.assign(d.style, {
          position: "absolute", left: "0", width: "100%", pointerEvents: "none", zIndex: "3",
          backdropFilter: `blur(${blur}px)`, webkitBackdropFilter: `blur(${blur}px)`, maskImage: mask, webkitMaskImage: mask,
        });
        parent.appendChild(d);
        return d;
      };
      this.parts.push({ top: make("bottom"), bottom: make("top"), start, ramp });
    }
    // the button: a screen with a sharp band across the middle, soft dots above and below
    this.button = document.createElement("button");
    this.button.id = "tilt-toggle";
    this.button.type = "button";
    const dots = (y: number) => [6, 10, 14, 18].map((x) => `<circle cx="${x}" cy="${y}" r="1.1" fill="currentColor" opacity="0.5"/>`).join("");
    this.button.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/>
      ${dots(7.5)}<rect x="5" y="10.5" width="14" height="3" rx="1" fill="currentColor"/>${dots(16.5)}</svg>`;
    this.button.addEventListener("click", () => this.toggle());
    (document.getElementById("corner-buttons") ?? document.body).appendChild(this.button);
    try { if (localStorage.getItem(KEY) === "off") this.set(false); } catch { /* storage blocked: on */ }
    this.set(this.on);
  }

  toggle() {
    this.set(!this.on);
    try { localStorage.setItem(KEY, this.on ? "on" : "off"); } catch { /* storage blocked */ }
  }

  private set(on: boolean) {
    this.on = on;
    for (const p of this.parts) p.top.style.display = p.bottom.style.display = on ? "" : "none";
    this.button.setAttribute("aria-pressed", String(on));
    this.button.title = this.button.ariaLabel = `Tilt-shift: ${on ? "on" : "off"} (M)`;
    this.height = 0; // lay out again when switched on
  }

  /** each frame: lay the layers out around the middle when the screen height changes */
  update() {
    const H = innerHeight;
    if (!this.on || H === this.height) return;
    this.height = H;
    const f = H / 2;
    for (const { top, bottom, start, ramp } of this.parts) {
      const s = start * H, r = `${ramp * H}px`;
      Object.assign(top.style, { top: "0", height: `${Math.max(0, f - s)}px` });
      Object.assign(bottom.style, { top: `${f + s}px`, height: `${Math.max(0, H - f - s)}px` });
      top.style.setProperty("--ramp", r);
      bottom.style.setProperty("--ramp", r);
    }
  }
}
