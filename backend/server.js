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
const CALL_STATE_TTL = 30 * 60 * 1000;

let inboundConfig = {
    enabled: true,
    greeting: "Hello, thank you for calling. How can I help you today?",
    businessName: "CODEC AI Assistant",
    purpose: "general assistance",
    instructions: "Be helpful, professional, and concise. Answer questions and assist callers with their needs.",
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'
};

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
    // Upsample 8kHz to 16kHz
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

const OUTBOUND_SYSTEM_PROMPT = `You are CODEC, an AI assistant making a phone call on behalf of a user.

IMPORTANT BEHAVIOR:
- You are on a LIVE PHONE CALL - respond naturally to what you hear
- Listen to what the other person says and respond appropriately
- Keep responses SHORT - 1-2 sentences maximum
- Be conversational and natural
- If they ask questions, answer them
- If they put you on hold, wait patiently
- Stay focused on the task at hand

CONVERSATION FLOW:
1. Greet them and state your purpose clearly
2. Listen to their response
3. Answer their questions or provide information
4. Confirm details before ending
5. Thank them and say goodbye

Remember: This is a real phone conversation. Be natural, listen, and respond.`;

const getInboundSystemPrompt = (config) => `You are ${config.businessName}, an AI assistant answering a phone call.

IMPORTANT BEHAVIOR:
- You are on a LIVE PHONE CALL - respond naturally to what you hear
- Listen carefully to what the caller says
- Keep responses SHORT - 1-2 sentences maximum
- Be helpful and professional
- Answer questions based on your purpose: ${config.purpose}

INSTRUCTIONS: ${config.instructions}

CONVERSATION FLOW:
1. After your greeting, LISTEN for their response
2. Answer their questions helpfully
3. If you can't help, explain politely
4. Be friendly when ending the call

Remember: This is a real phone conversation. Listen and respond naturally.`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function searchWeb(query) {
    const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
    const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;
    if (!apiKey || !engineId) {
        return { success: false, error: 'Search not configured' };
    }
    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${engineId}&q=${encodeURIComponent(query)}&num=5`;
        const response = await fetch(url);
        const data = await response.json();
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
        return { success: false, error: error.message };
    }
}

async function findRestaurantPhone(businessName, location) {
    const query = `${businessName} ${location} phone number`.trim();
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
                    return { success: true, phone, source: item.title };
                }
            }
        }
    }
    return { success: false, error: 'Phone number not found' };
}

async function agentPlan(userRequest) {
    const prompt = `Analyze this request and extract information.

Request: "${userRequest}"

Respond ONLY with valid JSON:
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
        console.error('[AGENT] Error:', error.message);
    }
    return { action: 'unknown', ready_to_call: false, missing_info: ['Could not parse'] };
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
            return voicesCache;
        }
    } catch (error) {
        console.error('[VOICES] Error:', error.message);
    }
    return { success: false, error: 'Failed to fetch voices' };
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
    res.json({
        name: 'CODEC AI Caller',
        version: '2.1.0',
        status: 'running',
        features: ['outbound_calls', 'inbound_calls', 'voice_selection', 'ai_planning']
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeCalls: callState.size,
        inboundEnabled: inboundConfig.enabled
    });
});

app.get('/api/voices', async (req, res) => {
    try {
        const result = await getElevenLabsVoices();
        if (result.success) {
            res.json(result);
        } else {
            res.json({ success: true, voices: DEFAULT_VOICES, fallback: true });
        }
    } catch (error) {
        res.json({ success: true, voices: DEFAULT_VOICES, fallback: true });
    }
});

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
    console.log('[CONFIG] Updated:', inboundConfig);
    res.json({ success: true, config: inboundConfig });
});

app.post('/api/agent/plan', async (req, res) => {
    const { request } = req.body;
    if (!request?.trim()) {
        return res.status(400).json({ error: 'Request required' });
    }
    try {
        const plan = await agentPlan(request);
        if (plan.need_phone_search && plan.business_name && process.env.GOOGLE_SEARCH_API_KEY) {
            const phoneResult = await findRestaurantPhone(plan.business_name, plan.location || '');
            if (phoneResult.success) {
                plan.phone_number = phoneResult.phone;
                plan.phone_source = phoneResult.source;
                plan.ready_to_call = true;
            }
        }
        res.json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/search', async (req, res) => {
    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'Query required' });
    res.json(await searchWeb(query));
});

app.post('/api/find-phone', async (req, res) => {
    const { business, location } = req.body;
    if (!business?.trim()) return res.status(400).json({ error: 'Business required' });
    res.json(await findRestaurantPhone(business, location || ''));
});

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

app.get('/twilio/voice', (req, res) => {
    res.json({ endpoint: '/twilio/voice', method: 'POST', inboundEnabled: inboundConfig.enabled });
});

