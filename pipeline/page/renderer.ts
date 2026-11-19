/**
 * Headless renderer page: open-data 3D scene through one orthographic camera.
 * Terrain + ground surface (OSM, drawn per tile onto a canvas texture) + extruded buildings + trees.
 * Driven by src/render.ts via Playwright: window.renderTile(tx, ty) -> PNG data.
 */
import * as THREE from "three";
import { CAMERA, axes, ecefToEnu, llhToEcef, tileCamera, useRegion } from "../src/camera.ts";
import { REGIONS } from "../src/places.ts";
import { drawGround, type Feature } from "./ground.ts";
import { deckHeight } from "../src/bridges.ts";
import { ZG_SPECIES } from "../src/species.ts";

const params = new URLSearchParams(location.search);
const REGION = params.get("region") ?? "israel-center";
useRegion(REGION); // before any projection below
/** LGL regions (Baden-Württemberg) get the finished procedural look (no paint step): LoD2 roofs, hillshade, outlines. */
const STYLED = REGIONS[REGION].sources === "lgl" || REGIONS[REGION].sources === "zg3d"; // LoD2 regions: drawn, not painted
/** Zagreb: its own plaster and tile palette, Austro-Hungarian façades, prefab slabs and the landmark styles 6–10 (shader `ZG`). */
const ZG = REGIONS[REGION].sources === "zg3d";
/** Ellipsoid height the height pass counts from (heights.ts). */
const HEIGHT_BASE = REGIONS[REGION].heightBase ?? 0;
const SS = Number(params.get("ss") ?? 2); // supersampling
const SIZE = CAMERA.tile * SS;
const HEIGHT_SIZE = 256;
/** Ground texture resolution (m per texel); the render samples ~0.125 m across, 0.18 m in depth. */
const GROUND_MPT = 0.15;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// ?markers=lat,lon,h;lat,lon,h  -> red 6 m spheres (alignment debugging)
for (const m of (params.get("markers") ?? "").split(";").filter(Boolean)) {
  const [lat, lon, h] = m.split(",").map(Number);
  const s = new THREE.Mesh(new THREE.SphereGeometry(6), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  s.position.set(...ecefToEnu(llhToEcef(lat, lon, h)));
  scene.add(s);
}

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10);

// ---- terrain ---------------------------------------------------------------------------------
const meta: { x0: number; y0: number; nx: number; ny: number; step: number } = await (await fetch("/ground/meta.json")).json();
const terrain = new Float32Array(await (await fetch("/ground/height.bin")).arrayBuffer());
const features: Feature[] = await (await fetch("/ground/features.json")).json();
const fbox = features.map((f) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  if (f.j) return [-Infinity, -Infinity, Infinity, Infinity]; // point sets (junctions, zebras): always passed
  for (const ring of f.r ?? [f.l!]) for (const [x, y] of ring) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
});

/** Ground ENU "up" at (x, y), bilinear on the terrain grid. */
function ground(x: number, y: number): number {
  const fx = Math.min(meta.nx - 1.001, Math.max(0, (x - meta.x0) / meta.step));
  const fy = Math.min(meta.ny - 1.001, Math.max(0, (y - meta.y0) / meta.step));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * meta.nx + ix;
  return (terrain[i] * (1 - ax) + terrain[i + 1] * ax) * (1 - ay) + (terrain[i + meta.nx] * (1 - ax) + terrain[i + meta.nx + 1] * ax) * ay;
}

/**
 * Sun direction (towards the sun, ENU). Styled regions light from the viewer's back-left whatever the heading,
 * so the left facades are sunlit and the right ones shaded, like the house style.
 */
const SUN = STYLED ? (() => {
  const { right: r, dir: d } = axes(), f = new THREE.Vector2(d[0], d[1]).normalize();
  return new THREE.Vector3(-0.45 * f.x - 0.55 * r[0], -0.45 * f.y - 0.55 * r[1], 0.8).normalize();
})() : new THREE.Vector3(-0.55, -0.35, 0.76).normalize();
/** ground contact shadows point away from the sun */
const SHADOW: [number, number] = (() => { const v = new THREE.Vector2(-SUN.x, -SUN.y).normalize(); return [v.x, v.y]; })();
const groundTexture = new THREE.CanvasTexture(document.createElement("canvas"));
// styled: every material is a raw shader writing the canvas colours as they are (the post pass reads them back)
groundTexture.colorSpace = STYLED ? THREE.NoColorSpace : THREE.SRGBColorSpace;
groundTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
/** Ground with hillshade: lit by the sun relative to flat ground, so slopes toward it brighten and away darken. */
const hillshadeMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec2 vUv; varying vec3 vNormal;
    void main() { vUv = uv; vNormal = normal; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D map; uniform vec3 sun;
    varying vec2 vUv; varying vec3 vNormal;
    void main() {
      vec3 n = normalize(vNormal);
      float shade = clamp(1.0 + 1.0 * (dot(n, sun) - sun.z), 0.80, 1.15); // capped: ramps and stair pits in the DGM stay readable
      gl_FragColor = vec4(texture2D(map, vUv).rgb * shade, 1.0);
    }`,
  uniforms: { map: { value: groundTexture }, sun: { value: SUN } },
});
const groundMesh = new THREE.Mesh(new THREE.BufferGeometry(), STYLED ? hillshadeMaterial : new THREE.MeshBasicMaterial({ map: groundTexture }));
scene.add(groundMesh);
let terrainLo = Infinity, terrainHi = -Infinity;
for (const h of terrain) if (Number.isFinite(h)) { terrainLo = Math.min(terrainLo, h); terrainHi = Math.max(terrainHi, h); }

/**
 * ENU rectangle of ground the tile camera can see: the screen rect swept over the terrain's height range,
 * first the whole grid's, then narrowed to the range inside that first rect (hilly regions span 300 m+).
 */
function footprint(tx: number, ty: number) {
  let rect = sweep(tx, ty, terrainLo - 5, terrainHi + 5);
  for (let pass = 0; pass < 2; pass++) {
    let lo = Infinity, hi = -Infinity;
    const s = meta.step;
    for (let y = rect[1]; y <= rect[3] + s; y += s) for (let x = rect[0]; x <= rect[2] + s; x += s) {
      const g = ground(x, y);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
    }
    rect = sweep(tx, ty, lo - 5, hi + 5);
  }
  return rect;
}
function sweep(tx: number, ty: number, lo: number, hi: number) {
  const { right: r, up: v, dir: d } = axes();
  const T = CAMERA.tile * CAMERA.mpp, xs: number[] = [], ys: number[] = [];
  for (const sx of [tx * T, (tx + 1) * T]) for (const sy of [ty * T, (ty + 1) * T]) for (const u of [lo, hi]) {
    // p = r*sx - v*sy + d*t with p.z = u
    const t = (u + v[2] * sy) / d[2];
    xs.push(r[0] * sx - v[0] * sy + d[0] * t);
    ys.push(r[1] * sx - v[1] * sy + d[1] * t);
  }
  const m = 15;
  return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
}

function buildGround(tx: number, ty: number, data?: TileObjects) {
  const [x0, y0, x1, y1] = footprint(tx, ty);
  // texture
  const cv = groundTexture.image as HTMLCanvasElement;
  const w = Math.ceil((x1 - x0) / GROUND_MPT), h = Math.ceil((y1 - y0) / GROUND_MPT);
  // three.js allocates GPU storage once per texture: a new size needs a fresh one, or tiles get stale ground (hilly regions)
  if (w !== cv.width || h !== cv.height) groundTexture.dispose();
  cv.width = w;
  cv.height = h;
  const visible = features.filter((_, i) => fbox[i][0] < x1 && fbox[i][2] > x0 && fbox[i][1] < y1 && fbox[i][3] > y0);
  // bridges (styled regions): off the ground, onto their own deck above the gap (bridges.ts)
  const bridges = STYLED ? visible.filter((f) => f.b && f.l && f.l.length >= 2) : [];
  // LoD2 footprints cast the same contact shadows as extruded buildings
  const shadows = { b: [...(data?.b ?? []), ...(data?.m ?? []).filter((m) => !m[9] || m[9] < 2).map((m) => [m[4], m[5], m[0], null] as [P2[], number, number, null])], t: data?.t ?? [] };
  const ctx = cv.getContext("2d")!;
  drawGround(ctx, bridges.length ? visible.filter((f) => !bridges.includes(f)) : visible, [x0, y0, x1, y1], GROUND_MPT, shadows, ground, STYLED ? SHADOW : undefined, STYLED);
  buildDecks(ctx, bridges, [x0, y0, x1, y1], w, h);
  if (STYLED) deckShadows(ctx, data);
  groundTexture.needsUpdate = true;
  // terrain mesh: 5 m grid draped on the terrain, UVs into the canvas
  const step = Math.min(5, meta.step), nx = Math.ceil((x1 - x0) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1;
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), idx: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(x1, x0 + i * step), y = Math.min(y1, y0 + j * step), k = j * nx + i;
    pos.set([x, y, ground(x, y)], k * 3);
    uv.set([(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)], k * 2);
    if (i && j) idx.push(k - nx - 1, k - nx, k, k - nx - 1, k, k - 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  if (STYLED) geo.computeVertexNormals();
  groundMesh.geometry.dispose();
  groundMesh.geometry = geo;
}

// ---- bridge decks ------------------------------------------------------------------------------
const deckTexture = new THREE.CanvasTexture(document.createElement("canvas"));
deckTexture.colorSpace = THREE.NoColorSpace;
deckTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
const deckMaterial = hillshadeMaterial.clone();
deckMaterial.uniforms.map = { value: deckTexture };
deckMaterial.side = THREE.DoubleSide;
/** deck edges: concrete, lit like the hillshade (sunlit side brighter) */
const fasciaMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    void main() { vNormal = normal; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color, sun; varying vec3 vNormal;
    void main() { gl_FragColor = vec4(color * (0.72 + 0.4 * max(dot(normalize(vNormal), sun), 0.0)), 1.0); }`,
  uniforms: { color: { value: new THREE.Color(0.8, 0.79, 0.76) }, sun: { value: SUN } },
  side: THREE.DoubleSide,
});
const decks = new THREE.Group();
scene.add(decks);
/** fascia depth below the deck surface (m) */
const FASCIA = 1.3;

/**
 * Bridge decks for this tile: the bridges drawn alone onto a second canvas (same look as on the ground),
 * a ribbon carrying it at the deck height, concrete fascias along both edges, and the deck's shadow on
 * the ground canvas `ctx` (still in ENU metres after drawGround).
 */
