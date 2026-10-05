// GLSL for the Neural Core scene. Values above 1.0 are intentional: they feed bloom.

/** 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT). */
export const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * snoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

// ── Jarvis core: displaced plasma sphere ─────────────────────────────────────
export const CORE_VERT = /* glsl */ `
uniform float uTime;
uniform float uEnergy;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
varying float vNoise;
${SIMPLEX}
void main() {
  float n = snoise(position * 0.16 + vec3(0.0, uTime * 0.35, uTime * 0.2));
  float n2 = snoise(position * 0.45 - vec3(uTime * 0.6));
  float disp = n * (0.35 + uEnergy * 1.3) + n2 * (0.12 + uEnergy * 0.5);
  vec3 p = position + normal * disp;
  vNoise = n;
  vLocal = p;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const CORE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uEnergy;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorRim;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
varying float vNoise;
${SIMPLEX}
void main() {
  vec3 v = normalize(cameraPosition - vPosW);
  float fres = pow(1.0 - max(dot(normalize(vNormalW), v), 0.0), 2.2);
  float bands = fbm(vLocal * 0.22 + vec3(0.0, uTime * 0.25, 0.0)) * 0.5 + 0.5;
  float veins = smoothstep(0.46, 0.5, abs(snoise(vLocal * 0.5 + uTime * 0.3)) ) ;
  vec3 col = mix(uColorA, uColorB * 0.55, bands) * (0.45 + 0.5 * (vNoise * 0.5 + 0.5));
  col += uColorB * (1.0 - veins) * (0.22 + 0.3 * uEnergy);
  col += uColorRim * fres * (1.4 + 0.8 * uEnergy);
  col *= 1.0 + uEnergy * 0.2;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ── Hologram shell for agent bodies ──────────────────────────────────────────
export const HOLO_VERT = /* glsl */ `
uniform float uTime;
uniform float uGlitch;
varying vec3 vNormalW;
varying vec3 vPosW;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec3 p = position;
  // Error state: horizontal slices jump sideways.
  float slice = floor((p.y + uTime * 3.0) * 4.0);
  float jump = step(0.82, hash(slice + floor(uTime * 12.0))) * uGlitch;
  p.x += (hash(slice * 1.7 + floor(uTime * 20.0)) - 0.5) * 1.4 * jump;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const HOLO_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uActive;
uniform float uGlitch;
uniform float uFocus;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vec3 v = normalize(cameraPosition - vPosW);
  float fres = pow(1.0 - abs(dot(normalize(vNormalW), v)), 2.4);
  float scan = smoothstep(0.7, 1.0, sin(vPosW.y * 6.0 - uTime * 5.0) * 0.5 + 0.5);
  float flicker = 1.0 - uGlitch * step(0.7, fract(sin(floor(uTime * 24.0)) * 43758.5)) * 0.6;
  vec3 col = uColor * (0.18 + fres * (1.6 + 1.4 * uActive + uFocus)) + uColor * scan * (0.12 + 0.3 * uActive);
  col = mix(col, vec3(1.0, 0.2, 0.25) * (0.4 + fres * 2.0), uGlitch * 0.7);
  float alpha = clamp(0.35 + fres * 0.65 + scan * 0.1, 0.0, 1.0);
  gl_FragColor = vec4(col * flicker, alpha);
}
`;

// ── Synapse: curved tube with travelling light pulses ────────────────────────
export const SYNAPSE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SYNAPSE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uActivity;
varying vec2 vUv;
float pulse(float x) { return exp(-x * x * 900.0); }
void main() {
  float s = vUv.x;
  float speed = mix(0.12, 0.9, uActivity);
  float outP = pulse(fract(s * 2.0 - uTime * speed) - 0.5);
  float inP = pulse(fract(s * 3.0 + uTime * speed * 0.8) - 0.5) * uActivity;
  float base = mix(0.12, 0.35, uActivity);
  float intensity = base + (outP * (0.6 + 2.6 * uActivity) + inP * 2.0);
  float ends = smoothstep(0.0, 0.06, s) * smoothstep(1.0, 0.94, s);
  // Brighter core line along the tube.
  float core = pow(1.0 - abs(vUv.y - 0.5) * 2.0, 2.0);
  gl_FragColor = vec4(uColor * intensity * (0.35 + core) * ends, 1.0);
}
`;

