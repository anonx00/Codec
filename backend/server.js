const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const twilio = require('twilio');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS support
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const PORT = process.env.PORT || 8080;

// Initialize Twilio
let twilioClient = null;
const getTwilioClient = () => {
    if (!twilioClient) {
        twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    return twilioClient;
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const callState = new Map();
const conversationState = new Map(); // Store chat conversations
const CALL_STATE_TTL = 30 * 60 * 1000;

let inboundConfig = {
    enabled: true,
    greeting: "Hello, thank you for calling. How can I help you today?",
    businessName: "CODEC AI Assistant",
    purpose: "general assistance",
    instructions: "Be helpful, professional, and concise.",
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'
};

// Cleanup
setInterval(() => {
    const now = Date.now();
    for (const [sid, state] of callState.entries()) {
        if (now - new Date(state.startTime).getTime() > CALL_STATE_TTL) {
            callState.delete(sid);
        }
    }
    for (const [id, conv] of conversationState.entries()) {
        if (now - conv.lastUpdate > CALL_STATE_TTL) {
            conversationState.delete(id);
        }
    }
}, 5 * 60 * 1000);

// ============================================================================
// GEMINI CONFIGURATION
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash-exp';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const GEMINI_REST_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================================
// CACHING
// ============================================================================

let voicesCache = null;
let voicesCacheTime = 0;
const VOICES_CACHE_TTL = 60 * 60 * 1000;

// ============================================================================
// AUDIO CONVERSION
// ============================================================================

const MULAW_DECODE_TABLE = new Int16Array([
    -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
    -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
    -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
    -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
    -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
    -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
    -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
    -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
    -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
    -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
    -876, -844, -812, -780, -748, -716, -684, -652,
    -620, -588, -556, -524, -492, -460, -428, -396,
    -372, -356, -340, -324, -308, -292, -276, -260,
    -244, -228, -212, -196, -180, -164, -148, -132,
    -120, -112, -104, -96, -88, -80, -72, -64,
    -56, -48, -40, -32, -24, -16, -8, 0,
    32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
    23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
    15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
    11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
    7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
    5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
    3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
    2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
    1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
    1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
    876, 844, 812, 780, 748, 716, 684, 652,
    620, 588, 556, 524, 492, 460, 428, 396,
    372, 356, 340, 324, 308, 292, 276, 260,
    244, 228, 212, 196, 180, 164, 148, 132,
    120, 112, 104, 96, 88, 80, 72, 64,
    56, 48, 40, 32, 24, 16, 8, 0
]);

function mulawToPcm16(mulawBuffer) {
    const pcm8k = new Int16Array(mulawBuffer.length);
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm8k[i] = MULAW_DECODE_TABLE[mulawBuffer[i]];
    }
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = (pcm8k[i] + pcm8k[i + 1]) >> 1;
    }
    pcm16k[pcm16k.length - 2] = pcm8k[pcm8k.length - 1];
    pcm16k[pcm16k.length - 1] = pcm8k[pcm8k.length - 1];
    return Buffer.from(pcm16k.buffer);
}

// ============================================================================
// CHAT SYSTEM PROMPT
// ============================================================================

