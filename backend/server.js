const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const twilio = require('twilio');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const PORT = process.env.PORT || 8080;

let twilioClient = null;
const getTwilioClient = () => {
    if (!twilioClient) {
        twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    return twilioClient;
};

// ============================================================================
// STATE
// ============================================================================

const callState = new Map();
const conversationState = new Map();
const pendingGeminiSessions = new Map(); // Pre-established Gemini connections

let inboundConfig = {
    enabled: true,
    greeting: "Hello, how can I help you?",
    businessName: "CODEC",
    purpose: "general assistance",
    instructions: "Be helpful and concise."
};

// Cleanup old calls and stale Gemini sessions
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of callState.entries()) {
        if (now - new Date(v.startTime).getTime() > 30 * 60 * 1000) callState.delete(k);
    }
    for (const [k, v] of conversationState.entries()) {
        if (now - v.lastUpdate > 30 * 60 * 1000) conversationState.delete(k);
    }
    // Clean up stale Gemini sessions (unused after 60 seconds)
    for (const [k, v] of pendingGeminiSessions.entries()) {
        if (now - v.createdAt > 60 * 1000) {
            if (v.geminiWs) v.geminiWs.close();
            pendingGeminiSessions.delete(k);
        }
    }
}, 5 * 60 * 1000);

// ============================================================================
// GEMINI CONFIG
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Native audio model for true real-time voice (from docs)
const GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';
// Use v1alpha for native audio features (affective dialog, proactive audio)
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const GEMINI_REST_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================================
// AUDIO CONVERSION (Optimized)
// ============================================================================

// Pre-computed mu-law tables for speed
const MULAW_DECODE = new Int16Array([
    -32124,-31100,-30076,-29052,-28028,-27004,-25980,-24956,-23932,-22908,-21884,-20860,-19836,-18812,-17788,-16764,
    -15996,-15484,-14972,-14460,-13948,-13436,-12924,-12412,-11900,-11388,-10876,-10364,-9852,-9340,-8828,-8316,
    -7932,-7676,-7420,-7164,-6908,-6652,-6396,-6140,-5884,-5628,-5372,-5116,-4860,-4604,-4348,-4092,
    -3900,-3772,-3644,-3516,-3388,-3260,-3132,-3004,-2876,-2748,-2620,-2492,-2364,-2236,-2108,-1980,
    -1884,-1820,-1756,-1692,-1628,-1564,-1500,-1436,-1372,-1308,-1244,-1180,-1116,-1052,-988,-924,
    -876,-844,-812,-780,-748,-716,-684,-652,-620,-588,-556,-524,-492,-460,-428,-396,
    -372,-356,-340,-324,-308,-292,-276,-260,-244,-228,-212,-196,-180,-164,-148,-132,
    -120,-112,-104,-96,-88,-80,-72,-64,-56,-48,-40,-32,-24,-16,-8,0,
    32124,31100,30076,29052,28028,27004,25980,24956,23932,22908,21884,20860,19836,18812,17788,16764,
    15996,15484,14972,14460,13948,13436,12924,12412,11900,11388,10876,10364,9852,9340,8828,8316,
    7932,7676,7420,7164,6908,6652,6396,6140,5884,5628,5372,5116,4860,4604,4348,4092,
    3900,3772,3644,3516,3388,3260,3132,3004,2876,2748,2620,2492,2364,2236,2108,1980,
    1884,1820,1756,1692,1628,1564,1500,1436,1372,1308,1244,1180,1116,1052,988,924,
    876,844,812,780,748,716,684,652,620,588,556,524,492,460,428,396,
    372,356,340,324,308,292,276,260,244,228,212,196,180,164,148,132,
    120,112,104,96,88,80,72,64,56,48,40,32,24,16,8,0
]);

// Pre-compute mu-law encode table
const MULAW_ENCODE = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
    let sample = i - 32768;
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    let sign = 0;
    if (sample < 0) { sign = 0x80; sample = -sample; }
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;
    let exp = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exp > 0; exp--, expMask >>= 1) {}
    const mantissa = (sample >> (exp + 3)) & 0x0F;
    MULAW_ENCODE[i] = ~(sign | (exp << 4) | mantissa) & 0xFF;
}