// ── Holographic radar disc under the system ──────────────────────────────────
export const RADAR_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  // Distance to the nearest ring / spoke line, in line units.
  float rd = 0.5 - abs(fract(r * 9.0) - 0.5);
  float sd = (0.5 - abs(fract(a / 6.2831853 * 24.0) - 0.5)) * r * 6.0;
  float rings = smoothstep(0.05, 0.0, rd);
  float spokes = smoothstep(0.03, 0.0, sd) * step(0.18, r);
  float sweepA = fract((a / 6.2831853) - uTime * 0.08);
  // Bright leading edge, long soft trail.
  float sweep = pow(sweepA, 5.0) * smoothstep(1.0, 0.965, sweepA);
  float fade = smoothstep(1.0, 0.55, r) * smoothstep(0.08, 0.25, r);
  float intensity = (rings * 0.26 + spokes * 0.08 + sweep * 0.22 + rings * sweep * 0.6) * fade;
  gl_FragColor = vec4(uColor * intensity, intensity * 0.7);
}
`;

// ── Status halo: segmented arc ring facing the camera ────────────────────────
export const HALO_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uLoad;
uniform float uPulse;
uniform float uSpin;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = fract(atan(p.y, p.x) / 6.2831853 + 0.25 - uTime * uSpin);
  float ring = smoothstep(0.035, 0.0, abs(r - 0.86) - 0.03);
  float segs = step(0.25, fract(a * 36.0));
  float inner = smoothstep(0.02, 0.0, abs(r - 0.72) - 0.008) * 0.5;
  // Load arc: brighter part of the ring, sized by the agent's load.
  float loadArc = step(a, uLoad) * smoothstep(0.03, 0.0, abs(r - 0.95) - 0.02);
  float beat = 0.55 + 0.45 * sin(uTime * uPulse);
  float intensity = ring * segs * beat * 1.4 + inner * beat + loadArc * 1.6;
  gl_FragColor = vec4(uColor * intensity, 1.0);
}
`;

export const PLAIN_UV_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// ── Deep-space nebula dome ────────────────────────────────────────────────────
export const NEBULA_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const NEBULA_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vDir;
${SIMPLEX}
void main() {
  vec3 d = normalize(vDir);
  float n1 = fbm(d * 2.2 + vec3(uTime * 0.004, 0.0, 0.0));
  float n2 = fbm(d * 4.5 + vec3(0.0, uTime * 0.006, 3.0));
  float band = smoothstep(0.55, 0.0, abs(d.y + 0.15 * n1));
  vec3 base = vec3(0.004, 0.008, 0.02);
  vec3 violet = vec3(0.16, 0.05, 0.32);
  vec3 teal = vec3(0.02, 0.18, 0.26);
  vec3 magenta = vec3(0.28, 0.04, 0.18);
  vec3 col = base;
  col += violet * smoothstep(0.0, 0.9, n1) * 0.28 * (0.3 + band);
  col += teal * smoothstep(0.1, 1.0, n2) * 0.26 * band;
  col += magenta * pow(smoothstep(0.35, 1.0, n1 * n2 + 0.3), 2.0) * 0.18;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ── Twinkling stars / dust points ─────────────────────────────────────────────
export const STARS_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vTwinkle;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vTwinkle = 0.55 + 0.45 * sin(uTime * (0.6 + aPhase * 1.8) + aPhase * 40.0);
  vColor = aColor;
  gl_PointSize = aSize * uPixelRatio * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const STARS_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vTwinkle;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(vColor * vTwinkle * a, a * vTwinkle);
}
`;

// ── Final grade: vignette, subtle chromatic aberration, film grain ───────────
export const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.0016 },
  },
  vertexShader: PLAIN_UV_VERT,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uAberration;
varying vec2 vUv;
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c);
  vec2 off = c * uAberration * (1.0 + d * 2.0);
  vec3 col;
  col.r = texture2D(tDiffuse, vUv + off).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv - off).b;
  col *= smoothstep(0.95, 0.35, d);
  col += (rand(vUv * 1000.0 + uTime) - 0.5) * 0.035;
  gl_FragColor = vec4(col, 1.0);
}
`,
};
