import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import {
  CORE_FRAG, CORE_VERT, GRADE_SHADER, NEBULA_FRAG, NEBULA_VERT, PLAIN_UV_VERT, RADAR_FRAG,
  STARS_FRAG, STARS_VERT, SYNAPSE_FRAG, SYNAPSE_VERT,
} from './shaders';
import { AGENT_COLORS, STATUS_COLORS, createAgentModel, glowTexture, setTaskShards, type AgentModel } from './agentModels';

// Jarvis Neural Core: the live 3D map of Jarvis and its agents. Framework-free,
// used directly by the web app and bundled into the mobile app's WebView.

export interface NeuralAgent {
  id: string;
  name: string;
  status: 'IDLE' | 'THINKING' | 'WRITING' | 'ERROR' | string;
  role?: string;
  description?: string;
  load?: number;
  tasks?: string[];
  prompt?: string;
}

export interface NeuralMapOptions {
  onNodeClick?: (id: string, status: string, desc: string) => void;
  /** 'auto' picks 'low' on phones. */
  quality?: 'high' | 'low' | 'auto';
}

export interface NeuralMap {
  setAgents: (agents: NeuralAgent[]) => void;
  setSpeaking: (speaking: boolean) => void;
  dispose: () => void;
}

const ORBIT_R = 46;
const TILT = THREE.MathUtils.degToRad(14);
const CORE_R = 10;

interface AgentSlot {
  agent: NeuralAgent;
  model: AgentModel;
  anchor: THREE.Vector3; // position in the system group
  bobPhase: number;
  synapse: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial>;
  curve: THREE.QuadraticBezierCurve3;
  packets: THREE.Points;
  packetT: Float32Array;
  label: HTMLDivElement;
  busy: number; // eased 0..1
  error: number; // eased 0..1
  color: THREE.Color;
}

const STYLE_ID = 'jarvis-neural-map-style';
const CSS = `
.nm-root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #01030a; touch-action: none; }
.nm-root canvas { display: block; width: 100% !important; height: 100% !important; outline: none; }
.nm-labels { position: absolute; inset: 0; pointer-events: none; font-family: ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
.nm-label { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); padding: 5px 10px 6px 10px; white-space: nowrap;
  background: linear-gradient(135deg, rgba(8,18,32,0.78), rgba(4,10,20,0.55)); border: 1px solid var(--c); border-radius: 3px;
  box-shadow: 0 0 18px -6px var(--c), inset 0 0 12px -8px var(--c); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  transition: opacity .25s ease; will-change: transform; }
.nm-label::before, .nm-label::after { content: ''; position: absolute; width: 7px; height: 7px; border: 1.5px solid var(--c); }
.nm-label::before { left: -4px; top: -4px; border-right: none; border-bottom: none; }
.nm-label::after { right: -4px; bottom: -4px; border-left: none; border-top: none; }
.nm-name { display: flex; align-items: center; gap: 6px; color: #eaf6ff; font-size: 11px; font-weight: 700; letter-spacing: .16em; }
.nm-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--s); box-shadow: 0 0 8px var(--s); }
.nm-busy .nm-dot { animation: nm-pulse 1s ease-in-out infinite; }
.nm-meta { margin-top: 2px; color: rgba(226,242,255,.62); font-size: 9.5px; letter-spacing: .08em; }
.nm-meta b { color: var(--s); font-weight: 700; }
.nm-stem { position: absolute; left: 50%; top: 100%; width: 1px; height: 14px; background: linear-gradient(var(--c), transparent); }
@keyframes nm-pulse { 50% { opacity: .35; transform: scale(.7); } }
`;