function buildDecks(ctx: CanvasRenderingContext2D, bridges: Feature[], [x0, y0, x1, y1]: number[], w: number, h: number) {
  for (const c of decks.children) (c as THREE.Mesh).geometry.dispose();
  decks.clear();
  if (!bridges.length) return;
  const cv = deckTexture.image as HTMLCanvasElement;
  if (w !== cv.width || h !== cv.height) deckTexture.dispose();
  cv.width = w; cv.height = h;
  drawGround(cv.getContext("2d")!, bridges, [x0, y0, x1, y1], GROUND_MPT, { b: [], t: [] }, ground, SHADOW, STYLED);
  deckTexture.needsUpdate = true;
  const top: number[] = [], uv: number[] = [], side: number[] = [], sideN: number[] = [];
  const U = (x: number, y: number) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)];
  ctx.save();
  ctx.fillStyle = "rgba(40,40,48,0.28)";
  for (const f of bridges) {
    const l = f.l!, deck = deckHeight(l, ground, f.e), half = f.k === "rail" ? 2.5 : (f.w ?? 6) / 2 + 1.5;
    // samples every ≤ 2 m along the line, with the direction there
    const pts: Array<{ x: number; y: number; z: number; dx: number; dy: number; g: number }> = [];
    for (let i = 0; i + 1 < l.length; i++) {
      const [ax, ay] = l[i], [bx, by] = l[i + 1], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-3) continue;
      const n = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k <= n; k++) {
        if (k === 0 && pts.length) continue;
        const t = k / n, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        pts.push({ x, y, z: deck.at(deck.cum[i] + L * t, x, y) + 0.05, dx: (bx - ax) / L, dy: (by - ay) / L, g: ground(x, y) });
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      // mitred normals: average the directions at a joint
      const na = i > 0 ? [-(pts[i - 1].dy + a.dy) / 2, (pts[i - 1].dx + a.dx) / 2] : [-a.dy, a.dx];
      const nb = [-b.dy, b.dx];
      const la = Math.hypot(na[0], na[1]) || 1, lb = Math.hypot(nb[0], nb[1]) || 1;
      const A = [[a.x + (na[0] / la) * half, a.y + (na[1] / la) * half], [a.x - (na[0] / la) * half, a.y - (na[1] / la) * half]];
      const B = [[b.x + (nb[0] / lb) * half, b.y + (nb[1] / lb) * half], [b.x - (nb[0] / lb) * half, b.y - (nb[1] / lb) * half]];
      // top: A0 B0 B1, A0 B1 A1 (counter-clockwise from above: left side is +normal)
      for (const [p, z] of [[A[1], a.z], [B[1], b.z], [B[0], b.z], [A[1], a.z], [B[0], b.z], [A[0], a.z]] as Array<[number[], number]>) {
        top.push(p[0], p[1], z); uv.push(...U(p[0], p[1]));
      }
      // fascias: both edges, from the deck down FASCIA m (or to the ground where it is close)
      for (const [s0, s1, sgn] of [[A[0], B[0], 1], [B[1], A[1], -1]] as Array<[number[], number[], number]>) {
        const za = sgn > 0 ? a.z : b.z, zb = sgn > 0 ? b.z : a.z;
        const ba = Math.max(za - FASCIA, Math.min(za, (sgn > 0 ? a.g : b.g))), bb = Math.max(zb - FASCIA, Math.min(zb, (sgn > 0 ? b.g : a.g)));
        const q = [[s0[0], s0[1], ba], [s1[0], s1[1], bb], [s1[0], s1[1], zb], [s0[0], s0[1], za]];
        const ex = s1[0] - s0[0], ey = s1[1] - s0[1], el = Math.hypot(ex, ey) || 1, nx = -ey / el, ny = ex / el; // outward: left of the way for A, right for B (walked backwards)
        for (const k of [0, 1, 2, 0, 2, 3]) { side.push(...q[k]); sideN.push(nx, ny, 0); }
      }
      // shadow on the ground: the deck strip shifted away from the sun by its clearance
      const clear = (a.z + b.z - a.g - b.g) / 2;
      if (clear > 1) {
        const L = Math.min(9, clear * 0.45), sx = SHADOW[0] * L, sy = SHADOW[1] * L;
        ctx.beginPath();
        ctx.moveTo(A[0][0] + sx, A[0][1] + sy); ctx.lineTo(B[0][0] + sx, B[0][1] + sy); ctx.lineTo(B[1][0] + sx, B[1][1] + sy); ctx.lineTo(A[1][0] + sx, A[1][1] + sy);
        ctx.closePath(); ctx.fill();
      }
    }
  }
  ctx.restore();
  const tg = new THREE.BufferGeometry();
  tg.setAttribute("position", new THREE.Float32BufferAttribute(top, 3));
  tg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  tg.setAttribute("normal", new THREE.Float32BufferAttribute(top.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.Float32BufferAttribute(side, 3));
  sg.setAttribute("normal", new THREE.Float32BufferAttribute(sideN, 3));
  decks.add(new THREE.Mesh(tg, deckMaterial), new THREE.Mesh(sg, fasciaMaterial));
}

/** Drop shadows of hand-built bridge decks (mesh entries flagged 2, bridgemodels.ts), like buildDecks' shadows. */
function deckShadows(ctx: CanvasRenderingContext2D, data?: TileObjects) {
  ctx.save();
  ctx.fillStyle = "rgba(40,40,48,0.28)";
  ctx.beginPath();
  for (const m of data?.m ?? []) {
    if (m[9] !== 2) continue;
    const roof = m[2];
    for (let i = 0; i + 8 < roof.length; i += 9) {
      const cx = (roof[i] + roof[i + 3] + roof[i + 6]) / 3, cy = (roof[i + 1] + roof[i + 4] + roof[i + 7]) / 3;
      const clear = (roof[i + 2] + roof[i + 5] + roof[i + 8]) / 3 - ground(cx, cy);
      if (clear <= 1) continue;
      const L = Math.min(9, clear * 0.45), sx = SHADOW[0] * L, sy = SHADOW[1] * L;
      ctx.moveTo(roof[i] + sx, roof[i + 1] + sy); ctx.lineTo(roof[i + 3] + sx, roof[i + 4] + sy); ctx.lineTo(roof[i + 6] + sx, roof[i + 7] + sy); ctx.closePath();
    }
  }
  ctx.fill("nonzero");
  ctx.restore();
}

/** Ellipsoid height (cm + 10000, 16 bit in RG) of whatever surface is visible. */
const heightMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vEnu;
    void main() {
      #ifdef USE_INSTANCING
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
      #else
        vec4 w = modelMatrix * vec4(position, 1.0);
      #endif
      vEnu = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  depthTest: true,
  depthWrite: true,
  side: THREE.DoubleSide,
  fragmentShader: /* glsl */ `
    uniform float base;
    varying vec3 vEnu;
    void main() {
      float h = vEnu.z + dot(vEnu.xy, vEnu.xy) / (2.0 * 6371000.0);
      float v = clamp(floor((h - base + 100.0) * 100.0 + 0.5), 0.0, 65535.0);
      gl_FragColor = vec4(floor(v / 256.0) / 255.0, mod(v, 256.0) / 255.0, 0.0, 1.0);
    }`,
  uniforms: { base: { value: HEIGHT_BASE } },
});
const heightTarget = new THREE.WebGLRenderTarget(HEIGHT_SIZE, HEIGHT_SIZE, {
  colorSpace: THREE.NoColorSpace, depthBuffer: true,
  depthTexture: new THREE.DepthTexture(HEIGHT_SIZE, HEIGHT_SIZE, THREE.UnsignedIntType),
});
heightTarget.texture.generateMipmaps = false;

// ---------------------------------------------------------------------------------------------
// Open-data 3D objects.

type P2 = [number, number];
export interface TileObjects {
  b: Array<[P2[], number, number, number | null]>; // ring, height, style, ground hint (ellipsoid)
  t: Array<[number, number, number, number, number?]>; // x, y, radius, crown height, species (Zagreb: species.ts)
  /** LoD2 meshes: style, roof kind, roof xyz[], wall (xyz, along, above base)[], footprint, height, seed */
  m?: Array<[number, number, number[], number[], P2[], number, number, (number[] | null)?, (number[] | null)?, number?]>; // … osm roof, osm wall, bare (no roof furniture)
}

/** wall, roof colours per style (see scene.ts): bauhaus, residential, public, tower, shed, modern */
const PALETTE: Array<[number[], number[]]> = [
  [[0.97, 0.96, 0.93], [0.88, 0.87, 0.84]],
  [[0.94, 0.88, 0.76], [0.84, 0.82, 0.78]],
  [[0.88, 0.82, 0.69], [0.76, 0.74, 0.70]],
  [[0.66, 0.75, 0.82], [0.70, 0.72, 0.74]],
  [[0.78, 0.76, 0.72], [0.60, 0.60, 0.60]],
  [[0.86, 0.87, 0.88], [0.80, 0.80, 0.80]],
];

/** AI texture sheet (style/textures) on clay-tile roofs; opt-in (render --tex) while we decide on it. Facades
 *  stay procedural: a tiling sheet gives every building the same window rhythm (its lessons are in the shader). */
