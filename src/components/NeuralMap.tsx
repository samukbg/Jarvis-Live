import React, { useEffect, useRef } from 'react';
import { createNeuralMap, type NeuralAgent, type NeuralMap as Engine } from '../neural/createNeuralMap';

interface Props {
  agents: NeuralAgent[];
  isSpeaking?: boolean;
  onNodeClick?: (id: string, status: string, desc: string) => void;
}

/** The Jarvis Neural Core 3D map (shared engine in src/neural, also bundled for mobile). */
export const NeuralMap: React.FC<Props> = ({ agents, isSpeaking = false, onNodeClick }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;

  useEffect(() => {
    if (!mountRef.current) return;
    const engine = createNeuralMap(mountRef.current, { onNodeClick: (...args) => clickRef.current?.(...args) });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => { engineRef.current?.setAgents(agents); }, [agents]);
  useEffect(() => { engineRef.current?.setSpeaking(isSpeaking); }, [isSpeaking]);

  return <div ref={mountRef} style={{ width: '100%', height: '100%' }} />;
};
