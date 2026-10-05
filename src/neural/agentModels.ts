import * as THREE from 'three';
import { HALO_FRAG, HOLO_FRAG, HOLO_VERT, PLAIN_UV_VERT } from './shaders';

// Sculpted identities for each agent: a dark metallic body lit by the core,
// wrapped in a hologram shell, plus identity-specific motion.

export const AGENT_COLORS: Record<string, string> = {
  hermes: '#FACC15',
  gemini: '#818CF8',
  claude: '#F0885C',
  agy: '#A855F7',
  nexus: '#34D399',
};
export const STATUS_COLORS: Record<string, string> = {
  THINKING: '#FBBF24',
  WRITING: '#22D3EE',
  ERROR: '#EF4444',
};

export interface AgentModel {
  group: THREE.Group;
  /** Invisible sphere used for tap detection. */
  hit: THREE.Mesh;
  holo: THREE.ShaderMaterial[];
  halo: THREE.ShaderMaterial;
  haloMesh: THREE.Mesh;
  glow: THREE.Sprite;
  shards: THREE.Group;
  update: (t: number, dt: number, busy: number) => void;
  dispose: () => void;
}

export function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function holoMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: color.clone() },
      uActive: { value: 0 },
      uGlitch: { value: 0 },
      uFocus: { value: 0 },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function bodyMaterial(color: THREE.Color) {
  return new THREE.MeshStandardMaterial({
    color: 0x0b1424,
    metalness: 0.85,
    roughness: 0.32,
    emissive: color.clone().multiplyScalar(0.06),
  });
}

/** Body + hologram shell of the same geometry. */
function sculpt(geo: THREE.BufferGeometry, color: THREE.Color, holos: THREE.ShaderMaterial[]) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(geo, bodyMaterial(color));
  body.scale.setScalar(0.96);
  const holo = holoMaterial(color);
  holos.push(holo);
  const shell = new THREE.Mesh(geo, holo);
  g.add(body, shell);
  return g;
}

