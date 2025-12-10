'use client';

import { useState, useEffect, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

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
}

interface InboundConfig {
  enabled: boolean;
  greeting: string;
  businessName: string;
  purpose: string;
  instructions: string;
}

type View = 'chat' | 'calling' | 'settings';

export default function Home() {
  const [view, setView] = useState<View>('chat');
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

  // Initialize
  useEffect(() => {
    fetchInboundConfig();
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      content: "Hey! I'm CODEC, your AI phone assistant. I can make calls to anyone on your behalf - restaurants, businesses, friends, family. Who would you like me to call?",
      timestamp: new Date()
    }]);
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Poll call status
  useEffect(() => {
    if (view === 'calling' && callStatus?.sid) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_URL}/api/call/${callStatus.sid}`);
          const data = await res.json();
          setCallStatus(data);

          if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(data.status)) {
            clearInterval(interval);
            setTimeout(() => {
              setMessages(prev => [...prev, {
                id: `call-done-${Date.now()}`,
                role: 'system',
                content: data.status === 'completed'
                  ? `Call completed! Duration: ${data.duration || 0} seconds. Anything else?`
                  : `Call ended: ${data.status}. Want me to try again?`,
                timestamp: new Date()
              }]);
              setView('chat');
              setPendingCall(null);
            }, 1000);
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
      const res = await fetch(`${API_URL}/api/inbound/config`);
      const data = await res.json();
      if (data.success && data.config) setInboundConfig(data.config);
    } catch (err) {
      console.error('Error fetching config:', err);
    }
  };

  const saveInboundConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/api/inbound/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message: userMessage.content })
      });

      const data = await res.json();
      setConversationId(data.conversationId);

      let cleanContent = data.message;
      if (data.callData) {
        cleanContent = cleanContent.replace(/\{"action":"call"[^}]+\}/g, '').trim();
        setPendingCall(data.callData);
      }

      setMessages(prev => [...prev, {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: cleanContent || "Ready to make that call!",
        timestamp: new Date(),
        callData: data.callData
      }]);
    } catch (err) {
      console.error('Chat error:', err);
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "Sorry, connection issue. Try again.",
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
      const res = await fetch(`${API_URL}/api/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          content: `Calling ${pendingCall.business} at ${pendingCall.phone}...`,
          timestamp: new Date()
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `Couldn't make the call: ${data.error}`,
          timestamp: new Date()
        }]);
      }
    } catch (err) {
      console.error('Call error:', err);
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "Connection failed. Try again.",
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const hangupCall = async () => {
    if (!callStatus?.sid) return;
    try {
      await fetch(`${API_URL}/api/call/${callStatus.sid}/hangup`, { method: 'POST' });
      setMessages(prev => [...prev, {
        id: `hangup-${Date.now()}`,
        role: 'system',
        content: 'Call ended. Anything else?',
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
      await fetch(`${API_URL}/api/chat/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      content: "Fresh start! What can I help you with?",
      timestamp: new Date()
    }]);
  };

  return (
    <main className="h-screen flex flex-col bg-gradient-to-b from-slate-900 to-slate-800">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">CODEC</h1>
            <p className="text-xs text-slate-400">AI Phone Assistant</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
            className={`p-2 rounded-lg transition-colors ${view === 'settings' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={resetChat}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
            title="New conversation"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </header>

      {/* Settings View */}
      {view === 'settings' && (
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-2xl mx-auto space-y-6">
            <h2 className="text-2xl font-bold text-white">Inbound Call Settings</h2>
            <p className="text-slate-400">Configure how I answer calls to your Twilio number</p>

            <div className="bg-slate-800 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-white">Accept Inbound Calls</div>
                  <div className="text-sm text-slate-400">When off, callers hear a rejection message</div>
                </div>
                <button
                  onClick={() => setInboundConfig({ ...inboundConfig, enabled: !inboundConfig.enabled })}
                  className={`w-12 h-6 rounded-full transition-colors ${inboundConfig.enabled ? 'bg-green-500' : 'bg-slate-600'}`}
                >
                  <div className={`w-5 h-5 bg-white rounded-full shadow transform transition-transform ${inboundConfig.enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Business Name</label>
                <input
                  type="text"
                  value={inboundConfig.businessName}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, businessName: e.target.value })}
                  className="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Greeting Message</label>
                <textarea
                  value={inboundConfig.greeting}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, greeting: e.target.value })}
                  className="w-full h-20 p-3 bg-slate-700 border border-slate-600 rounded-lg text-white resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Purpose</label>
                <input
                  type="text"
                  value={inboundConfig.purpose}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, purpose: e.target.value })}
                  className="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white"
                  placeholder="e.g., customer support, appointment booking"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">AI Instructions</label>
                <textarea
                  value={inboundConfig.instructions}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, instructions: e.target.value })}
                  className="w-full h-24 p-3 bg-slate-700 border border-slate-600 rounded-lg text-white resize-none"
                  placeholder="How should the AI handle calls?"
                />
              </div>

              {configSaved && (
                <div className="p-3 bg-green-600/20 border border-green-500 rounded-lg text-green-400">
                  Settings saved!
                </div>
              )}

              <button
                onClick={saveInboundConfig}
                className="w-full py-3 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calling View */}
      {view === 'calling' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="relative inline-block mb-6">
              <div className="w-32 h-32 bg-green-600/20 rounded-full flex items-center justify-center">
                <div className="w-28 h-28 bg-green-600/30 rounded-full animate-ping absolute" />
                <svg className="w-16 h-16 text-green-500 relative z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
              </div>
            </div>

            <h2 className="text-2xl font-bold text-white mb-2">
              {pendingCall?.business || 'Making Call'}
            </h2>
            <p className="text-slate-400 mb-4">{pendingCall?.phone}</p>

            <div className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 rounded-full mb-6">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-slate-300 capitalize">{callStatus?.status || 'connecting'}</span>
            </div>

            <p className="text-sm text-slate-500 mb-6">
              I&apos;m handling the conversation...
            </p>

            <button
              onClick={hangupCall}
              className="px-8 py-3 bg-red-600 text-white font-medium rounded-full hover:bg-red-700 transition-colors flex items-center gap-2 mx-auto"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
              </svg>
              End Call
            </button>
          </div>
        </div>
      )}

      {/* Chat View */}
      {view === 'chat' && (
        <>
          <div className="flex-1 overflow-auto p-4 space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] px-4 py-3 rounded-2xl ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : msg.role === 'system'
                      ? 'bg-slate-700 text-slate-300 border border-slate-600'
                      : 'bg-slate-800 text-white'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>

                  {msg.callData && (
                    <div className="mt-3 p-3 bg-slate-900/50 rounded-lg border border-slate-600">
                      <div className="text-sm space-y-1">
                        <div className="flex justify-between">
                          <span className="text-slate-400">To:</span>
                          <span className="text-white">{msg.callData.business}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Phone:</span>
                          <span className="text-white">{msg.callData.phone}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Purpose:</span>
                          <span className="text-white capitalize">{msg.callData.task}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-slate-800 px-4 py-3 rounded-2xl">
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Call Action */}
          {pendingCall && (
            <div className="px-4 pb-2">
              <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-medium text-white">{pendingCall.business}</div>
                    <div className="text-sm text-slate-400">{pendingCall.phone}</div>
                  </div>
                </div>
                <button
                  onClick={makeCall}
                  disabled={isLoading}
                  className="w-full py-3 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 disabled:bg-slate-600 transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  Make the Call
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <div className="p-4 border-t border-slate-700">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder="Type your message..."
                className="flex-1 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                className="px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:bg-slate-700 disabled:text-slate-500 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
