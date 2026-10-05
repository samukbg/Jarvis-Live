import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, audioVisualizerData } from '../store';

const vertexShader = `
uniform float uTime;
uniform float uNoiseIntensity;
uniform float uDisplacementStrength;

vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
  return mod289(((x*34.0)+10.0)*x);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec3 fade(vec3 t) {
  return t*t*t*(t*(t*6.0-15.0)+10.0);
}

float pnoise(vec3 P, vec3 rep) {
  vec3 Pi0 = mod(floor(P), rep); // Integer part, modulo period
  vec3 Pi1 = mod(Pi0 + vec3(1.0), rep); // Integer part + 1, mod period
  Pi0 = mod289(Pi0);
  Pi1 = mod289(Pi1);
  vec3 Pf0 = fract(P); // Fractional part for interpolation
  vec3 Pf1 = Pf0 - vec3(1.0); // Fractional part - 1.0
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;

  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);

  vec4 gx0 = ixy0 * (1.0 / 7.0);
  vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);

  vec4 gx1 = ixy1 * (1.0 / 7.0);
  vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);

  vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
  vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
  vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
  vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
  vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
  vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
  vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
  vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);

  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;

  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);

  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x); 
  return 2.2 * n_xyz;
}

void main() {
  float noise = uNoiseIntensity * pnoise(position + uTime, vec3(10.0));
  float displacement = noise * uDisplacementStrength;
  vec3 newPosition = position + normal * displacement;
  vec4 modelPosition = modelMatrix * vec4(newPosition, 1.0);
  vec4 viewPosition = viewMatrix * modelPosition;
  vec4 projectedPosition = projectionMatrix * viewPosition;

  gl_Position = projectedPosition;
}
`;

const fragmentShader = `
uniform vec2 uResolution;
uniform vec3 uColor;
uniform float uOpacity;

void main() {
  vec2 color = gl_FragCoord.xy / uResolution;
  // Blend base color with the color varying by coordinates
  vec3 finalColor = uColor * (0.5 + 0.5 * color.x) + vec3(0.1, 0.1, 0.2);
  gl_FragColor = vec4(finalColor, uOpacity);
}
`;