const TEX = STYLED && params.get("tex") === "1";
async function sheet(file: string) {
  const t = await new THREE.TextureLoader().loadAsync(`/textures/${file}`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const NO_TEX = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
NO_TEX.needsUpdate = true;
const roofTex = TEX ? await sheet("roof-tile.png") : NO_TEX;

const buildingMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    attribute vec3 color;
    attribute vec2 facade;   // (meters along wall, meters above ground); y = -1000: roof / rooftop object
    attribute float kind;    // style index
    varying vec3 vColor; varying vec3 vNormal; varying vec2 vFacade; varying float vKind; varying vec3 vPos;
    void main() {
      vColor = color; vNormal = normal; vFacade = facade; vKind = kind; vPos = position;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sun;
    uniform sampler2D roofTex; uniform float useTex;
    varying vec3 vColor; varying vec3 vNormal; varying vec2 vFacade; varying float vKind; varying vec3 vPos;
    // the roof sheet's mean colour (dividing by it tints the sheet to each roof's colour); one repeat per
    // ROOF_M metres, ~3× real tile size so the rows stay readable
    const vec3 ROOF_MEAN = vec3(0.796, 0.325, 0.208);
    const float ROOF_M = 8.0;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    const vec3 GLASS = vec3(0.30, 0.40, 0.50);
    #ifdef ZG
    const bool ZGS = true;
    #else
    const bool ZGS = false;
    #endif
    #ifdef ZG
    /** St Mark's roof (style 7): x -10…10 along the eave (west to east), y 0 at the eave … 10 at the ridge; x > 500 = no arms */
    vec3 markRoof(float x, float y) {
      vec3 RED = vec3(0.74, 0.20, 0.16), WHITE = vec3(0.95, 0.94, 0.90), BLUE = vec3(0.17, 0.27, 0.58), GOLD = vec3(0.92, 0.72, 0.22), BROWN = vec3(0.36, 0.22, 0.14);
      bool arms = x < 500.0;
      x = arms ? x : x - 1000.0;
      // eave: dark band, then zigzag chevrons in white, red, blue, gold
      if (y < 0.45) return BROWN;
      float zz = abs(fract(x / 1.3) - 0.5) * 2.0;
      if (y < 1.9) {
        int b = int(mod(floor((y - 0.45 + zz * 0.55) / 0.3), 4.0));
        return b == 0 ? WHITE : b == 1 ? RED : b == 2 ? BLUE : GOLD;
      }
      if (arms && y > 9.6) return BROWN; // ridge (the other planes are in metres from the eave)
      if (arms) {
        // left: Kingdom of Croatia-Slavonia-Dalmatia; right: City of Zagreb; shields 4.4 × 5.6 with a round foot
        for (int s = 0; s < 2; s++) {
          float cx = s == 0 ? -3.6 : 2.6, dx = x - cx, w = 2.2, top = 8.8, bot = 3.0;
          float foot = bot + w - sqrt(max(0.0, w * w - dx * dx));
          if (abs(dx) > w + 0.18 || y > top + 0.18 || y < foot - 0.18) continue;
          if (abs(dx) > w || y > top || y < foot) return GOLD; // rim
          float u = (dx + w) / (2.0 * w), v = (y - bot) / (top - bot);
          if (s == 0) {
            if (v > 0.5) {
              if (u < 0.5) return mod(floor(u * 10.0) + floor(v * 10.0), 2.0) < 1.0 ? RED : WHITE;   // Croatia: chequy
              vec2 q = vec2(fract(u * 2.0), v * 2.0 - 1.0);                                           // Dalmatia: three crowned leopard heads
              float d = min(length(q - vec2(0.25, 0.68)), min(length(q - vec2(0.5, 0.68)), length(q - vec2(0.75, 0.68))));
              return d < 0.12 ? GOLD : BLUE;
            }
            // Slavonia: blue, two white rivers with the red band (and its marten) between
            float vv = v * 2.0;
            return vv > 0.62 && vv < 0.74 ? WHITE : vv > 0.32 && vv < 0.62 ? RED : vv > 0.2 && vv < 0.32 ? WHITE : BLUE;
          }
          // Zagreb: white castle with three towers and an open gate on red, on a green hill
          float ax = abs(dx);
          if (v < 0.18) return vec3(0.25, 0.48, 0.25);
          bool wall = v < 0.52 && ax < 1.55, tower = (ax < 0.38 || (ax > 1.0 && ax < 1.55)) && v < 0.7;
          bool merlon = (wall && v > 0.47 || tower && v > 0.65) && fract(dx / 0.32) < 0.5;
          if ((wall || tower) && !merlon) return ax < 0.32 && v < 0.36 ? BROWN : WHITE;
          return RED;
        }
      }
      // field: lozenges in rows of red, white and blue (the rows zigzag across the slope)
      float s = 0.55, U = floor((x + y) / s), V = floor((x - y) / s);
      float row = mod(U - V, 6.0);
      return row < 2.0 ? RED : row < 3.0 ? WHITE : row < 5.0 ? BLUE : WHITE;
    }
    #endif
    void main() {
      vec3 n = normalize(vNormal);
      float light = min(1.08, 0.80 + 0.32 * max(dot(n, sun), 0.0));
      vec3 c = vColor;
      if (vKind > 9.5) {
        // Stuttgart (LoD2): punched windows in plaster, sandstone, glass; roofs untextured
        light = 0.70 + 0.42 * max(dot(n, sun), 0.0) + 0.06 * n.z;
        if (vFacade.y < -100.0 && vFacade.x < 0.5) {
          if (n.z < 0.97 && useTex > 0.5 && vColor.r > 1.6 * vColor.b) {
            // clay tiles: rows along the eaves, the sheet's top up the slope
            vec2 dn = normalize(n.xy), al = vec2(-dn.y, dn.x);
            vec2 uv = vec2(dot(vPos.xy, al), -dot(vPos.xy, dn) / max(n.z, 0.3)) / ROOF_M;
            c = texture2D(roofTex, uv).rgb * vColor / ROOF_MEAN;
          }
          else if (n.z < 0.97) { if (fract(vPos.z / 0.42) < 0.16) c *= 0.93; }   // tile courses
          else if (abs(floor(vKind + 0.001) - 22.0) > 0.5) c *= 0.95 + 0.07 * hash(floor(vPos.xy * 2.0)); // gravel (car park decks: flat concrete)
          #ifdef ZG
          // old tile weathers in patches (moss, soot, newer tiles): mottle pitched roofs, soften flat ones
          if (n.z < 0.97) c *= 0.9 + 0.15 * vnoise(vPos.xy * 0.45) + 0.06 * (hash(floor(vPos.xy * 3.0)) - 0.5);
          else c *= 0.95 + 0.08 * vnoise(vPos.xy * 0.3);
          #endif
        }
        if (vFacade.y > -100.0) {
          // kind = 10 + style + 0.05 + 0.9 * v: v is the building's own variation (addMeshes), every
          // facade parameter below derives from it, so no two streets look alike
          float kf = floor(vKind + 0.001);
          int k = int(kf + 0.5) - 10;
          float v = clamp((vKind - kf - 0.05) / 0.9, 0.0, 1.0);
          float r1 = hash(vec2(v * 97.0, 1.3)), r2 = hash(vec2(v * 61.0, 4.7)), r3 = hash(vec2(v * 43.0, 8.9));
          float r4 = hash(vec2(v * 29.0, 2.1)), r5 = hash(vec2(v * 83.0, 6.5)), r6 = hash(vec2(v * 17.0, 9.3));
          float y = vFacade.y, x = vFacade.x;
          vec3 WIN = vec3(0.24, 0.30, 0.37);
          vec3 FRAME = r5 < 0.7 ? vec3(0.95, 0.95, 0.93) : (r5 < 0.85 ? vec3(0.32, 0.32, 0.34) : vec3(0.52, 0.40, 0.29));
          if (k <= 2) {
            // punched windows: floor height, bay, window size and grouping, ground floor, frames, shutters
            // Zagreb's 19th-century blocks: tall storeys, window heads, shops in most ground floors
            float FH = k == 2 ? 3.8 + 0.9 * r1 : (k == 0 ? (ZGS ? 3.5 + 0.7 * r1 : 3.0 + 0.5 * r1) : 2.75 + 0.35 * r1);
            bool shop = k != 2 && r6 < (ZGS && k == 0 ? 0.45 : 0.22);
            float GF = shop ? 4.2 : (k == 2 || r6 < 0.5 ? FH * 1.2 : FH);
            float BAY = k == 2 ? 3.1 + 1.2 * r2 : 2.2 + 1.7 * r2;
            float hw = min(k == 2 ? 0.6 + 0.25 * r3 : 0.55 + 0.25 * r3, BAY * 0.5 - 0.35); // big windows read at map scale
            bool pairs = k != 2 && r4 > 0.72 && BAY > 2.8;
            // older-looking buildings: tall windows in a stone surround under a head cap (as in the AI facade sheet)
            bool orn = k == 2 || (k == 0 && r3 > 0.4);
            float fi = y < GF ? 0.0 : 1.0 + floor((y - GF) / FH);
            float fy = y < GF ? y : mod(y - GF, FH), fh = y < GF ? GF : FH;
            float wh = fh * (k == 2 || orn ? 0.56 + 0.1 * r4 : 0.5 + 0.12 * r4), s0 = min(fh * 0.3, fh - wh - (orn ? 0.45 : 0.3));
            float bay = floor(x / BAY), cx = mod(x, BAY) - BAY * 0.5;
            if (pairs) { cx = abs(cx) - (hw * 0.5 + 0.12); }
            float rw = hash(vec2(bay, fi) + v * 31.0);
            bool plinth = y < 0.3 + 0.5 * r1;
            if (shop && fi < 0.5) {
              // shop front: glass between pilasters, a fascia band above
              if (fy > 0.35 && fy < GF - 0.9 && abs(mod(x, 2.0 * BAY) - BAY) < BAY - 0.3) c = mix(WIN, vec3(0.62, 0.70, 0.76), 0.25 + 0.3 * rw);
              else if (fy > GF - 0.75 && fy < GF - 0.35) c *= 0.82;
            } else if (abs(cx) < hw && fy > s0 && fy < s0 + wh) {
              float t = (fy - s0) / wh;
              vec3 g = WIN * (0.94 + 0.12 * rw);                                   // flat slate glass, a touch of variation
              if (rw < 0.06) g = mix(vec3(0.50, 0.60, 0.70), WIN, t * 0.7);          // the odd window catching the sky
              else if (rw < 0.13 && t > 0.62) g = vec3(0.70, 0.69, 0.65);            // a lowered blind
              c = g;
              float e = min(hw - abs(cx), min(fy - s0, s0 + wh - fy));
              if (e < 0.08) c = FRAME;                                             // frame
              else if (k != 1 && hw > 0.35 && abs(cx) < 0.045) c = FRAME;          // mullion: two casements
              else if (r4 > 0.5 && k != 1 && abs(t - 0.75) * wh < 0.04) c = FRAME; // transom
            } else if (orn && abs(cx) < hw + 0.32 && fy >= s0 + wh + 0.12 && fy < s0 + wh + 0.36) {
              c *= fy < s0 + wh + 0.17 ? 0.72 : 1.08;                              // head cap, shadow line under it
            } else if (orn && abs(cx) < hw + 0.15 && fy > s0 - 0.02 && fy < s0 + wh + 0.12) {
              c *= abs(cx) > hw + 0.11 ? 0.8 : 1.06;                               // stone surround, outlined
            } else if (abs(cx) < hw + (orn ? 0.25 : 0.1) && fy > s0 - 0.16 && fy <= s0) {
              c = orn ? c * 1.08 : FRAME * 0.97;                                   // sill
            } else if (orn && abs(cx) < hw + 0.25 && fy > s0 - 0.3 && fy <= s0 - 0.16) {
              c *= 0.84;                                                           // the sill's shadow
            } else if (ZGS && k == 0 && r3 > 0.3 && !orn && abs(cx) < hw + 0.18 && fy >= s0 + wh && fy < s0 + wh + 0.3) {
              c *= 0.86;                                                           // window head (Zagreb)
            } else if (k == 0 && r5 > 0.8 && abs(cx) >= hw && abs(cx) < hw * 1.85 && fy > s0 && fy < s0 + wh && BAY > hw * 4.0 + 0.4) {
              c = r1 < 0.4 ? vec3(0.33, 0.45, 0.36) : (r1 < 0.7 ? vec3(0.45, 0.50, 0.55) : vec3(0.50, 0.38, 0.28)); // shutters
              if (fract(fy / 0.22) < 0.25) c *= 0.85;
            } else if (fi > 0.5 && fy < 0.45) {
              c *= fy < 0.16 ? 0.58 + 0.12 * r2 : 1.07;                            // cornice between storeys: shadow line + lit band (≥1 px each)
            }
            if (plinth) c *= 0.8;
          } else if (k == 3) {       // towers: curtain wall, tint per building
            vec3 tint = r1 < 0.3 ? vec3(0.42, 0.55, 0.68) : (r1 < 0.55 ? vec3(0.40, 0.56, 0.55) : (r1 < 0.8 ? vec3(0.52, 0.55, 0.58) : vec3(0.55, 0.48, 0.40)));
            float FH = 3.4 + 0.5 * r2, M = 1.2 + 0.6 * r3;
            c = mix(c, tint, 0.75) * (0.92 + 0.12 * hash(vec2(floor(x / M), floor(y / FH)) + v));
            if (fract(y / FH) < 0.1 + 0.15 * r4 || fract(x / M) < 0.06) c = vec3(0.84, 0.86, 0.88);
          } else if (k == 4) {       // sheds, garages, halls: horizontal or vertical cladding
            if (r1 < 0.5 ? fract(y / 0.9) < 0.08 : fract(x / 0.6) < 0.12) c *= 0.93;
          }
          #ifdef ZG
          else if (k == 6) {         // post-war prefab slabs (Novi Zagreb, Trnje): storey bands, loggias, panel joints
            float FH = 2.8 + 0.12 * r1, PW = 3.0 + 1.6 * r2, fy = mod(y, FH), bx = floor(x / PW), cx = mod(x, PW);
            float run = 3.0 + floor(r4 * 3.0);                                   // a loggia every few bays
            bool loggia = r3 < 0.7 && mod(bx, run) < (r3 < 0.35 ? 2.0 : 1.0);
            vec3 accent = r5 < 0.5 ? c : (r5 < 0.65 ? vec3(0.86, 0.56, 0.40) : (r5 < 0.8 ? vec3(0.62, 0.70, 0.80) : vec3(0.90, 0.78, 0.48)));
            if (y < 2.8) c *= fract(x / 7.0) < 0.6 ? 0.62 : 0.86;                 // entrances and storage at the foot
            else if (loggia) {
              if (fy < 1.0) c = accent * (fract(x / 0.25) < 0.5 ? 0.96 : 1.0); // parapet
              else c = vec3(0.30, 0.31, 0.33) + 0.06 * hash(vec2(bx, floor(y / FH)) + v); // shaded recess
            } else if (fy > 0.95 && fy < 2.35 && abs(cx - PW * 0.5) < PW * 0.32) {
              float rw = hash(vec2(bx, floor(y / FH)) + v * 13.0);
              c = rw < 0.2 ? vec3(0.56, 0.64, 0.72) : rw < 0.35 ? vec3(0.80, 0.78, 0.72) : WIN;
              if (abs(cx - PW * 0.5) < 0.05) c = vec3(0.9);
            }
            if (fy < 0.06 || cx < 0.05) c *= 0.84;                              // panel joints
          } else if (k == 7) {       // St Mark's tiled roof
            c = markRoof(x, y);
            light = 0.86 + 0.24 * max(dot(n, sun), 0.0);
          } else if (k == 8 && abs(n.z) > 0.12) { // openwork spire: rows of small dark tracery openings
            vec2 g = vec2(x / 0.8, y / 1.5), f = fract(g) - 0.5;
            if (length(f * vec2(1.0, 0.7)) < 0.26 && mod(floor(g.y), 2.0) < 1.0) c *= 0.45;
            c *= 0.96 + 0.06 * vnoise(vec2(x, y) * 0.7);
          } else if (k == 8) {       // Gothic ashlar (the cathedral): courses, tall lancets per 12 m stage
            if (fract(y / 0.55) < 0.07) c *= 0.93;
            float BAY = 2.6, cx = abs(mod(x, BAY) - BAY * 0.5), fy = mod(y, 12.0), w = 0.42;
            float apex = 9.6 + (w - cx) * 1.6;                                   // pointed arch
            if (y > 2.0 && cx < w && fy > 3.4 && fy < apex) c = mix(vec3(0.22, 0.25, 0.30), c, fy > 9.6 ? 0.25 : 0.0);
            else if (fy > 11.2) c *= 0.88;                                       // string course
            c *= 0.96 + 0.06 * vnoise(vec2(x, y) * 0.7);                         // weathered stone
          } else if (k == 9) {       // dark glass curtain wall (Cibona): sky reflection, fine floor lines
            float FH = 3.5, fy = fract(y / FH);
            c = mix(vec3(0.10, 0.12, 0.16), vec3(0.34, 0.40, 0.48), 0.25 + 0.35 * vnoise(vec2(x * 0.08, y * 0.03)));
            if (fy < 0.06) c = vec3(0.30, 0.32, 0.35);
            else if (fract(x / 1.5) < 0.04) c *= 0.8;
            light = 0.8 + 0.3 * max(dot(n, sun), 0.0);
          } else if (k == 10) {      // vertical stone ribs and dark window slots (Zagrepčanka)
            float cx = fract(x / 1.6), fy = fract(y / 3.4);
            if (cx > 0.58 && cx < 0.94 && fy > 0.08) c = mix(vec3(0.20, 0.23, 0.27), vec3(0.42, 0.48, 0.55), 0.3 * vnoise(vec2(x * 0.1, y * 0.05)));
            else if (cx > 0.5 && cx <= 0.58) c *= 0.82;                          // rib shadow
          }
          #endif
          else if (k == 11) {      // masonry (tunnel portals, retaining walls): ashlar courses, staggered joints
            float row = floor(y / 0.55), bl = 0.9 + 0.6 * hash(vec2(row, 3.1)), sx = x / bl + 0.5 * mod(row, 2.0);
            c *= 0.9 + 0.16 * hash(vec2(floor(sx), row));
            if (fract(y / 0.55) < 0.14 || fract(sx) < 0.08) c *= 0.72;
          } else if (k == 12) {      // multi-storey car park: per level a concrete parapet band, then the dark open deck; columns
            float FH = 2.9, fy = fract(y / FH);
            bool column = abs(fract(x / 7.5) - 0.5) > 0.46;
            if (fy > 0.4 && !column && y > 0.5) c = vec3(0.30, 0.31, 0.34) * (fy > 0.88 ? 0.82 : 1.0);
            else if (fy < 0.05) c *= 0.88;                                        // slab edge
          }
          else {                   // offices: ribbon windows or a grid of square windows, shop fronts
            float FH = 3.4 + 0.5 * r1, M = 1.3 + 0.8 * r2, fy = fract(y / FH);
            vec3 g = mix(WIN, r5 < 0.5 ? vec3(0.36, 0.48, 0.58) : vec3(0.40, 0.50, 0.46), 0.5) * (0.9 + 0.2 * hash(vec2(floor(x / M), floor(y / FH)) + v));
            float lo = 0.25 + 0.1 * r3, hi = 0.82 + 0.08 * r4;
            if (r3 < 0.35) { if (fy > lo && fy < hi && abs(fract(x / M) - 0.5) < 0.32) c = g; }
            else if (fy > lo && fy < hi) c = fract(x / M) < 0.06 ? c * 0.85 : g;
            if (y < 4.0 && y > 0.3 && r6 < 0.6 && fract(x / 6.0) > 0.08) c = WIN * 0.9; // shop fronts
          }
        }
        gl_FragColor = vec4(c * light, 1.0);
        return;
      }
      if (vFacade.y > -100.0) {
        int k = int(vKind + 0.5);
        float fl = fract(vFacade.y / 3.2), x = vFacade.x;
        bool ground = vFacade.y < 3.2;
        if (k == 0) {            // Bauhaus: continuous ribbon windows, white balcony parapets
          bool ribbon = fl > 0.45 && fl < 0.78 && fract(x / 7.0) > 0.08;
          if (ribbon) c = mix(c, GLASS, 0.75);
          else if (fl < 0.12) c *= 0.93;
        } else if (k == 1) {     // 60s-80s residential: windows + recessed balcony band
          float col = fract(x / 3.0);
          if (fl > 0.30 && fl < 0.80 && col > 0.20 && col < 0.80) c = mix(c, GLASS, 0.70);
          if (fl < 0.22) c *= 0.86;
        } else if (k == 3) {     // tower: glass curtain wall, spandrel lines
          c = mix(c, GLASS * 1.1, 0.55);
          if (fl < 0.10 || fract(x / 1.6) < 0.06) c = vec3(0.80, 0.83, 0.86);
        } else if (k == 5) {     // modern: large windows, glass balconies
          float col = fract(x / 4.0);
          if (fl > 0.18 && fl < 0.88 && col > 0.08 && col < 0.92) c = mix(c, GLASS, 0.65);
        } else if (k == 2) {     // public: tall sparse windows
          float col = fract(x / 4.5);
          if (fl > 0.25 && fl < 0.85 && col > 0.35 && col < 0.65) c = mix(c, GLASS, 0.6);
        }
        if (ground && k != 3 && k != 4) c *= 0.84;  // shops / pilotis shade
      }
      gl_FragColor = vec4(c * light, 1.0);
    }`,
  uniforms: { sun: { value: SUN }, roofTex: { value: roofTex }, useTex: { value: TEX ? 1 : 0 } },
  defines: ZG ? { ZG: 1 } : {},
});

/**
 * Tree species of Tel Aviv streets and parks, as placeholder colours and shapes the paint step turns
 * into real trees (style/trees.png). Weights are rough shares; palms only replace small crowns.
 * [name, weight, crown colour, crown scale xy, crown scale z, palm?]
 */
const SPECIES: Array<[string, number, number[], number, number, boolean]> = [
  ["ficus", 22, [0.16, 0.36, 0.14], 1, 0.85, false],
  ["tipuana", 13, [0.42, 0.62, 0.22], 1.05, 0.7, false],
  ["jacaranda", 9, [0.62, 0.5, 0.85], 1, 0.7, false],
  ["poinciana", 7, [0.88, 0.32, 0.16], 1.15, 0.45, false],
  ["olive", 10, [0.6, 0.66, 0.55], 0.8, 0.75, false],
  ["pine", 8, [0.12, 0.3, 0.26], 0.95, 1.1, false],
  ["eucalyptus", 6, [0.38, 0.52, 0.46], 0.85, 1.25, false],
  ["date palm", 14, [0.55, 0.62, 0.2], 0, 0, true],
  ["fan palm", 11, [0.32, 0.5, 0.2], 0, 0, true],
];
/**
 * Stuttgart: street and park trees (plane, lime, maple, chestnut…) and the forests of the Kessel slopes
 * (beech, oak, spruce). [name, weight, colour, xy, z, conifer?] (the last flag means a cone, not a palm)
 */
const SPECIES_STR: typeof SPECIES = [
  ["plane", 18, [0.42, 0.60, 0.22], 1.05, 0.85, false],
  ["lime", 18, [0.36, 0.58, 0.18], 1, 0.9, false],
  ["maple", 14, [0.46, 0.64, 0.20], 1, 0.85, false],
  ["chestnut", 9, [0.24, 0.46, 0.14], 1, 0.9, false],
  ["oak", 10, [0.30, 0.48, 0.16], 1.05, 0.8, false],
  ["beech", 10, [0.28, 0.50, 0.18], 1, 0.9, false],
  ["birch", 6, [0.56, 0.68, 0.28], 0.75, 1.15, false],
  ["cherry", 4, [0.90, 0.66, 0.72], 0.95, 0.75, false],
  ["spruce", 11, [0.13, 0.33, 0.24], 0, 0, true],
];
if (STYLED) SPECIES.splice(0, SPECIES.length, ...SPECIES_STR);
/** Zagreb: scene.ts names every crown's species (wood, park, street, riverbank… see greenery.ts). */
const NAMED: typeof SPECIES | null = REGIONS[REGION].sources === "zg3d" ? ZG_SPECIES.map(([n, c, xy, z, cone]) => [n, 1, c, xy, z, cone]) : null;
const SPECIES_TOTAL = SPECIES.reduce((t, s) => t + s[1], 0);
const rand = (x: number, y: number) => Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
/** Mostly one species per ~40 m patch (streets are planted in runs), every 4th tree a random one. */
function species(x: number, y: number, r: number, named?: number) {
  if (NAMED && named !== undefined && NAMED[named]) return NAMED[named];
  const own = rand(x, y) < 0.25;
  let h = (own ? rand(y, x) : rand(Math.floor(x / 40), Math.floor(y / 40))) * SPECIES_TOTAL;
  for (const s of SPECIES) if ((h -= s[1]) < 0) return s[5] && r > (STYLED ? 6 : 4.5) ? SPECIES[0] : s; // no palm for a big canopy
  return SPECIES[0];
}

const treeMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vNormal; varying float vShade; varying vec3 vColor;
    void main() {
      vNormal = normalize(mat3(instanceMatrix) * normal);
      vShade = fract(sin(dot(instanceMatrix[3].xy, vec2(12.9898, 78.233))) * 43758.5453);
      vColor = instanceColor;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sun; uniform bool styled;
    varying vec3 vNormal; varying float vShade; varying vec3 vColor;
    void main() {
      vec3 n = normalize(vNormal);
      float light = 0.55 + 0.45 * max(dot(n, sun), 0.0);
      vec3 c = vColor * (0.9 + 0.2 * vShade);
      if (styled) { light = 0.50 + 0.62 * max(dot(n, sun), 0.0) + 0.08 * n.z; c *= 1.0 + 0.12 * (vShade - 0.5); }
      gl_FragColor = vec4(c * light, 1.0);
    }`,
  uniforms: { sun: { value: SUN }, styled: { value: STYLED } },
});

/** Lumpy crown: an icosphere pushed in and out per vertex, so crowns read as foliage, not balls. */
function crownGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 2), p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.9 + 0.2 * (Math.abs(Math.sin(x * 9.1 + y * 5.3 + z * 7.7) * 43758.5453) % 1);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  return mergeByPosition(g);
}
/** Recompute smooth normals after the push (icosphere vertices are duplicated per face). */
function mergeByPosition(g: THREE.BufferGeometry) {
  g.deleteAttribute("uv");
  const m = (g.index ? g : g.toNonIndexed());
  m.computeVertexNormals();
  return m;
}