export function createAgentModel(id: string, glowTex: THREE.Texture): AgentModel {
  const key = id.toLowerCase();
  const color = new THREE.Color(AGENT_COLORS[key] ?? '#22D3EE');
  const group = new THREE.Group();
  const holo: THREE.ShaderMaterial[] = [];
  const spinners: Array<(t: number, dt: number, busy: number) => void> = [];
  const disposables: Array<{ dispose: () => void }> = [];

  if (key === 'hermes') {
    // Faceted crystal with crackling lightning while it works.
    const crystal = sculpt(new THREE.OctahedronGeometry(3, 0), color, holo);
    crystal.scale.set(1, 1.5, 1);
    group.add(crystal);
    const boltMat = new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending });
    const bolts = new THREE.Group();
    group.add(bolts);
    let nextBolt = 0;
    spinners.push((t, dt, busy) => {
      crystal.rotation.y += dt * (0.5 + busy * 2);
      if (t > nextBolt) {
        nextBolt = t + 0.08 + Math.random() * 0.12;
        bolts.children.forEach((b) => (b as THREE.Line).geometry.dispose());
        bolts.clear();
        const count = busy > 0.5 ? 3 : Math.random() < 0.15 ? 1 : 0;
        for (let k = 0; k < count; k++) {
          const pts: THREE.Vector3[] = [];
          const dir = new THREE.Vector3().randomDirection();
          let p = dir.clone().multiplyScalar(2.2);
          pts.push(p.clone());
          for (let s = 0; s < 6; s++) {
            p = p.clone().add(dir.clone().multiplyScalar(0.9)).add(new THREE.Vector3().randomDirection().multiplyScalar(0.5));
            pts.push(p);
          }
          bolts.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), boltMat));
        }
      }
    });
    disposables.push(boltMat);
  } else if (key === 'gemini') {
    // Twin stars orbiting one another.
    const pivot = new THREE.Group();
    const a = sculpt(new THREE.IcosahedronGeometry(1.7, 3), color, holo);
    const b = sculpt(new THREE.IcosahedronGeometry(1.7, 3), color, holo);
    a.position.x = 2.2;
    b.position.x = -2.2;
    const ringGeo = new THREE.TorusGeometry(2.2, 0.03, 8, 96);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.5), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending }));
    ring.rotation.x = Math.PI / 2;
    pivot.add(a, b, ring);
    pivot.rotation.z = 0.35;
    group.add(pivot);
    spinners.push((_t, dt, busy) => { pivot.rotation.y += dt * (0.8 + busy * 2.5); });
    disposables.push(ringGeo, ring.material as THREE.Material);
  } else if (key === 'claude') {
    // Radial starburst of blades.
    const burst = new THREE.Group();
    const blade = new THREE.OctahedronGeometry(1, 0);
    blade.scale(0.45, 2.6, 0.45);
    blade.translate(0, 2.4, 0);
    const dirs = [
      [0, 0, 0], [0, 0, Math.PI / 4], [0, 0, Math.PI / 2], [0, 0, (3 * Math.PI) / 4],
      [Math.PI / 2, 0, 0], [Math.PI / 2, 0, Math.PI / 2],
    ];
    dirs.forEach(([x, y, z]) => {
      for (const flip of [0, Math.PI]) {
        const b = sculpt(blade, color, holo);
        b.rotation.set(x, y, z + flip);
        burst.add(b);
      }
    });
    const heart = sculpt(new THREE.IcosahedronGeometry(1.1, 1), color, holo);
    burst.add(heart);
    burst.scale.setScalar(0.85);
    group.add(burst);
    spinners.push((t, dt, busy) => {
      burst.rotation.y += dt * (0.35 + busy * 1.6);
      burst.rotation.x = Math.sin(t * 0.4) * 0.3;
      burst.scale.setScalar(0.85 * (1 + Math.sin(t * (2 + busy * 5)) * 0.04 * (0.5 + busy)));
    });
  } else if (key === 'agy') {
    // Anti-gravity engine: a torus knot turning on two axes.
    const knot = sculpt(new THREE.TorusKnotGeometry(2.1, 0.55, 160, 18, 2, 3), color, holo);
    group.add(knot);
    spinners.push((_t, dt, busy) => {
      knot.rotation.y += dt * (0.4 + busy * 1.8);
      knot.rotation.x += dt * (0.2 + busy * 0.8);
    });
  } else if (key === 'nexus') {
    // Network globe: wire lattice with glowing vertices.
    const geo = new THREE.IcosahedronGeometry(3, 1);
    const globe = sculpt(geo, color, holo);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(2), transparent: true, blending: THREE.AdditiveBlending }));
    const dots = new THREE.Points(geo, new THREE.PointsMaterial({ color: color.clone().multiplyScalar(3), size: 0.45, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    globe.add(edges, dots);
    group.add(globe);
    spinners.push((_t, dt, busy) => { globe.rotation.y += dt * (0.3 + busy * 1.5); });
    disposables.push(edges.geometry, edges.material as THREE.Material, dots.material as THREE.Material);
  } else {
    const core = sculpt(new THREE.DodecahedronGeometry(2.6, 0), color, holo);
    group.add(core);
    spinners.push((_t, dt, busy) => { core.rotation.y += dt * (0.4 + busy * 1.5); });
  }

  // Glow behind the body.
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.setScalar(13);
  group.add(glow);

  // Status halo (billboarded by the scene each frame).
  const halo = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: color.clone() },
      uLoad: { value: 0 },
      uPulse: { value: 1.2 },
      uSpin: { value: 0.03 },
    },
    vertexShader: PLAIN_UV_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const haloGeo = new THREE.PlaneGeometry(11, 11);
  const haloMesh = new THREE.Mesh(haloGeo, halo);
  group.add(haloMesh);

  // Task shards: one small crystal per queued task, orbiting the agent.
  const shards = new THREE.Group();
  group.add(shards);

  const hitGeo = new THREE.SphereGeometry(5.5, 12, 12);
  const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
  group.add(hit);

  return {
    group,
    hit,
    holo,
    halo,
    haloMesh,
    glow,
    shards,
    update: (t, dt, busy) => {
      spinners.forEach((s) => s(t, dt, busy));
      shards.rotation.y += dt * (0.6 + busy * 1.5);
      shards.children.forEach((s, i) => { s.rotation.x += dt * (1 + i * 0.3); s.rotation.z += dt; });
    },
    dispose: () => {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      disposables.forEach((d) => d.dispose());
    },
  };
}

const shardGeo = new THREE.OctahedronGeometry(0.45, 0);

/** Re-populates the task shards to match the agent's current task count (max 8). */
export function setTaskShards(model: AgentModel, count: number, color: THREE.Color) {
  const n = Math.min(8, Math.max(0, count));
  if (model.shards.children.length === n) return;
  model.shards.children.forEach((c) => ((c as THREE.Mesh).material as THREE.Material).dispose());
  model.shards.clear();
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(shardGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
    const a = (i / n) * Math.PI * 2;
    m.position.set(Math.cos(a) * 6.2, Math.sin(a * 2) * 0.8, Math.sin(a) * 6.2);
    model.shards.add(m);
  }
}