// ── BlobMesh ─────────────────────────────────────────────────────────────────
// Uses direct refs to the THREE.ShaderMaterial instances so useFrame can
// mutate their uniforms directly.  R3F's reconciler clones uniform values
// when applying props, so the previous "shared uniforms" approach never
// actually reached the GPU.
const BlobMesh = (_props: { onClick?: () => void }) => {
  const meshRef = useRef<THREE.Group>(null);
  const wireMatRef = useRef<THREE.ShaderMaterial>(null);
  const fillMatRef = useRef<THREE.ShaderMaterial>(null);

  const isDelegating = useStore(state => state.agents.some(a => ['agy', 'claude', 'hermes', 'codex', 'openclaw'].includes(a.id) && a.status !== 'IDLE'));

  // Initial uniform objects — only used at mount, then we mutate via refs
  const initUniforms = useMemo(() => ({
    uTime:                 { value: 0 },
    uNoiseIntensity:       { value: 1.5 },
    uDisplacementStrength: { value: 0.2 },
    uResolution:           { value: new THREE.Vector2(300, 300) },
    uColor:                { value: new THREE.Color('#22d3ee') },
    uOpacity:              { value: 1.0 },
  }), []);

  const initFillUniforms = useMemo(() => ({
    uTime:                 { value: 0 },
    uNoiseIntensity:       { value: 1.5 },
    uDisplacementStrength: { value: 0.2 },
    uResolution:           { value: new THREE.Vector2(300, 300) },
    uColor:                { value: new THREE.Color('#22d3ee') },
    uOpacity:              { value: 0.15 },
  }), []);

  // Reusable color objects
  const cyanColor = useMemo(() => new THREE.Color('#22d3ee'), []);
  const redColor  = useMemo(() => new THREE.Color('#ef4444'), []);

  // Interpolated animation state
  const anim = useRef({
    noiseIntensity: 1.5,
    displacementStrength: 0.2,
    rotSpeedX: 0.005,
    rotSpeedY: 0.005,
  });

  const isListening = useStore(state => state.voiceState.isListening);
  const isSpeaking = useStore(state => state.voiceState.isSpeaking);

  useFrame((state) => {
    if (!meshRef.current) return;
    const wMat = wireMatRef.current;
    const fMat = fillMatRef.current;
    if (!wMat || !fMat) return;

    const t = state.clock.getElapsedTime();
    wMat.uniforms.uTime.value = t;
    fMat.uniforms.uTime.value = t;

    const audioData = audioVisualizerData.data;

    let targetNoise = 1.0;
    let targetDisp = 0.1;
    let targetRotX = 0.005;
    let targetRotY = 0.005;
    let speed = 0.12;

    if (isDelegating) {
      speed = 0.15;
      targetNoise = 2.2;
      targetDisp = 0.35;
      targetRotX = 0.03;
      targetRotY = 0.04;
    } else if (isSpeaking) {
      speed = 0.22;
      let maxAudio = 0;
      if (audioData && audioData.length > 0) {
        maxAudio = Math.max(...audioData) / 255.0;
      }
      const intensity = Math.max(0.2, (window as any).avatarVolume || maxAudio || (0.4 + 0.35 * Math.sin(t * 10.0)));
      targetNoise = 1.2 + intensity * 2.5;
      targetDisp = 0.15 + intensity * 0.65;
      targetRotX = 0.008 + intensity * 0.025;
      targetRotY = 0.01 + intensity * 0.025;
    } else if (isListening) {
      speed = 0.18;
      targetNoise = 1.8;
      targetDisp = 0.25;
      targetRotX = 0.012;
      targetRotY = 0.018;
    }

    const targetColor = isListening ? redColor : cyanColor;
    wMat.uniforms.uColor.value.lerp(targetColor, 0.1);
    fMat.uniforms.uColor.value.lerp(targetColor, 0.1);

    anim.current.noiseIntensity += (targetNoise - anim.current.noiseIntensity) * speed;
    anim.current.displacementStrength += (targetDisp - anim.current.displacementStrength) * speed;
    anim.current.rotSpeedX += (targetRotX - anim.current.rotSpeedX) * speed;
    anim.current.rotSpeedY += (targetRotY - anim.current.rotSpeedY) * speed;

    wMat.uniforms.uNoiseIntensity.value = anim.current.noiseIntensity;
    wMat.uniforms.uDisplacementStrength.value = anim.current.displacementStrength;
    fMat.uniforms.uNoiseIntensity.value = anim.current.noiseIntensity;
    fMat.uniforms.uDisplacementStrength.value = anim.current.displacementStrength;

    meshRef.current.rotation.x += anim.current.rotSpeedX;
    meshRef.current.rotation.y += anim.current.rotSpeedY;
  });

  return (
    <group
      ref={meshRef}
      position={[0, 0, 0]}
      scale={[1.52, 1.52, 1.52]}
    >
      {/* Wireframe Mesh */}
      <mesh>
        {isDelegating ? (
          <torusKnotGeometry args={[1.2, 0.4, 128, 32, 3, 4]} />
        ) : (
          <icosahedronGeometry args={[2, 40]} />
        )}
        <shaderMaterial
          ref={wireMatRef}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          uniforms={initUniforms}
          wireframe={true}
          transparent={true}
        />
      </mesh>
      {/* Transparent Fill Mesh */}
      <mesh scale={0.99}>
        {isDelegating ? (
          <torusKnotGeometry args={[1.2, 0.4, 128, 32, 3, 4]} />
        ) : (
          <icosahedronGeometry args={[2, 40]} />
        )}
        <shaderMaterial
          ref={fillMatRef}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          uniforms={initFillUniforms}
          wireframe={false}
          transparent={true}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
};

// ── Public component ─────────────────────────────────────────────────────────
interface BlobAnimationProps {
  onClick?: () => void;
}

export const BlobAnimation: React.FC<BlobAnimationProps> = ({ onClick }) => {
  return (
    <div 
      className="w-full h-full relative flex justify-center items-center pointer-events-auto cursor-pointer select-none"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <Canvas camera={{ position: [0, 0, 7.5], fov: 60 }}>
        <BlobMesh />
      </Canvas>
    </div>
  );
};
