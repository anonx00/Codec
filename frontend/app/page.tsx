'use client';

import { useState, useEffect, useRef, useCallback, Suspense, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Text, Effects } from '@react-three/drei';
import * as THREE from 'three';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

// ============================================================================
// TYPES
// ============================================================================

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  callData?: CallData;
}

interface CallData {
  action: string;
  phone: string;
  task: string;
  business: string;
  details: string;
}

interface CallStatus {
  sid: string;
  status: string;
  duration?: number;
  summaryStatus?: 'processing' | 'complete' | 'error' | null;
  summary?: string | null;
}

interface InboundConfig {
  enabled: boolean;
  greeting: string;
  businessName: string;
  purpose: string;
  instructions: string;
}

type View = 'login' | 'chat' | 'calling' | 'settings';

// ============================================================================
// THREE.JS COMPONENTS - MGS CODEC STYLE
// ============================================================================

// Animated grid background
function GridBackground() {
  const gridRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (gridRef.current) {
      // Subtle pulse effect
      gridRef.current.children.forEach((child, i) => {
        const mesh = child as THREE.Mesh;
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = 0.1 + Math.sin(state.clock.elapsedTime * 2 + i * 0.1) * 0.05;
      });
    }
  });

  return (
    <group ref={gridRef} position={[0, 0, -2]}>
      {/* Vertical lines */}
      {Array.from({ length: 25 }).map((_, i) => (
        <mesh key={`v-${i}`} position={[-3 + i * 0.25, 0, 0]}>
          <planeGeometry args={[0.005, 6]} />
          <meshBasicMaterial color="#00ff88" transparent opacity={0.1} />
        </mesh>
      ))}
      {/* Horizontal lines */}
      {Array.from({ length: 20 }).map((_, i) => (
        <mesh key={`h-${i}`} position={[0, -2.5 + i * 0.25, 0]}>
          <planeGeometry args={[8, 0.005]} />
          <meshBasicMaterial color="#00ff88" transparent opacity={0.1} />
        </mesh>
      ))}
    </group>
  );
}

// Animated static/noise particles
function StaticNoise({ active }: { active: boolean }) {
  const particlesRef = useRef<THREE.Points>(null);
  const particleCount = 200;

  const positions = useMemo(() => {
    const pos = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 6;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    }
    return pos;
  }, []);

  useFrame((state) => {
    if (particlesRef.current && active) {
      const positions = particlesRef.current.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < particleCount; i++) {
        // Random flicker
        if (Math.random() > 0.95) {
          positions[i * 3] = (Math.random() - 0.5) * 6;
          positions[i * 3 + 1] = (Math.random() - 0.5) * 4;
        }
      }
      particlesRef.current.geometry.attributes.position.needsUpdate = true;

      const material = particlesRef.current.material as THREE.PointsMaterial;
      material.opacity = 0.3 + Math.sin(state.clock.elapsedTime * 20) * 0.2;
    }
  });

  return (
    <points ref={particlesRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particleCount}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        color="#00ff88"
        size={0.02}
        transparent
        opacity={active ? 0.4 : 0.1}
        sizeAttenuation
      />
    </points>
  );
}

// Radar sweep effect
function RadarSweep({ position, size = 0.8 }: { position: [number, number, number]; size?: number }) {
  const sweepRef = useRef<THREE.Mesh>(null);
  const [angle, setAngle] = useState(0);

  useFrame((state) => {
    const newAngle = state.clock.elapsedTime * 2;
    setAngle(newAngle);
    if (sweepRef.current) {
      sweepRef.current.rotation.z = newAngle;
    }
  });

  return (
    <group position={position}>
      {/* Radar circles */}
      {[0.2, 0.4, 0.6, 0.8].map((r, i) => (
        <mesh key={i}>
          <ringGeometry args={[r * size - 0.01, r * size, 64]} />
          <meshBasicMaterial color="#00ff88" transparent opacity={0.2} />
        </mesh>
      ))}
      {/* Sweep line */}
      <mesh ref={sweepRef}>
        <planeGeometry args={[size, 0.01]} />
        <meshBasicMaterial color="#00ff88" transparent opacity={0.8} />
      </mesh>
      {/* Center dot */}
      <mesh>
        <circleGeometry args={[0.03, 16]} />
        <meshBasicMaterial color="#00ff88" />
      </mesh>
    </group>
  );
}