const objects = new THREE.Group();
scene.add(objects);
function pointInRing(x: number, y: number, ring: P2[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const mulberry = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const CROWN = STYLED ? crownGeometry() : null!;
/** a unit cone (base at z = 0, tip at z = 1) as a matrix applied to the crown sphere: squash the sphere into a spindle */
const CONE = new THREE.Matrix4().makeScale(1, 1, 0.5).setPosition(0, 0, 0.45);

/** Stuttgart wall colours: cream, ochre, pale pink, white, light grey, pale yellow (plaster), sandstone, glass, grey, office. */
const WALLS_STR = [[0.95, 0.91, 0.81], [0.94, 0.85, 0.67], [0.94, 0.84, 0.78], [0.96, 0.95, 0.92], [0.87, 0.87, 0.85], [0.96, 0.91, 0.72]];
const WALL_BY_STYLE: Record<number, number[][]> = {
  2: [[0.88, 0.79, 0.62], [0.84, 0.76, 0.62], [0.92, 0.88, 0.80]],
  3: [[0.80, 0.84, 0.88]],
  4: [[0.80, 0.79, 0.76], [0.74, 0.74, 0.72], [0.84, 0.82, 0.76]],
  12: [[0.82, 0.81, 0.78], [0.78, 0.78, 0.76]], // car park concrete
  5: [[0.90, 0.90, 0.89], [0.84, 0.85, 0.86], [0.93, 0.91, 0.86]],
};
/** roof kinds (scene.ts lod2Style): red tile, brown tile, slate, gravel, copper, dark membrane, green roof, parking deck */
const ROOFS_STR = [[0.76, 0.36, 0.25], [0.62, 0.36, 0.26], [0.50, 0.51, 0.55], [0.86, 0.84, 0.79], [0.45, 0.70, 0.60], [0.74, 0.74, 0.74], [0.56, 0.68, 0.40], [0.62, 0.63, 0.65]];
/**
 * Zagreb (Commons photos in ATTRIBUTION.md): Donji and Gornji grad are plastered in "Maria Theresa" ochre and
 * yellow, cream, salmon and pale pink, some pastel green and grey-white; roofs are weathered red-brown tile,
 * with dark sheet metal on many larger blocks and grey-green copper on public buildings.
 */
const WALLS_ZG = [
  [0.95, 0.82, 0.52], [0.92, 0.75, 0.46], [0.96, 0.87, 0.58], [0.96, 0.89, 0.72], [0.94, 0.72, 0.58], [0.93, 0.79, 0.72],
  [0.78, 0.85, 0.71], [0.95, 0.84, 0.52], [0.89, 0.88, 0.85], [0.95, 0.93, 0.86], [0.89, 0.79, 0.64], [0.93, 0.80, 0.56],
];
const WALL_BY_STYLE_ZG: Record<number, number[][]> = {
  1: [[0.95, 0.90, 0.78], [0.95, 0.87, 0.66], [0.93, 0.80, 0.70], [0.95, 0.94, 0.90], [0.88, 0.87, 0.84], [0.92, 0.82, 0.62], [0.86, 0.88, 0.80]], // later plaster
  2: [[0.94, 0.83, 0.56], [0.92, 0.87, 0.76], [0.86, 0.83, 0.76], [0.95, 0.91, 0.82]], // public: ochre, cream, stone
  3: [[0.80, 0.84, 0.88]],
  4: [[0.80, 0.79, 0.76], [0.74, 0.74, 0.72], [0.84, 0.82, 0.76]],
  5: [[0.90, 0.90, 0.89], [0.84, 0.85, 0.86], [0.93, 0.91, 0.86]],
  6: [[0.82, 0.81, 0.77], [0.87, 0.86, 0.82], [0.78, 0.78, 0.76], [0.86, 0.82, 0.74], [0.90, 0.89, 0.86]], // prefab concrete
  7: [[0.9, 0.9, 0.9]],
  8: [[0.90, 0.87, 0.80]], // cathedral limestone
  9: [[0.2, 0.24, 0.3]],
  10: [[0.9, 0.89, 0.85]],
};
/** red tile, brown tile, dark sheet metal, grey bitumen, copper, light membrane, green roof */
const ROOFS_ZG = [[0.69, 0.38, 0.27], [0.56, 0.34, 0.26], [0.43, 0.44, 0.46], [0.74, 0.72, 0.68], [0.44, 0.62, 0.54], [0.78, 0.78, 0.76], [0.56, 0.66, 0.42]];
const ROOFS = ZG ? ROOFS_ZG : ROOFS_STR;

type Plane = { n: number[]; d: number; tris: number[][]; area: number };
type Out = { pos: number[]; nor: number[]; col: number[]; fac: number[]; kin: number[] };

/** coloured quad (counter-clockwise from outside), no facade pattern */
function quad3(o: Out, q: number[][], c: number[]) {
  const ux = q[1][0] - q[0][0], uy = q[1][1] - q[0][1], uz = q[1][2] - q[0][2];
  const vx = q[2][0] - q[0][0], vy = q[2][1] - q[0][1], vz = q[2][2] - q[0][2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  for (const k of [0, 1, 2, 0, 2, 3]) { o.pos.push(...q[k]); o.nor.push(nx, ny, nz); o.col.push(...c); o.fac.push(0, -1000); o.kin.push(0); }
}

/** box turned by t (u = (cos t, sin t)): centre (x, y), base z, su × sv, height h on the -v side and hb on the +v side */
function prism(o: Out, x: number, y: number, z: number, su: number, sv: number, h: number, hb: number, t: number, c: number[]) {
  const cu = Math.cos(t), sn = Math.sin(t);
  const P = (i: number, j: number, top: boolean) => {
    const U = (i * su) / 2, V = (j * sv) / 2;
    return [x + U * cu - V * sn, y + U * sn + V * cu, z + (top ? (j < 0 ? h : hb) : 0)];
  };
  const t00 = P(-1, -1, true), t10 = P(1, -1, true), t11 = P(1, 1, true), t01 = P(-1, 1, true);
  const b00 = P(-1, -1, false), b10 = P(1, -1, false), b11 = P(1, 1, false), b01 = P(-1, 1, false);
  quad3(o, [t00, t10, t11, t01], c);
  const side = c.map((q) => q * 0.92);
  quad3(o, [b00, b10, t10, t00], side); quad3(o, [b10, b11, t11, t10], side);
  quad3(o, [b11, b01, t01, t11], side); quad3(o, [b01, b00, t00, t01], side);
}

const inTri = (x: number, y: number, t: number[]) => {
  const d1 = (x - t[2]) * (t[1] - t[3]) - (t[0] - t[2]) * (y - t[3]);
  const d2 = (x - t[4]) * (t[3] - t[5]) - (t[2] - t[4]) * (y - t[5]);
  const d3 = (x - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (y - t[1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

/**
 * Roof furniture laid out like the real thing, not scattered: everything is aligned to the building's main axis
 * (longest footprint edge). Flat roofs get a parapet along their outer edge, a plant room near the middle, AC units
 * in a cluster, and (on some buildings) PV in rows tilted south across what is left; halls get skylight strips.
 * Pitched roofs get flush PV on the plane that faces south most. Deterministic per building (rnd).
 */
function roofFurniture(o: Out, planes: Plane[], footprint: P2[], walls: number[], style: number, green: boolean, wall: number[], rnd: () => number) {
  let axis = 0, best = 0;
  for (let i = 0; i < footprint.length; i++) {
    const [ax, ay] = footprint[i], [bx, by] = footprint[(i + 1) % footprint.length], L = Math.hypot(bx - ax, by - ay);
    if (L > best) { best = L; axis = Math.atan2(by - ay, bx - ax); }
  }
  const solar = rnd() < (style === 4 ? 0.4 : ZG ? 0.06 : 0.22), parapetH = 0.45 + 0.6 * rnd(), hall = style === 4;
  const total = planes.reduce((t, q) => t + q.area, 0), flatShare = planes.filter((q) => q.n[2] > 0.97).reduce((t, q) => t + q.area, 0) / total;
  const taken = new Set<string>();
  const cell = (x: number, y: number) => `${Math.floor(x * 2)},${Math.floor(y * 2)}`;
  /** sample points of a turned rectangle (0.5 m steps), grown by m */
  const samples = (x: number, y: number, su: number, sv: number, t: number, m: number) => {
    const out: P2[] = [], cu = Math.cos(t), sn = Math.sin(t), U = su / 2 + m, V = sv / 2 + m;
    for (let i = -U; i <= U + 1e-6; i += Math.min(0.5, U)) for (let j = -V; j <= V + 1e-6; j += Math.min(0.5, V))
      out.push([x + i * cu - j * sn, y + i * sn + j * cu]);
    return out;
  };
  const onPlane = (pl: Plane, p: P2) => pl.tris.some((t) => inTri(p[0], p[1], t));
  const zAt = (pl: Plane, x: number, y: number) => (pl.d - pl.n[0] * x - pl.n[1] * y) / pl.n[2];
  /** place a turned item if it fits on the plane (with margin m) and on free roof */
  const fits = (pl: Plane, x: number, y: number, su: number, sv: number, t: number, m: number) =>
    samples(x, y, su, sv, t, m).every((p) => onPlane(pl, p)) && samples(x, y, su, sv, t, 0).every((p) => !taken.has(cell(p[0], p[1])));
  const take = (x: number, y: number, su: number, sv: number, t: number) => { for (const p of samples(x, y, su, sv, t, 0.3)) taken.add(cell(p[0], p[1])); };
  /** grid of points over the plane in the frame turned by t, step s */
  const grid = (pl: Plane, t: number, s: number) => {
    const cu = Math.cos(t), sn = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const tr of pl.tris) for (let k = 0; k < 6; k += 2) {
      const u = tr[k] * cu + tr[k + 1] * sn, v = -tr[k] * sn + tr[k + 1] * cu;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    return { cu, sn, u0, u1, v0, v1, at: (u: number, v: number): P2 => [u * cu - v * sn, u * sn + v * cu], s };
  };
  /** rows of modules along u (step su), row pitch pv: each run of fitting modules becomes one item */
  const rows = (pl: Plane, t: number, su: number, sv: number, pv: number, m: number, emit: (x: number, y: number, len: number) => void, minRun = 1, maxRows = Infinity) => {
    const g = grid(pl, t, su);
    let rowsDone = 0;
    for (let v = g.v0 + m + sv / 2; v <= g.v1 - m - sv / 2 && rowsDone < maxRows; v += pv) {
      const before = taken.size;
      let run: number[] = [];
      const flush = () => {
        if (run.length >= minRun) {
          const [x, y] = g.at((run[0] + run[run.length - 1]) / 2, v), len = run[run.length - 1] - run[0] + su;
          emit(x, y, len); take(x, y, len, sv, t);
        }
        run = [];
      };
      for (let u = g.u0 + su / 2; u <= g.u1; u += su) {
        const [x, y] = g.at(u, v);
        if (fits(pl, x, y, su, sv, t, m)) run.push(u); else flush();
      }
      flush();
      if (taken.size > before) rowsDone++;
    }
  };

  // parapet along the flat roof's edge: the top edges of the walls below it (a horizontal wall edge whose third
  // corner is lower), at the height of a flat plane that lies just inside it
  const flats = planes.filter((q) => q.n[2] > 0.97 && q.area > 25);
  if (flatShare > 0.6 && flats.length) {
    const cap = green ? [0.7, 0.7, 0.68] : wall.map((q) => q * 0.97), th = 0.3;
    for (let i = 0; i + 14 < walls.length; i += 15) {
      for (let e = 0; e < 3; e++) {
        const p = i + e * 5, q = i + ((e + 1) % 3) * 5, r = i + ((e + 2) % 3) * 5;
        const ax = walls[p], ay = walls[p + 1], az = walls[p + 2], bx = walls[q], by = walls[q + 1], bz = walls[q + 2];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 0.3 || Math.abs(az - bz) > 0.05 || walls[r + 2] > az - 0.5) continue;
        const ex = (bx - ax) / L, ey = (by - ay) / L, mx = (ax + bx) / 2, my = (ay + by) / 2;
        for (const sg of [1, -1]) {
          const nx = -ey * sg, ny = ex * sg;
          const pl = flats.find((f) => Math.abs(zAt(f, mx, my) - az) < 0.3 && onPlane(f, [mx + nx * 0.6, my + ny * 0.6]));
          if (!pl) continue;
          prism(o, mx + (nx * th) / 2, my + (ny * th) / 2, az, L + th, th, parapetH, parapetH, Math.atan2(ey, ex), cap);
          break;
        }
      }
    }
  }
  for (const pl of planes) {
    if (pl.n[2] > 0.97) {
      const z = (x: number, y: number) => zAt(pl, x, y); // near level, but coordinates are km from the origin
      if (green || pl.area < 40 || flatShare < 0.6) continue;
      const g = grid(pl, axis, 1);
      const pts: P2[] = [];
      for (let u = g.u0; u <= g.u1; u += 1) for (let v = g.v0; v <= g.v1; v += 1) pts.push(g.at(u, v));
      let cx = 0, cy = 0;
      for (const t of pl.tris) { cx += t[0] + t[2] + t[4]; cy += t[1] + t[3] + t[5]; }
      cx /= pl.tris.length * 3; cy /= pl.tris.length * 3;
      // plant room / stair housing near the middle, clad like the building
      if (pl.area > 250 && !hall && rnd() < 0.75) {
        const su = 3 + 4 * rnd(), sv = 3 + 2 * rnd(), h = 2.4 + 0.6 * rnd();
        const near = [...pts].sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
        const p = near.find((q) => fits(pl, q[0], q[1], su, sv, axis, 1.5));
        if (p) { prism(o, p[0], p[1], z(p[0], p[1]), su, sv, h, h, axis, wall.map((q) => q * 0.93)); take(p[0], p[1], su, sv, axis); }
      }
      // AC units: one cluster in a grid of up to 4 per row
      if (pl.area > 100) {
        const n = Math.max(1, Math.min(10, Math.round((pl.area / 220) * (0.5 + rnd())))), per = Math.min(4, n);
        const cu = Math.cos(axis), sn = Math.sin(axis);
        for (let tries = 0, done = 0; tries < 12 && !done; tries++) {
          const [ax, ay] = pts[Math.floor(rnd() * pts.length)];
          if (!fits(pl, ax, ay, 1.3, 0.9, axis, 1.2)) continue;
          for (let k = 0; k < n; k++) {
            const du = (k % per) * 1.9, dv = Math.floor(k / per) * 1.7;
            const x = ax + du * cu - dv * sn, y = ay + du * sn + dv * cu;
            if (!fits(pl, x, y, 1.3, 0.9, axis, 1.0)) continue;
            prism(o, x, y, z(x, y), 1.3, 0.9, 0.9, 0.9, axis, [0.8, 0.8, 0.79]); take(x, y, 1.3, 0.9, axis); done++;
          }
        }
      }
      // PV rows: along whichever building axis runs closer to east-west, tilted to face south
      if (solar && pl.area > 80) {
        let t = Math.abs(Math.cos(axis)) >= Math.abs(Math.sin(axis)) ? axis : axis + Math.PI / 2;
        if (Math.cos(t) < 0) t += Math.PI; // +v points north: the low edge (-v) is the south one
        rows(pl, t, 1.1, 1.7, 2.6, 1.0, (x, y, len) => prism(o, x, y, z(x, y) + 0.15, len, 1.7, 0.15, 0.85, t, [0.16, 0.21, 0.34]), 2, 3 + Math.floor(rnd() * 8)); // one array, not the whole roof
      } else if (hall && pl.area > 600) {
        // skylight strips along the hall
        rows(pl, axis, 2, 1.6, 7, 2.5, (x, y, len) => prism(o, x, y, z(x, y), len, 1.6, 0.5, 0.5, axis, [0.7, 0.78, 0.84]));
      }
    }
  }
  // pitched roofs: flush PV on the plane facing south most (normal pointing south)
  if (solar) {
    // most south-facing area wins (n.y < 0 faces south)
    const pl = planes.filter((q) => q.n[2] <= 0.97 && q.n[1] < -0.25 && q.area > 20)
      .reduce<Plane | undefined>((m, q) => (!m || q.n[1] * q.area < m.n[1] * m.area ? q : m), undefined);
    if (pl) {
      const h = Math.hypot(pl.n[0], pl.n[1]), t = Math.atan2(-pl.n[0] / h, pl.n[1] / h); // u along the eave
      rows(pl, t, 1.0, 1.7, 1.75, 0.6, (x, y, len) => {
        const cu = Math.cos(t), sn = Math.sin(t), U = len / 2, V = 0.85;
        const q = [[-U, -V], [U, -V], [U, V], [-U, V]].map(([i, j]) => {
          const px = x + i * cu - j * sn, py = y + i * sn + j * cu;
          return [px, py, zAt(pl, px, py) + 0.12];
        });
        quad3(o, q, [0.14, 0.18, 0.3]);
      }, 3);
    }
  }
}

/**
 * Top deck of a multi-storey car park (learned from an AI repaint of the Robert-Bosch-Krankenhaus P1): laid out
 * along the footprint's longest edge in 16 m modules (5 m bays | 6 m aisle | 5 m bays), white bay lines every
 * 2.5 m, a few parked cars (rounded boxes, ~1 per 250 m²), a stair/lift box at one end. Plain grey deck below.
 */
const CAR_COLOURS = [[0.86, 0.87, 0.88], [0.36, 0.38, 0.42], [0.42, 0.52, 0.66], [0.70, 0.71, 0.73], [0.74, 0.30, 0.26], [0.22, 0.23, 0.25]];
function parkingDeck(o: Out, ring: P2[], z: number, rnd: () => number) {
  let t = 0, best = 0;
  for (let k = 0; k < ring.length; k++) {
    const [ax, ay] = ring[k], [bx, by] = ring[(k + 1) % ring.length], L = Math.hypot(bx - ax, by - ay);
    if (L > best) { best = L; t = Math.atan2(by - ay, bx - ax); }
  }
  const cu = Math.cos(t), sn = Math.sin(t);
  const toW = (u: number, v: number): P2 => [u * cu - v * sn, u * sn + v * cu];
  const us = ring.map(([x, y]) => x * cu + y * sn), vs = ring.map(([x, y]) => -x * sn + y * cu);
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  const ins = (u: number, v: number, m = 0.6) => [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]].every(([du, dv]) => pointInRing(...toW(u + du, v + dv), ring));
  const line = (ua: number, va: number, ub: number, vb: number, w: number) => {
    const du = ub - ua, dv = vb - va, L = Math.hypot(du, dv) || 1, nu = (-dv / L) * w / 2, nv = (du / L) * w / 2;
    const q = [[ua - nu, va - nv], [ub - nu, vb - nv], [ub + nu, vb + nv], [ua + nu, va + nv]].map(([u, v]) => [...toW(u, v), z + 0.04]);
    const up = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]) > 0; // counter-clockwise from above
    quad3(o, up ? q : q.reverse(), [0.97, 0.97, 0.95]);
  };
  const W = v1 - v0, n = Math.max(1, Math.floor((W - 1) / 16)), vm = v0 + (W - n * 16) / 2;
  const bays: Array<[number, number, number]> = []; // u, v (bay centre), side
  for (let m = 0; m < n; m++) {
    const vc = vm + m * 16 + 8;
    for (const side of [-1, 1]) {
      const va = vc + side * 3, vb = vc + side * 8;
      let first = true;
      for (let u = u0 + 1.5; u + 2.5 <= u1 - 1.5; u += 2.5) {
        if (!ins(u, va) || !ins(u, vb) || !ins(u + 2.5, va) || !ins(u + 2.5, vb)) { first = true; continue; }
        if (first) line(u, va, u, vb, 0.22);
        line(u + 2.5, va, u + 2.5, vb, 0.22);
        bays.push([u + 1.25, (va + vb) / 2, side]);
        first = false;
      }
    }
  }
  const area = Math.abs(THREE.ShapeUtils.area(ring.map(([x, y]) => new THREE.Vector2(x, y))));
  for (let k = Math.min(bays.length, Math.round(area / 250)); k > 0 && bays.length; k--) {
    const [u, v] = bays.splice(Math.floor(rnd() * bays.length), 1)[0];
    const [x, y] = toW(u, v), c = CAR_COLOURS[Math.floor(rnd() * CAR_COLOURS.length)];
    prism(o, x, y, z, 1.8, 4.3, 0.75, 0.75, t, c.map((q) => q * 0.85)); // body
    prism(o, x, y, z + 0.75, 1.5, 2.3, 0.55, 0.55, t, c);               // cabin
  }
  for (const [u, v] of [[u0 + 2.5, v0 + 2.5], [u1 - 2.5, v1 - 2.5], [u0 + 2.5, v1 - 2.5], [u1 - 2.5, v0 + 2.5]])
    if (ins(u, v, 1.6)) { const [x, y] = toW(u, v); prism(o, x, y, z, 3.2, 3.2, 3.0, 3.0, t, [0.80, 0.79, 0.76]); break; } // stairs / lift
}

/** LoD2 meshes into the shared building arrays (flat-shaded triangles; walls carry facade coordinates). */
function addMeshes(data: TileObjects, pos: number[], nor: number[], col: number[], fac: number[], kin: number[]) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const [style, roofKind, roof, wall, footprint, , seed, osmRoof, osmWall, bare] of data.m ?? []) {
    const j = (seed % 97) / 97 - 0.5; // per-building tint
    const walls = (ZG ? WALL_BY_STYLE_ZG[style] ?? WALLS_ZG : WALL_BY_STYLE[style] ?? WALLS_STR), w = (osmWall ?? walls[seed % walls.length]).map((v) => Math.min(1, v * (1 + 0.04 * j)));
    // OSM roof:colour / roof:material where mapped (scene.ts), else the palette by roof kind
    let tileRoof = (osmRoof ?? ROOFS[Math.floor(roofKind / 10)]).map((v) => v * (1 + 0.14 * j));
    // Zagreb: tile from orange-red to brown per building (new and old tile, different works)
    if (ZG && !osmRoof && roofKind < 20) { const t = (seed % 89) / 89; tileRoof = tileRoof.map((v, i) => v * (1 - 0.3 * t) + [0.56, 0.33, 0.24][i] * 0.3 * t); }
    const flatRoof = (osmRoof && roofKind % 10 !== 6 ? osmRoof : ROOFS[roofKind % 10]).map((v) => v * (1 + 0.08 * j));
    const rnd = mulberry(seed * 7919 + 1);
    // style in the integer part, the building's facade variation in the fraction (buildingMaterial)
    const kind = 10 + style + 0.05 + 0.9 * mulberry(seed * 104729 + 7)();
    const green = roofKind % 10 === 6, deck = style === 12, landmark = (style === 4 && !!osmRoof) || !!bare || deck; // hand-modelled / LOOKS landmarks / car parks: no roof furniture
    let deckZ = -Infinity;
    const planes: Plane[] = [];
    for (let i = 0; i + 8 < roof.length; i += 9) {
      a.fromArray(roof, i); b.fromArray(roof, i + 3); c.fromArray(roof, i + 6);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const area = n.length() / 2;
      n.normalize();
      if (n.z < 0) n.negate();
      const r = n.z > 0.97 ? flatRoof : tileRoof; // planes within ~14° of level are flat roofs
      for (const v of [a, b, c]) { pos.push(v.x, v.y, v.z); nor.push(n.x, n.y, n.z); col.push(...r); fac.push(0, -1000); kin.push(kind); }
      if (deck && n.z > 0.97 && area > 1) deckZ = Math.max(deckZ, a.z, b.z, c.z);
      if (landmark || area < 0.01 || n.z < 0.3) continue;
      // group triangles into planes (same normal and offset) for the roof furniture
      const d = n.x * a.x + n.y * a.y + n.z * a.z;
      let pl = planes.find((q) => Math.abs(q.n[0] - n.x) + Math.abs(q.n[1] - n.y) + Math.abs(q.n[2] - n.z) < 0.04 && Math.abs(q.d - d) < 0.3);
      if (!pl) planes.push(pl = { n: [n.x, n.y, n.z], d, tris: [], area: 0 });
      pl.tris.push([a.x, a.y, b.x, b.y, c.x, c.y]); pl.area += area;
    }
    if (planes.length) roofFurniture({ pos, nor, col, fac, kin }, planes, footprint, wall, style, green, w, rnd);
    if (deck && deckZ > -Infinity) parkingDeck({ pos, nor, col, fac, kin }, footprint, deckZ, rnd);
    for (let i = 0; i + 14 < wall.length; i += 15) {
      a.fromArray(wall, i); b.fromArray(wall, i + 5); c.fromArray(wall, i + 10);
      n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      for (const k of [0, 5, 10]) {
        const above = wall[i + k + 4];
        // walls reach 3 m below the LoD2 base, so a downhill slope never opens a gap under the house
        const drop = above < 0.05 ? 3 : 0;
        pos.push(wall[i + k], wall[i + k + 1], wall[i + k + 2] - drop); nor.push(n.x, n.y, n.z); col.push(...w);
        fac.push(wall[i + k + 3], above - drop); kin.push(kind);
      }
    }
  }
}

function buildObjects(data: TileObjects) {
  objects.children.forEach((o: any) => o.geometry?.dispose());
  objects.clear();
  const pos: number[] = [], nor: number[] = [], col: number[] = [], fac: number[] = [], tow: number[] = [];
  /** axis-aligned box on a roof (rooftop clutter), no facade pattern */
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: number[]) => {
    const X = [x - sx / 2, x + sx / 2], Y = [y - sy / 2, y + sy / 2], Z = [z, z + sz];
    const faces: Array<[number[][], number[]]> = [
      [[[X[0], Y[0], Z[1]], [X[1], Y[0], Z[1]], [X[1], Y[1], Z[1]], [X[0], Y[1], Z[1]]], [0, 0, 1]],
      [[[X[0], Y[0], Z[0]], [X[1], Y[0], Z[0]], [X[1], Y[0], Z[1]], [X[0], Y[0], Z[1]]], [0, -1, 0]],
      [[[X[1], Y[0], Z[0]], [X[1], Y[1], Z[0]], [X[1], Y[1], Z[1]], [X[1], Y[0], Z[1]]], [1, 0, 0]],
      [[[X[1], Y[1], Z[0]], [X[0], Y[1], Z[0]], [X[0], Y[1], Z[1]], [X[1], Y[1], Z[1]]], [0, 1, 0]],
      [[[X[0], Y[1], Z[0]], [X[0], Y[0], Z[0]], [X[0], Y[0], Z[1]], [X[0], Y[1], Z[1]]], [-1, 0, 0]],
    ];
    for (const [q, nn] of faces) for (const v of [0, 1, 2, 0, 2, 3]) {
      pos.push(...q[v]); nor.push(...nn); col.push(...c); fac.push(0, -1000); tow.push(0);
    }
  };
  const rnd = (seed: number) => () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 2 ** 32;
  data.b.forEach(([ring, h, style]) => {
    // sit on the highest ground under the footprint; walls reach 1 m below the lowest so slopes never show a gap
    const gs = ring.map(([x, y]) => ground(x, y));
    const top = Math.max(...gs) + h, g = Math.min(...gs) - 1;
    const [wall, roof] = PALETTE[style] ?? PALETTE[0];
    const isTower = style;
    let along = 0;
    for (let k = 0; k < ring.length; k++) {
      const [ax, ay] = ring[k], [bx, by] = ring[(k + 1) % ring.length];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.05) continue;
      const nx = (by - ay) / L, ny = -(bx - ax) / L; // outward for CCW
      const quad = [[ax, ay, g, along, -1], [bx, by, g, along + L, -1], [bx, by, top, along + L, top - g - 1], [ax, ay, top, along, top - g - 1]];
      for (const q of [0, 1, 2, 0, 2, 3]) {
        pos.push(quad[q][0], quad[q][1], quad[q][2]); nor.push(nx, ny, 0); col.push(...wall);
        fac.push(quad[q][3], quad[q][4]); tow.push(isTower);
      }
      along += L;
    }
    const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
    for (const t of tris) for (const v of t) {
      pos.push(ring[v][0], ring[v][1], top); nor.push(0, 0, 1); col.push(...roof); fac.push(0, -1000); tow.push(0);
    }
    // rooftop clutter on flat residential roofs: solar water heaters (panel + tank), AC units
    if (style !== 3 && style !== 4 && h > 6) {
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const area = Math.abs(THREE.ShapeUtils.area(ring.map(([x, y]) => new THREE.Vector2(x, y))));
      const r = rnd(Math.round(x0 * 31 + y0 * 17));
      const n = Math.min(10, Math.floor(area / 70));
      for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
        const px = x0 + 1.5 + r() * (x1 - x0 - 3), py = y0 + 1.5 + r() * (y1 - y0 - 3);
        if (!pointInRing(px, py, ring)) continue;
        k++;
        const kind = r();
        if (kind < 0.55) {        // solar water heater: dark panel + white tank
          box(px, py, top, 2.0, 1.1, 0.35, [0.16, 0.22, 0.38]);
          box(px, py + 0.9, top, 1.6, 0.6, 0.7, [0.93, 0.93, 0.92]);
        } else if (kind < 0.85) { // AC unit
          box(px, py, top, 0.9, 0.7, 0.6, [0.74, 0.75, 0.76]);
        } else {                  // stair / lift housing
          box(px, py, top, 2.6, 2.6, 2.6, roof.map((v) => v * 0.95));
        }
      }
    }
  });
  if (STYLED) addMeshes(data, pos, nor, col, fac, tow);
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute("facade", new THREE.Float32BufferAttribute(fac, 2));
    geo.setAttribute("kind", new THREE.Float32BufferAttribute(tow, 1));
    objects.add(new THREE.Mesh(geo, buildingMaterial));
  }
  if (data.t.length) {
    const crowns = new THREE.InstancedMesh(STYLED ? CROWN : new THREE.IcosahedronGeometry(1, 2), treeMaterial, data.t.length);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5), treeMaterial, data.t.length);
    const m = new THREE.Matrix4(), c = new THREE.Color(), bark = new THREE.Color(0.40, 0.31, 0.23);
    data.t.forEach(([x, y, r, ch, named], i) => {
      const g = ground(x, y), [name, , col, sxy, sz, palm] = species(x, y, r, named);
      if (palm && STYLED) {
        // conifer: narrow cone from near the ground to the top
        const top = g + ch + r * sz + Math.max(r, 2);
        const w = Math.max(1.4, r * 0.8) * (sxy || 1); // sxy: a slimmer cone (thuja, cypress)
        m.makeScale(w, w, top - g - 1.5).setPosition(x, y, g + 1.5);
        crowns.setMatrixAt(i, m.multiply(CONE));
        m.makeScale(0.3, 0.3, 2).setPosition(x, y, g);
        trunks.setMatrixAt(i, m);
      } else if (palm) {
        // small star crown high on a thin trunk
        const top = g + Math.max(ch, 8) + (name === "fan palm" ? 6 : 0); // Washingtonias tower over the rest
        m.makeScale(2.6, 2.6, 0.9).setPosition(x, y, top);
        crowns.setMatrixAt(i, m);
        m.makeScale(0.4, 0.4, top - g).setPosition(x, y, g);
        trunks.setMatrixAt(i, m);
      } else {
        if (STYLED) {
          // crown stretched down into an oval (at most 1.7× as tall as wide) so only a short trunk shows under it
          const top = ch + r * sz, bot = Math.min(ch - r * sz, Math.max(2, 0.28 * top, top - 3.4 * r * sxy)), hz = (top - bot) / 2;
          m.makeScale(r * sxy, r * sxy, hz).setPosition(x, y, g + bot + hz);
          crowns.setMatrixAt(i, m);
          m.makeScale(Math.max(0.35, r * 0.12), Math.max(0.35, r * 0.12), bot + hz * 0.5).setPosition(x, y, g);
        } else {
          m.makeScale(r * sxy, r * sxy, r * sz).setPosition(x, y, g + ch);
          crowns.setMatrixAt(i, m);
          m.makeScale(0, 0, 0);
        }
        trunks.setMatrixAt(i, m);
      }
      crowns.setColorAt(i, c.setRGB(col[0], col[1], col[2]));
      trunks.setColorAt(i, bark);
    });
    objects.add(crowns, trunks);
  }
}

