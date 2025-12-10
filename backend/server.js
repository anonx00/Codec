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

// Initialize Twilio (lazy - only when needed)
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

// Store active call state with TTL cleanup
const callState = new Map();
const CALL_STATE_TTL = 30 * 60 * 1000; // 30 minutes

// Inbound call configuration (persisted in memory, could be moved to database)
let inboundConfig = {
    enabled: true,
    greeting: "Hello, thank you for calling. How can I help you today?",
    businessName: "CODEC AI Assistant",
    purpose: "general assistance",
    instructions: "Be helpful, professional, and concise. Answer questions and assist callers with their needs.",
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'
};

// Cleanup old call states periodically
setInterval(() => {
    const now = Date.now();
    for (const [sid, state] of callState.entries()) {
        if (now - new Date(state.startTime).getTime() > CALL_STATE_TTL) {
            callState.delete(sid);
            console.log(`[CLEANUP] Removed stale call state: ${sid}`);
        }
    }
}, 5 * 60 * 1000);

// ============================================================================
// GEMINI CONFIGURATION
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const GEMINI_REST_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================================
// CACHING
// ============================================================================

let voicesCache = null;
let voicesCacheTime = 0;
const VOICES_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ============================================================================
// AUDIO CONVERSION - Pre-computed lookup table
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

    // Upsample 8kHz to 16kHz with linear interpolation
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
// SYSTEM PROMPTS
// ============================================================================

const OUTBOUND_SYSTEM_PROMPT = `You are CODEC, an advanced AI assistant making phone calls on behalf of users.

Personality:
- Professional, friendly, and confident
- Concise - keep responses to 1-2 sentences max
- Adaptable to different situations

Guidelines:
- Greet appropriately based on context
- State your purpose clearly and concisely
- If the requested time isn't available, ask for alternatives
- Confirm all details before ending
- Handle being put on hold gracefully
- If wrong number, apologize briefly and end

Remember: Be persistent but never rude. Represent the user professionally.`;

const getInboundSystemPrompt = (config) => `You are ${config.businessName}, an AI assistant answering incoming phone calls.

Your Purpose: ${config.purpose}

Instructions: ${config.instructions}

Guidelines:
- Start with a warm greeting
- Listen carefully to what the caller needs
- Be helpful, professional, and concise
- Keep responses to 1-2 sentences
- If you can't help with something, politely explain and offer alternatives
- Always be polite when ending the call

Remember: You represent ${config.businessName}. Be professional and helpful.`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function searchWeb(query) {
    const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
    const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

    if (!apiKey || !engineId) {
        console.log('[SEARCH] Google Search not configured');
        return { success: false, error: 'Search not configured' };
    }

    console.log(`[SEARCH] Query: ${query}`);

    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${engineId}&q=${encodeURIComponent(query)}&num=5`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            return { success: false, error: data.error.message };
        }

        if (data.items?.length > 0) {
            return {
                success: true,
                results: data.items.map(item => ({
                    title: item.title,
                    snippet: item.snippet,
                    link: item.link
                }))
            };
        }

        return { success: false, error: 'No results found' };
    } catch (error) {
        console.error('[SEARCH] Error:', error.message);
        return { success: false, error: error.message };
    }
}

async function findRestaurantPhone(businessName, location) {
    const query = `${businessName} ${location} phone number contact`.trim();
    const result = await searchWeb(query);

    if (!result.success) return result;

    const phonePatterns = [
        /\+61\s?\d{1,2}\s?\d{4}\s?\d{4}/g,
        /\(0\d\)\s?\d{4}\s?\d{4}/g,
        /0\d\s?\d{4}\s?\d{4}/g,
        /1[38]00\s?\d{3}\s?\d{3}/g,
    ];

    for (const item of result.results) {
        const text = `${item.title} ${item.snippet}`;
        for (const pattern of phonePatterns) {
            const matches = text.match(pattern);
            if (matches) {
                const phone = matches[0].replace(/[\s\-\(\)]/g, '');
                if (phone.length >= 8) {
                    return { success: true, phone, source: item.title, restaurant: businessName };
                }
            }
        }
    }

    return { success: false, error: 'Phone number not found' };
}

async function agentPlan(userRequest) {
    console.log(`[AGENT] Planning: ${userRequest.substring(0, 100)}...`);

    const prompt = `Analyze this request and extract structured information.

Request: "${userRequest}"

Respond ONLY with valid JSON (no markdown):
{
    "action": "reservation|inquiry|complaint|other",
    "business_name": "name or null",
    "location": "city/area or null",
    "date_time": "when or null",
    "party_size": number or null,
    "special_requests": "notes or null",
    "need_phone_search": true/false,
    "ready_to_call": true/false,
    "missing_info": []
}`;

    try {
        const response = await fetch(
            `${GEMINI_REST_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
                })
            }
        );

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (error) {
        console.error('[AGENT] Planning error:', error.message);
    }

    return { action: 'unknown', ready_to_call: false, missing_info: ['Could not parse request'] };
}