const CHAT_SYSTEM_PROMPT = `You are CODEC, an AI assistant that helps users make phone calls. You chat with users to understand what they need, then make calls on their behalf.

YOUR CAPABILITIES:
- Make phone calls to businesses (restaurants, hotels, services, etc.)
- Book reservations, make inquiries, file complaints
- Search for phone numbers if not provided

CONVERSATION FLOW:
1. Greet the user warmly
2. Ask what they need help with
3. Gather necessary details through natural conversation:
   - What type of call (reservation, inquiry, etc.)
   - Business name and location
   - Date/time if applicable
   - Party size if applicable
   - Phone number (or you can search for it)
   - Any special requests
4. Confirm all details before making the call
5. When ready, output a JSON block to trigger the call

RESPONSE FORMAT:
- Be conversational, friendly, and helpful
- Keep responses concise (2-3 sentences max)
- Ask ONE question at a time
- When you have all details and user confirms, output EXACTLY this JSON format on its own line:

{"action":"call","phone":"+61XXXXXXXXX","task":"reservation","business":"Business Name","details":"Party of 2, Friday 7pm, quiet table"}

IMPORTANT:
- Only output the JSON when you have ALL required info AND user confirms
- Phone must be in international format (+61 for Australia)
- If user provides phone, use it. Otherwise ask if they want you to search.
- Be natural - don't sound robotic
- If user asks something outside your capabilities, politely explain what you can do`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function searchWeb(query) {
    const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
    const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;
    if (!apiKey || !engineId) return { success: false, error: 'Search not configured' };

    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${engineId}&q=${encodeURIComponent(query)}&num=5`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.items?.length > 0) {
            return { success: true, results: data.items.map(item => ({ title: item.title, snippet: item.snippet, link: item.link })) };
        }
        return { success: false, error: 'No results' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function findPhoneNumber(businessName, location) {
    const query = `${businessName} ${location} phone number`.trim();
    const result = await searchWeb(query);
    if (!result.success) return result;

    const phonePatterns = [/\+61\s?\d{1,2}\s?\d{4}\s?\d{4}/g, /\(0\d\)\s?\d{4}\s?\d{4}/g, /0\d\s?\d{4}\s?\d{4}/g];

    for (const item of result.results) {
        const text = `${item.title} ${item.snippet}`;
        for (const pattern of phonePatterns) {
            const matches = text.match(pattern);
            if (matches) {
                let phone = matches[0].replace(/[\s\-\(\)]/g, '');
                if (phone.startsWith('0')) phone = '+61' + phone.substring(1);
                return { success: true, phone, source: item.title };
            }
        }
    }
    return { success: false, error: 'Phone not found' };
}

async function chatWithGemini(conversationId, userMessage) {
    // Get or create conversation
    let conv = conversationState.get(conversationId);
    if (!conv) {
        conv = { messages: [], lastUpdate: Date.now(), callData: null };
        conversationState.set(conversationId, conv);
    }

    // Add user message
    conv.messages.push({ role: 'user', content: userMessage });
    conv.lastUpdate = Date.now();

    // Build conversation history for Gemini
    const contents = conv.messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
    }));

    try {
        const response = await fetch(
            `${GEMINI_REST_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents,
                    systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
                    generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
                })
            }
        );

        const data = await response.json();
        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm sorry, I couldn't process that. Could you try again?";

        // Add AI response to conversation
        conv.messages.push({ role: 'assistant', content: aiResponse });

        // Check if AI wants to make a call (JSON in response)
        const jsonMatch = aiResponse.match(/\{"action":"call"[^}]+\}/);
        let callData = null;
        if (jsonMatch) {
            try {
                callData = JSON.parse(jsonMatch[0]);
                conv.callData = callData;
            } catch (e) {
                console.error('[CHAT] JSON parse error:', e);
            }
        }

        return { response: aiResponse, callData };
    } catch (error) {
        console.error('[CHAT] Error:', error);
        return { response: "Sorry, I encountered an error. Please try again.", callData: null };
    }
}

async function getElevenLabsVoices() {
    const now = Date.now();
    if (voicesCache && (now - voicesCacheTime) < VOICES_CACHE_TTL) return voicesCache;

    try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
        });
        const data = await response.json();
        if (data.voices) {
            voicesCache = {
                success: true,
                voices: data.voices.map(v => ({
                    voice_id: v.voice_id, name: v.name,
                    category: v.category || 'custom',
                    accent: v.labels?.accent || 'neutral',
                    gender: v.labels?.gender || 'neutral'
                }))
            };
            voicesCacheTime = now;
            return voicesCache;
        }
    } catch (error) {
        console.error('[VOICES] Error:', error.message);
    }
    return { success: false };
}