// Fast mu-law 8kHz -> PCM 16kHz
function mulawToPcm16k(mulaw) {
    const len = mulaw.length;
    const pcm = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
        const s = MULAW_DECODE[mulaw[i]];
        pcm[i * 2] = s;
        pcm[i * 2 + 1] = s; // Simple duplicate for upsampling
    }
    return Buffer.from(pcm.buffer);
}

// PCM 24kHz -> mu-law 8kHz with proper low-pass filtering to prevent aliasing/static
function pcm24kToMulaw8k(pcmBuffer) {
    const src = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    const destLen = Math.floor(src.length / 3);
    const mulaw = Buffer.alloc(destLen);

    for (let i = 0; i < destLen; i++) {
        const srcIdx = i * 3;
        // Average 3 samples (simple low-pass filter) to prevent aliasing
        const s1 = src[srcIdx] || 0;
        const s2 = src[srcIdx + 1] || 0;
        const s3 = src[srcIdx + 2] || 0;
        const avg = Math.round((s1 + s2 + s3) / 3);

        // Convert averaged sample to mu-law
        mulaw[i] = MULAW_ENCODE[avg + 32768];
    }
    return mulaw;
}

// ============================================================================
// PRE-ESTABLISH GEMINI SESSION
// ============================================================================

function preEstablishGemini(sessionId, state) {
    return new Promise((resolve, reject) => {
        const geminiWs = new WebSocket(GEMINI_WS_URL);

        const timeout = setTimeout(() => {
            geminiWs.close();
            pendingGeminiSessions.delete(sessionId);
            reject(new Error('Gemini connection timeout'));
        }, 10000);

        geminiWs.on('open', () => {
            console.log(`[GEMINI] Pre-establishing for ${sessionId}`);

            // Build prompt - natural phone conversation
            const prompt = state.direction === 'inbound'
                ? `You're answering a phone call for ${state.businessName}. Greet them warmly with: "${state.greeting}" then help them. Be natural and brief. Speak with a calm, friendly Australian accent.`
                : `You're making a phone call to ${state.businessName} about: ${state.task}. Say "Hey! This is ${state.callerName} calling" and briefly explain why you're calling. Be casual, friendly, and natural. Speak with a calm Australian accent. Keep responses short and conversational.`;

            // Full native audio config with all features
            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                        }
                    },
                    systemInstruction: { parts: [{ text: prompt }] },
                    // Native audio features
                    enableAffectiveDialog: true,  // Emotion-aware responses
                    proactivity: { proactiveAudio: true },  // Model decides when to respond
                    // VAD configuration for phone calls
                    realtimeInputConfig: {
                        automaticActivityDetection: {
                            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",  // Don't cut off too fast
                            prefixPaddingMs: 100,  // Capture speech start
                            silenceDurationMs: 500  // Wait for natural pauses
                        }
                    },
                    // Get transcriptions for debugging
                    outputAudioTranscription: {}
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.setupComplete) {
                    clearTimeout(timeout);
                    console.log(`[GEMINI] Pre-established and ready for ${sessionId}`);

                    // Store the ready session
                    pendingGeminiSessions.set(sessionId, {
                        geminiWs,
                        ready: true,
                        state,
                        createdAt: Date.now()
                    });

                    resolve(geminiWs);
                }
            } catch (e) {}
        });

        geminiWs.on('error', (e) => {
            clearTimeout(timeout);
            pendingGeminiSessions.delete(sessionId);
            reject(e);
        });
    });
}

// ============================================================================
// CHAT (Web UI)
// ============================================================================

const CHAT_PROMPT = `You are CODEC, an AI phone assistant. Help users make calls to anyone.

When ready to call, output: {"action":"call","phone":"+XXX","task":"why","business":"who","details":"info"}

Be casual and friendly. No restrictions on who they can call.`;

