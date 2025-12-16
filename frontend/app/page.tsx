'use client';

import { useState, useEffect, useRef, useCallback, Suspense, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
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
// THREE.JS COMPONENTS - MINIMALIST CODEC
// ============================================================================

// Animated ring with glow
function GlowRing({ radius, color, speed = 1, thickness = 0.02 }: {
  radius: number; color: string; speed?: number; thickness?: number
}) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (ref.current) {
      const mat = ref.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.4 + Math.sin(state.clock.elapsedTime * speed) * 0.3;
    }
  });

  return (
    <mesh ref={ref}>
      <ringGeometry args={[radius - thickness, radius, 64]} />
      <meshBasicMaterial color={color} transparent opacity={0.5} />
    </mesh>
  );
}

// Pulsing center dot
function CenterPulse({ active, color }: { active: boolean; color: string }) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (ref.current) {
      const scale = active
        ? 1 + Math.sin(state.clock.elapsedTime * 6) * 0.2
        : 1 + Math.sin(state.clock.elapsedTime * 2) * 0.05;
      ref.current.scale.setScalar(scale);

      const mat = ref.current.material as THREE.MeshBasicMaterial;
      mat.opacity = active ? 0.9 : 0.5;
    }
  });

  return (
    <mesh ref={ref}>
      <circleGeometry args={[0.15, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0.7} />
    </mesh>
  );
}

// Audio visualization bars
function AudioBars({ active }: { active: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const barCount = 24;

  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.children.forEach((child, i) => {
        const mesh = child as THREE.Mesh;
        if (active) {
          const wave = Math.sin(state.clock.elapsedTime * 8 + i * 0.4);
          const noise = Math.random() * 0.2;
          mesh.scale.y = 0.5 + Math.abs(wave) * 0.8 + noise;
        } else {
          mesh.scale.y = 0.2 + Math.sin(state.clock.elapsedTime + i * 0.3) * 0.1;
        }
      });
    }
  });

  return (
    <group ref={groupRef}>
      {Array.from({ length: barCount }).map((_, i) => {
        const angle = (i / barCount) * Math.PI * 2;
        const x = Math.cos(angle) * 0.8;
        const y = Math.sin(angle) * 0.8;
        return (
          <mesh key={i} position={[x, y, 0]} rotation={[0, 0, angle + Math.PI / 2]}>
            <boxGeometry args={[0.04, 0.3, 0.01]} />
            <meshBasicMaterial color="#00ff88" transparent opacity={active ? 0.8 : 0.3} />
          </mesh>
        );
      })}
    </group>
  );
}

// Rotating scanner line
function ScannerLine({ active }: { active: boolean }) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.z = state.clock.elapsedTime * (active ? 3 : 1);
      const mat = ref.current.material as THREE.MeshBasicMaterial;
      mat.opacity = active ? 0.6 : 0.2;
    }
  });

  return (
    <mesh ref={ref}>
      <planeGeometry args={[2, 0.01]} />
      <meshBasicMaterial color="#00ff88" transparent opacity={0.4} />
    </mesh>
  );
}