const DEFAULT_VOICES = [
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Eric', category: 'premade', accent: 'american', gender: 'male' },
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', accent: 'american', gender: 'female' },
    { voice_id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', category: 'premade', accent: 'american', gender: 'male' },
    { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', category: 'premade', accent: 'american', gender: 'male' },
];

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/', (req, res) => {
    res.json({ name: 'CODEC AI Caller', version: '3.0.0', status: 'running' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', activeCalls: callState.size, activeChats: conversationState.size });
});

// Chat endpoint - main conversational interface
app.post('/api/chat', async (req, res) => {
    const { conversationId, message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

    const convId = conversationId || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const result = await chatWithGemini(convId, message);

    res.json({
        conversationId: convId,
        message: result.response,
        callData: result.callData
    });
});

// Search for phone number
app.post('/api/search-phone', async (req, res) => {
    const { business, location } = req.body;
    if (!business?.trim()) return res.status(400).json({ error: 'Business name required' });
    res.json(await findPhoneNumber(business, location || ''));
});

// Get voices
app.get('/api/voices', async (req, res) => {
    const result = await getElevenLabsVoices();
    res.json(result.success ? result : { success: true, voices: DEFAULT_VOICES, fallback: true });
});

// Inbound config
app.get('/api/inbound/config', (req, res) => {
    res.json({ success: true, config: inboundConfig });
});

app.post('/api/inbound/config', (req, res) => {
    const { enabled, greeting, businessName, purpose, instructions, voiceId } = req.body;
    if (typeof enabled === 'boolean') inboundConfig.enabled = enabled;
    if (greeting?.trim()) inboundConfig.greeting = greeting.trim();
    if (businessName?.trim()) inboundConfig.businessName = businessName.trim();
    if (purpose?.trim()) inboundConfig.purpose = purpose.trim();
    if (instructions?.trim()) inboundConfig.instructions = instructions.trim();
    if (voiceId?.trim()) inboundConfig.voiceId = voiceId.trim();
    res.json({ success: true, config: inboundConfig });
});

// Make call
app.post('/api/call', async (req, res) => {
    const { phoneNumber, task, businessName, details, voiceId } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    try {
        const client = getTwilioClient();
        const serverDomain = process.env.SERVER_DOMAIN;
        if (!serverDomain) return res.status(500).json({ error: 'SERVER_DOMAIN not configured' });

        const call = await client.calls.create({
            url: `https://${serverDomain}/twilio/voice?direction=outbound`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `https://${serverDomain}/twilio/status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });

        callState.set(call.sid, {
            direction: 'outbound',
            task: task || 'general inquiry',
            businessName: businessName || 'the business',
            details: details || '',
            voiceId: voiceId || process.env.ELEVENLABS_VOICE_ID,
            status: 'initiated',
            startTime: new Date().toISOString()
        });

        console.log(`[CALL] Outbound: ${call.sid} to ${phoneNumber}`);
        res.json({ success: true, callSid: call.sid, status: 'initiated' });
    } catch (error) {
        console.error('[CALL] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get call status
app.get('/api/call/:callSid', async (req, res) => {
    const state = callState.get(req.params.callSid);
    if (!state) return res.status(404).json({ error: 'Call not found' });

    if (!['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(state.status)) {
        try {
            const call = await getTwilioClient().calls(req.params.callSid).fetch();
            state.status = call.status;
            state.duration = call.duration;
        } catch (e) {}
    }
    res.json({ sid: req.params.callSid, ...state });
});

// Get all calls
app.get('/api/calls', (req, res) => {
    const calls = [];
    for (const [sid, state] of callState.entries()) {
        calls.push({ sid, ...state });
    }
    res.json({ success: true, calls });
});

// Reset conversation
app.post('/api/chat/reset', (req, res) => {
    const { conversationId } = req.body;
    if (conversationId) conversationState.delete(conversationId);
    res.json({ success: true });
});

// ============================================================================
// TWILIO WEBHOOKS
// ============================================================================

app.get('/twilio/voice', (req, res) => {
    res.json({ endpoint: '/twilio/voice', method: 'POST' });
});

app.post('/twilio/voice', (req, res) => {
    const serverDomain = process.env.SERVER_DOMAIN;
    const direction = req.query.direction || 'inbound';
    const callSid = req.body.CallSid;
    const from = req.body.From;
    const to = req.body.To;

    console.log(`[TWILIO] ${direction} call: ${callSid}`);

    if (direction === 'inbound' && callSid && !callState.has(callSid)) {
        if (!inboundConfig.enabled) {
            res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, we are not accepting calls right now.</Say><Hangup/></Response>`);
            return;
        }
        callState.set(callSid, {
            direction: 'inbound', from, to,
            task: inboundConfig.purpose,
            businessName: inboundConfig.businessName,
            details: inboundConfig.instructions,
            greeting: inboundConfig.greeting,
            voiceId: inboundConfig.voiceId,
            status: 'answered',
            startTime: new Date().toISOString()
        });
    }

    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${serverDomain}/ws/voice">
            <Parameter name="direction" value="${direction}"/>
            <Parameter name="callSid" value="${callSid}"/>
        </Stream>
    </Connect>
</Response>`);
});

app.post('/twilio/status', (req, res) => {
    const { CallSid, CallStatus, CallDuration } = req.body;
    if (CallSid && callState.has(CallSid)) {
        const state = callState.get(CallSid);
        state.status = CallStatus;
        if (CallDuration) state.duration = parseInt(CallDuration);
        if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
            state.endTime = new Date().toISOString();
        }
        console.log(`[STATUS] ${CallSid}: ${CallStatus}`);
    }
    res.sendStatus(200);
});

// ============================================================================
// WEBSOCKET SERVER
// ============================================================================

const server = app.listen(PORT, () => {
    console.log(`[CODEC] Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws/voice' });

// Phone call system prompt
const CALL_SYSTEM_PROMPT = `You are CODEC, an AI making a phone call. You are in a LIVE phone conversation.

CRITICAL RULES:
- Keep responses SHORT (1-2 sentences max)
- Listen and respond naturally
- Stay focused on your task
- Be polite and professional
- Confirm important details
- Say goodbye politely when done`;

const getInboundPrompt = (config) => `You are ${config.businessName}, answering a phone call.
Purpose: ${config.purpose}
Instructions: ${config.instructions}

RULES:
- Keep responses SHORT (1-2 sentences)
- Be helpful and professional
- Listen carefully to the caller`;

wss.on('connection', (twilioWs) => {
    console.log('[WS] Twilio connected');

    let callSid = null;
    let streamSid = null;
    let direction = 'outbound';
    let geminiWs = null;
    let elevenLabsWs = null;
    let isGeminiReady = false;
    let currentVoiceId = process.env.ELEVENLABS_VOICE_ID;
    let conversationStarted = false;

    let audioBuffer = [];
    let audioBufferTimer = null;

    const flushAudioBuffer = () => {
        if (audioBuffer.length === 0 || !geminiWs || !isGeminiReady) return;
        const combined = Buffer.concat(audioBuffer);
        audioBuffer = [];

        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: combined.toString('base64') }]
                }
            }));
        }
    };

    const setupGemini = (context, systemPrompt) => {
        console.log(`[GEMINI] Connecting...`);
        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[GEMINI] Connected');
            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } }
                    },
                    systemInstruction: { parts: [{ text: `${systemPrompt}\n\nContext: ${context}` }] }
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete) {
                    console.log('[GEMINI] Ready');
                    isGeminiReady = true;

                    if (!conversationStarted) {
                        conversationStarted = true;
                        const state = callState.get(callSid) || {};

                        let startPrompt;
                        if (direction === 'inbound') {
                            startPrompt = `Say: "${state.greeting || inboundConfig.greeting}" Then listen.`;
                        } else {
                            startPrompt = `Call connected to ${state.businessName}. Task: ${state.task}. Details: ${state.details}. Greet them and state your purpose briefly.`;
                        }

                        geminiWs.send(JSON.stringify({
                            clientContent: {
                                turns: [{ role: "user", parts: [{ text: startPrompt }] }],
                                turnComplete: true
                            }
                        }));
                    }
                    return;
                }

                // Handle responses
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        if (part.text) {
                            console.log(`[GEMINI] ${part.text}`);
                            sendToElevenLabs(part.text);
                        }
                    }
                }
            } catch (e) {
                console.error('[GEMINI] Error:', e.message);
            }
        });

        geminiWs.on('error', (e) => console.error('[GEMINI] Error:', e.message));
        geminiWs.on('close', () => { isGeminiReady = false; });
    };

    const setupElevenLabs = () => {
        console.log(`[11LABS] Connecting...`);
        elevenLabsWs = new WebSocket(
            `wss://api.elevenlabs.io/v1/text-to-speech/${currentVoiceId}/stream-input?model_id=eleven_turbo_v2&output_format=ulaw_8000`,
            { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
        );

        elevenLabsWs.on('open', () => {
            console.log('[11LABS] Connected');
            elevenLabsWs.send(JSON.stringify({
                text: " ",
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                xi_api_key: process.env.ELEVENLABS_API_KEY
            }));
        });

        elevenLabsWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.audio && streamSid && twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: msg.audio }
                    }));
                }
            } catch (e) {}
        });

        elevenLabsWs.on('error', (e) => console.error('[11LABS] Error:', e.message));
    };

    const sendToElevenLabs = (text) => {
        if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN || !text) return;
        elevenLabsWs.send(JSON.stringify({ text: text + " ", try_trigger_generation: true }));
        elevenLabsWs.send(JSON.stringify({ text: "" }));
    };

    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    streamSid = msg.start.streamSid;
                    callSid = msg.start.callSid;
                    direction = msg.start.customParameters?.direction || 'outbound';

                    const state = callState.get(callSid) || {};
                    currentVoiceId = state.voiceId || process.env.ELEVENLABS_VOICE_ID;

                    const context = direction === 'inbound'
                        ? `Inbound call from ${state.from || 'unknown'}`
                        : `${state.task} for ${state.businessName}. ${state.details}`;

                    const prompt = direction === 'inbound'
                        ? getInboundPrompt(state.businessName ? state : inboundConfig)
                        : CALL_SYSTEM_PROMPT;

                    setupGemini(context, prompt);
                    setupElevenLabs();
                    audioBufferTimer = setInterval(flushAudioBuffer, 100);
                    break;

                case 'media':
                    audioBuffer.push(mulawToPcm16(Buffer.from(msg.media.payload, 'base64')));
                    break;

                case 'stop':
                    cleanup();
                    break;
            }
        } catch (e) {
            console.error('[TWILIO] Error:', e.message);
        }
    });

    const cleanup = () => {
        if (audioBufferTimer) clearInterval(audioBufferTimer);
        if (geminiWs) geminiWs.close();
        if (elevenLabsWs) elevenLabsWs.close();
        audioBuffer = [];
    };

    twilioWs.on('close', cleanup);
    twilioWs.on('error', (e) => console.error('[TWILIO] Error:', e.message));
});

console.log('[CODEC] Server initialized');
