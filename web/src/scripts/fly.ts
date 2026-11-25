/**
 * Fly a biplane over the map (places.ts `effects.fly`). A round button in the corner column (or F) takes off from
 * the middle of the screen; the arrows or WASD bank it into turns and change its speed, and a finger or the mouse
 * held on the map steers it towards that point. The map follows it. F, Esc or the button again lands it (it is
 * simply gone). The plane is a 3D model (biplane.ts, three.js, loaded at the first take-off) seen like the map and
 * lit by its sun. It is an object of the map's world, like the houses: 2.5 times life size (~24 m across), flying
 * ALT metres up at a real speed, so it grows and shrinks with the map; puffs of smoke stay in the air behind it.
 * Its shadow lies where the sunlight through it meets the surface: drawn flat for level ground (biplane.ts), then,
 * where the map's surface heights are there (heights.ts), every pixel near it takes the flat shadow from where its
 * own surface would be at ground level along the sunlight, so the shadow climbs walls and lies on roofs and crowns,
 * moved towards the plane by their height, as the map's own shadows are.
 */
import type { Biplane3D } from "./biplane.ts";
import type { Heights } from "./heights.ts";
type Vec3 = [number, number, number];
type ToScreen = (x: number, y: number) => [number, number];

export interface FlyHost {
  enu2px: number[][];
  /** the region's typical ground height in the ENU frame (places.ts groundH) */
  groundZ: number;
  /** [x0, y0, x1, y1] global art px of the map, kept inside */
  bounds: number[];
  /** global art px at the middle of the screen */
  center(): [number, number];
  /** a point on the map element (CSS px) → global art px */
  screenToGlobal(sx: number, sy: number): [number, number];
  /** move the middle of the screen to global art px (immediately) */
  follow(x: number, y: number): void;
  /** taking off (true) or landing: the map stops or starts panning by drag, the mine goes back up */
  onChange(flying: boolean): void;
  /** the map's surface heights (export.ts tiles/height), if exported: their index and a tile's address */
  heights?: { index(): Promise<Record<string, string>>; url(tx: number, ty: number, v: string): string };
}

/** the model's size against life (it is ~9.4 m across) */
const SCALE = 2.5;
/** height over the ground (m) */
const ALT = 45;
/** speed (m/s) */
const SPEED = { start: 55, min: 25, max: 110, accel: 30 };
const BANK = 0.6, TURN = 1.25; // max bank (rad); turn rate = TURN · tan(bank) rad/s
const PUFF_EVERY = 0.07, PUFF_LIFE = 2.4;
/** metres per art px (camera.ts CAMERA.mpp) */
const MPP = 0.25;
/** heights over the local ground the shadow is laid on (m): lower and higher ones are taken as these */
const DROP_MIN = -12, DROP_MAX = 45;
/** the draped shadow is worked out on a grid at most this many cells across, then drawn scaled up */
const WORK = 320;
/** the flat shadow's coverage is read back this many texels across (biplane.ts requestShadowMask) */
const MASK = 256;
/** its colour: the map's own shadows' cool grey-blue (biplane.ts draws the flat one alike) */
const SHADE = [34, 41, 62];

export class Fly {
  flying = false;
  private x = 0; private y = 0; private psi = 0; private v = SPEED.start; private bank = 0; private pitch = 0;
  private t = 0; private age = 0; private puffT = 0;
  /** smoke left in the air (ENU) */
  private puffs: Array<{ p: Vec3; age: number }> = [];
  private keys = new Set<string>();
  private pointer: [number, number] | null = null;
  private cam: [number, number] | null = null;
  private model: Biplane3D | null = null;
  private loading: Promise<void> | null = null;
  private heights: Heights | null = null;
  private heightsLoading: Promise<void> | null = null;
  /** the local ground the shadow is laid on (m, heights.ts), eased so it never jumps; the last frame's dt */
  private zg: number | null = null;
  private dt = 0;
  /** the draped shadow before it is drawn scaled, and its pixels (kept: no new buffer a frame) */
  private workCanvas = document.createElement("canvas");
  private work: ImageData | null = null;
  private inv: number[];
  private button: HTMLButtonElement;
  private hint: HTMLElement;
  private hintTimer = 0;