async function getElevenLabsVoices() {
    const now = Date.now();

    if (voicesCache && (now - voicesCacheTime) < VOICES_CACHE_TTL) {
        return voicesCache;
    }

    try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
        });

        const data = await response.json();

        if (data.voices) {
            voicesCache = {
                success: true,
                voices: data.voices.map(v => ({
                    voice_id: v.voice_id,
                    name: v.name,
                    category: v.category || 'custom',
                    accent: v.labels?.accent || 'neutral',
                    gender: v.labels?.gender || 'neutral',
                    preview_url: v.preview_url
                }))
            };
            voicesCacheTime = now;
            console.log(`[VOICES] Cached ${voicesCache.voices.length} voices`);
            return voicesCache;
        }
    } catch (error) {
        console.error('[VOICES] Fetch error:', error.message);
    }

    return { success: false, error: 'Failed to fetch voices' };
}

// Default voices fallback
const DEFAULT_VOICES = [
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Eric', category: 'premade', accent: 'american', gender: 'male' },
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', accent: 'american', gender: 'female' },
    { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', category: 'premade', accent: 'american', gender: 'female' },
    { voice_id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli', category: 'premade', accent: 'american', gender: 'female' },
    { voice_id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', category: 'premade', accent: 'american', gender: 'male' },
    { voice_id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', category: 'premade', accent: 'american', gender: 'male' },
    { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', category: 'premade', accent: 'american', gender: 'male' },
    { voice_id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam', category: 'premade', accent: 'american', gender: 'male' }
];

// ============================================================================
// API ROUTES
// ============================================================================

// Root route
app.get('/', (req, res) => {
    res.json({
        name: 'CODEC AI Caller',
        version: '2.0.0',
        status: 'running',
        features: ['outbound_calls', 'inbound_calls', 'voice_selection', 'ai_planning'],
        endpoints: {
            health: 'GET /health',
            voices: 'GET /api/voices',
            plan: 'POST /api/agent/plan',
            call: 'POST /api/call',
            callStatus: 'GET /api/call/:callSid',
            inboundConfig: 'GET/POST /api/inbound/config',
            search: 'POST /api/search',
            twilioVoice: 'POST /twilio/voice'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'CODEC AI Caller',
        timestamp: new Date().toISOString(),
        activeCalls: callState.size,
        inboundEnabled: inboundConfig.enabled
    });
});

// Voices endpoint with fallback
app.get('/api/voices', async (req, res) => {
    try {
        const result = await getElevenLabsVoices();
        if (result.success) {
            res.json(result);
        } else {
            res.json({ success: true, voices: DEFAULT_VOICES, fallback: true });
        }
    } catch (error) {
        console.error('[API] Voices error:', error);
        res.json({ success: true, voices: DEFAULT_VOICES, fallback: true });
    }
});

// Inbound call configuration
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

    console.log('[CONFIG] Inbound config updated:', inboundConfig);
    res.json({ success: true, config: inboundConfig });
});

// AI Planning
app.post('/api/agent/plan', async (req, res) => {
    const { request } = req.body;

    if (!request?.trim()) {
        return res.status(400).json({ error: 'Request description required' });
    }

    try {
        const plan = await agentPlan(request);

        if (plan.need_phone_search && plan.business_name && process.env.GOOGLE_SEARCH_API_KEY) {
            const phoneResult = await findRestaurantPhone(plan.business_name, plan.location || '');
            if (phoneResult.success) {
                plan.phone_number = phoneResult.phone;
                plan.phone_source = phoneResult.source;
                plan.ready_to_call = true;
            } else {
                plan.missing_info = plan.missing_info || [];
                plan.missing_info.push('Phone number not found - please provide it');
            }
        }

        res.json({ success: true, plan });
    } catch (error) {
        console.error('[API] Plan error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search
app.post('/api/search', async (req, res) => {
    const { query } = req.body;
    if (!query?.trim()) {
        return res.status(400).json({ error: 'Search query required' });
    }
    res.json(await searchWeb(query));
});

// Find phone
app.post('/api/find-phone', async (req, res) => {
    const { business, location } = req.body;
    if (!business?.trim()) {
        return res.status(400).json({ error: 'Business name required' });
    }
    res.json(await findRestaurantPhone(business, location || ''));
});

// Initiate outbound call
app.post('/api/call', async (req, res) => {
    const { phoneNumber, task, businessName, details, voiceId } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required' });
    }

    try {
        const client = getTwilioClient();
        const serverDomain = process.env.SERVER_DOMAIN;

        if (!serverDomain) {
            return res.status(500).json({ error: 'SERVER_DOMAIN not configured' });
        }

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

        console.log(`[CALL] Outbound initiated: ${call.sid} to ${phoneNumber}`);
        res.json({ success: true, callSid: call.sid, status: 'initiated' });
    } catch (error) {
        console.error('[CALL] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get call status
app.get('/api/call/:callSid', async (req, res) => {
    const { callSid } = req.params;
    const state = callState.get(callSid);

    if (!state) {
        return res.status(404).json({ error: 'Call not found' });
    }

    if (!['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(state.status)) {
        try {
            const client = getTwilioClient();
            const call = await client.calls(callSid).fetch();
            state.status = call.status;
            state.duration = call.duration;
        } catch (error) {
            // Use cached state
        }
    }

    res.json({ sid: callSid, ...state });
});

// Get all active calls
app.get('/api/calls', (req, res) => {
    const calls = [];
    for (const [sid, state] of callState.entries()) {
        calls.push({ sid, ...state });
    }
    res.json({ success: true, calls });
});

// ============================================================================
// TWILIO WEBHOOKS
// ============================================================================

// GET handler for browser visits
app.get('/twilio/voice', (req, res) => {
    res.json({
        endpoint: '/twilio/voice',
        method: 'POST',
        description: 'Twilio webhook for voice calls (inbound and outbound)',
        inboundEnabled: inboundConfig.enabled
    });
});

// Voice webhook - handles both inbound and outbound
app.post('/twilio/voice', (req, res) => {
    const serverDomain = process.env.SERVER_DOMAIN;
    const direction = req.query.direction || 'inbound';
    const callSid = req.body.CallSid;
    const from = req.body.From;
    const to = req.body.To;

    console.log(`[TWILIO] ${direction} call: ${callSid} from ${from} to ${to}`);

    // For inbound calls, create state if not exists
    if (direction === 'inbound' && callSid && !callState.has(callSid)) {
        if (!inboundConfig.enabled) {
            // Reject call if inbound is disabled
            res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Sorry, we are not accepting calls at this time. Please try again later.</Say>
    <Hangup/>
</Response>`);
            return;
        }

        callState.set(callSid, {
            direction: 'inbound',
            from: from,
            to: to,
            task: inboundConfig.purpose,
            businessName: inboundConfig.businessName,
            details: inboundConfig.instructions,
            greeting: inboundConfig.greeting,
            voiceId: inboundConfig.voiceId,
            status: 'answered',
            startTime: new Date().toISOString()
        });
        console.log(`[CALL] Inbound call registered: ${callSid} from ${from}`);
    }

    // Connect to media stream
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

// Status callback
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
// HTTP & WEBSOCKET SERVER
// ============================================================================

const server = app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    CODEC AI CALLER                         ║
║                   Production Server                        ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP:      http://0.0.0.0:${PORT}                           ║
║  WebSocket: wss://SERVER_DOMAIN/ws/voice                   ║
║  Inbound:   ${inboundConfig.enabled ? 'ENABLED' : 'DISABLED'}                                      ║
╚═══════════════════════════════════════════════════════════╝
`);
});

const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (twilioWs, req) => {
    console.log('[WS] Twilio media stream connected');

    let callSid = null;
    let streamSid = null;
    let direction = 'outbound';
    let geminiWs = null;
    let elevenLabsWs = null;
    let isGeminiReady = false;
    let currentVoiceId = process.env.ELEVENLABS_VOICE_ID;
    let hasGreeted = false;

    // Audio buffer for batching
    let audioBuffer = [];
    let audioBufferTimer = null;
    const AUDIO_BUFFER_MS = 100;

    const flushAudioBuffer = () => {
        if (audioBuffer.length === 0 || !geminiWs || !isGeminiReady) return;

        const combined = Buffer.concat(audioBuffer);
        audioBuffer = [];

        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: "audio/pcm;rate=16000",
                        data: combined.toString('base64')
                    }]
                }
            }));
        }
    };

    const setupGemini = (context, systemPrompt) => {
        console.log(`[GEMINI] Connecting for ${direction} call...`);
        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[GEMINI] Connected');
            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: { responseModalities: ["TEXT"] },
                    systemInstruction: {
                        parts: [{ text: `${systemPrompt}\n\nContext: ${context}` }]
                    }
                }
            }));
        });

        geminiWs.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete) {
                    console.log('[GEMINI] Ready');
                    isGeminiReady = true;

                    // For inbound calls, greet immediately
                    // For outbound calls, wait for the other party to answer
                    const state = callState.get(callSid);
                    if (direction === 'inbound' && state?.greeting && !hasGreeted) {
                        hasGreeted = true;
                        sendToElevenLabs(state.greeting);
                    } else if (direction === 'outbound') {
                        geminiWs.send(JSON.stringify({
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: "The call has connected. Begin the conversation appropriately." }]
                                }],
                                turnComplete: true
                            }
                        }));
                    }
                    return;
                }

                const parts = msg.serverContent?.modelTurn?.parts || [];
                for (const part of parts) {
                    if (part.text) {
                        console.log(`[GEMINI ${direction}]:`, part.text);
                        sendToElevenLabs(part.text);
                    }
                }
            } catch (e) {
                console.error('[GEMINI] Parse error:', e.message);
            }
        });

        geminiWs.on('error', (e) => console.error('[GEMINI] Error:', e.message));
        geminiWs.on('close', () => {
            console.log('[GEMINI] Disconnected');
            isGeminiReady = false;
        });
    };

    const setupElevenLabs = () => {
        const voiceId = currentVoiceId;
        const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2';

        console.log(`[11LABS] Connecting voice: ${voiceId}`);

        elevenLabsWs = new WebSocket(
            `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=ulaw_8000`,
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
            } catch (e) {
                // Binary or non-JSON
            }
        });

        elevenLabsWs.on('error', (e) => console.error('[11LABS] Error:', e.message));
        elevenLabsWs.on('close', () => console.log('[11LABS] Disconnected'));
    };

    const sendToElevenLabs = (text) => {
        if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN) return;
        elevenLabsWs.send(JSON.stringify({ text: text + " ", try_trigger_generation: true }));
        elevenLabsWs.send(JSON.stringify({ text: "" }));
    };

    // Handle Twilio messages
    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    console.log('[TWILIO] Stream started');
                    streamSid = msg.start.streamSid;
                    callSid = msg.start.callSid;

                    // Get custom parameters
                    const params = msg.start.customParameters || {};
                    direction = params.direction || 'outbound';

                    const state = callState.get(callSid) || {};
                    currentVoiceId = state.voiceId || process.env.ELEVENLABS_VOICE_ID;

                    // Build context and system prompt based on direction
                    let context, systemPrompt;
                    if (direction === 'inbound') {
                        context = `Inbound call. Caller: ${state.from || 'unknown'}. Purpose: ${state.task || inboundConfig.purpose}`;
                        systemPrompt = getInboundSystemPrompt(state.businessName ? state : inboundConfig);
                    } else {
                        context = `${state.task || 'inquiry'} - ${state.businessName || 'business'}. ${state.details || ''}`;
                        systemPrompt = OUTBOUND_SYSTEM_PROMPT;
                    }

                    setupGemini(context, systemPrompt);
                    setupElevenLabs();

                    audioBufferTimer = setInterval(flushAudioBuffer, AUDIO_BUFFER_MS);
                    break;

                case 'media':
                    const pcm = mulawToPcm16(Buffer.from(msg.media.payload, 'base64'));
                    audioBuffer.push(pcm);
                    break;

                case 'stop':
                    console.log('[TWILIO] Stream stopped');
                    cleanup();
                    break;
            }
        } catch (e) {
            console.error('[TWILIO] Message error:', e.message);
        }
    });

    const cleanup = () => {
        if (audioBufferTimer) clearInterval(audioBufferTimer);
        if (geminiWs) geminiWs.close();
        if (elevenLabsWs) elevenLabsWs.close();
        audioBuffer = [];
    };

    twilioWs.on('close', () => {
        console.log('[TWILIO] Disconnected');
        cleanup();
    });

    twilioWs.on('error', (e) => console.error('[TWILIO] Error:', e.message));
});

console.log('[CODEC] Server initialized - Inbound & Outbound calls ready');
