/**
 * The biplane of fly.ts as a 3D model (three.js, loaded only when one takes off): built here from solids, about
 * 7.7 m long and 9.4 m across (fly.ts scales it). Seen exactly as the map is (the region's camera: its heading, 45°
 * down; camera.ts axes) and lit by the map's sun (the styled renderer's: from the viewer's back left, high). Two
 * passes into one small transparent canvas, each drawn onto the map before the next: the shadow alone (every vertex
 * pushed along the sunlight onto the ground `drop` under the plane, drawn once per pixel through the stencil),
 * centred on where the plane's centre casts it, then the plane alone, centred on itself. Where fly.ts lays the shadow
 * over roofs it needs the shadow's coverage on the CPU: that is rendered small into its own target and read back
 * without holding up the frame (requestShadowMask), arriving a frame or so later.
 */
import * as THREE from "three";
import { axes } from "../../../pipeline/src/camera.ts";

/** half the view across (model m): the plane's farthest part is ~5 m from its centre */
const HALF = 6;

export class Biplane3D {
  readonly canvas: HTMLCanvasElement;
  /** towards the sun (ENU, unit): the map's */
  readonly sun: [number, number, number];
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private plane = new THREE.Group();
  private shadow: THREE.Group;
  private props: THREE.Object3D[] = [];
  private scarves: THREE.Object3D[] = [];
  private shadowMatrix = new THREE.Matrix4();
  private back: THREE.Vector3;
  private drop = 18;
  private maskTarget: THREE.WebGLRenderTarget | null = null;
  /** a read of the shadow's coverage is on its way (requestShadowMask), into these bytes */
  private reading = false;
  private rgba: Uint8Array | null = null;
  /**
   * The shadow's coverage as last read back (requestShadowMask): alpha per texel, `size` across, rows from the top,
   * the same view as renderShadow's; [u0, v0, u1, v1] bounds its non-empty texels (u0 > u1 when it is empty).
   */
  mask: { size: number; alpha: Uint8Array; box: [number, number, number, number] } | null = null;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, stencil: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // the map's camera: right, up and the view direction in ENU (x east, y north, z up)
    const ax = axes();
    this.back = new THREE.Vector3(...ax.dir).negate();
    this.camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 0.1, 200);
    this.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...ax.right), new THREE.Vector3(...ax.up), this.back));
    // the map's sun (pipeline/page/renderer.ts SUN, styled): from the viewer's back left, high
    const f = new THREE.Vector2(ax.dir[0], ax.dir[1]).normalize();
    const sun = new THREE.Vector3(-0.45 * f.x - 0.55 * ax.right[0], -0.45 * f.y - 0.55 * ax.right[1], 0.8).normalize();
    this.sun = [sun.x, sun.y, sun.z];
    const light = new THREE.DirectionalLight(0xfff4e2, 2.6);
    light.position.copy(sun.clone().multiplyScalar(20));
    const sky = new THREE.HemisphereLight(0xdfe9ff, 0x6f8a52, 1.1);
    sky.position.set(0, 0, 1); // z is up here
    this.scene.add(light, light.target, sky);
    this.build();
    this.scene.add(this.plane);
    const ink = new THREE.MeshBasicMaterial({
      color: 0x22293e, transparent: true, opacity: 0.36, depthTest: false, depthWrite: false, // the map's shadows' cool grey-blue
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    });
    this.shadow = this.plane.clone();
    this.shadow.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = ink;
      if (o.name === "see-through") o.visible = false; // the propeller's blur and the windscreen cast none
    });
    this.shadow.matrixAutoUpdate = false;
    for (const root of [this.plane, this.shadow]) root.traverse((o) => { if (o.name === "prop") this.props.push(o); if (o.name === "scarf") this.scarves.push(o); });
    this.scene.add(this.shadow);
  }

  /** the canvas for `pxPerM` device px per model metre (at most 2048 px across) */
  resize(pxPerM: number) {
    const size = Math.min(2048, Math.max(8, Math.ceil(2 * HALF * pxPerM)));
    if (this.canvas.width !== size) this.renderer.setSize(size, size, false);
  }

  /**
   * Turn it (heading in ENU radians from east, counter-clockwise; bank, positive = left wing down; pitch, nose up),
   * spin the propeller and wave the scarf at time t; its shadow `drop` model metres under it.
   */
  pose(heading: number, bank: number, pitch: number, t: number, drop: number) {
    this.plane.rotation.set(-bank, -pitch, heading, "ZYX");
    this.plane.updateMatrix();
    for (const p of this.props) p.rotation.x = t * 41;
    for (const s of this.scarves) s.rotation.z = 0.35 * Math.sin(t * 13) + 0.15 * Math.sin(t * 29);
    this.drop = drop;
    const [x, y, z] = this.sun, kx = x / z, ky = y / z;
    this.shadowMatrix.set(1, 0, -kx, -kx * drop, 0, 1, -ky, -ky * drop, 0, 0, 0, -drop, 0, 0, 0, 1);
    this.shadow.matrix.multiplyMatrices(this.shadowMatrix, this.plane.matrix);
  }

  /** the shadow alone, the canvas centred on where the plane's centre casts it */
  renderShadow() {
    const [x, y, z] = this.sun, c = new THREE.Vector3((-x / z) * this.drop, (-y / z) * this.drop, -this.drop);
    this.pass(true, c);
  }

  /** the plane alone, the canvas centred on it */
  renderPlane() { this.pass(false, new THREE.Vector3()); }

  /**
   * The shadow alone (as renderShadow, after pose) into a small target `size` px across, its pixels read back to the CPU
   * without holding up the frame (three copies them into a buffer on the GPU, then looks at a fence until that is
   * done): they land in `mask` a frame or so later, too soon for the slowly turning plane to show it. One read at a
   * time; a call while one is on its way does nothing. Reading the canvas back instead stalled every frame until the
   * GPU had finished everything before it.
   */
  requestShadowMask(size: number) {
    if (this.reading) return;
    let rt = this.maskTarget;
    if (!rt || rt.width !== size) {
      rt?.dispose();
      rt = this.maskTarget = new THREE.WebGLRenderTarget(size, size, { stencilBuffer: true, samples: 4 });
    }
    const [x, y, z] = this.sun;
    this.renderer.setRenderTarget(rt);
    this.pass(true, new THREE.Vector3((-x / z) * this.drop, (-y / z) * this.drop, -this.drop));
    this.renderer.setRenderTarget(null);
    if (this.rgba?.length !== size * size * 4) this.rgba = new Uint8Array(size * size * 4);
    const rgba = this.rgba;
    this.reading = true;
    this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size, rgba)
      .then(() => this.unpack(size, rgba), () => { /* lost context: the flat shadow stands in */ })
      .finally(() => { this.reading = false; });
  }

  /** the pixels read back into `mask`: their alpha, rows flipped to run from the top like a canvas's, and its box */
  private unpack(size: number, rgba: Uint8Array) {
    const m = this.mask?.size === size ? this.mask : (this.mask = { size, alpha: new Uint8Array(size * size), box: [0, 0, 0, 0] });
    const { alpha, box } = m;
    box[0] = box[1] = size; box[2] = box[3] = -1;
    for (let v = 0; v < size; v++) {
      const row = (size - 1 - v) * size;
      for (let u = 0; u < size; u++) {
        const a = (alpha[v * size + u] = rgba[(row + u) * 4 + 3]);
        if (!a) continue;
        if (u < box[0]) box[0] = u;
        if (u > box[2]) box[2] = u;
        if (v < box[1]) box[1] = v;
        if (v > box[3]) box[3] = v;
      }
    }
  }

  private pass(shadow: boolean, centre: THREE.Vector3) {
    this.plane.visible = !shadow; this.shadow.visible = shadow;
    this.camera.position.copy(centre).addScaledVector(this.back, 60);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() { this.maskTarget?.dispose(); this.renderer.dispose(); }

  // ---- the model: x forward, y left, z up (m) ----------------------------------------------------------
  private build() {
    const g = this.plane;
    const mat = (color: number, roughness = 0.6, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const RED = mat(0xc8372d, 0.62), CREAM = mat(0xefe3c4, 0.5), DARK = mat(0x37332f, 0.38, 0.65), WOOD = mat(0x6e4526, 0.5);
    const RUBBER = mat(0x1d1b19, 0.85), STRUT = mat(0xd9cfb6, 0.55), WIRE = mat(0x2c2a28, 0.5, 0.4), LEATHER = mat(0x6d4428, 0.7);
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = g) => {
      const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); parent.add(mesh); return mesh;
    };
    /** a round rod from a to b */
    const rod = (a: number[], b: number[], r: number, m: THREE.Material) => {
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), L = A.distanceTo(B);
      const mesh = add(new THREE.CylinderGeometry(r, r, L, 6), m);
      mesh.position.copy(A).add(B).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    };
    /** a flat rounded plate (wing, tailplane) in the x–y plane, `t` thick */
    const plate = (chord: number, span: number, tip: number, t: number) => {
      const s = new THREE.Shape(), a = chord / 2, b = span / 2, r = Math.min(tip, a);
      s.moveTo(-a, -b + r); s.lineTo(-a, b - r); s.quadraticCurveTo(-a, b, -a + r, b); s.lineTo(a - r, b); s.quadraticCurveTo(a, b, a, b - r);
      s.lineTo(a, -b + r); s.quadraticCurveTo(a, -b, a - r, -b); s.lineTo(-a + r, -b); s.quadraticCurveTo(-a, -b, -a, -b + r);
      const geo = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: true, bevelThickness: t * 0.3, bevelSize: Math.min(0.04, t * 0.4), bevelSegments: 2, curveSegments: 8 });
      geo.translate(0, 0, -t / 2);
      return geo;
    };

    // fabric wings: red, ribs, a paler leading edge, cream bands near the tips (UVs are the plate's metres)
    const fabric = (chord: number, span: number) => {
      const c = document.createElement("canvas"); c.width = 64; c.height = 512;
      const x = c.getContext("2d")!;
      x.fillStyle = "#c8372d"; x.fillRect(0, 0, 64, 512);
      x.fillStyle = "rgba(255,200,170,0.28)"; x.fillRect(50, 0, 14, 512); // leading edge (+x)
      x.fillStyle = "rgba(60,10,6,0.22)"; for (let v = 12; v < 512; v += 24) x.fillRect(0, v, 64, 2); // ribs
      x.fillStyle = "#efe3c4"; x.fillRect(0, 40, 64, 22); x.fillRect(0, 450, 64, 22);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.repeat.set(1 / chord, 1 / span); tex.offset.set(0.5, 0.5);
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 });
    };
    add(plate(1.5, 9.4, 0.65, 0.11), fabric(1.5, 9.4), 0.35, 0, 1.3);   // upper wing, staggered forward
    add(plate(1.4, 8.8, 0.6, 0.1), fabric(1.4, 8.8), -0.05, 0, -0.42);   // lower wing

    // fuselage: turned, round, tapering to the tail; then the engine
    const prof: THREE.Vector2[] = [[0.06, -4.65], [0.16, -4.3], [0.3, -3.4], [0.46, -2.1], [0.56, -0.9], [0.6, 0.4], [0.6, 1.6], [0.58, 2.25], [0.5, 2.4]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const body = new THREE.LatheGeometry(prof, 20);
    body.rotateZ(-Math.PI / 2); // lathe axis y → x
    body.scale(1, 0.92, 1);
    // cream, a red cheat line along each side (the lathe's u: 0 top, 0.25 right, 0.75 left; v: tail → nose)
    const skin = document.createElement("canvas"); skin.width = 256; skin.height = 128;
    const sk = skin.getContext("2d")!;
    sk.fillStyle = "#efe3c4"; sk.fillRect(0, 0, 256, 128);
    sk.fillStyle = "#c8372d"; for (const u of [0.25, 0.75]) sk.fillRect(u * 256 - 7, 14, 14, 92);
    sk.fillRect(0, 108, 256, 6); // a band round the tail
    const skinTex = new THREE.CanvasTexture(skin); skinTex.colorSpace = THREE.SRGBColorSpace;
    add(body, new THREE.MeshStandardMaterial({ map: skinTex, roughness: 0.5 }));
    add(new THREE.CylinderGeometry(0.64, 0.6, 0.55, 20, 1, true).rotateZ(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8372d, roughness: 0.45, side: THREE.DoubleSide }), 2.55); // cowling ring
    for (let i = 0; i < 7; i++) { // radial engine: seven cylinders inside the cowling ring
      const a = (i / 7) * Math.PI * 2;
      const cyl = add(new THREE.CylinderGeometry(0.09, 0.1, 0.36, 8), DARK, 2.62, Math.cos(a) * 0.36, Math.sin(a) * 0.36);
      cyl.rotation.x = a - Math.PI / 2;
    }
    add(new THREE.SphereGeometry(0.22, 12, 8), DARK, 2.62);
    // the propeller: two wooden blades round a spinner, and a faint disc where they blur
    const prop = new THREE.Group(); prop.name = "prop"; prop.position.set(2.98, 0, 0); g.add(prop);
    add(new THREE.ConeGeometry(0.17, 0.42, 14).rotateZ(-Math.PI / 2), mat(0xd9b04a, 0.35, 0.6), 0.15, 0, 0, prop);
    for (const s of [-1, 1]) { const b = add(new THREE.BoxGeometry(0.06, 0.17, 1.12), WOOD, 0, 0, s * 0.6, prop); b.rotation.z = s * 0.25; }
    const disc = add(new THREE.CircleGeometry(1.18, 32).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5a4632, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }), 3.0);
    disc.renderOrder = 2; disc.name = "see-through";

    // struts: cabane over the fuselage, two pairs between the wings, and the bracing wires
    for (const y of [-1, 1]) {
      rod([0.75, y * 0.3, 0.45], [0.65, y * 0.6, 1.24], 0.035, STRUT);
      rod([-0.05, y * 0.3, 0.48], [0.05, y * 0.6, 1.24], 0.035, STRUT);
      for (const x of [0.75, -0.25]) rod([x - 0.25, y * 3.25, -0.37], [x, y * 3.35, 1.24], 0.04, STRUT);
      rod([0.5, y * 3.3, 1.22], [0.2, y * 0.5, -0.34], 0.01, WIRE);
      rod([0.5, y * 3.3, -0.35], [0.3, y * 0.6, 1.22], 0.01, WIRE);
      rod([-0.5, y * 3.3, 1.22], [-0.3, y * 0.5, -0.34], 0.01, WIRE);
    }

    // tail: tailplane, fin with rudder (red, a cream band), skid
    add(plate(0.9, 3.2, 0.4, 0.06), RED, -4.15, 0, 0.12);
    const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(-1.15, 0); fin.lineTo(-1.25, 0.7); fin.quadraticCurveTo(-1.2, 1.15, -0.85, 1.12); fin.lineTo(-0.15, 0.25); fin.lineTo(0, 0);
    const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.02, bevelSegments: 1 });
    finGeo.translate(0, 0, -0.03); finGeo.rotateX(Math.PI / 2);
    add(finGeo, RED, -3.45, 0, 0.18);
    add(new THREE.BoxGeometry(0.16, 0.07, 0.92), CREAM, -4.32, 0, 0.62).rotation.y = 0.12;
    rod([-4.2, 0, -0.12], [-4.45, 0, -0.42], 0.03, DARK);

    // landing gear: V struts, an axle, two wheels
    for (const y of [-1, 1]) {
      rod([1.45, y * 0.3, -0.45], [1.3, y * 0.95, -1.18], 0.04, DARK);
      rod([0.55, y * 0.3, -0.48], [1.25, y * 0.95, -1.18], 0.04, DARK);
      add(new THREE.CylinderGeometry(0.34, 0.34, 0.13, 18), RUBBER, 1.3, y * 1.02, -1.18);
      add(new THREE.CylinderGeometry(0.14, 0.14, 0.15, 12), CREAM, 1.3, y * 1.02, -1.18);
    }
    rod([1.3, -0.95, -1.18], [1.3, 0.95, -1.18], 0.03, DARK);

    // cockpit: the opening, a small windscreen, the pilot in a leather helmet and goggles, a white scarf
    add(new THREE.CylinderGeometry(0.4, 0.4, 0.06, 18), mat(0x1a1714, 0.9), -0.95, 0, 0.55).scale.set(1.35, 1, 1);
    const screen = add(new THREE.PlaneGeometry(0.42, 0.26), new THREE.MeshStandardMaterial({ color: 0xcfe4ee, transparent: true, opacity: 0.45, roughness: 0.1, side: THREE.DoubleSide }), -0.42, 0, 0.72);
    screen.rotation.set(0, -1.1, Math.PI / 2); screen.name = "see-through";
    add(new THREE.SphereGeometry(0.21, 14, 10), LEATHER, -1.0, 0, 0.78);
    for (const y of [-1, 1]) add(new THREE.SphereGeometry(0.06, 8, 6), mat(0x9fc3cf, 0.2, 0.5), -0.84, y * 0.08, 0.82);
    const scarf = new THREE.Group(); scarf.name = "scarf"; scarf.position.set(-1.12, 0, 0.66); g.add(scarf);
    add(new THREE.BoxGeometry(0.85, 0.02, 0.17).translate(-0.42, 0, 0), mat(0xfbf8f0, 0.8), 0, 0, 0, scarf);
  }
}