  constructor(private host: FlyHost, private map: HTMLElement) {
    const M = host.enu2px, det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    this.inv = [M[1][1] / det, -M[0][1] / det, -M[1][0] / det, M[0][0] / det];
    // the button: a biplane from above
    const b = (this.button = document.createElement("button"));
    b.id = "fly-toggle";
    b.type = "button";
    b.title = b.ariaLabel = "Fly a biplane (F)";
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
      <rect x="3.2" y="11.6" width="17.6" height="2" rx="1" opacity="0.55"/><rect x="2" y="8.2" width="20" height="3.2" rx="1.4"/>
      <rect x="10.9" y="4.4" width="2.2" height="15.2" rx="1.1"/><rect x="7.6" y="17.2" width="8.8" height="2.1" rx="0.9"/>
      <rect x="8.2" y="2.4" width="7.6" height="1.2" rx="0.6" opacity="0.6"/></svg>`;
    b.addEventListener("click", () => (this.flying ? this.stop() : this.start()));
    (document.getElementById("corner-buttons") ?? document.body).appendChild(b);
    this.hint = document.createElement("div");
    this.hint.id = "fly-hint";
    Object.assign(this.hint.style, {
      position: "fixed", left: "50%", bottom: "calc(64px + env(safe-area-inset-bottom, 0px))", transform: "translateX(-50%)", zIndex: "15",
      padding: "6px 12px", borderRadius: "10px", background: "rgba(18,17,15,0.78)", color: "#f4ecda", font: "500 13px/1.3 ui-sans-serif, system-ui, sans-serif",
      pointerEvents: "none", opacity: "0", transition: "opacity .4s", textAlign: "center", width: "max-content", maxWidth: "calc(100vw - 32px)",
    });
    document.body.appendChild(this.hint);
    // keys: captured before the viewer's own arrow-key panning while flying
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      const k = e.key.toLowerCase();
      // F before the viewer sees it (its own F flips the map)
      if (k === "f") { e.preventDefault(); e.stopPropagation(); if (this.flying) this.stop(); else this.start(); return; }
      if (!this.flying) return;
      if (k === "escape") { this.stop(); return; }
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", "a", "d", "w", "s"].includes(k)) { this.keys.add(k); e.preventDefault(); e.stopPropagation(); }
    }, true);
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()), true);
    window.addEventListener("blur", () => this.keys.clear());
    // a finger or the mouse held on the map steers towards it
    const at = (e: PointerEvent): [number, number] => { const r = this.map.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const onMap = (e: PointerEvent) => !(e.target as HTMLElement).closest("nav, aside, button, a");
    this.map.addEventListener("pointerdown", (e) => { if (this.flying && onMap(e)) this.pointer = at(e); });
    this.map.addEventListener("pointermove", (e) => { if (this.flying && this.pointer) this.pointer = at(e); });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) this.map.addEventListener(ev, () => (this.pointer = null));
  }

  /** ENU ground-plane direction of an art-px vector */
  private toEnu(dx: number, dy: number): [number, number] { const i = this.inv; return [i[0] * dx + i[1] * dy, i[2] * dx + i[3] * dy]; }
  private project(p: Vec3): [number, number] {
    const M = this.host.enu2px;
    return [M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]];
  }
  /** the plane in the air (ENU) */
  private get air(): Vec3 { return [this.x, this.y, this.host.groundZ + ALT]; }

  start() {
    if (this.flying) return;
    this.loading ??= import("./biplane.ts").then(({ Biplane3D }) => { this.model = new Biplane3D(); });
    const hs = this.host.heights;
    if (hs) this.heightsLoading ??= Promise.all([import("./heights.ts"), hs.index()]).then(([{ Heights: H }, index]) => { this.heights = new H(index, hs.url); });
    // in the air right in the middle of the screen, nose up the screen
    const M = this.host.enu2px, z = this.host.groundZ + ALT, [cx, cy] = this.host.center();
    [this.x, this.y] = this.toEnu(cx - M[0][2] * z, cy - M[1][2] * z);
    const up = this.toEnu(0, -1);
    this.psi = Math.atan2(up[1], up[0]);
    this.v = SPEED.start; this.bank = 0; this.pitch = 0; this.age = 0; this.puffs = []; this.cam = null; this.zg = null;
    if (this.model) this.model.mask = null; // the last flight's shadow
    this.flying = true;
    this.button.setAttribute("aria-pressed", "true");
    this.button.title = this.button.ariaLabel = "Land the biplane (F)";
    const touch = matchMedia("(pointer: coarse)").matches;
    this.hint.textContent = touch ? "Hold a finger on the map to steer · tap ✈ to land" : "← → steer · ↑ ↓ speed · hold the mouse on the map to steer · F or Esc to land";
    this.hint.style.opacity = "1";
    this.hintTimer = 7;
    this.host.onChange(true);
  }

  stop() {
    if (!this.flying) return;
    this.flying = false;
    this.keys.clear(); this.pointer = null; this.puffs = [];
    this.button.setAttribute("aria-pressed", "false");
    this.button.title = this.button.ariaLabel = "Fly a biplane (F)";
    this.hint.style.opacity = "0";
    this.host.onChange(false);
  }

  step(dt: number) {
    if (!this.flying) return;
    dt = Math.min(dt, 0.1);
    this.t += dt; this.age += dt; this.dt = dt;
    if (this.hintTimer > 0 && (this.hintTimer -= dt) <= 0) this.hint.style.opacity = "0";
    const keys = this.keys, was = this.v;
    let u = (keys.has("arrowleft") || keys.has("a") ? 1 : 0) - (keys.has("arrowright") || keys.has("d") ? 1 : 0);
    const throttle = (keys.has("arrowup") || keys.has("w") ? 1 : 0) - (keys.has("arrowdown") || keys.has("s") ? 1 : 0);
    this.v = Math.min(SPEED.max, Math.max(SPEED.min, this.v + throttle * SPEED.accel * dt));
    const [px, py] = this.project(this.air); // the plane on the map (global art px)
    const want = (dx: number, dy: number) => { // turn towards an art-px direction from the plane
      const d = this.toEnu(dx, dy), a = Math.atan2(d[1], d[0]) - this.psi;
      return Math.max(-1, Math.min(1, Math.atan2(Math.sin(a), Math.cos(a)) / 0.5));
    };
    if (this.pointer) {
      const [qx, qy] = this.host.screenToGlobal(this.pointer[0], this.pointer[1]);
      if (Math.hypot(qx - px, qy - py) * MPP > (9.4 * SCALE) / 2) u = want(qx - px, qy - py); // not on the plane itself
    }
    // out past the map's edge: home back towards its middle
    const [x0, y0, x1, y1] = this.host.bounds, m = 600;
    if (px < x0 + m || px > x1 - m || py < y0 + m || py > y1 - m) u = want((x0 + x1) / 2 - px, (y0 + y1) / 2 - py);
    this.bank += (u * BANK - this.bank) * Math.min(1, dt * 4);
    this.psi += TURN * Math.tan(this.bank) * dt;
    this.x += Math.cos(this.psi) * this.v * dt;
    this.y += Math.sin(this.psi) * this.v * dt;
    // nose up a little while speeding up, down while slowing, and a slow bob
    const target = Math.max(-0.12, Math.min(0.12, (this.v - was) / Math.max(dt, 1e-3) / 250)) + 0.03 * Math.sin(this.t * 0.9);
    this.pitch += (target - this.pitch) * Math.min(1, dt * 3);
    // smoke from the tail, left in the air where it was made
    this.puffT += dt;
    for (const p of this.puffs) p.age += dt;
    this.puffs = this.puffs.filter((p) => p.age < PUFF_LIFE);
    if (this.puffT >= PUFF_EVERY) {
      this.puffT = 0;
      const back = 4.6 * SCALE, [ax, ay, az] = this.air;
      this.puffs.push({ p: [ax - Math.cos(this.psi) * back, ay - Math.sin(this.psi) * back, az + 0.3 * SCALE], age: 0 });
    }
    // the camera: eased towards where the plane will be in a second
    const [tx, ty] = this.project([this.x + Math.cos(this.psi) * this.v, this.y + Math.sin(this.psi) * this.v, this.air[2]]);
    const c = this.cam ?? [px, py], e = Math.min(1, dt * 2.5);
    this.cam = [c[0] + (tx - c[0]) * e, c[1] + (ty - c[1]) * e];
    this.host.follow(this.cam[0], this.cam[1]);
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen) {
    if (!this.flying) return;
    const proj = (q: Vec3) => { const [x, y] = this.project(q); return toScreen(x, y); };
    const ppm = (toScreen(1, 0)[0] - toScreen(0, 0)[0]) / MPP; // device px per metre (the map is only scaled and moved)
    const fade = Math.min(1, this.age / 0.4);
    const m = this.model;
    // the shadow under the plane, along the sunlight: flat, then laid over the surface where its heights are in
    if (m) {
      m.resize(ppm * SCALE);
      m.pose(this.psi, this.bank, this.pitch, this.t, ALT / SCALE);
      const [sx, sy, sz] = m.sun, a = this.air, W = m.canvas.width;
      const [gx, gy] = proj([a[0] - (sx / sz) * ALT, a[1] - (sy / sz) * ALT, a[2] - ALT]);
      if (!this.heights || !this.drape(ctx, toScreen, m, gx, gy, W, fade)) {
        m.renderShadow();
        ctx.globalAlpha = fade; ctx.drawImage(m.canvas, gx - W / 2, gy - W / 2); ctx.globalAlpha = 1;
      }
    }
    // smoke, oldest first, drifting up a little
    for (const q of this.puffs) {
      const [sx, sy] = proj([q.p[0], q.p[1], q.p[2] + q.age * 3]), f = q.age / PUFF_LIFE, r = (0.5 + q.age * 1.3) * SCALE * ppm;
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - f) * (1 - f) * fade})`;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 2 * Math.PI); ctx.fill();
    }
    if (!m) return; // three.js still loading
    const [px, py] = proj(this.air), W = m.canvas.width;
    m.renderPlane();
    ctx.globalAlpha = fade; ctx.drawImage(m.canvas, px - W / 2, py - W / 2); ctx.globalAlpha = 1;
  }

  /**
   * The flat shadow (W px square centred on gx, gy for ground at the local ground's height; its coverage read back from
   * the model a frame or two ago) laid over the surface: a pixel showing a surface dz higher than that ground is in
   * shadow where the flat shadow is at the pixel moved away from the sun by dz along the sunlight, as seen on screen.
   * False when there is nothing to lay it on yet.
   */
  private drape(ctx: CanvasRenderingContext2D, toScreen: ToScreen, m: Biplane3D, gx: number, gy: number, W: number, fade: number) {
    const H = this.heights!, M = this.host.enu2px, L = m.sun;
    const o = toScreen(0, 0), k = toScreen(1, 0)[0] - o[0]; // art px = (screen − o) / k
    const art = (x: number, y: number): [number, number] => [(x - o[0]) / k, (y - o[1]) / k];
    // the screen shift per metre of height: the sunlight's direction projected, per metre it rises
    const cx = ((M[0][0] * L[0] + M[0][1] * L[1] + M[0][2] * L[2]) / L[2]) * k, cy = ((M[1][0] * L[0] + M[1][1] * L[1] + M[1][2] * L[2]) / L[2]) * k;
    // where the shadow can show: its flat square, moved along the sunlight by the lowest and the highest drop
    const x0 = gx - W / 2, y0 = gy - W / 2;
    const rx0 = x0 + Math.min(0, cx * DROP_MIN, cx * DROP_MAX), rx1 = x0 + W + Math.max(0, cx * DROP_MIN, cx * DROP_MAX);
    const ry0 = y0 + Math.min(0, cy * DROP_MIN, cy * DROP_MAX), ry1 = y0 + W + Math.max(0, cy * DROP_MIN, cy * DROP_MAX);
    const [ax0, ay0] = art(rx0, ry0), [ax1, ay1] = art(rx1, ry1);
    H.want(ax0 - 64, ay0 - 64, ax1 + 64, ay1 + 64);
    // the local ground: low (a fifth of the way up) among the surfaces under the flat shadow, sampled on a lattice
    // fixed to the map, and eased over time, so it follows the land without jumping as things pass under
    const [sx0, sy0] = art(x0, y0), [sx1, sy1] = art(x0 + W, y0 + W), gap = Math.max(8, (sx1 - sx0) / 10), zs: number[] = [];
    for (let y = Math.ceil(sy0 / gap) * gap; y <= sy1; y += gap) for (let x = Math.ceil(sx0 / gap) * gap; x <= sx1; x += gap) {
      const z = H.at(x, y);
      if (!Number.isNaN(z)) zs.push(z);
    }
    if (!zs.length && this.zg === null) return false;
    if (zs.length) {
      zs.sort((a, b) => a - b);
      const want = zs[Math.floor(zs.length * 0.2)];
      this.zg = this.zg === null ? want : this.zg + (want - this.zg) * Math.min(1, this.dt * 2);
    }
    const zg = this.zg!;
    // the flat shadow's coverage (biplane.ts): asked for again each frame, the one that has arrived used
    m.requestShadowMask(MASK);
    if (!m.mask) return false;
    const { size: ms, alpha: mask, box: [bu0, bv0, bu1, bv1] } = m.mask, f = ms / W;
    // the draped shadow on a grid, a cell per `step` screen px, its cells fixed to the map (no shimmer as it moves)
    const step = Math.max(1, Math.ceil(Math.max(rx1 - rx0, ry1 - ry0) / WORK));
    const gx0 = o[0] + Math.floor((rx0 - o[0]) / step) * step, gy0 = o[1] + Math.floor((ry0 - o[1]) / step) * step;
    const ow = Math.ceil((rx1 - gx0) / step) + 1, oh = Math.ceil((ry1 - gy0) / step) + 1, wc = this.workCanvas;
    if (wc.width !== ow || wc.height !== oh) { wc.width = ow; wc.height = oh; }
    const wg = wc.getContext("2d")!;
    if (this.work?.width !== ow || this.work.height !== oh) this.work = wg.createImageData(ow, oh);
    else this.work.data.fill(0);
    const img = this.work, out = img.data;
    const mAt = (u: number, v: number) => (u < 0 || v < 0 || u >= ms || v >= ms ? 0 : mask[v * ms + u]);
    // only the columns and rows whose texels, for some drop, can fall in the coverage's box: a cell reads texels
    // floor(fu) and the next, fu = (px − cx·dz − x0)·f − 0.5, so it needs fu ≥ u0 − 1 for the largest and fu < u1 + 1
    // for the smallest shift (rows alike); every cell left out would come out empty
    const sxa = Math.min(cx * DROP_MIN, cx * DROP_MAX), sxb = Math.max(cx * DROP_MIN, cx * DROP_MAX);
    const sya = Math.min(cy * DROP_MIN, cy * DROP_MAX), syb = Math.max(cy * DROP_MIN, cy * DROP_MAX);
    const cell = (p: number, g0: number) => (p - g0) / step - 0.5; // the cell whose centre is at screen px p
    const i0 = Math.max(0, Math.floor(cell(x0 + sxa + (bu0 - 0.5) / f, gx0))), i1 = Math.min(ow - 1, Math.ceil(cell(x0 + sxb + (bu1 + 1.5) / f, gx0)));
    const j0 = Math.max(0, Math.floor(cell(y0 + sya + (bv0 - 0.5) / f, gy0))), j1 = Math.min(oh - 1, Math.ceil(cell(y0 + syb + (bv1 + 1.5) / f, gy0)));
    let any = false;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = gx0 + (i + 0.5) * step, py = gy0 + (j + 0.5) * step, [x, y] = art(px, py), z = H.at(x, y);
      const dz = Number.isNaN(z) ? 0 : Math.max(DROP_MIN, Math.min(DROP_MAX, z - zg));
      // the flat shadow where this surface would lie at ground level, read between its pixels
      const fu = (px - cx * dz - x0) * f - 0.5, fv = (py - cy * dz - y0) * f - 0.5, u = Math.floor(fu), v = Math.floor(fv), du = fu - u, dv = fv - v;
      const alpha = (mAt(u, v) * (1 - du) + mAt(u + 1, v) * du) * (1 - dv) + (mAt(u, v + 1) * (1 - du) + mAt(u + 1, v + 1) * du) * dv;
      if (alpha >= 1) { const q = (j * ow + i) * 4; out[q] = SHADE[0]; out[q + 1] = SHADE[1]; out[q + 2] = SHADE[2]; out[q + 3] = alpha; any = true; }
    }
    if (!any) return true;
    wg.putImageData(img, 0, 0);
    ctx.globalAlpha = fade; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(wc, 0, 0, ow, oh, gx0, gy0, ow * step, oh * step);
    ctx.globalAlpha = 1;
    return true;
  }
}
