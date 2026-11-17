/**
 * Richer trees for the styled look (preset `richTrees`): instead of one lumpy ball per crown, crowns of several
 * lobes in a few variants per shape, species of a Central European town with their own shape, colour and bark
 * (limes, maples, oaks, chestnuts, ash, birches with white trunks, fruit trees in gardens, columnar poplars,
 * weeping willows, tiered spruces, pines with a high umbrella crown, thujas), and a foliage shader: clumps of
 * leaves lighter and darker (3D noise in the crown's own space), a darker underside, the sunlit tops of clumps
 * catching light. Species come in stands (one per ~40 m patch) with a third of the trees picked one by one.
 *
 * Each crown keeps the top the surface model measured (scene.ts: crown centre = top − 0.85 × radius).
 */
import * as THREE from "three";

type Shape = "round" | "column" | "weeping" | "spruce" | "pine" | "thuja";
/** xy, z: the crown's horizontal and vertical radius in crown radii; minR, maxR: only crowns that size (m) */
interface Species { name: string; weight: number; colour: number[]; xy: number; z: number; shape: Shape; bark: number[]; minR?: number; maxR?: number }
const BARK = [0.42, 0.34, 0.27], BIRCH = [0.88, 0.87, 0.82], PINE_BARK = [0.58, 0.40, 0.28];
const SPECIES: Species[] = [
  { name: "lime", weight: 16, colour: [0.36, 0.56, 0.20], xy: 1, z: 0.9, shape: "round", bark: BARK },
  { name: "maple", weight: 14, colour: [0.43, 0.61, 0.22], xy: 1, z: 0.85, shape: "round", bark: BARK },
  { name: "oak", weight: 9, colour: [0.30, 0.47, 0.17], xy: 1.05, z: 0.8, shape: "round", bark: BARK },
  { name: "chestnut", weight: 6, colour: [0.25, 0.45, 0.16], xy: 1, z: 0.9, shape: "round", bark: BARK },
  { name: "ash", weight: 6, colour: [0.41, 0.57, 0.25], xy: 0.95, z: 0.9, shape: "round", bark: BARK },
  { name: "birch", weight: 9, colour: [0.53, 0.67, 0.29], xy: 0.72, z: 1.15, shape: "round", bark: BIRCH },
  { name: "fruit", weight: 8, colour: [0.45, 0.61, 0.25], xy: 1.05, z: 0.75, shape: "round", bark: BARK, maxR: 3 },
  { name: "poplar", weight: 3, colour: [0.40, 0.58, 0.24], xy: 0.42, z: 1.7, shape: "column", bark: BARK, minR: 2.5 },
  { name: "willow", weight: 3, colour: [0.57, 0.67, 0.31], xy: 1.05, z: 0.8, shape: "weeping", bark: BARK, minR: 2.5 },
  { name: "spruce", weight: 8, colour: [0.15, 0.31, 0.21], xy: 0.85, z: 1, shape: "spruce", bark: BARK },
  { name: "pine", weight: 6, colour: [0.21, 0.37, 0.23], xy: 1, z: 0.45, shape: "pine", bark: PINE_BARK, minR: 2 },
  { name: "thuja", weight: 6, colour: [0.24, 0.42, 0.21], xy: 0.6, z: 1, shape: "thuja", bark: BARK, maxR: 2.5 },
];
const VARIANTS = 4;

const hash = (a: number, b: number) => { const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return h - Math.floor(h); };
const hash3 = (a: number, b: number, c: number) => { const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return h - Math.floor(h); };
const mulberry = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A species for a crown at (x, y) of radius r: stands per ~40 m patch, a third picked one by one. */
function pick(x: number, y: number, r: number): Species {
  const own = hash(x, y) < 0.33, u = own ? hash(y, x) : hash(Math.floor(x / 40), Math.floor(y / 40));
  const fits = SPECIES.filter((s) => r >= (s.minR ?? 0) && r <= (s.maxR ?? 99));
  let h = u * fits.reduce((a, s) => a + s.weight, 0);
  for (const s of fits) if ((h -= s.weight) < 0) return s;
  return fits[0];
}

