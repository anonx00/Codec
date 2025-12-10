'use client';

import { useState, useEffect } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

interface Voice {
  voice_id: string;
  name: string;
  category: string;
  accent: string;
  gender: string;
  preview_url?: string;
}

interface Plan {
  action: string;
  business_name: string | null;
  location: string | null;
  date_time: string | null;
  party_size: number | null;
  special_requests: string | null;
  phone_number?: string;
  phone_source?: string;
  ready_to_call: boolean;
  missing_info: string[];
}

interface CallStatus {
  sid: string;
  status: string;
  duration?: number;
  task?: string;
  businessName?: string;
  direction?: string;
}

interface InboundConfig {
  enabled: boolean;
  greeting: string;
  businessName: string;
  purpose: string;
  instructions: string;
  voiceId: string;
}

type Tab = 'outbound' | 'inbound' | 'calls';
type Step = 'input' | 'planning' | 'review' | 'calling' | 'complete';

export default function Home() {
  const [tab, setTab] = useState<Tab>('outbound');
  const [step, setStep] = useState<Step>('input');
  const [userRequest, setUserRequest] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [manualPhone, setManualPhone] = useState('');
  const [callStatus, setCallStatus] = useState<CallStatus | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeCalls, setActiveCalls] = useState<CallStatus[]>([]);

  // Inbound config state
  const [inboundConfig, setInboundConfig] = useState<InboundConfig>({
    enabled: true,
    greeting: 'Hello, thank you for calling. How can I help you today?',
    businessName: 'CODEC AI Assistant',
    purpose: 'general assistance',
    instructions: 'Be helpful, professional, and concise.',
    voiceId: ''
  });
  const [configSaved, setConfigSaved] = useState(false);

  // Fetch voices and inbound config on mount
  useEffect(() => {
    fetchVoices();
    fetchInboundConfig();
  }, []);

  // Poll call status when calling
  useEffect(() => {
    if (step === 'calling' && callStatus?.sid) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_URL}/api/call/${callStatus.sid}`);
          const data = await res.json();
          setCallStatus(data);

          if (['completed', 'failed', 'busy', 'no-answer'].includes(data.status)) {
            setStep('complete');
            clearInterval(interval);
          }
        } catch (err) {
          console.error('Status poll error:', err);
        }
      }, 2000);

      return () => clearInterval(interval);
    }
  }, [step, callStatus?.sid]);

  // Poll active calls when on calls tab
  useEffect(() => {
    if (tab === 'calls') {
      fetchActiveCalls();
      const interval = setInterval(fetchActiveCalls, 5000);
      return () => clearInterval(interval);
    }
  }, [tab]);

  const fetchVoices = async () => {
    try {
      const res = await fetch(`${API_URL}/api/voices`);
      const data = await res.json();
      if (data.success && data.voices) {
        setVoices(data.voices);
        const defaultVoice = data.voices.find((v: Voice) => v.name.toLowerCase().includes('eric'));
        if (defaultVoice) setSelectedVoice(defaultVoice.voice_id);
        else if (data.voices.length > 0) setSelectedVoice(data.voices[0].voice_id);
      }
    } catch (err) {
      console.error('Error fetching voices:', err);
    }
  };

  const fetchInboundConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/api/inbound/config`);
      const data = await res.json();
      if (data.success && data.config) {
        setInboundConfig(data.config);
      }
    } catch (err) {
      console.error('Error fetching inbound config:', err);
    }
  };

  const fetchActiveCalls = async () => {
    try {
      const res = await fetch(`${API_URL}/api/calls`);
      const data = await res.json();
      if (data.success && data.calls) {
        setActiveCalls(data.calls);
      }
    } catch (err) {
      console.error('Error fetching calls:', err);
    }
  };

  const saveInboundConfig = async () => {
    setIsLoading(true);
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
      setError('Failed to save configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePlan = async () => {
    if (!userRequest.trim()) return;

    setIsLoading(true);
    setError('');
    setStep('planning');

    try {
      const res = await fetch(`${API_URL}/api/agent/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: userRequest })
      });

      const data = await res.json();

      if (data.success && data.plan) {
        setPlan(data.plan);
        setStep('review');
      } else {
        setError(data.error || 'Failed to understand request');
        setStep('input');
      }
    } catch (err) {
      setError('Failed to connect to server');
      setStep('input');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCall = async () => {
    const phoneNumber = plan?.phone_number || manualPhone;

    if (!phoneNumber) {
      setError('Phone number required');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const details = [
        plan?.date_time && `Time: ${plan.date_time}`,
        plan?.party_size && `Party of ${plan.party_size}`,
        plan?.special_requests && `Notes: ${plan.special_requests}`
      ].filter(Boolean).join(', ');

      const res = await fetch(`${API_URL}/api/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber,
          task: plan?.action || 'general inquiry',
          businessName: plan?.business_name || 'the business',
          details,
          voiceId: selectedVoice
        })
      });

      const data = await res.json();

      if (data.success) {
        setCallStatus({ sid: data.callSid, status: 'initiated' });
        setStep('calling');
      } else {
        setError(data.error || 'Failed to initiate call');
      }
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  };

  const resetAll = () => {
    setStep('input');
    setUserRequest('');
    setPlan(null);
    setManualPhone('');
    setCallStatus(null);
    setError('');
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            <span className="text-indigo-600">CODEC</span> AI Caller
          </h1>
          <p className="text-xl text-gray-600">
            AI-powered phone calls - outbound and inbound
          </p>
        </div>

        {/* Tabs */}
        <div className="flex justify-center mb-8">
          <div className="bg-gray-100 p-1 rounded-xl inline-flex">
            <button
              onClick={() => { setTab('outbound'); resetAll(); }}
              className={`px-6 py-2 rounded-lg font-medium transition-all ${
                tab === 'outbound' ? 'bg-white shadow text-indigo-600' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              Make Calls
            </button>
            <button
              onClick={() => setTab('inbound')}
              className={`px-6 py-2 rounded-lg font-medium transition-all ${
                tab === 'inbound' ? 'bg-white shadow text-indigo-600' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              Inbound Settings
            </button>
            <button
              onClick={() => setTab('calls')}
              className={`px-6 py-2 rounded-lg font-medium transition-all ${
                tab === 'calls' ? 'bg-white shadow text-indigo-600' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              Active Calls
            </button>
          </div>
        </div>

        {/* Outbound Tab */}
        {tab === 'outbound' && (
          <>
            {/* Step 1: Input */}
            {step === 'input' && (
              <div className="bg-white rounded-2xl shadow-xl p-8 animate-fade-in">
                <h2 className="text-2xl font-semibold text-gray-800 mb-6">
                  What would you like me to do?
                </h2>

                <textarea
                  value={userRequest}
                  onChange={(e) => setUserRequest(e.target.value)}
                  placeholder="Example: Book a table for 2 at Luigi's Italian Restaurant in Sydney for Friday 7pm. We need a quiet corner table if possible."
                  className="w-full h-40 p-4 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none text-gray-800 placeholder-gray-400"
                />

                {/* Voice Selection */}
                <div className="mt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Choose AI Voice
                  </label>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {voices.slice(0, 8).map((voice) => (
                      <button
                        key={voice.voice_id}
                        onClick={() => setSelectedVoice(voice.voice_id)}
                        className={`p-3 rounded-lg border-2 transition-all ${
                          selectedVoice === voice.voice_id
                            ? 'border-indigo-600 bg-indigo-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="font-medium text-gray-800">{voice.name}</div>
                        <div className="text-xs text-gray-500">
                          {voice.accent} · {voice.gender}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {error && (
                  <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  onClick={handlePlan}
                  disabled={!userRequest.trim() || isLoading}
                  className="mt-6 w-full py-4 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  {isLoading ? 'Analyzing...' : 'Plan My Call'}
                </button>
              </div>
            )}

            {/* Step 2: Planning Animation */}
            {step === 'planning' && (
              <div className="bg-white rounded-2xl shadow-xl p-12 text-center animate-fade-in">
                <div className="relative inline-block">
                  <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center">
                    <div className="w-16 h-16 bg-indigo-200 rounded-full animate-pulse-ring absolute" />
                    <svg className="w-10 h-10 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                </div>
                <h2 className="text-2xl font-semibold text-gray-800 mt-6">
                  Analyzing your request...
                </h2>
                <p className="text-gray-500 mt-2">
                  Preparing the call plan
                </p>
              </div>
            )}

            {/* Step 3: Review Plan */}
            {step === 'review' && plan && (
              <div className="bg-white rounded-2xl shadow-xl p-8 animate-fade-in">
                <h2 className="text-2xl font-semibold text-gray-800 mb-6">
                  Here&apos;s my plan
                </h2>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <div className="text-sm text-gray-500">Action</div>
                      <div className="font-medium text-gray-800 capitalize">{plan.action}</div>
                    </div>
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <div className="text-sm text-gray-500">Business</div>
                      <div className="font-medium text-gray-800">{plan.business_name || 'Not specified'}</div>
                    </div>
                    {plan.location && (
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <div className="text-sm text-gray-500">Location</div>
                        <div className="font-medium text-gray-800">{plan.location}</div>
                      </div>
                    )}
                    {plan.date_time && (
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <div className="text-sm text-gray-500">Date/Time</div>
                        <div className="font-medium text-gray-800">{plan.date_time}</div>
                      </div>
                    )}
                    {plan.party_size && (
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <div className="text-sm text-gray-500">Party Size</div>
                        <div className="font-medium text-gray-800">{plan.party_size} people</div>
                      </div>
                    )}
                  </div>

                  {plan.special_requests && (
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <div className="text-sm text-gray-500">Special Requests</div>
                      <div className="font-medium text-gray-800">{plan.special_requests}</div>
                    </div>
                  )}

                  {/* Phone Number */}
                  <div className={`p-4 rounded-lg ${plan.phone_number ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
                    <div className="text-sm text-gray-500">Phone Number</div>
                    {plan.phone_number ? (
                      <div>
                        <div className="font-medium text-gray-800">{plan.phone_number}</div>
                        <div className="text-xs text-gray-500">Found via: {plan.phone_source}</div>
                      </div>
                    ) : (
                      <input
                        type="tel"
                        value={manualPhone}
                        onChange={(e) => setManualPhone(e.target.value)}
                        placeholder="+61 xxx xxx xxx"
                        className="mt-2 w-full p-2 border border-gray-300 rounded-lg text-gray-800"
                      />
                    )}
                  </div>

                  {/* Missing Info */}
                  {plan.missing_info && plan.missing_info.length > 0 && (
                    <div className="bg-yellow-50 border border-yellow-200 p-4 rounded-lg">
                      <div className="font-medium text-yellow-800">Missing Information:</div>
                      <ul className="list-disc list-inside text-yellow-700 text-sm mt-2">
                        {plan.missing_info.map((info, i) => (
                          <li key={i}>{info}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-lg">
                    {error}
                  </div>
                )}

                <div className="flex gap-4 mt-8">
                  <button
                    onClick={resetAll}
                    className="flex-1 py-4 border border-gray-300 text-gray-700 font-semibold rounded-xl hover:bg-gray-50 transition-colors"
                  >
                    Start Over
                  </button>
                  <button
                    onClick={handleCall}
                    disabled={(!plan.phone_number && !manualPhone) || isLoading}
                    className="flex-1 py-4 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {isLoading ? 'Initiating...' : 'Make the Call'}
                  </button>
                </div>
              </div>
            )}

            {/* Step 4: Calling */}
            {step === 'calling' && (
              <div className="bg-white rounded-2xl shadow-xl p-12 text-center animate-fade-in">
                <div className="relative inline-block">
                  <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center">
                    <div className="w-20 h-20 bg-green-200 rounded-full animate-pulse-ring absolute" />
                    <svg className="w-12 h-12 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                </div>

                <h2 className="text-2xl font-semibold text-gray-800 mt-6">
                  Call in Progress
                </h2>

                <div className="mt-4 inline-flex items-center px-4 py-2 bg-gray-100 rounded-full">
                  <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse mr-2" />
                  <span className="text-gray-600 capitalize">{callStatus?.status || 'connecting'}</span>
                </div>

                <p className="text-sm text-gray-400 mt-6">
                  CODEC is handling the conversation.
                </p>
              </div>
            )}

            {/* Step 5: Complete */}
            {step === 'complete' && (
              <div className="bg-white rounded-2xl shadow-xl p-12 text-center animate-fade-in">
                <div className={`w-24 h-24 mx-auto rounded-full flex items-center justify-center ${
                  callStatus?.status === 'completed' ? 'bg-green-100' : 'bg-red-100'
                }`}>
                  {callStatus?.status === 'completed' ? (
                    <svg className="w-12 h-12 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-12 h-12 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </div>

                <h2 className="text-2xl font-semibold text-gray-800 mt-6">
                  {callStatus?.status === 'completed' ? 'Call Completed' : 'Call Ended'}
                </h2>

                <p className="text-gray-500 mt-2">
                  Status: {callStatus?.status}
                  {callStatus?.duration && ` · Duration: ${callStatus.duration}s`}
                </p>

                <button
                  onClick={resetAll}
                  className="mt-8 px-8 py-4 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors"
                >
                  Make Another Call
                </button>
              </div>
            )}
          </>
        )}

        {/* Inbound Settings Tab */}
        {tab === 'inbound' && (
          <div className="bg-white rounded-2xl shadow-xl p-8 animate-fade-in">
            <h2 className="text-2xl font-semibold text-gray-800 mb-6">
              Inbound Call Settings
            </h2>
            <p className="text-gray-600 mb-6">
              Configure how the AI handles incoming calls to your Twilio number.
            </p>

            <div className="space-y-6">
              {/* Enable/Disable */}
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div>
                  <div className="font-medium text-gray-800">Accept Inbound Calls</div>
                  <div className="text-sm text-gray-500">When disabled, callers hear a rejection message</div>
                </div>
                <button
                  onClick={() => setInboundConfig({ ...inboundConfig, enabled: !inboundConfig.enabled })}
                  className={`relative w-14 h-8 rounded-full transition-colors ${
                    inboundConfig.enabled ? 'bg-green-500' : 'bg-gray-300'
                  }`}
                >
                  <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                    inboundConfig.enabled ? 'left-7' : 'left-1'
                  }`} />
                </button>
              </div>

              {/* Business Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Business Name
                </label>
                <input
                  type="text"
                  value={inboundConfig.businessName}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, businessName: e.target.value })}
                  placeholder="Your Business Name"
                  className="w-full p-3 border border-gray-300 rounded-lg text-gray-800"
                />
              </div>

              {/* Greeting */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Greeting Message
                </label>
                <textarea
                  value={inboundConfig.greeting}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, greeting: e.target.value })}
                  placeholder="Hello, thank you for calling..."
                  className="w-full h-24 p-3 border border-gray-300 rounded-lg text-gray-800 resize-none"
                />
                <p className="text-xs text-gray-500 mt-1">This is what the AI says when answering</p>
              </div>

              {/* Purpose */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Purpose
                </label>
                <input
                  type="text"
                  value={inboundConfig.purpose}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, purpose: e.target.value })}
                  placeholder="customer support, appointment booking, general inquiries"
                  className="w-full p-3 border border-gray-300 rounded-lg text-gray-800"
                />
              </div>

              {/* Instructions */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  AI Instructions
                </label>
                <textarea
                  value={inboundConfig.instructions}
                  onChange={(e) => setInboundConfig({ ...inboundConfig, instructions: e.target.value })}
                  placeholder="Be helpful and professional. Answer questions about our products..."
                  className="w-full h-32 p-3 border border-gray-300 rounded-lg text-gray-800 resize-none"
                />
                <p className="text-xs text-gray-500 mt-1">Tell the AI how to handle calls and what information to provide</p>
              </div>

              {/* Voice Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  AI Voice for Inbound Calls
                </label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {voices.slice(0, 8).map((voice) => (
                    <button
                      key={voice.voice_id}
                      onClick={() => setInboundConfig({ ...inboundConfig, voiceId: voice.voice_id })}
                      className={`p-3 rounded-lg border-2 transition-all ${
                        inboundConfig.voiceId === voice.voice_id
                          ? 'border-indigo-600 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="font-medium text-gray-800">{voice.name}</div>
                      <div className="text-xs text-gray-500">{voice.gender}</div>
                    </button>
                  ))}
                </div>
              </div>

              {configSaved && (
                <div className="p-4 bg-green-50 text-green-700 rounded-lg">
                  Configuration saved successfully!
                </div>
              )}

              {error && (
                <div className="p-4 bg-red-50 text-red-700 rounded-lg">
                  {error}
                </div>
              )}

              <button
                onClick={saveInboundConfig}
                disabled={isLoading}
                className="w-full py-4 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:bg-gray-400 transition-colors"
              >
                {isLoading ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>
        )}

        {/* Active Calls Tab */}
        {tab === 'calls' && (
          <div className="bg-white rounded-2xl shadow-xl p-8 animate-fade-in">
            <h2 className="text-2xl font-semibold text-gray-800 mb-6">
              Active Calls
            </h2>

            {activeCalls.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                <p>No active calls at the moment</p>
              </div>
            ) : (
              <div className="space-y-4">
                {activeCalls.map((call) => (
                  <div key={call.sid} className="p-4 border border-gray-200 rounded-lg">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-medium text-gray-800">
                          {call.direction === 'inbound' ? 'Inbound' : 'Outbound'} Call
                        </div>
                        <div className="text-sm text-gray-500">
                          {call.businessName || 'Unknown'}
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                          {call.sid}
                        </div>
                      </div>
                      <div className={`px-3 py-1 rounded-full text-sm ${
                        call.status === 'in-progress' ? 'bg-green-100 text-green-700' :
                        call.status === 'completed' ? 'bg-gray-100 text-gray-700' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {call.status}
                      </div>
                    </div>
                    {call.duration && (
                      <div className="text-sm text-gray-500 mt-2">
                        Duration: {call.duration}s
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="text-center mt-12 text-sm text-gray-400">
          <p>Powered by Gemini + ElevenLabs + Twilio</p>
        </div>
      </div>
    </main>
  );
}