app.post('/twilio/voice', (req, res) => {
    const serverDomain = process.env.SERVER_DOMAIN;
    const direction = req.query.direction || 'inbound';
    const callSid = req.body.CallSid;
    const from = req.body.From;
    const to = req.body.To;

    console.log(`[TWILIO] ${direction} call: ${callSid} from ${from} to ${to}`);

    if (direction === 'inbound' && callSid && !callState.has(callSid)) {
        if (!inboundConfig.enabled) {
            res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, we are not accepting calls at this time.</Say><Hangup/></Response>`);
            return;
        }
        callState.set(callSid, {
            direction: 'inbound',
            from, to,
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
// HTTP & WEBSOCKET SERVER
// ============================================================================

const server = app.listen(PORT, () => {
    console.log(`[CODEC] Server running on port ${PORT}`);
    console.log(`[CODEC] Inbound calls: ${inboundConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
});

const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (twilioWs) => {
    console.log('[WS] Twilio connected');

    let callSid = null;
    let streamSid = null;
    let direction = 'outbound';
    let geminiWs = null;
    let elevenLabsWs = null;
    let isGeminiReady = false;
    let currentVoiceId = process.env.ELEVENLABS_VOICE_ID;
    let hasGreeted = false;
    let conversationStarted = false;
    let pendingText = '';

    // Audio buffer
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
            console.log('[GEMINI] WebSocket connected, sending setup...');

            // Setup with AUDIO response for real-time conversation
            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: "Aoede"
                                }
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{ text: `${systemPrompt}\n\nCurrent task context: ${context}` }]
                    }
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete) {
                    console.log('[GEMINI] Setup complete, ready for conversation');
                    isGeminiReady = true;

                    // Start the conversation
                    const state = callState.get(callSid);

                    if (direction === 'inbound' && state?.greeting && !hasGreeted) {
                        hasGreeted = true;
                        // Send greeting as text, Gemini will speak it
                        geminiWs.send(JSON.stringify({
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: `Start the call by saying: "${state.greeting}" Then listen for their response.` }]
                                }],
                                turnComplete: true
                            }
                        }));
                    } else if (direction === 'outbound' && !conversationStarted) {
                        conversationStarted = true;
                        const state = callState.get(callSid);
                        const taskInfo = state ? `Task: ${state.task}. Business: ${state.businessName}. Details: ${state.details}` : '';

                        geminiWs.send(JSON.stringify({
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: `The phone call has connected. ${taskInfo}. Start the conversation by greeting them and stating your purpose. Keep it brief.` }]
                                }],
                                turnComplete: true
                            }
                        }));
                    }
                    return;
                }

                // Handle audio response from Gemini
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        if (part.inlineData?.mimeType?.includes('audio')) {
                            // Convert Gemini audio to Twilio format and send
                            const audioData = part.inlineData.data;
                            sendAudioToTwilio(audioData);
                        }
                        if (part.text) {
                            console.log(`[GEMINI] Text: ${part.text}`);
                            // Also send to ElevenLabs as backup
                            sendToElevenLabs(part.text);
                        }
                    }
                }

                // Handle turn complete
                if (msg.serverContent?.turnComplete) {
                    console.log('[GEMINI] Turn complete, listening...');
                }

            } catch (e) {
                console.error('[GEMINI] Parse error:', e.message);
            }
        });

        geminiWs.on('error', (e) => {
            console.error('[GEMINI] Error:', e.message);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`[GEMINI] Disconnected: ${code} ${reason}`);
            isGeminiReady = false;
        });
    };

    const sendAudioToTwilio = (base64Audio) => {
        if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;

        try {
            // Gemini outputs 24kHz PCM, need to convert to 8kHz mu-law for Twilio
            // For now, send through ElevenLabs for proper format conversion
            // This is a simplified path - in production you'd convert directly
        } catch (e) {
            console.error('[AUDIO] Conversion error:', e.message);
        }
    };

    const setupElevenLabs = () => {
        const voiceId = currentVoiceId;
        const modelId = 'eleven_turbo_v2';

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
        if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN || !text) return;

        console.log(`[11LABS] Speaking: ${text.substring(0, 50)}...`);
        elevenLabsWs.send(JSON.stringify({
            text: text + " ",
            try_trigger_generation: true
        }));
        elevenLabsWs.send(JSON.stringify({ text: "" })); // Flush
    };

    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    console.log('[TWILIO] Stream started');
                    streamSid = msg.start.streamSid;
                    callSid = msg.start.callSid;

                    const params = msg.start.customParameters || {};
                    direction = params.direction || 'outbound';

                    const state = callState.get(callSid) || {};
                    currentVoiceId = state.voiceId || process.env.ELEVENLABS_VOICE_ID;

                    let context, systemPrompt;
                    if (direction === 'inbound') {
                        context = `Inbound call from ${state.from || 'unknown'}`;
                        systemPrompt = getInboundSystemPrompt(state.businessName ? state : inboundConfig);
                    } else {
                        context = `${state.task || 'inquiry'} for ${state.businessName || 'business'}. ${state.details || ''}`;
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
            console.error('[TWILIO] Error:', e.message);
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

console.log('[CODEC] Server initialized');