function isPhone() {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || Math.min(window.innerWidth, window.innerHeight) < 600;
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export function createNeuralMap(container: HTMLElement, options: NeuralMapOptions = {}): NeuralMap {
  const quality = options.quality === 'auto' || !options.quality ? (isPhone() ? 'low' : 'high') : options.quality;
  const low = quality === 'low';

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'nm-root';
  container.appendChild(root);
  const labelsLayer = document.createElement('div');
  labelsLayer.className = 'nm-labels';

  // ── Renderer & post ────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: !low, powerPreference: 'high-performance' });
  const dpr = Math.min(window.devicePixelRatio || 1, low ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  root.appendChild(renderer.domElement);
  root.appendChild(labelsLayer);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x01030a, 0.0022);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000);
  camera.position.set(0, 90, 260);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), low ? 0.8 : 0.9, 0.55, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GRADE_SHADER);
  composer.addPass(grade);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 28;
  controls.maxDistance = 260;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.8;
  controls.enabled = false; // until the intro ends

  const glowTex = glowTexture();
  const t0 = performance.now();
  const time = () => (performance.now() - t0) / 1000;

  // ── Environment ────────────────────────────────────────────────────────────
  const nebulaMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: NEBULA_VERT, fragmentShader: NEBULA_FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
  const nebula = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 32), nebulaMat);
  scene.add(nebula);

  const makePoints = (count: number, radius: [number, number], sizes: [number, number], palette: THREE.Color[]) => {
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    const col = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.randomDirection().multiplyScalar(radius[0] + Math.random() * (radius[1] - radius[0]));
      pos.set([v.x, v.y * 0.7, v.z], i * 3);
      size[i] = sizes[0] + Math.pow(Math.random(), 3) * (sizes[1] - sizes[0]);
      phase[i] = Math.random();
      const c = palette[Math.floor(Math.random() * palette.length)];
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: dpr } },
      vertexShader: STARS_VERT,
      fragmentShader: STARS_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    return new THREE.Points(geo, mat);
  };
  const stars = makePoints(low ? 1400 : 3000, [500, 1000], [1.2, 5.5], [new THREE.Color('#dbeafe'), new THREE.Color('#a5f3fc'), new THREE.Color('#c4b5fd'), new THREE.Color('#fde68a')]);
  scene.add(stars);
  const dust = makePoints(low ? 450 : 1100, [30, 180], [0.3, 1.4], [new THREE.Color('#22d3ee').multiplyScalar(0.6), new THREE.Color('#a855f7').multiplyScalar(0.5)]);
  scene.add(dust);

  // ── System group (slow rotation carries agents and synapses) ───────────────
  const system = new THREE.Group();
  scene.add(system);

  // Radar disc.
  const radarMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#22d3ee') } },
    vertexShader: PLAIN_UV_VERT,
    fragmentShader: RADAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const radar = new THREE.Mesh(new THREE.PlaneGeometry(190, 190), radarMat);
  radar.rotation.x = -Math.PI / 2;
  radar.position.y = -30;
  scene.add(radar);

  // Orbit rings on the agents' tilted plane.
  const orbitPlane = new THREE.Group();
  orbitPlane.rotation.x = TILT;
  system.add(orbitPlane);
  const ringLine = (r: number, color: string, opacity: number, dashed: boolean) => {
    const pts = new THREE.EllipseCurve(0, 0, r, r, 0, Math.PI * 2).getPoints(256).map((p) => new THREE.Vector3(p.x, 0, p.y));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 1.6, gapSize: 1.4, blending: THREE.AdditiveBlending, depthWrite: false })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    return line;
  };
  orbitPlane.add(ringLine(ORBIT_R, '#7dd3fc', 0.35, true));
  const outerRing = ringLine(ORBIT_R + 22, '#a78bfa', 0.16, false);
  orbitPlane.add(outerRing);
  // Tick marks on the outer ring, turning slowly.
  const ticks = new THREE.Group();
  const tickGeo = new THREE.BoxGeometry(0.25, 0.25, 2.6);
  const tickMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#a78bfa').multiplyScalar(1.4), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending });
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const tick = new THREE.Mesh(tickGeo, tickMat);
    tick.position.set(Math.cos(a) * (ORBIT_R + 22), 0, Math.sin(a) * (ORBIT_R + 22));
    tick.lookAt(0, 0, 0);
    if (i % 6 === 0) tick.scale.z = 2.2;
    ticks.add(tick);
  }
  orbitPlane.add(ticks);

  // ── Jarvis core ────────────────────────────────────────────────────────────
  const coreGroup = new THREE.Group();
  scene.add(coreGroup);
  const coreMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uColorA: { value: new THREE.Color('#031a33') },
      uColorB: { value: new THREE.Color('#22d3ee') },
      uColorRim: { value: new THREE.Color('#7dd3fc') },
    },
    vertexShader: CORE_VERT,
    fragmentShader: CORE_FRAG,
  });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(CORE_R, low ? 32 : 64), coreMat);
  core.userData = { id: 'JARVIS', status: 'ORCHESTRATING', desc: 'Jarvis core — orchestrates every agent on this map.' };
  coreGroup.add(core);

  const latticeGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(CORE_R * 1.35, 1));
  const lattice = new THREE.LineSegments(latticeGeo, new THREE.LineBasicMaterial({ color: new THREE.Color('#67e8f9').multiplyScalar(1.4), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  coreGroup.add(lattice);

  const shellRings: THREE.Mesh[] = [];
  [
    { r: CORE_R * 1.75, t: 0.06, rot: [Math.PI / 2, 0, 0], c: '#22d3ee' },
    { r: CORE_R * 1.95, t: 0.04, rot: [Math.PI / 3, Math.PI / 5, 0], c: '#a78bfa' },
    { r: CORE_R * 2.2, t: 0.03, rot: [-Math.PI / 4, 0, Math.PI / 6], c: '#67e8f9' },
  ].forEach(({ r, t, rot, c }) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 180), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.set(rot[0], rot[1], rot[2]);
    shellRings.push(m);
    coreGroup.add(m);
  });

  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color('#22d3ee'), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
  coreGlow.scale.setScalar(CORE_R * 5);
  coreGroup.add(coreGlow);

  const coreLight = new THREE.PointLight('#67e8f9', 2600, 0, 2);
  coreGroup.add(coreLight);
  const rim = new THREE.DirectionalLight('#a78bfa', 1.4);
  rim.position.set(-80, 60, -120);
  scene.add(rim, new THREE.AmbientLight('#0b1b33', 1.2));

  // ── Agents ─────────────────────────────────────────────────────────────────
  const slots = new Map<string, AgentSlot>();
  const packetMat = new THREE.PointsMaterial({ size: 2.4, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: false, color: '#ffffff' });

  const statusColor = (a: NeuralAgent, base: THREE.Color) => (STATUS_COLORS[a.status] ? new THREE.Color(STATUS_COLORS[a.status]) : base.clone().multiplyScalar(0.8));
  const statusLabel = (s: string) => (s === 'THINKING' ? 'THINKING' : s === 'WRITING' ? 'WRITING' : s === 'ERROR' ? 'ERROR' : 'STANDBY');

  const buildLabel = (color: THREE.Color) => {
    const el = document.createElement('div');
    el.className = 'nm-label';
    el.innerHTML = '<div class="nm-name"><span class="nm-dot"></span><span class="nm-title"></span></div><div class="nm-meta"><b class="nm-state"></b> · <span class="nm-role"></span></div><div class="nm-stem"></div>';
    el.style.setProperty('--c', `#${color.getHexString()}`);
    labelsLayer.appendChild(el);
    return el;
  };
  const refreshLabel = (slot: AgentSlot) => {
    const { agent, label } = slot;
    const s = statusColor(agent, slot.color);
    label.style.setProperty('--s', `#${s.getHexString()}`);
    label.classList.toggle('nm-busy', agent.status === 'THINKING' || agent.status === 'WRITING');
    (label.querySelector('.nm-title') as HTMLElement).textContent = agent.name.toUpperCase();
    (label.querySelector('.nm-state') as HTMLElement).textContent = statusLabel(agent.status);
    (label.querySelector('.nm-role') as HTMLElement).textContent = (agent.role || agent.description || '').toUpperCase().slice(0, 28);
  };

  const layout = () => {
    const list = [...slots.values()];
    list.forEach((slot, i) => {
      const a = (i / list.length) * Math.PI * 2 + 0.4;
      const local = new THREE.Vector3(Math.cos(a) * ORBIT_R, (i % 2 ? 1 : -1) * 3.5, Math.sin(a) * ORBIT_R);
      slot.anchor.copy(local.applyAxisAngle(new THREE.Vector3(1, 0, 0), TILT));
      slot.model.group.position.copy(slot.anchor);
      // Synapse: core surface → agent, bowed upward for a sense of flow.
      const from = slot.anchor.clone().normalize().multiplyScalar(CORE_R * 1.05);
      const mid = slot.anchor.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 14, 0));
      const to = slot.anchor.clone().sub(slot.anchor.clone().normalize().multiplyScalar(4.2));
      slot.curve.v0.copy(from);
      slot.curve.v1.copy(mid);
      slot.curve.v2.copy(to);
      slot.curve.updateArcLengths(); // curves cache arc lengths; stale ones collapse the tube
      slot.synapse.geometry.dispose();
      slot.synapse.geometry = new THREE.TubeGeometry(slot.curve, 96, 0.3, 8, false);
    });
  };

  const addAgent = (agent: NeuralAgent) => {
    const color = new THREE.Color(AGENT_COLORS[agent.id.toLowerCase()] ?? '#22d3ee');
    const model = createAgentModel(agent.id, glowTex);
    model.group.scale.setScalar(1.25);
    model.hit.userData = { agentId: agent.id };
    system.add(model.group);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
    const synapse = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 8, 0.16, 6, false),
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uColor: { value: color.clone().multiplyScalar(1.6) }, uActivity: { value: 0 } },
        vertexShader: SYNAPSE_VERT,
        fragmentShader: SYNAPSE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    system.add(synapse);
    const packetCount = 8;
    const packetGeo = new THREE.BufferGeometry();
    packetGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(packetCount * 3), 3));
    const packets = new THREE.Points(packetGeo, packetMat.clone());
    (packets.material as THREE.PointsMaterial).color = color.clone().multiplyScalar(2.5);
    packets.visible = false;
    system.add(packets);
    const packetT = new Float32Array(packetCount).map((_, i) => i / packetCount);
    const slot: AgentSlot = {
      agent, model, anchor: new THREE.Vector3(), bobPhase: Math.random() * Math.PI * 2,
      synapse, curve, packets, packetT, label: buildLabel(color), busy: 0, error: 0, color,
    };
    slots.set(agent.id, slot);
    refreshLabel(slot);
  };

  const removeAgent = (id: string) => {
    const slot = slots.get(id);
    if (!slot) return;
    system.remove(slot.model.group, slot.synapse, slot.packets);
    slot.model.dispose();
    slot.synapse.geometry.dispose();
    slot.synapse.material.dispose();
    slot.packets.geometry.dispose();
    (slot.packets.material as THREE.Material).dispose();
    slot.label.remove();
    slots.delete(id);
  };

  const setAgents = (agents: NeuralAgent[]) => {
    const ids = new Set(agents.map((a) => a.id));
    let changed = false;
    [...slots.keys()].forEach((id) => { if (!ids.has(id)) { removeAgent(id); changed = true; } });
    agents.forEach((a) => {
      const slot = slots.get(a.id);
      if (!slot) { addAgent(a); changed = true; return; }
      slot.agent = a;
      refreshLabel(slot);
    });
    if (changed) layout();
    slots.forEach((slot) => setTaskShards(slot.model, slot.agent.tasks?.length ?? 0, slot.color));
  };

  // ── Speaking ───────────────────────────────────────────────────────────────
  let speakingTarget = 0;
  let energy = 0;
  const setSpeaking = (on: boolean) => { speakingTarget = on ? 1 : 0; };

  // ── Camera direction: intro, focus, return ─────────────────────────────────
  const home = { pos: new THREE.Vector3(0, 34, 118), target: new THREE.Vector3(0, 0, 0) };
  /** Far enough for the whole orbit to fit the screen width; higher up in portrait. */
  const homeFor = (aspect: number, fov: number) => {
    const halfW = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect;
    const dist = Math.max(124, (ORBIT_R + 16) / halfW);
    const elevation = THREE.MathUtils.degToRad(aspect < 1 ? 38 : 16);
    return new THREE.Vector3(0, Math.sin(elevation) * dist, Math.cos(elevation) * dist);
  };
  let tween: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; start: number; dur: number } | null = {
    fromPos: camera.position.clone(), toPos: home.pos.clone(), fromT: new THREE.Vector3(0, 10, 0), toT: home.target.clone(), start: 0, dur: 3.2,
  };
  let focused: string | null = null;
  const flyTo = (pos: THREE.Vector3, target: THREE.Vector3, dur = 1.4) => {
    tween = { fromPos: camera.position.clone(), toPos: pos, fromT: controls.target.clone(), toT: target, start: time(), dur };
    controls.enabled = false;
  };

  // ── Interaction ────────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const onUp = (e: PointerEvent) => {
    if (!down) return;
    const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 450;
    down = null;
    if (!tap) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([core, ...[...slots.values()].map((s) => s.model.hit)], false);
    if (!hits.length) {
      if (focused) { focused = null; flyTo(home.pos.clone(), home.target.clone()); }
      return;
    }
    const obj = hits[0].object;
    if (obj === core) {
      focused = null;
      flyTo(new THREE.Vector3(0, 12, 46), new THREE.Vector3());
      options.onNodeClick?.('JARVIS', 'ORCHESTRATING', core.userData.desc);
      return;
    }
    const slot = slots.get(obj.userData.agentId);
    if (!slot) return;
    focused = slot.agent.id;
    const world = slot.model.group.getWorldPosition(new THREE.Vector3());
    const out = world.clone().setY(0).normalize();
    // Keep the whole agent (halo included) in frame on narrow screens.
    const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect);
    const dist = Math.max(26, 13 / halfW);
    flyTo(world.clone().add(out.multiplyScalar(dist)).add(new THREE.Vector3(0, dist * 0.35, 0)), world);
    const a = slot.agent;
    options.onNodeClick?.(a.name, a.status, [a.role, a.description, a.prompt ? `Current task: ${a.prompt}` : ''].filter(Boolean).join('\n\n'));
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);

  // ── Resize ─────────────────────────────────────────────────────────────────
  const resize = () => {
    const w = root.clientWidth || container.clientWidth || window.innerWidth;
    const h = root.clientHeight || container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    // Portrait screens: pull back so the whole orbit stays in frame.
    camera.fov = w < h ? 58 : 45;
    camera.updateProjectionMatrix();
    const nextHome = homeFor(camera.aspect, camera.fov);
    if (!nextHome.equals(home.pos)) {
      home.pos.copy(nextHome);
      controls.maxDistance = Math.max(260, nextHome.length() * 1.6);
      if (tween && tween.start === 0) tween.toPos.copy(nextHome); // still in the intro
      else if (!focused) flyTo(home.pos.clone(), home.target.clone(), 0.8);
    }
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w * (low ? 0.4 : 0.5), h * (low ? 0.4 : 0.5));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  resize();

  // ── Frame loop ─────────────────────────────────────────────────────────────
  let raf = 0;
  let last = time();
  const tmp = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (document.visibilityState === 'hidden') return;
    const t = time();
    const dt = Math.min(0.05, t - last);
    last = t;

    // Camera tween.
    if (tween) {
      const k = Math.min(1, (t - tween.start) / tween.dur);
      const e = easeInOut(k);
      camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
      controls.target.lerpVectors(tween.fromT, tween.toT, e);
      if (k >= 1) { tween = null; controls.enabled = true; }
    }
    controls.update();

    energy += (speakingTarget - energy) * (1 - Math.exp(-dt * 4));
    coreMat.uniforms.uTime.value = t;
    coreMat.uniforms.uEnergy.value = energy;
    core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.015 + energy * 0.06);
    lattice.rotation.y = t * 0.12;
    lattice.rotation.x = Math.sin(t * 0.2) * 0.3;
    shellRings.forEach((r, i) => { r.rotation.z += dt * (0.15 + i * 0.1) * (1 + energy * 2); });
    (coreGlow.material as THREE.SpriteMaterial).opacity = 0.3 + energy * 0.3 + Math.sin(t * 2) * 0.04;
    coreLight.intensity = 2600 * (1 + energy * 0.8);

    nebulaMat.uniforms.uTime.value = t;
    (stars.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    (dust.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    dust.rotation.y = t * 0.008;
    radarMat.uniforms.uTime.value = t;
    ticks.rotation.y = -t * 0.03;
    grade.uniforms.uTime.value = t;

    system.rotation.y = focused ? system.rotation.y : system.rotation.y + dt * 0.04;
    camera.getWorldDirection(camDir);

    slots.forEach((slot) => {
      const st = slot.agent.status;
      const busyTarget = st === 'THINKING' || st === 'WRITING' ? 1 : 0;
      slot.busy += (busyTarget - slot.busy) * (1 - Math.exp(-dt * 3));
      slot.error += ((st === 'ERROR' ? 1 : 0) - slot.error) * (1 - Math.exp(-dt * 4));
      const g = slot.model.group;
      g.position.copy(slot.anchor).add(tmp.set(0, Math.sin(t * 0.9 + slot.bobPhase) * 1.2, 0));
      slot.model.update(t, dt, slot.busy);
      const isFocus = focused === slot.agent.id ? 1 : 0;
      slot.model.holo.forEach((m) => {
        m.uniforms.uTime.value = t;
        m.uniforms.uActive.value = slot.busy;
        m.uniforms.uGlitch.value = slot.error;
        m.uniforms.uFocus.value += (isFocus * 0.35 - m.uniforms.uFocus.value) * 0.1;
      });
      // Halo faces the camera; colour and tempo follow the status.
      slot.model.haloMesh.quaternion.copy(camera.quaternion);
      const h = slot.model.halo.uniforms;
      h.uTime.value = t;
      (h.uColor.value as THREE.Color).copy(statusColor(slot.agent, slot.color));
      h.uLoad.value += (Math.min(1, (slot.agent.load ?? 0) / 100) - h.uLoad.value) * 0.05;
      h.uPulse.value = st === 'THINKING' ? 5 : st === 'WRITING' ? 8 : st === 'ERROR' ? 14 : 1.2;
      h.uSpin.value = 0.03 + slot.busy * 0.25;
      // Glows fade as the camera gets close, so a close-up never washes out.
      const near = THREE.MathUtils.clamp(camera.position.distanceTo(g.getWorldPosition(tmp)) / 70, 0.2, 1);
      (slot.model.glow.material as THREE.SpriteMaterial).opacity = (0.35 + slot.busy * 0.4) * near;

      const sm = slot.synapse.material.uniforms;
      sm.uTime.value = t;
      sm.uActivity.value = Math.max(slot.busy, slot.error * 0.3);
      (sm.uColor.value as THREE.Color).copy(slot.error > 0.5 ? new THREE.Color('#ef4444') : slot.color).multiplyScalar(1.6);

      // Data packets riding the synapse while the agent works.
      slot.packets.visible = slot.busy > 0.05;
      if (slot.packets.visible) {
        const arr = (slot.packets.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        for (let i = 0; i < slot.packetT.length; i++) {
          const dir = i % 2 ? -1 : 1;
          slot.packetT[i] = (slot.packetT[i] + dir * dt * (0.25 + (i % 3) * 0.08) + 1) % 1;
          const p = slot.curve.getPoint(slot.packetT[i]);
          arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
        }
        slot.packets.geometry.attributes.position.needsUpdate = true;
        (slot.packets.material as THREE.PointsMaterial).opacity = slot.busy;
      }
    });

    composer.render();

    // Labels: project each agent, hide when the core is in the way.
    const w = root.clientWidth;
    const hgt = root.clientHeight;
    slots.forEach((slot) => {
      const world = slot.model.group.getWorldPosition(tmp).add(new THREE.Vector3(0, 7.5, 0));
      const toAgent = world.clone().sub(camera.position);
      const dist = toAgent.length();
      const along = -camera.position.dot(toAgent) / dist; // distance to the point closest to the core
      const closest = camera.position.clone().add(toAgent.clone().multiplyScalar(along / dist));
      const hidden = along > 0 && along < dist && closest.length() < CORE_R * 1.3;
      const p = world.project(camera);
      const visible = !hidden && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      slot.label.style.opacity = visible ? '1' : '0';
      if (visible) {
        const scale = THREE.MathUtils.clamp(90 / dist, 0.7, 1.15);
        // Keep the label on screen: clamp its centre by half its (scaled) width.
        const half = (slot.label.offsetWidth * scale) / 2 + 6;
        const x = THREE.MathUtils.clamp((p.x * 0.5 + 0.5) * w, half, Math.max(half, w - half));
        const y = Math.max(slot.label.offsetHeight * scale + 6, (-p.y * 0.5 + 0.5) * hgt - 14);
        slot.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      }
    });
  };
  frame();

  return {
    setAgents,
    setSpeaking,
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      [...slots.keys()].forEach(removeAgent);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      glowTex.dispose();
      composer.dispose();
      renderer.dispose();
      root.remove();
    },
  };
}