// Enhanced portrait with face silhouette
function EnhancedPortrait({ speaking, isAI, label }: { speaking: boolean; isAI: boolean; label: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const waveRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (groupRef.current) {
      // Breathing animation
      const breathe = 1 + Math.sin(state.clock.elapsedTime * 2) * 0.01;
      groupRef.current.scale.set(breathe, breathe, 1);
    }

    if (glowRef.current) {
      const material = glowRef.current.material as THREE.MeshBasicMaterial;
      if (speaking) {
        material.opacity = 0.4 + Math.sin(state.clock.elapsedTime * 8) * 0.3;
      } else {
        material.opacity = 0.15 + Math.sin(state.clock.elapsedTime * 2) * 0.05;
      }
    }

    // Voice waves animation
    if (waveRef.current && speaking) {
      waveRef.current.children.forEach((child, i) => {
        const mesh = child as THREE.Mesh;
        const scale = 1 + Math.sin(state.clock.elapsedTime * 12 + i * 1.5) * 0.15;
        mesh.scale.set(scale, scale, 1);
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = (1 - i * 0.25) * (0.5 + Math.sin(state.clock.elapsedTime * 10) * 0.3);
      });
    }
  });

  const color = isAI ? '#00ff88' : '#00aaff';

  return (
    <group ref={groupRef}>
      {/* Outer glow */}
      <mesh ref={glowRef} position={[0, 0, -0.2]}>
        <circleGeometry args={[0.9, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.2} />
      </mesh>

      {/* Portrait border - octagon */}
      <mesh>
        <ringGeometry args={[0.7, 0.75, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>

      {/* Inner border */}
      <mesh>
        <ringGeometry args={[0.55, 0.58, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} />
      </mesh>

      {/* Face silhouette area */}
      <mesh>
        <circleGeometry args={[0.52, 32]} />
        <meshBasicMaterial color="#001a0d" />
      </mesh>

      {/* Simple face silhouette */}
      <group position={[0, 0.05, 0.01]}>
        {/* Head outline */}
        <mesh position={[0, 0.1, 0]}>
          <circleGeometry args={[0.25, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.15} />
        </mesh>
        {/* Shoulders */}
        <mesh position={[0, -0.25, 0]}>
          <planeGeometry args={[0.5, 0.2]} />
          <meshBasicMaterial color={color} transparent opacity={0.15} />
        </mesh>
      </group>

      {/* Voice waves - when speaking */}
      <group ref={waveRef} position={[0, 0, 0.05]}>
        {speaking && [0.6, 0.75, 0.9].map((size, i) => (
          <mesh key={i}>
            <ringGeometry args={[size - 0.02, size, 32]} />
            <meshBasicMaterial color={color} transparent opacity={0.3} />
          </mesh>
        ))}
      </group>

      {/* Corner decorations */}
      {[
        { pos: [-0.6, 0.6, 0], rot: 0 },
        { pos: [0.6, 0.6, 0], rot: Math.PI / 2 },
        { pos: [0.6, -0.6, 0], rot: Math.PI },
        { pos: [-0.6, -0.6, 0], rot: -Math.PI / 2 }
      ].map((corner, i) => (
        <group key={i} position={corner.pos as [number, number, number]} rotation={[0, 0, corner.rot]}>
          <mesh position={[0.08, 0, 0]}>
            <planeGeometry args={[0.15, 0.02]} />
            <meshBasicMaterial color={color} />
          </mesh>
          <mesh position={[0, 0.08, 0]}>
            <planeGeometry args={[0.02, 0.15]} />
            <meshBasicMaterial color={color} />
          </mesh>
        </group>
      ))}

      {/* Status indicator */}
      <mesh position={[0, -0.9, 0]}>
        <circleGeometry args={[0.04, 16]} />
        <meshBasicMaterial color={speaking ? '#ffffff' : color} />
      </mesh>
    </group>
  );
}

// Enhanced waveform display
function EnhancedWaveform({ active }: { active: boolean }) {
  const barsRef = useRef<THREE.Group>(null);
  const barCount = 32;

  useFrame((state) => {
    if (barsRef.current) {
      barsRef.current.children.forEach((child, i) => {
        const mesh = child as THREE.Mesh;
        if (active) {
          // Complex waveform simulation
          const wave1 = Math.sin(state.clock.elapsedTime * 8 + i * 0.3);
          const wave2 = Math.sin(state.clock.elapsedTime * 12 + i * 0.2);
          const noise = Math.random() * 0.3;
          const scale = 0.3 + Math.abs(wave1 * 0.5 + wave2 * 0.3 + noise);
          mesh.scale.y = scale;

          const material = mesh.material as THREE.MeshBasicMaterial;
          material.opacity = 0.6 + scale * 0.4;
        } else {
          mesh.scale.y = 0.1 + Math.sin(state.clock.elapsedTime + i * 0.5) * 0.05;
        }
      });
    }
  });

  return (
    <group ref={barsRef}>
      {Array.from({ length: barCount }).map((_, i) => (
        <mesh key={i} position={[-1.5 + i * (3 / barCount), 0, 0]}>
          <boxGeometry args={[0.06, 0.4, 0.01]} />
          <meshBasicMaterial color="#00ff88" transparent opacity={0.7} />
        </mesh>
      ))}
    </group>
  );
}

// Signal strength indicator
function SignalStrength({ strength = 4 }: { strength?: number }) {
  return (
    <group>
      {Array.from({ length: 5 }).map((_, i) => (
        <mesh key={i} position={[i * 0.12, i * 0.05, 0]}>
          <boxGeometry args={[0.08, 0.1 + i * 0.08, 0.01]} />
          <meshBasicMaterial
            color="#00ff88"
            transparent
            opacity={i < strength ? 0.9 : 0.2}
          />
        </mesh>
      ))}
    </group>
  );
}

// Status text display
function StatusDisplay({ text, position }: { text: string; position: [number, number, number] }) {
  const textRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (textRef.current) {
      const material = textRef.current.material as THREE.MeshBasicMaterial;
      material.opacity = 0.7 + Math.sin(state.clock.elapsedTime * 4) * 0.3;
    }
  });

  return (
    <Text
      ref={textRef}
      position={position}
      fontSize={0.12}
      color="#00ff88"
      anchorX="center"
      anchorY="middle"
      font="/fonts/ShareTechMono-Regular.ttf"
      characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-"
    >
      {text}
    </Text>
  );
}

// MGS-style frame with tech details
function TechFrame() {
  const frameRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (frameRef.current) {
      // Subtle frame pulse
      frameRef.current.children.forEach((child, i) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.opacity = 0.6 + Math.sin(state.clock.elapsedTime * 2 + i * 0.5) * 0.2;
        }
      });
    }
  });

  return (
    <group ref={frameRef}>
      {/* Main frame border */}
      <mesh position={[0, 1.5, 0]}>
        <planeGeometry args={[5.5, 0.02]} />
        <meshBasicMaterial color="#00ff88" transparent opacity={0.8} />
      </mesh>
      <mesh position={[0, -1.5, 0]}>
        <planeGeometry args={[5.5, 0.02]} />
        <meshBasicMaterial color="#00ff88" transparent opacity={0.8} />
      </mesh>
      <mesh position={[-2.75, 0, 0]}>
        <planeGeometry args={[0.02, 3]} />
        <meshBasicMaterial color="#00ff88" transparent opacity={0.8} />
      </mesh>
      <mesh position={[2.75, 0, 0]}>
        <planeGeometry args={[0.02, 3]} />
        <meshBasicMaterial color="#00ff88" transparent opacity={0.8} />
      </mesh>

      {/* Corner accents */}
      {[[-2.75, 1.5], [2.75, 1.5], [-2.75, -1.5], [2.75, -1.5]].map(([x, y], i) => (
        <group key={i} position={[x, y, 0]}>
          <mesh position={[x > 0 ? -0.15 : 0.15, 0, 0]}>
            <planeGeometry args={[0.3, 0.04]} />
            <meshBasicMaterial color="#00ff88" />
          </mesh>
          <mesh position={[0, y > 0 ? -0.15 : 0.15, 0]}>
            <planeGeometry args={[0.04, 0.3]} />
            <meshBasicMaterial color="#00ff88" />
          </mesh>
        </group>
      ))}

      {/* Top info bar */}
      <mesh position={[0, 1.35, 0]}>
        <planeGeometry args={[3, 0.005]} />
        <meshBasicMaterial color="#00ff88" transparent opacity={0.4} />
      </mesh>

      {/* Bottom info bar */}
      <mesh position={[0, -1.35, 0]}>
        <planeGeometry args={[3, 0.005]} />
        <meshBasicMaterial color="#00ff88" transparent opacity={0.4} />
      </mesh>
    </group>
  );
}