// ---- styled post pass: outlines (depth creases), ambient occlusion, paper grain -------------------
const colorTarget = new THREE.WebGLRenderTarget(SIZE, SIZE, {
  colorSpace: THREE.NoColorSpace, depthBuffer: true, generateMipmaps: false,
  depthTexture: new THREE.DepthTexture(SIZE, SIZE, THREE.UnsignedIntType),
});
const postMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor, tDepth;
    uniform float near, far, px, size;   // px: metres per supersampled pixel
    uniform vec2 origin;                  // global art pixel of the tile's top-left corner
    uniform float ss;
    varying vec2 vUv;
    float depth(vec2 uv) { return near + texture2D(tDepth, uv).x * (far - near); }
    vec3 P(vec2 uv) { return vec3(uv * size * px, depth(uv)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    void main() {
      vec2 e = vec2(1.0 / size, 0.0), f = vec2(0.0, 1.0 / size);
      vec3 c = texture2D(tColor, vUv).rgb;
      float z = depth(vUv);
      if (z > far - 1.0) { gl_FragColor = vec4(c, 1.0); return; }
      // outlines: depth Laplacian over 2 px (planes are linear in an ortho depth buffer, so only creases and silhouettes show)
      float lx = abs(depth(vUv + 2.0 * e) + depth(vUv - 2.0 * e) - 2.0 * z);
      float ly = abs(depth(vUv + 2.0 * f) + depth(vUv - 2.0 * f) - 2.0 * z);
      float edge = smoothstep(0.35, 1.2, max(lx, ly));
      // ambient occlusion: samples above this pixel's tangent plane, within 1.5 m
      vec3 p = P(vUv);
      vec3 n = normalize(cross(P(vUv + e) - P(vUv - e), P(vUv + f) - P(vUv - f)));
      if (n.z > 0.0) n = -n;
      float occ = 0.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996, r = (2.0 + float(i) * 1.4);
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r / size;
        vec3 v = P(uv) - p;
        float d = length(v);
        occ += max(0.0, dot(n, v / max(d, 1e-3)) - 0.2) * (1.0 - smoothstep(1.0, 3.0, d));
      }
      occ = clamp(occ / 12.0 * 2.2, 0.0, 1.0);
      c *= 1.0 - 0.38 * occ;
      c = mix(c, c * vec3(0.42, 0.40, 0.42), edge * 0.75);
      // paper: soft blotches over a few hundred art pixels + fine grain, continuous across tiles
      vec2 g = origin + vec2(vUv.x, 1.0 - vUv.y) * size / ss;
      float paper = (vnoise(g / 220.0) - 0.5) * 0.05 + (vnoise(g / 37.0) - 0.5) * 0.03 + (hash(floor(g * ss)) - 0.5) * 0.025;
      c *= 1.0 + paper;
      // a touch more colour: the raw render is flat next to the painted house style
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.12);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
  uniforms: {
    tColor: { value: colorTarget.texture }, tDepth: { value: colorTarget.depthTexture },
    near: { value: 1 }, far: { value: 6000 }, px: { value: CAMERA.mpp / SS }, size: { value: SIZE },
    origin: { value: new THREE.Vector2() }, ss: { value: SS },
  },
  depthTest: false, depthWrite: false,
});
const postScene = new THREE.Scene();
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function placeCamera(tx: number, ty: number) {
  const c = tileCamera(tx, ty);
  camera.left = -c.half; camera.right = c.half;
  camera.top = c.half; camera.bottom = -c.half;
  camera.near = c.near; camera.far = c.far;
  camera.position.set(...c.pos);
  camera.up.set(...c.up);
  camera.lookAt(c.pos[0] + c.dir[0], c.pos[1] + c.dir[1], c.pos[2] + c.dir[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

async function renderTile(tx: number, ty: number, data?: TileObjects) {
  placeCamera(tx, ty);
  buildObjects(data ?? { b: [], t: [] });
  buildGround(tx, ty, data);
  if (STYLED) {
    renderer.setRenderTarget(colorTarget);
    renderer.render(scene, camera);
    const u = postMaterial.uniforms;
    u.near.value = camera.near; u.far.value = camera.far;
    u.origin.value.set(tx * CAMERA.tile, ty * CAMERA.tile);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  } else {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
  const color = renderer.domElement.toDataURL("image/png");

  scene.overrideMaterial = heightMaterial;
  renderer.setRenderTarget(heightTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
  renderer.setClearColor(0x000000, 1);
  const buf = new Uint8Array(HEIGHT_SIZE * HEIGHT_SIZE * 4);
  renderer.readRenderTargetPixels(heightTarget, 0, 0, HEIGHT_SIZE, HEIGHT_SIZE, buf);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  return { color, height: bufToB64(buf) };
}

function bufToB64(buf: Uint8Array) {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

declare global {
  interface Window {
    renderTile: typeof renderTile;
    ready: boolean;
  }
}
window.renderTile = renderTile;
window.ready = true;