// Main codec visualization
function CodecVisualization({ isActive, isSpeaking }: { isActive: boolean; isSpeaking: boolean }) {
  return (
    <>
      <color attach="background" args={['#050a05']} />

      {/* Outer rings */}
      <GlowRing radius={1.4} color="#00ff88" speed={1} thickness={0.01} />
      <GlowRing radius={1.2} color="#00ff88" speed={1.5} thickness={0.01} />
      <GlowRing radius={1.0} color="#00ff88" speed={2} thickness={0.015} />

      {/* Audio visualization */}
      <AudioBars active={isActive} />

      {/* Scanner */}
      <ScannerLine active={isActive} />

      {/* Center pulse */}
      <CenterPulse active={isSpeaking} color={isSpeaking ? '#ffffff' : '#00ff88'} />

      {/* Inner detail rings */}
      <GlowRing radius={0.5} color="#00ff88" speed={3} thickness={0.01} />
      <GlowRing radius={0.3} color="#00ff88" speed={4} thickness={0.01} />
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
      return <strong key={i} className="font-semibold text-green-400">{part.slice(2, -2)}</strong>;
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check auth on mount
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
        } catch {}
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
      content: "Ready. What call should I make?",
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
              if (data.summaryStatus === 'processing') return;

              clearInterval(interval);
              setTimeout(() => {
                let content = `Done. ${data.duration || 0}s`;
                if (data.summary) content += `\n\n${data.summary}`;
                content += '\n\nWhat else?';

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
                  content: `Failed: ${data.status}. Try again?`,
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
    } catch {}
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
        setAuthError(data.error || 'Invalid code');
      }
    } catch {
      setAuthError('Connection failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await authFetch(`${API_URL}/api/auth/logout`, { method: 'POST' });
    } catch {}
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
    } catch {}
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
        content: cleanContent || "Ready to call.",
        timestamp: new Date(),
        callData: data.callData
      }]);
    } catch {
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "Error. Try again.",
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
          content: `Calling ${pendingCall.business || pendingCall.phone}...`,
          timestamp: new Date()
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${data.error}`,
          timestamp: new Date()
        }]);
      }
    } catch {
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "Call failed.",
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
        content: 'Call ended.',
        timestamp: new Date()
      }]);
      setView('chat');
      setPendingCall(null);
      setCallStatus(null);
    } catch {}
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
      content: "Reset. What call should I make?",
      timestamp: new Date()
    }]);
  };

  // Loading
  if (authLoading && view === 'login') {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-green-500 font-mono animate-pulse">Loading...</div>
      </main>
    );
  }

  // Login
  if (view === 'login' && !isAuthenticated) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-light text-green-500 mb-2 tracking-widest">CODEC</h1>
            <p className="text-green-700 text-sm tracking-wider">AI PHONE ASSISTANT</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <input
                type="password"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                className="w-full bg-transparent border border-green-900 text-green-500 px-4 py-3 font-mono text-center tracking-widest focus:outline-none focus:border-green-500 transition-colors"
                placeholder="ACCESS CODE"
                autoFocus
              />
            </div>

            {authError && (
              <div className="text-red-500 text-center text-sm font-mono">{authError}</div>
            )}

            <button
              type="submit"
              disabled={!accessCode.trim() || authLoading}
              className="w-full border border-green-500 text-green-500 py-3 font-mono tracking-wider hover:bg-green-500/10 transition-colors disabled:opacity-30"
            >
              {authLoading ? '...' : 'ENTER'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-green-900/30">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-green-500 font-mono text-sm tracking-wider">CODEC</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
            className={`p-2 text-green-700 hover:text-green-500 transition-colors ${view === 'settings' ? 'text-green-500' : ''}`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button onClick={resetChat} className="p-2 text-green-700 hover:text-green-500 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button onClick={handleLogout} className="p-2 text-green-700 hover:text-red-500 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* Settings */}
      {view === 'settings' && (
        <div className="flex-1 overflow-auto p-4">
          <div className="max-w-lg mx-auto space-y-4">
            <h2 className="text-green-500 font-mono text-sm tracking-wider mb-4">INBOUND SETTINGS</h2>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-green-700 text-sm font-mono">ENABLED</span>
                <button
                  onClick={() => setInboundConfig({ ...inboundConfig, enabled: !inboundConfig.enabled })}
                  className={`w-10 h-5 rounded-full transition-colors ${inboundConfig.enabled ? 'bg-green-500' : 'bg-green-900'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-black transition-transform ${inboundConfig.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              <div>
                <label className="text-green-700 text-xs font-mono block mb-1">NAME</label>
                <input
                  type="text"
                  value={inboundConfig.businessName}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, businessName: e.target.value })}
                  className="w-full bg-transparent border border-green-900 text-green-500 px-3 py-2 text-sm font-mono focus:outline-none focus:border-green-500"
                />
              </div>

              <div>
                <label className="text-green-700 text-xs font-mono block mb-1">GREETING</label>
                <textarea
                  value={inboundConfig.greeting}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, greeting: e.target.value })}
                  className="w-full bg-transparent border border-green-900 text-green-500 px-3 py-2 text-sm font-mono h-20 resize-none focus:outline-none focus:border-green-500"
                />
              </div>

              <div>
                <label className="text-green-700 text-xs font-mono block mb-1">PURPOSE</label>
                <input
                  type="text"
                  value={inboundConfig.purpose}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, purpose: e.target.value })}
                  className="w-full bg-transparent border border-green-900 text-green-500 px-3 py-2 text-sm font-mono focus:outline-none focus:border-green-500"
                />
              </div>

              <div>
                <label className="text-green-700 text-xs font-mono block mb-1">INSTRUCTIONS</label>
                <textarea
                  value={inboundConfig.instructions}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, instructions: e.target.value })}
                  className="w-full bg-transparent border border-green-900 text-green-500 px-3 py-2 text-sm font-mono h-24 resize-none focus:outline-none focus:border-green-500"
                />
              </div>

              {configSaved && (
                <div className="text-green-500 text-xs font-mono">Saved</div>
              )}

              <button
                onClick={saveInboundConfig}
                className="w-full border border-green-500 text-green-500 py-2 text-sm font-mono tracking-wider hover:bg-green-500/10 transition-colors"
              >
                SAVE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calling View */}
      {view === 'calling' && (
        <div className="flex-1 flex flex-col">
          {/* Three.js Visualization */}
          <div className="flex-1 relative">
            <Canvas camera={{ position: [0, 0, 3], fov: 50 }}>
              <Suspense fallback={null}>
                <CodecVisualization
                  isActive={true}
                  isSpeaking={callStatus?.status === 'in-progress'}
                />
              </Suspense>
            </Canvas>

            {/* Overlay info */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div className="text-center">
                <div className="text-green-500 font-mono text-xl tracking-wider mb-2">
                  {pendingCall?.business?.toUpperCase() || pendingCall?.phone || 'CALLING'}
                </div>
                {pendingCall?.business && (
                  <div className="text-green-700 font-mono text-sm mb-4">
                    {pendingCall?.phone}
                  </div>
                )}
                <div className="text-green-500/80 font-mono text-sm tracking-widest animate-pulse">
                  {callStatus?.summaryStatus === 'processing'
                    ? 'PROCESSING...'
                    : callStatus?.status?.toUpperCase().replace('-', ' ') || 'CONNECTING...'}
                </div>
              </div>
            </div>
          </div>

          {/* Hang up button */}
          <div className="p-4 flex justify-center">
            <button
              onClick={hangupCall}
              className="px-8 py-3 border border-red-500 text-red-500 font-mono text-sm tracking-wider hover:bg-red-500/10 transition-colors"
            >
              END CALL
            </button>
          </div>
        </div>
      )}

      {/* Chat View */}
      {view === 'chat' && (
        <>
          <div className="flex-1 overflow-auto p-4 space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 text-sm font-mono ${
                    msg.role === 'user'
                      ? 'text-blue-400 border-l-2 border-blue-500/30'
                      : msg.role === 'system'
                      ? 'text-yellow-500/80 border-l-2 border-yellow-500/30'
                      : 'text-green-500 border-l-2 border-green-500/30'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{renderMarkdown(msg.content)}</p>

                  {msg.callData && (
                    <div className="mt-2 pt-2 border-t border-green-900/30 text-xs space-y-1">
                      <div className="flex justify-between">
                        <span className="text-green-700">TO:</span>
                        <span>{msg.callData.business}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-green-700">NUM:</span>
                        <span>{msg.callData.phone}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-green-700">TASK:</span>
                        <span className="uppercase">{msg.callData.task}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="text-green-500 font-mono text-sm px-3 py-2 border-l-2 border-green-500/30">
                  <span className="animate-pulse">...</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Call action */}
          {pendingCall && !isLoading && (
            <div className="px-4 pb-2">
              <button
                onClick={makeCall}
                className="w-full border border-green-500 text-green-500 py-3 font-mono text-sm tracking-wider hover:bg-green-500/10 transition-colors"
              >
                CALL {(pendingCall.business || pendingCall.phone || 'NOW').toUpperCase()}
              </button>
            </div>
          )}

          {/* Input */}
          <div className="p-4 border-t border-green-900/30">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder="Type..."
                className="flex-1 bg-transparent border border-green-900 text-green-500 px-3 py-2 text-sm font-mono focus:outline-none focus:border-green-500 placeholder-green-900"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                className="px-4 py-2 border border-green-500 text-green-500 font-mono text-sm hover:bg-green-500/10 transition-colors disabled:opacity-30"
              >
                →
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