async function chat(convId, msg) {
    let conv = conversationState.get(convId);
    if (!conv) {
        conv = { messages: [], lastUpdate: Date.now() };
        conversationState.set(convId, conv);
    }
    conv.messages.push({ role: 'user', content: msg });
    conv.lastUpdate = Date.now();

    try {
        const r = await fetch(`${GEMINI_REST_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: conv.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
                systemInstruction: { parts: [{ text: CHAT_PROMPT }] },
                generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
            })
        });
        const d = await r.json();
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, try again.";
        conv.messages.push({ role: 'assistant', content: text });

        const jsonMatch = text.match(/\{"action":"call"[^}]+\}/);
        let callData = null;
        if (jsonMatch) try { callData = JSON.parse(jsonMatch[0]); } catch {}

        return { response: text, callData };
    } catch (e) {
        return { response: "Error occurred.", callData: null };
    }
}

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/', (_, res) => res.json({ name: 'CODEC', version: '5.1', mode: 'Gemini Real-time Audio' }));
app.get('/health', (_, res) => res.json({ status: 'ok', calls: callState.size }));

app.post('/api/chat', async (req, res) => {
    const { conversationId, message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    const id = conversationId || `c_${Date.now()}`;
    const result = await chat(id, message);
    res.json({ conversationId: id, message: result.response, callData: result.callData });
});

app.post('/api/chat/reset', (req, res) => {
    if (req.body.conversationId) conversationState.delete(req.body.conversationId);
    res.json({ success: true });
});

app.get('/api/inbound/config', (_, res) => res.json({ success: true, config: inboundConfig }));
app.post('/api/inbound/config', (req, res) => {
    const { enabled, greeting, businessName, purpose, instructions } = req.body;
    if (typeof enabled === 'boolean') inboundConfig.enabled = enabled;
    if (greeting?.trim()) inboundConfig.greeting = greeting.trim();
    if (businessName?.trim()) inboundConfig.businessName = businessName.trim();
    if (purpose?.trim()) inboundConfig.purpose = purpose.trim();
    if (instructions?.trim()) inboundConfig.instructions = instructions.trim();
    res.json({ success: true, config: inboundConfig });
});

app.post('/api/call', async (req, res) => {
    const { phoneNumber, task, businessName, details, callerName } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone required' });

    try {
        const domain = process.env.SERVER_DOMAIN;
        if (!domain) return res.status(500).json({ error: 'SERVER_DOMAIN not set' });

        // Generate a temporary session ID for pre-establishing Gemini
        const tempSessionId = `pre_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Build call state early so we can pass it to Gemini
        const state = {
            direction: 'outbound',
            task: task || 'chat',
            businessName: businessName || 'Someone',
            details: details || '',
            callerName: callerName || 'Alex',
            status: 'initiated',
            startTime: new Date().toISOString()
        };

        // Pre-establish Gemini connection BEFORE placing call
        console.log(`[CALL] Pre-establishing Gemini for outbound call...`);
        await preEstablishGemini(tempSessionId, state);
        console.log(`[CALL] Gemini ready, now placing Twilio call...`);

        // NOW place the Twilio call - Gemini is already ready!
        const call = await getTwilioClient().calls.create({
            url: `https://${domain}/twilio/voice?direction=outbound&preSession=${tempSessionId}`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `https://${domain}/twilio/status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });

        // Move the pre-established session to the real call SID
        const preSession = pendingGeminiSessions.get(tempSessionId);
        if (preSession) {
            pendingGeminiSessions.delete(tempSessionId);
            pendingGeminiSessions.set(call.sid, preSession);
        }

        // Store call state with the real SID
        callState.set(call.sid, state);

        res.json({ success: true, callSid: call.sid });
    } catch (e) {
        console.error('[CALL] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/call/:sid/hangup', async (req, res) => {
    try {
        await getTwilioClient().calls(req.params.sid).update({ status: 'completed' });
        if (callState.has(req.params.sid)) callState.get(req.params.sid).status = 'completed';
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/call/:sid', async (req, res) => {
    const s = callState.get(req.params.sid);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (!['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(s.status)) {
        try {
            const c = await getTwilioClient().calls(req.params.sid).fetch();
            s.status = c.status;
            s.duration = c.duration;
        } catch {}
    }
    res.json({ sid: req.params.sid, ...s });
});

app.get('/api/calls', (_, res) => {
    const calls = [];
    for (const [sid, s] of callState.entries()) calls.push({ sid, ...s });
    res.json({ success: true, calls });
});

// ============================================================================
// TWILIO WEBHOOKS
// ============================================================================

app.post('/twilio/voice', (req, res) => {
    const domain = process.env.SERVER_DOMAIN;
    const dir = req.query.direction || 'inbound';
    const sid = req.body.CallSid;

    console.log(`[CALL] ${dir}: ${sid}`);

    // For inbound calls, pre-establish Gemini while responding with TwiML
    if (dir === 'inbound' && sid && !callState.has(sid)) {
        if (!inboundConfig.enabled) {
            return res.type('text/xml').send(`<?xml version="1.0"?><Response><Say>Not available.</Say><Hangup/></Response>`);
        }

        const state = {
            direction: 'inbound',
            from: req.body.From,
            to: req.body.To,
            task: inboundConfig.purpose,
            businessName: inboundConfig.businessName,
            details: inboundConfig.instructions,
            greeting: inboundConfig.greeting,
            status: 'answered',
            startTime: new Date().toISOString()
        };
        callState.set(sid, state);

        // Pre-establish Gemini for inbound (fire and forget - will be ready by WebSocket connect)
        preEstablishGemini(sid, state).catch(e => console.error('[GEMINI] Pre-establish failed:', e.message));
    }

    // No greeting needed - Gemini is pre-established and will speak immediately
    // Connect directly to WebSocket for instant AI response
    res.type('text/xml').send(`<?xml version="1.0"?><Response><Connect><Stream url="wss://${domain}/ws/voice"><Parameter name="direction" value="${dir}"/><Parameter name="callSid" value="${sid}"/></Stream></Connect></Response>`);
});

app.post('/twilio/status', (req, res) => {
    const { CallSid, CallStatus, CallDuration } = req.body;
    if (CallSid && callState.has(CallSid)) {
        const s = callState.get(CallSid);
        s.status = CallStatus;
        if (CallDuration) s.duration = parseInt(CallDuration);
    }
    res.sendStatus(200);
});

// ============================================================================
// REAL-TIME VOICE WEBSOCKET
// ============================================================================

const server = app.listen(PORT, () => console.log(`[CODEC] Port ${PORT}`));
const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (twilioWs) => {
    console.log('[WS] Twilio connected');

    let callSid = null, streamSid = null, direction = 'outbound';
    let geminiWs = null;
    let ready = false;

    // Wire up Gemini message handler to stream audio to Twilio
    const wireGeminiToTwilio = (gWs) => {
        gWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                // Handle interruption - user started speaking
                if (msg.serverContent?.interrupted) {
                    console.log('[GEMINI] Interrupted by user');
                    // Could clear Twilio's audio buffer here if needed
                    return;
                }

                // Log AI transcriptions for debugging
                if (msg.serverContent?.outputTranscription?.text) {
                    console.log('[AI]', msg.serverContent.outputTranscription.text);
                }

                // Stream audio directly to Twilio
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        if (part.inlineData?.data) {
                            const pcm = Buffer.from(part.inlineData.data, 'base64');
                            const mulaw = pcm24kToMulaw8k(pcm);

                            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
                                twilioWs.send(JSON.stringify({
                                    event: 'media',
                                    streamSid,
                                    media: { payload: mulaw.toString('base64') }
                                }));
                            }
                        }
                    }
                }
            } catch (e) {}
        });

        gWs.on('error', (e) => console.error('[GEMINI] Error:', e.message));
        gWs.on('close', () => { ready = false; });
    };

    // Fallback: create Gemini on-the-fly if no pre-established session
    const startGeminiFallback = (state) => {
        console.log('[GEMINI] No pre-established session, creating new one...');
        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[GEMINI] Fallback connected');

            const prompt = direction === 'inbound'
                ? `You're answering a phone call for ${state.businessName}. Greet them warmly with: "${state.greeting}" then help them. Be natural and brief. Speak with a calm, friendly Australian accent.`
                : `You're making a phone call to ${state.businessName} about: ${state.task}. Say "Hey! This is ${state.callerName} calling" and briefly explain why you're calling. Be casual, friendly, and natural. Speak with a calm Australian accent. Keep responses short and conversational.`;

            // Full native audio config
            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                        }
                    },
                    systemInstruction: { parts: [{ text: prompt }] },
                    enableAffectiveDialog: true,
                    proactivity: { proactiveAudio: true },
                    realtimeInputConfig: {
                        automaticActivityDetection: {
                            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                            prefixPaddingMs: 100,
                            silenceDurationMs: 500
                        }
                    },
                    outputAudioTranscription: {}
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete) {
                    console.log('[GEMINI] Fallback ready');
                    ready = true;

                    // Signal turn complete to trigger AI response
                    geminiWs.send(JSON.stringify({
                        clientContent: { turnComplete: true }
                    }));
                    return;
                }

                // Handle interruption - stop any pending audio
                if (msg.serverContent?.interrupted) {
                    console.log('[GEMINI] Interrupted by user');
                    return;
                }

                // Log transcriptions for debugging
                if (msg.serverContent?.outputTranscription?.text) {
                    console.log('[AI]', msg.serverContent.outputTranscription.text);
                }

                // Stream audio to Twilio
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        if (part.inlineData?.data) {
                            const pcm = Buffer.from(part.inlineData.data, 'base64');
                            const mulaw = pcm24kToMulaw8k(pcm);

                            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
                                twilioWs.send(JSON.stringify({
                                    event: 'media',
                                    streamSid,
                                    media: { payload: mulaw.toString('base64') }
                                }));
                            }
                        }
                    }
                }
            } catch (e) {}
        });

        geminiWs.on('error', (e) => console.error('[GEMINI] Error:', e.message));
        geminiWs.on('close', () => { ready = false; });
    };

    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                callSid = msg.start.customParameters?.callSid || msg.start.callSid;
                direction = msg.start.customParameters?.direction || 'outbound';

                console.log(`[CALL] ${callSid} stream started`);

                // Check for pre-established Gemini session
                const preSession = pendingGeminiSessions.get(callSid);
                if (preSession && preSession.ready && preSession.geminiWs?.readyState === WebSocket.OPEN) {
                    console.log(`[GEMINI] Using pre-established session for ${callSid}`);
                    geminiWs = preSession.geminiWs;
                    ready = true;
                    pendingGeminiSessions.delete(callSid);

                    // Wire up the audio routing
                    wireGeminiToTwilio(geminiWs);

                    // Signal turn complete to trigger AI to speak first
                    geminiWs.send(JSON.stringify({
                        clientContent: {
                            turnComplete: true
                        }
                    }));
                } else {
                    // Fallback: create new Gemini session
                    startGeminiFallback(callState.get(callSid) || {});
                }
            }
            else if (msg.event === 'media' && ready && geminiWs?.readyState === WebSocket.OPEN) {
                // Stream caller audio to Gemini
                const pcm = mulawToPcm16k(Buffer.from(msg.media.payload, 'base64'));
                geminiWs.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm.toString('base64') }]
                    }
                }));
            }
            else if (msg.event === 'stop') {
                console.log(`[CALL] ${callSid} stream stopped`);
                if (geminiWs) geminiWs.close();
            }
        } catch (e) {}
    });

    twilioWs.on('close', () => {
        console.log('[WS] Twilio disconnected');
        if (geminiWs) geminiWs.close();
    });
});

console.log('[CODEC] v5.4 Ready - Full Native Audio with Affective Dialog + Proactive Audio');