// Main 3D codec scene - enhanced version
function CodecScene({ isCalling, isSpeaking, frequency, status }: {
  isCalling: boolean;
  isSpeaking: boolean;
  frequency: string;
  status: string;
}) {
  return (
    <>
      <color attach="background" args={['#000a04']} />
      <ambientLight intensity={0.3} />

      {/* Background elements */}
      <GridBackground />
      <StaticNoise active={isCalling} />

      {/* Main frame */}
      <TechFrame />

      {/* AI Portrait - Left side */}
      <group position={[-1.4, 0.3, 0]}>
        <EnhancedPortrait speaking={isSpeaking} isAI={true} label="CODEC AI" />
        <Text
          position={[0, -1.05, 0]}
          fontSize={0.1}
          color="#00ff88"
          anchorX="center"
          font="/fonts/ShareTechMono-Regular.ttf"
        >
          CODEC AI
        </Text>
      </group>

      {/* User Portrait - Right side */}
      <group position={[1.4, 0.3, 0]}>
        <EnhancedPortrait speaking={!isSpeaking && isCalling} isAI={false} label="OPERATOR" />
        <Text
          position={[0, -1.05, 0]}
          fontSize={0.1}
          color="#00aaff"
          anchorX="center"
          font="/fonts/ShareTechMono-Regular.ttf"
        >
          OPERATOR
        </Text>
      </group>

      {/* Center section */}
      <group position={[0, -0.8, 0]}>
        <EnhancedWaveform active={isCalling} />
      </group>

      {/* Radar displays */}
      <RadarSweep position={[-2.2, -0.9, 0]} size={0.4} />
      <RadarSweep position={[2.2, -0.9, 0]} size={0.4} />

      {/* Top status bar */}
      <group position={[0, 1.65, 0]}>
        <Text
          position={[-1.8, 0, 0]}
          fontSize={0.08}
          color="#00ff88"
          anchorX="left"
          font="/fonts/ShareTechMono-Regular.ttf"
        >
          {`FREQ: ${frequency}`}
        </Text>
        <Text
          position={[0, 0, 0]}
          fontSize={0.1}
          color="#00ff88"
          anchorX="center"
          font="/fonts/ShareTechMono-Regular.ttf"
        >
          {status}
        </Text>
        <group position={[2, 0, 0]}>
          <SignalStrength strength={isCalling ? 4 : 2} />
        </group>
      </group>

      {/* Bottom status */}
      <Text
        position={[0, -1.65, 0]}
        fontSize={0.07}
        color="#00ff88"
        anchorX="center"
        font="/fonts/ShareTechMono-Regular.ttf"
      >
        {isCalling ? 'SECURE CHANNEL ESTABLISHED' : 'AWAITING TRANSMISSION'}
      </Text>
    </>
  );
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function renderMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-bold text-codec-green">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

async function authFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('codec_token');
  const headers = {
    ...options.headers,
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    localStorage.removeItem('codec_token');
    localStorage.removeItem('codec_token_expires');
    window.location.reload();
  }

  return response;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function Home() {
  const [view, setView] = useState<View>('login');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [accessCode, setAccessCode] = useState('');
  const [authError, setAuthError] = useState('');

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pendingCall, setPendingCall] = useState<CallData | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus | null>(null);
  const [inboundConfig, setInboundConfig] = useState<InboundConfig>({
    enabled: true,
    greeting: 'Hello, thank you for calling. How can I help you today?',
    businessName: 'CODEC AI Assistant',
    purpose: 'general assistance',
    instructions: 'Be helpful, professional, and concise.'
  });
  const [configSaved, setConfigSaved] = useState(false);
  const [glitchEffect, setGlitchEffect] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Trigger glitch effect periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setGlitchEffect(true);
      setTimeout(() => setGlitchEffect(false), 150);
    }, 8000 + Math.random() * 4000);
    return () => clearInterval(interval);
  }, []);

  // Check for existing auth on mount
  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('codec_token');
      const expires = localStorage.getItem('codec_token_expires');

      if (token && expires && Date.now() < parseInt(expires)) {
        try {
          const res = await fetch(`${API_URL}/api/auth/verify`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          const data = await res.json();
          if (data.valid) {
            setIsAuthenticated(true);
            setView('chat');
            initializeChat();
          } else {
            localStorage.removeItem('codec_token');
            localStorage.removeItem('codec_token_expires');
          }
        } catch {
          // Server might be down
        }
      }
      setAuthLoading(false);
    };

    checkAuth();
  }, []);

  const initializeChat = useCallback(() => {
    fetchInboundConfig();
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      content: "CODEC ONLINE. I'm your AI communications specialist. I can establish voice links to any target - restaurants, businesses, contacts. State your objective, Operator.",
      timestamp: new Date()
    }]);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Poll call status
  useEffect(() => {
    if (view === 'calling' && callStatus?.sid) {
      const interval = setInterval(async () => {
        try {
          const res = await authFetch(`${API_URL}/api/call/${callStatus.sid}`);
          const data = await res.json();
          setCallStatus(data);

          const isCallEnded = ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(data.status);

          if (isCallEnded) {
            if (data.status === 'completed') {
              if (data.summaryStatus === 'processing') {
                return;
              }

              clearInterval(interval);
              setTimeout(() => {
                let content = `TRANSMISSION COMPLETE. Duration: ${data.duration || 0} seconds.`;

                if (data.summary) {
                  content += `\n\n${data.summary}`;
                } else if (data.summaryStatus === 'error') {
                  content += '\n\nWARNING: Unable to decode transmission log.';
                }

                content += '\n\nAwaiting further orders, Operator.';

                setMessages(prev => [...prev, {
                  id: `call-done-${Date.now()}`,
                  role: 'system',
                  content,
                  timestamp: new Date()
                }]);
                setView('chat');
                setPendingCall(null);
              }, 500);
            } else {
              clearInterval(interval);
              setTimeout(() => {
                setMessages(prev => [...prev, {
                  id: `call-done-${Date.now()}`,
                  role: 'system',
                  content: `TRANSMISSION FAILED: ${data.status.toUpperCase()}. Retry mission?`,
                  timestamp: new Date()
                }]);
                setView('chat');
                setPendingCall(null);
              }, 1000);
            }
          }
        } catch (err) {
          console.error('Status poll error:', err);
        }
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [view, callStatus?.sid]);

  const fetchInboundConfig = async () => {
    try {
      const res = await authFetch(`${API_URL}/api/inbound/config`);
      const data = await res.json();
      if (data.success && data.config) setInboundConfig(data.config);
    } catch (err) {
      console.error('Error fetching config:', err);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode })
      });

      const data = await res.json();

      if (data.success && data.token) {
        localStorage.setItem('codec_token', data.token);
        localStorage.setItem('codec_token_expires', data.expiresAt.toString());
        setIsAuthenticated(true);
        setView('chat');
        initializeChat();
      } else {
        setAuthError(data.error || 'ACCESS DENIED');
      }
    } catch {
      setAuthError('COMM LINK FAILURE. RETRY.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await authFetch(`${API_URL}/api/auth/logout`, { method: 'POST' });
    } catch {
      // Ignore
    }
    localStorage.removeItem('codec_token');
    localStorage.removeItem('codec_token_expires');
    setIsAuthenticated(false);
    setView('login');
    setAccessCode('');
  };

  const saveInboundConfig = async () => {
    try {
      const res = await authFetch(`${API_URL}/api/inbound/config`, {
        method: 'POST',
        body: JSON.stringify(inboundConfig)
      });
      const data = await res.json();
      if (data.success) {
        setConfigSaved(true);
        setTimeout(() => setConfigSaved(false), 3000);
      }
    } catch (err) {
      console.error('Error saving config:', err);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await authFetch(`${API_URL}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({ conversationId, message: userMessage.content })
      });

      const data = await res.json();
      setConversationId(data.conversationId);

      let cleanContent = data.message;
      if (data.callData) {
        cleanContent = cleanContent
          .replace(/```json[\s\S]*?```/g, '')
          .replace(/```[\s\S]*?```/g, '')
          .replace(/\{"action"\s*:\s*"call"[\s\S]*?\}/g, '')
          .replace(/\n\s*\n/g, '\n')
          .trim();
        setPendingCall(data.callData);
      }

      setMessages(prev => [...prev, {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: cleanContent || "Target acquired. Ready to establish connection.",
        timestamp: new Date(),
        callData: data.callData
      }]);
    } catch (err) {
      console.error('Chat error:', err);
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "COMM ERROR. Signal interference detected. Retry transmission.",
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const makeCall = async () => {
    if (!pendingCall) return;
    setIsLoading(true);

    try {
      const res = await authFetch(`${API_URL}/api/call`, {
        method: 'POST',
        body: JSON.stringify({
          phoneNumber: pendingCall.phone,
          task: pendingCall.task,
          businessName: pendingCall.business,
          details: pendingCall.details
        })
      });

      const data = await res.json();

      if (data.success) {
        setCallStatus({ sid: data.callSid, status: 'initiated' });
        setView('calling');
        setMessages(prev => [...prev, {
          id: `calling-${Date.now()}`,
          role: 'system',
          content: `ESTABLISHING LINK TO ${pendingCall.business.toUpperCase()} [${pendingCall.phone}]...`,
          timestamp: new Date()
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `MISSION ABORT: ${data.error}`,
          timestamp: new Date()
        }]);
      }
    } catch (err) {
      console.error('Call error:', err);
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "LINK FAILURE. Check comm systems.",
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const hangupCall = async () => {
    if (!callStatus?.sid) return;
    try {
      await authFetch(`${API_URL}/api/call/${callStatus.sid}/hangup`, { method: 'POST' });
      setMessages(prev => [...prev, {
        id: `hangup-${Date.now()}`,
        role: 'system',
        content: 'TRANSMISSION TERMINATED. Awaiting orders.',
        timestamp: new Date()
      }]);
      setView('chat');
      setPendingCall(null);
      setCallStatus(null);
    } catch (err) {
      console.error('Hangup error:', err);
    }
  };

  const resetChat = async () => {
    if (conversationId) {
      await authFetch(`${API_URL}/api/chat/reset`, {
        method: 'POST',
        body: JSON.stringify({ conversationId })
      });
    }
    setConversationId(null);
    setPendingCall(null);
    setCallStatus(null);
    setView('chat');
    setMessages([{
      id: 'welcome-new',
      role: 'assistant',
      content: "CODEC RESET. Systems nominal. Ready for new directives.",
      timestamp: new Date()
    }]);
  };

  // Loading state
  if (authLoading && view === 'login') {
    return (
      <main className="codec-screen h-screen flex items-center justify-center">
        <div className="text-codec-green font-mono animate-pulse">
          INITIALIZING CODEC SYSTEMS...
        </div>
        <div className="scanlines" />
        <div className="crt-overlay" />
      </main>
    );
  }

  // Login View
  if (view === 'login' && !isAuthenticated) {
    return (
      <main className={`codec-screen h-screen flex items-center justify-center p-4 ${glitchEffect ? 'glitch' : ''}`}>
        <div className="w-full max-w-md codec-panel p-8">
          <div className="text-center mb-8">
            <div className="codec-hex-icon mx-auto mb-4">
              <svg className="w-16 h-16 text-codec-green" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5" strokeWidth="1" />
                <path d="M12 6L12 18M6 9L18 9M6 15L18 15" strokeWidth="1" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold text-codec-green mb-2 font-mono tracking-wider">CODEC</h1>
            <p className="text-codec-green-dim font-mono text-sm">TACTICAL COMMUNICATIONS SYSTEM</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-mono text-codec-green mb-2 tracking-wider">
                ACCESS CODE
              </label>
              <input
                type="password"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                className="codec-input w-full p-3 font-mono"
                placeholder="ENTER AUTHORIZATION"
                autoFocus
              />
            </div>

            {authError && (
              <div className="codec-error p-3 font-mono text-sm">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={!accessCode.trim() || authLoading}
              className="codec-button w-full py-3 font-mono tracking-wider"
            >
              {authLoading ? 'AUTHENTICATING...' : 'ESTABLISH LINK'}
            </button>
          </form>

          <p className="text-center text-codec-green-dim text-xs mt-6 font-mono">
            SECURE CHANNEL ESTABLISHED
          </p>
        </div>
        <div className="scanlines" />
        <div className="crt-overlay" />
      </main>
    );
  }

  return (
    <main className={`codec-screen h-screen flex flex-col ${glitchEffect ? 'glitch' : ''}`}>
      {/* Header */}
      <header className="codec-header flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="codec-hex-icon-sm">
            <svg className="w-8 h-8 text-codec-green" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5" strokeWidth="1.5" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-codec-green font-mono tracking-wider">CODEC</h1>
            <p className="text-xs text-codec-green-dim font-mono">v8.0 // TACTICAL AI</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-codec-green-dim font-mono text-xs mr-4">
            FREQ: 141.12
          </span>
          <button
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
            className={`codec-icon-button ${view === 'settings' ? 'active' : ''}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={resetChat}
            className="codec-icon-button"
            title="Reset transmission"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={handleLogout}
            className="codec-icon-button hover:text-red-500"
            title="Disconnect"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* Settings View */}
      {view === 'settings' && (
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-2xl mx-auto space-y-6">
            <h2 className="text-2xl font-bold text-codec-green font-mono tracking-wider">INBOUND CONFIG</h2>
            <p className="text-codec-green-dim font-mono text-sm">Configure response protocols for incoming transmissions</p>

            <div className="codec-panel p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-mono text-codec-green">ACCEPT INBOUND</div>
                  <div className="text-sm text-codec-green-dim font-mono">Toggle incoming transmission handling</div>
                </div>
                <button
                  onClick={() => setInboundConfig({ ...inboundConfig, enabled: !inboundConfig.enabled })}
                  className={`codec-toggle ${inboundConfig.enabled ? 'active' : ''}`}
                >
                  <div className="codec-toggle-knob" />
                </button>
              </div>

              <div>
                <label className="block text-sm font-mono text-codec-green mb-1">CALLSIGN</label>
                <input
                  type="text"
                  value={inboundConfig.businessName}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, businessName: e.target.value })}
                  className="codec-input w-full p-3 font-mono"
                />
              </div>

              <div>
                <label className="block text-sm font-mono text-codec-green mb-1">GREETING PROTOCOL</label>
                <textarea
                  value={inboundConfig.greeting}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, greeting: e.target.value })}
                  className="codec-input w-full h-20 p-3 font-mono resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-mono text-codec-green mb-1">MISSION TYPE</label>
                <input
                  type="text"
                  value={inboundConfig.purpose}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, purpose: e.target.value })}
                  className="codec-input w-full p-3 font-mono"
                  placeholder="e.g., tactical support, intel gathering"
                />
              </div>

              <div>
                <label className="block text-sm font-mono text-codec-green mb-1">DIRECTIVE</label>
                <textarea
                  value={inboundConfig.instructions}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, instructions: e.target.value })}
                  className="codec-input w-full h-24 p-3 font-mono resize-none"
                  placeholder="Operational parameters..."
                />
              </div>

              {configSaved && (
                <div className="codec-success p-3 font-mono text-sm">
                  CONFIG SAVED SUCCESSFULLY
                </div>
              )}

              <button
                onClick={saveInboundConfig}
                className="codec-button w-full py-3 font-mono tracking-wider"
              >
                SAVE CONFIGURATION
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calling View with Three.js - Full Screen MGS Codec */}
      {view === 'calling' && (
        <div className="flex-1 flex flex-col relative overflow-hidden">
          {/* Full Screen 3D Codec Scene */}
          <div className="absolute inset-0">
            <Canvas camera={{ position: [0, 0, 4.5], fov: 45 }}>
              <Suspense fallback={null}>
                <CodecScene
                  isCalling={true}
                  isSpeaking={callStatus?.status === 'in-progress'}
                  frequency="140.85"
                  status={callStatus?.status?.toUpperCase().replace('-', ' ') || 'CONNECTING'}
                />
              </Suspense>
            </Canvas>
          </div>

          {/* Overlay UI */}
          <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4">
            {/* Top bar */}
            <div className="flex justify-between items-start">
              <div className="codec-hud-panel p-3 pointer-events-auto">
                <div className="text-xs text-codec-green-dim font-mono">TARGET</div>
                <div className="text-lg font-bold text-codec-green font-mono tracking-wider">
                  {pendingCall?.business?.toUpperCase() || 'UNKNOWN'}
                </div>
                <div className="text-sm text-codec-green-dim font-mono">{pendingCall?.phone}</div>
              </div>

              <div className="codec-hud-panel p-3 pointer-events-auto">
                <div className="text-xs text-codec-green-dim font-mono">MISSION</div>
                <div className="text-sm text-codec-green font-mono uppercase">
                  {pendingCall?.task || 'ESTABLISH CONTACT'}
                </div>
              </div>
            </div>

            {/* Center status */}
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="codec-status-indicator-large mb-4">
                  <span className={`codec-status-dot-large ${callStatus?.status === 'in-progress' ? 'active' : callStatus?.summaryStatus === 'processing' ? 'processing' : ''}`} />
                </div>
                <div className="text-codec-green font-mono text-lg tracking-widest">
                  {callStatus?.summaryStatus === 'processing'
                    ? 'DECODING TRANSMISSION...'
                    : callStatus?.status === 'in-progress'
                    ? 'TRANSMISSION ACTIVE'
                    : 'ESTABLISHING LINK...'}
                </div>
              </div>
            </div>

            {/* Bottom bar */}
            <div className="flex justify-center">
              <button
                onClick={hangupCall}
                className="codec-button-danger px-8 py-3 font-mono tracking-wider inline-flex items-center gap-2 pointer-events-auto"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                </svg>
                ABORT MISSION
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat View */}
      {view === 'chat' && (
        <>
          <div className="flex-1 overflow-auto p-4 space-y-4 codec-messages">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} codec-message-animate`}
              >
                <div
                  className={`max-w-[80%] px-4 py-3 ${
                    msg.role === 'user'
                      ? 'codec-message-user'
                      : msg.role === 'system'
                      ? 'codec-message-system'
                      : 'codec-message-ai'
                  }`}
                >
                  <p className="whitespace-pre-wrap font-mono text-sm">{renderMarkdown(msg.content)}</p>

                  {msg.callData && (
                    <div className="mt-3 codec-target-info">
                      <div className="text-xs space-y-1 font-mono">
                        <div className="flex justify-between">
                          <span className="text-codec-green-dim">TARGET:</span>
                          <span className="text-codec-green">{msg.callData.business}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-codec-green-dim">FREQ:</span>
                          <span className="text-codec-green">{msg.callData.phone}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-codec-green-dim">MISSION:</span>
                          <span className="text-codec-green uppercase">{msg.callData.task}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="codec-message-ai px-4 py-3">
                  <div className="flex gap-1 font-mono text-codec-green">
                    <span className="animate-pulse">PROCESSING</span>
                    <span className="codec-cursor">_</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Call Action */}
          {pendingCall && (
            <div className="px-4 pb-2">
              <div className="codec-panel p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-mono text-codec-green">{pendingCall.business.toUpperCase()}</div>
                    <div className="text-sm text-codec-green-dim font-mono">{pendingCall.phone}</div>
                  </div>
                  <div className="codec-status-indicator">
                    TARGET ACQUIRED
                  </div>
                </div>
                <button
                  onClick={makeCall}
                  disabled={isLoading}
                  className="codec-button w-full py-3 font-mono tracking-wider flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  INITIATE TRANSMISSION
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <div className="p-4 codec-input-area">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder="ENTER DIRECTIVE..."
                className="codec-input flex-1 px-4 py-3 font-mono"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                className="codec-button px-4 py-3"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}

      {/* CRT Effects Overlay */}
      <div className="scanlines" />
      <div className="crt-overlay" />
    </main>
  );
}
