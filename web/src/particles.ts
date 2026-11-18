import * as THREE from "three";

/**
 * Soft round particles (dust, blood droplets, mist) in a single draw call. Simulated on the CPU:
 * each particle has velocity, gravity, damping, and size/opacity that change over its life.
 */
interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  color: THREE.Color;
  alpha: number;
  /** Opacity keyframes over life (evenly spaced). */
  fade: number[];
  gravity: number;
  damping: number;
}

export interface Burst {
  at: THREE.Vector3;
  direction: THREE.Vector3;
  count: number;
  speed: number;
  speedVariation: number;
  /** Cone half-angle in degrees. */
  spread: number;
  size: number;
  sizeVariation?: number;
  grow?: number;
  life: number;
  lifeVariation?: number;
  color: THREE.Color;
  colorVariation?: number;
  alpha: number;
  fade?: number[];
  gravity?: number;
  damping?: number;
}

const vertex = /* glsl */ `
  attribute float size;
  attribute vec4 rgba;
  uniform float scale;
  varying vec4 vColor;
  #include <fog_pars_vertex>
  void main() {
    vColor = rgba;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / max(0.05, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragment = /* glsl */ `
  varying vec4 vColor;
  #include <fog_pars_fragment>
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    // Same falloff as the soft-disc sprite: full at the centre, 35% at 0.45, zero at the rim.
    float a = d < 0.45 ? mix(1.0, 0.35, d / 0.45) : mix(0.35, 0.0, (d - 0.45) / 0.55);
    gl_FragColor = vec4(vColor.rgb, vColor.a * a);
    #include <fog_fragment>
  }
`;

export class Particles {
  readonly points: THREE.Points;
  private list: Particle[] = [];
  private readonly capacity: number;
  private positions: Float32Array;
  private sizes: Float32Array;
  private colors: Float32Array;
  private geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;

  constructor(capacity = 4000) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 4);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("size", new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("rgba", new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { scale: { value: 500 } }]),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  /** Pixels per metre at 1 m distance, kept in step with the camera's zoom. */
  setScale(viewHeightPx: number, fovDeg: number) {
    this.material.uniforms.scale.value = viewHeightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
  }

  emit(b: Burst) {
    const dir = b.direction.clone().normalize();
    // Basis around the emission direction for the cone.
    const helper = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(dir, helper).normalize();
    const w = new THREE.Vector3().crossVectors(dir, u);
    const spread = (b.spread * Math.PI) / 180;
    const count = Math.round(b.count);
    for (let k = 0; k < count; k++) {
      if (this.list.length >= this.capacity) this.list.shift();
      const theta = Math.acos(1 - Math.random() * (1 - Math.cos(spread)));
      const phi = Math.random() * Math.PI * 2;
      const d = dir.clone().multiplyScalar(Math.cos(theta))
        .addScaledVector(u, Math.sin(theta) * Math.cos(phi))
        .addScaledVector(w, Math.sin(theta) * Math.sin(phi));
      const speed = b.speed + (Math.random() * 2 - 1) * b.speedVariation;
      const size = b.size + (Math.random() * 2 - 1) * (b.sizeVariation ?? 0);
      const c = b.color.clone();
      if (b.colorVariation) c.offsetHSL(0, 0, (Math.random() * 2 - 1) * b.colorVariation * 0.3);
      this.list.push({
        p: b.at.clone(),
        v: d.multiplyScalar(Math.max(0, speed)),
        age: 0,
        life: Math.max(0.05, b.life + (Math.random() * 2 - 1) * (b.lifeVariation ?? 0)),
        size0: Math.max(0.001, size),
        size1: Math.max(0.001, size) * (b.grow ?? 1),
        color: c,
        alpha: b.alpha,
        fade: b.fade ?? [1, 1, 0],
        gravity: b.gravity ?? 0,
        damping: b.damping ?? 0,
      });
    }
  }

  update(dt: number) {
    let n = 0;
    const keep: Particle[] = [];
    for (const q of this.list) {
      q.age += dt;
      if (q.age >= q.life) continue;
      keep.push(q);
      q.v.y -= q.gravity * dt;
      if (q.damping) q.v.multiplyScalar(Math.exp(-q.damping * dt));
      q.p.addScaledVector(q.v, dt);
      const t = q.age / q.life;
      // Piecewise-linear opacity keyframes.
      const f = q.fade;
      const x = t * (f.length - 1);
      const i = Math.min(f.length - 2, Math.floor(x));
      const a = f[i] + (f[i + 1] - f[i]) * (x - i);
      this.positions[n * 3] = q.p.x;
      this.positions[n * 3 + 1] = q.p.y;
      this.positions[n * 3 + 2] = q.p.z;
      this.sizes[n] = q.size0 + (q.size1 - q.size0) * t;
      this.colors[n * 4] = q.color.r;
      this.colors[n * 4 + 1] = q.color.g;
      this.colors[n * 4 + 2] = q.color.b;
      this.colors[n * 4 + 3] = q.alpha * a;
      n++;
    }
    this.list = keep;
    this.geometry.setDrawRange(0, n);
    for (const name of ["position", "size", "rgba"]) {
      (this.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