// ---- crown geometry: unit size, built once -------------------------------------------------------------
type Buf = { pos: number[]; nor: number[]; tone: number[] };
/** A lumpy sphere (icosphere, vertices pushed in and out by their position, so shared vertices stay joined). */
function lobe(b: Buf, c: number[], rad: number, tone: number, stretch = 1) {
  const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 0.86 + 0.28 * hash3(x * 7.1 + c[0] * 3, y * 5.3 + c[1] * 3, z * 6.7 + c[2] * 3);
    b.pos.push(c[0] + x * rad * k, c[1] + y * rad * k, c[2] + z * rad * k * stretch);
    const L = Math.hypot(x, y, z / stretch);
    b.nor.push(x / L, y / L, z / stretch / L);
    b.tone.push(tone);
  }
  g.dispose();
}
/** Scale the crown to a horizontal radius of 1 and a height from −1 to 1 (normals by the inverse scale). */
function geometry(b: Buf, unitHeight: [number, number] = [-1, 1]): THREE.BufferGeometry {
  let R = 0, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < b.pos.length; i += 3) { R = Math.max(R, Math.hypot(b.pos[i], b.pos[i + 1])); z0 = Math.min(z0, b.pos[i + 2]); z1 = Math.max(z1, b.pos[i + 2]); }
  const sz = (unitHeight[1] - unitHeight[0]) / (z1 - z0);
  for (let i = 0; i < b.pos.length; i += 3) {
    b.pos[i] /= R; b.pos[i + 1] /= R; b.pos[i + 2] = unitHeight[0] + (b.pos[i + 2] - z0) * sz;
    const nx = b.nor[i] * R, ny = b.nor[i + 1] * R, nz = b.nor[i + 2] / sz, L = Math.hypot(nx, ny, nz);
    b.nor[i] = nx / L; b.nor[i + 1] = ny / L; b.nor[i + 2] = nz / L;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3));
  g.setAttribute("tone", new THREE.Float32BufferAttribute(b.tone, 1));
  return g;
}
/** Broadleaf crown: a core and 5–7 lobes round it, more of them high up; lower lobes a little darker. */
function roundCrown(seed: number, flat = false) {
  const rng = mulberry(seed), b: Buf = { pos: [], nor: [], tone: [] };
  lobe(b, [0, 0, flat ? 0 : -0.1], 0.7, 0.92);
  const n = 5 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const a = ((k + rng() * 0.7) / n) * Math.PI * 2, e = flat ? -0.15 + rng() * 0.35 : -0.25 + rng() * 1.0, d = 0.45 + rng() * 0.12;
    const c = [Math.cos(e) * Math.cos(a) * d, Math.cos(e) * Math.sin(a) * d, Math.sin(e) * d];
    lobe(b, c, 0.36 + rng() * 0.16, 0.9 + 0.18 * (c[2] + 0.4) + (rng() - 0.5) * 0.08);
  }
  return geometry(b);
}
/** Weeping crown: a dome with lobes hanging round its edge. */
function weepingCrown(seed: number) {
  const rng = mulberry(seed), b: Buf = { pos: [], nor: [], tone: [] };
  lobe(b, [0, 0, 0.25], 0.68, 1.0);
  const n = 7 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const a = ((k + rng() * 0.6) / n) * Math.PI * 2, d = 0.55 + rng() * 0.12;
    lobe(b, [Math.cos(a) * d, Math.sin(a) * d, -0.3 - rng() * 0.25], 0.3 + rng() * 0.1, 0.95 + (rng() - 0.5) * 0.1, 1.7);
  }
  return geometry(b);
}
/** Columnar crown (poplar): lobes stacked up a narrow spindle. */
function columnCrown(seed: number) {
  const rng = mulberry(seed), b: Buf = { pos: [], nor: [], tone: [] };
  for (let k = 0; k < 7; k++) {
    const z = -0.85 + k * 0.28 + (rng() - 0.5) * 0.08;
    lobe(b, [(rng() - 0.5) * 0.12, (rng() - 0.5) * 0.12, z], 0.5 * (1 - 0.35 * Math.abs(z)) + rng() * 0.06, 0.9 + 0.1 * (z + 1) / 2);
  }
  return geometry(b);
}
/** Spruce: tiers of cones with ragged rims, base at z = 0, tip at z = 1, radius 1 at the base. */
function spruceCrown(seed: number) {
  const rng = mulberry(seed), b: Buf = { pos: [], nor: [], tone: [] }, T = 5;
  for (let k = 0; k < T; k++) {
    const r = 1 - k * 0.19, z0 = k * 0.17, h = k === T - 1 ? 1 - z0 : 0.36;
    const g = new THREE.ConeGeometry(r, h, 10, 1, true).toNonIndexed(), p = g.attributes.position, nn = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      // the cone stands on y: turned a quarter round x to stand on z (a turn, not a swap: the faces keep facing
      // out); the rim (lowest ring) ragged by its angle
      let x = p.getX(i), y = -p.getZ(i);
      const zz = p.getY(i) + h / 2 + z0;
      if (p.getY(i) < -h / 2 + 1e-6) { const j = 0.85 + 0.3 * hash3(Math.round(Math.atan2(y, x) * 100), k, seed); x *= j; y *= j; }
      b.pos.push(x, y, zz);
      b.nor.push(nn.getX(i), -nn.getZ(i), nn.getY(i));
      b.tone.push(0.82 + 0.05 * k + (rng() - 0.5) * 0.04);
    }
    g.dispose();
  }
  return geometry(b, [0, 1]);
}
/** Thuja: a narrow, rounded spindle, base at z = 0, tip at z = 1. */
function thujaCrown(seed: number) {
  const pts = [[0.001, 0], [0.75, 0.04], [0.92, 0.25], [0.82, 0.55], [0.5, 0.82], [0.001, 1]].map(([r, z]) => new THREE.Vector2(r, z));
  const g = new THREE.LatheGeometry(pts, 10).toNonIndexed(), p = g.attributes.position, b: Buf = { pos: [], nor: [], tone: [] };
  g.computeVertexNormals();
  const nn = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = -p.getZ(i), z = p.getY(i), k = 0.92 + 0.16 * hash3(x * 9.1, y * 7.3, z * 5.7 + seed); // y up -> z up
    b.pos.push(x * k, y * k, z);
    b.nor.push(nn.getX(i), -nn.getZ(i), nn.getY(i));
    b.tone.push(0.88 + 0.14 * z);
  }
  g.dispose();
  return geometry(b, [0, 1]);
}
let GEOMETRY: Record<Shape, THREE.BufferGeometry[]> | null = null;
function geometries() {
  if (GEOMETRY) return GEOMETRY;
  const make = (f: (seed: number) => THREE.BufferGeometry) => Array.from({ length: VARIANTS }, (_, i) => f(i * 7919 + 13));
  return (GEOMETRY = { round: make((s) => roundCrown(s)), pine: make((s) => roundCrown(s, true)), weeping: make(weepingCrown), column: make(columnCrown), spruce: make(spruceCrown), thuja: make(thujaCrown) });
}

// ---- foliage shader ----------------------------------------------------------------------------------
let MATERIAL: THREE.ShaderMaterial | null = null;
function material(sun: THREE.Vector3) {
  return (MATERIAL ??= new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute float tone;
      varying vec3 vNormal; varying vec3 vLocal; varying float vTone; varying vec3 vColor; varying float vSeed;
      void main() {
        // the crown is scaled per tree: normals by the inverse scale (instance matrices carry no shear)
        vec3 s2 = vec3(dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz), dot(instanceMatrix[1].xyz, instanceMatrix[1].xyz), dot(instanceMatrix[2].xyz, instanceMatrix[2].xyz));
        vNormal = normalize(mat3(instanceMatrix) * (normal / s2));
        vLocal = position; vTone = tone; vColor = instanceColor;
        vSeed = fract(sin(dot(instanceMatrix[3].xy, vec2(12.9898, 78.233))) * 43758.5453);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sun;
      varying vec3 vNormal; varying vec3 vLocal; varying float vTone; varying vec3 vColor; varying float vSeed;
      float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
      void main() {
        vec3 n = normalize(vNormal);
        float lit = max(dot(n, sun), 0.0);
        // clumps of leaves (~a quarter of the crown's radius) and a finer grain inside them
        float clumps = 0.65 * noise(vLocal * 4.5 + vSeed * 17.0) + 0.35 * noise(vLocal * 9.0 + vSeed * 31.0);
        float leaf = 0.80 + 0.32 * smoothstep(0.25, 0.75, clumps);
        float under = 0.74 + 0.26 * smoothstep(-1.0, 0.5, vLocal.z); // the underside in its own shade
        vec3 c = vColor * vTone * leaf * under * (1.0 + 0.12 * (vSeed - 0.5));
        c += vec3(0.05, 0.06, 0.02) * smoothstep(0.6, 0.9, clumps) * lit;  // sunlit tops of clumps
        gl_FragColor = vec4(c * (0.48 + 0.62 * lit + 0.08 * n.z), 1.0);
      }`,
    uniforms: { sun: { value: sun } },
  }));
}

/**
 * Instanced crowns and trunks for a tile's trees ([x, y, crown radius, crown centre above the ground]); `ground`
 * gives the terrain height, `trunkMaterial` draws the trunks (instance colours: bark), `sun` lights the crowns.
 */
export function richTrees(trees: Array<[number, number, number, number]>, ground: (x: number, y: number) => number,
  trunkMaterial: THREE.Material, sun: THREE.Vector3): THREE.Object3D[] {
  const G = geometries(), groups = new Map<THREE.BufferGeometry, Array<[THREE.Matrix4, THREE.Color]>>();
  const trunks: Array<[THREE.Matrix4, THREE.Color]> = [];
  const q = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
  for (const [x, y, r, ch] of trees) {
    const g = ground(x, y), sp = pick(x, y, r), geo = G[sp.shape][Math.floor(hash(x * 3.1, y * 1.7) * VARIANTS)];
    const top = g + ch + r * 0.85; // the measured top
    q.setFromAxisAngle(Z, hash(y * 2.3, x * 5.9) * Math.PI * 2);
    const m = new THREE.Matrix4();
    let trunkTop = 0, tr = 0.12 + 0.045 * r;
    if (sp.shape === "spruce" || sp.shape === "thuja") {
      const base = g + (sp.shape === "spruce" ? Math.min(1.2, (top - g) * 0.12) : 0.05), R = Math.max(sp.shape === "spruce" ? 1 : 0.5, r * sp.xy);
      m.compose(new THREE.Vector3(x, y, base), q, new THREE.Vector3(R, R, Math.max(1, top - base)));
      if (sp.shape === "spruce") { trunkTop = base + 0.4; tr = 0.15 + 0.02 * r; }
    } else {
      let hz = r * sp.z, c = top - hz;
      if (c - hz < g + 0.4) { hz = Math.max(0.5, (top - g - 0.4) / 2); c = top - hz; } // keeps its top, starts above the ground
      m.compose(new THREE.Vector3(x, y, c), q, new THREE.Vector3(r * sp.xy, r * sp.xy, hz));
      trunkTop = c;
    }
    const j = (k: number) => 0.92 + 0.16 * hash(x + k * 13.1, y - k * 7.7);
    const col = new THREE.Color(sp.colour[0] * j(0), sp.colour[1] * j(1), sp.colour[2] * j(2));
    (groups.get(geo) ?? groups.set(geo, []).get(geo)!).push([m, col]);
    if (trunkTop > g) trunks.push([new THREE.Matrix4().makeScale(tr, tr, trunkTop - g).setPosition(x, y, g), new THREE.Color(...(sp.bark as [number, number, number]))]);
  }
  const out: THREE.Object3D[] = [];
  for (const [geo, list] of groups) {
    const mesh = new THREE.InstancedMesh(geo, material(sun), list.length);
    list.forEach(([m, c], i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, c); });
    out.push(mesh);
  }
  if (trunks.length) {
    const mesh = new THREE.InstancedMesh(TRUNK, trunkMaterial, trunks.length);
    trunks.forEach(([m, c], i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, c); });
    out.push(mesh);
  }
  return out;
}
const TRUNK = new THREE.CylinderGeometry(1, 1, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5);

/** Shrub greens: privet and hornbeam hedges, box, thuja, lilac and hazel bushes. */
const SHRUBS = [[0.34, 0.52, 0.20], [0.30, 0.47, 0.19], [0.24, 0.41, 0.21], [0.40, 0.56, 0.24], [0.36, 0.50, 0.26]];
/**
 * Instanced bushes and hedges ([x, y, radius, top above the ground]): lobed round bushes from the ground up to
 * their measured top, tall narrow ones (2 m+, under 1.1 m radius) mostly thujas; no trunks.
 */
export function richBushes(bushes: Array<[number, number, number, number]>, ground: (x: number, y: number) => number, sun: THREE.Vector3): THREE.Object3D[] {
  const G = geometries(), groups = new Map<THREE.BufferGeometry, Array<[THREE.Matrix4, THREE.Color]>>();
  const q = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
  for (const [x, y, r, top] of bushes) {
    const g = ground(x, y), v = Math.floor(hash(x * 2.7, y * 3.3) * VARIANTS), m = new THREE.Matrix4();
    const thuja = top >= 2 && r < 1.1 && hash(y * 1.9, x * 4.1) < 0.7;
    q.setFromAxisAngle(Z, hash(x * 5.3, y * 2.9) * Math.PI * 2);
    if (thuja) m.compose(new THREE.Vector3(x, y, g + 0.02), q, new THREE.Vector3(r * 0.85, r * 0.85, Math.max(0.8, top)));
    else m.compose(new THREE.Vector3(x, y, g + top / 2), q, new THREE.Vector3(r, r, Math.max(0.35, top / 2)));
    const base = thuja ? SHRUBS[2] : SHRUBS[Math.floor(hash(Math.floor(x / 25), Math.floor(y / 25)) * SHRUBS.length)];
    const j = (k: number) => 0.9 + 0.2 * hash(x + k * 17.3, y - k * 5.1);
    const geo = (thuja ? G.thuja : G.round)[v];
    (groups.get(geo) ?? groups.set(geo, []).get(geo)!).push([m, new THREE.Color(base[0] * j(0), base[1] * j(1), base[2] * j(2))]);
  }
  const out: THREE.Object3D[] = [];
  for (const [geo, list] of groups) {
    const mesh = new THREE.InstancedMesh(geo, material(sun), list.length);
    list.forEach(([m, c], i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, c); });
    out.push(mesh);
  }
  return out;
}
