const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const twilio = require('twilio');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// CORS support
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const PORT = process.env.PORT || 8080;

// Initialize Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Store active call state
const callState = {};

// Gemini Live API WebSocket URL
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const GEMINI_REST_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================================
// AGENTIC TOOLS - Web Search, Restaurant Lookup, etc.
// ============================================================================

/**
 * Search the web using Google Custom Search API
 */
async function searchWeb(query) {
    console.log(`[TOOL] Searching web for: ${query}`);

    const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_SEARCH_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(searchUrl);
        const data = await response.json();

        if (data.items && data.items.length > 0) {
            const results = data.items.slice(0, 5).map(item => ({
                title: item.title,
                snippet: item.snippet,
                link: item.link
            }));
            console.log(`[TOOL] Found ${results.length} results`);
            return { success: true, results };
        }
        return { success: false, error: 'No results found' };
    } catch (error) {
        console.error('[TOOL] Search error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Search for restaurant phone number
 */
async function findRestaurantPhone(restaurantName, location) {
    console.log(`[TOOL] Finding phone for: ${restaurantName} in ${location}`);

    const query = `${restaurantName} ${location} phone number contact`;
    const result = await searchWeb(query);

    if (result.success) {
        // Extract phone numbers from snippets using regex
        const phoneRegex = /(\+?\d{1,4}[\s\-]?)?(\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{3,4}/g;

        for (const item of result.results) {
            const phones = item.snippet.match(phoneRegex);
            if (phones && phones.length > 0) {
                // Clean up phone number
                const phone = phones[0].replace(/[\s\-\(\)]/g, '');
                if (phone.length >= 8) {
                    console.log(`[TOOL] Found phone: ${phone}`);
                    return {
                        success: true,
                        phone: phone,
                        source: item.title,
                        restaurant: restaurantName
                    };
                }
            }
        }
    }

    return { success: false, error: 'Could not find phone number' };
}

/**
 * Use Gemini to plan and execute agentic tasks
 */
async function agentPlan(userRequest) {
    console.log(`[AGENT] Planning for: ${userRequest}`);

    const response = await fetch(`${GEMINI_REST_URL}/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: `You are CODEC, an AI assistant that helps users make phone calls and reservations.

User request: "${userRequest}"

Analyze this request and extract:
1. What action is needed (reservation, inquiry, complaint, etc.)
2. Restaurant/business name (if mentioned)
3. Location/city (if mentioned, or infer from context)
4. Date and time (if mentioned)
5. Party size (if mentioned)
6. Any special requests
7. Do we need to search for the phone number?

Respond in JSON format:
{
    "action": "reservation|inquiry|complaint|other",
    "business_name": "name or null",
    "location": "city/area or null",
    "date_time": "extracted date/time or null",
    "party_size": number or null,
    "special_requests": "any special notes or null",
    "need_phone_search": true/false,
    "search_query": "query to find phone if needed",
    "ready_to_call": true/false,
    "missing_info": ["list of missing required info"]
}`
                }]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1024
            }
        })
    });

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.error('[AGENT] Failed to parse plan:', e);
        }
    }

    return { action: 'unknown', ready_to_call: false, missing_info: ['Could not understand request'] };
}

// ============================================================================
// ELEVENLABS VOICE API
// ============================================================================

/**
 * Get available voices from ElevenLabs
 */
async function getElevenLabsVoices() {
    try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY
            }
        });

        const data = await response.json();

        // Return formatted voice list with categories
        const voices = data.voices.map(voice => ({
            voice_id: voice.voice_id,
            name: voice.name,
            category: voice.category || 'custom',
            description: voice.description,
            preview_url: voice.preview_url,
            labels: voice.labels || {},
            accent: voice.labels?.accent || 'neutral',
            gender: voice.labels?.gender || 'neutral',
            age: voice.labels?.age || 'adult'
        }));

        return { success: true, voices };
    } catch (error) {
        console.error('Error fetching voices:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// AUDIO CONVERSION UTILITIES
// ============================================================================

function mulawToPcm16(mulawBuffer) {
    const MULAW_DECODE = new Int16Array([
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

    const pcm8k = new Int16Array(mulawBuffer.length);
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm8k[i] = MULAW_DECODE[mulawBuffer[i]];
    }

    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + pcm8k[i + 1]) / 2);
    }
    pcm16k[pcm16k.length - 2] = pcm8k[pcm8k.length - 1];
    pcm16k[pcm16k.length - 1] = pcm8k[pcm8k.length - 1];

    return Buffer.from(pcm16k.buffer);
}

function linearToMulaw(sample) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    const sign = (sample >> 8) & 0x80;

    if (sign !== 0) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;

    sample += MULAW_BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    const mulawByte = ~(sign | (exponent << 4) | mantissa);

    return mulawByte & 0xFF;
}

// ============================================================================
// SYSTEM PROMPT FOR CALL AGENT
// ============================================================================

const SYSTEM_INSTRUCTION = `You are CODEC, an advanced AI assistant making phone calls on behalf of users.

Your personality:
- Professional, friendly, and confident
- Concise - keep responses to 1-2 sentences
- Adaptable to different situations (reservations, inquiries, complaints)

Your capabilities:
- Make restaurant reservations
- General business inquiries
- Handle negotiations politely
- Adapt to unexpected situations

Call guidelines:
- Greet appropriately based on context
- State your purpose clearly
- If the requested time isn't available, negotiate alternatives
- Confirm all details before ending
- Handle being put on hold gracefully
- If it's not the right number, apologize and end politely

Remember: You represent the user professionally. Be persistent but never rude.`;

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * Health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'CODEC AI Caller',
        timestamp: new Date().toISOString()
    });
});

/**
 * Get available voices
 */
app.get('/api/voices', async (req, res) => {
    const result = await getElevenLabsVoices();
    res.json(result);
});

/**
 * Agentic task planning - user describes what they want
 */
app.post('/api/agent/plan', async (req, res) => {
    const { request } = req.body;

    if (!request) {
        return res.status(400).json({ error: 'Request description required' });
    }

    try {
        const plan = await agentPlan(request);

        // If we need to search for phone, do it
        if (plan.need_phone_search && plan.business_name) {
            const phoneResult = await findRestaurantPhone(
                plan.business_name,
                plan.location || ''
            );

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
        console.error('Agent planning error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Search for restaurant/business
 */
app.post('/api/search', async (req, res) => {
    const { query } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Search query required' });
    }

    const result = await searchWeb(query);
    res.json(result);
});

/**
 * Find phone number for a business
 */
app.post('/api/find-phone', async (req, res) => {
    const { business, location } = req.body;

    if (!business) {
        return res.status(400).json({ error: 'Business name required' });
    }

    const result = await findRestaurantPhone(business, location || '');
    res.json(result);
});

/**
 * Initiate a call - the main action
 */
app.post('/api/call', async (req, res) => {
    const {
        phoneNumber,
        task,
        businessName,
        details,
        voiceId
    } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required' });
    }

    try {
        const serverDomain = process.env.SERVER_DOMAIN;

        const call = await twilioClient.calls.create({
            url: `https://${serverDomain}/twilio/voice`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
        });

        // Store call context
        callState[call.sid] = {
            task: task || 'general inquiry',
            businessName: businessName || 'the business',
            details: details || '',
            voiceId: voiceId || process.env.ELEVENLABS_VOICE_ID,
            status: 'initiated',
            startTime: new Date().toISOString()
        };

        console.log(`[CALL] Initiated: ${call.sid} to ${phoneNumber}`);
        res.json({
            success: true,
            callSid: call.sid,
            status: 'initiated'
        });
    } catch (error) {
        console.error("Error creating call:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get call status
 */
app.get('/api/call/:callSid', async (req, res) => {
    const { callSid } = req.params;

    try {
        const call = await twilioClient.calls(callSid).fetch();
        const state = callState[callSid] || {};

        res.json({
            sid: call.sid,
            status: call.status,
            duration: call.duration,
            direction: call.direction,
            ...state
        });
    } catch (error) {
        res.status(404).json({ error: 'Call not found' });
    }
});

/**
 * TwiML webhook - Twilio calls this to get instructions
 */
app.post('/twilio/voice', (req, res) => {
    res.type('text/xml');
    const serverDomain = process.env.SERVER_DOMAIN;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${serverDomain}/ws/voice" />
    </Connect>
</Response>`;

    res.send(twiml);
});

/**
 * Twilio status callback
 */
app.post('/twilio/status', (req, res) => {
    const { CallSid, CallStatus } = req.body;
    console.log(`[CALL] Status update: ${CallSid} -> ${CallStatus}`);

    if (callState[CallSid]) {
        callState[CallSid].status = CallStatus;

        if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
            callState[CallSid].endTime = new Date().toISOString();
        }
    }

    res.sendStatus(200);
});

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    CODEC AI CALLER                         ║
║                   Production Server                        ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP Server:  http://0.0.0.0:${PORT}                        ║
║  WebSocket:    ws://0.0.0.0:${PORT}/ws/voice                 ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                                ║
║    GET  /health          - Health check                    ║
║    GET  /api/voices      - List ElevenLabs voices          ║
║    POST /api/agent/plan  - AI task planning                ║
║    POST /api/search      - Web search                      ║
║    POST /api/find-phone  - Find business phone             ║
║    POST /api/call        - Initiate call                   ║
║    GET  /api/call/:sid   - Get call status                 ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

// ============================================================================
// WEBSOCKET SERVER - Real-time voice handling
// ============================================================================

const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (twilioWs) => {
    console.log('[WS] New Twilio connection');

    let callSid = null;
    let streamSid = null;
    let geminiWs = null;
    let elevenLabsWs = null;
    let isSetupComplete = false;
    let currentVoiceId = process.env.ELEVENLABS_VOICE_ID;

    const setupGemini = (contextPrompt) => {
        console.log('[GEMINI] Connecting...');

        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[GEMINI] Connected');

            const setupMessage = {
                setup: {
                    model: `models/${process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp'}`,
                    generationConfig: {
                        responseModalities: ["TEXT"]
                    },
                    systemInstruction: {
                        parts: [{
                            text: SYSTEM_INSTRUCTION + "\n\nCurrent Task: " + contextPrompt
                        }]
                    }
                }
            };

            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data.toString());

                if (response.setupComplete) {
                    console.log('[GEMINI] Setup complete');
                    isSetupComplete = true;

                    // Start the conversation
                    const initialMessage = {
                        clientContent: {
                            turns: [{
                                role: "user",
                                parts: [{ text: "The call has connected. Begin the conversation appropriately." }]
                            }],
                            turnComplete: true
                        }
                    };
                    geminiWs.send(JSON.stringify(initialMessage));
                    return;
                }

                if (response.serverContent?.modelTurn?.parts) {
                    for (const part of response.serverContent.modelTurn.parts) {
                        if (part.text) {
                            console.log('[GEMINI] Response:', part.text);
                            await sendToElevenLabs(part.text);
                        }
                    }
                }
            } catch (error) {
                console.error('[GEMINI] Message error:', error);
            }
        });

        geminiWs.on('error', (error) => console.error('[GEMINI] Error:', error));
        geminiWs.on('close', () => {
            console.log('[GEMINI] Disconnected');
            isSetupComplete = false;
        });
    };

    const setupElevenLabs = () => {
        const voiceId = currentVoiceId;
        const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2';

        console.log(`[11LABS] Connecting with voice: ${voiceId}`);

        const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=ulaw_8000`;

        elevenLabsWs = new WebSocket(wsUrl, {
            headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
        });

        elevenLabsWs.on('open', () => {
            console.log('[11LABS] Connected');

            const bosMessage = {
                text: " ",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    use_speaker_boost: true
                },
                xi_api_key: process.env.ELEVENLABS_API_KEY
            };
            elevenLabsWs.send(JSON.stringify(bosMessage));
        });

        elevenLabsWs.on('message', (data) => {
            try {
                const response = JSON.parse(data.toString());

                if (response.audio && streamSid) {
                    const mediaMessage = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.audio }
                    };

                    if (twilioWs.readyState === WebSocket.OPEN) {
                        twilioWs.send(JSON.stringify(mediaMessage));
                    }
                }
            } catch (error) {
                // Binary data or parsing error
            }
        });

        elevenLabsWs.on('error', (error) => console.error('[11LABS] Error:', error));
        elevenLabsWs.on('close', () => console.log('[11LABS] Disconnected'));
    };

    const sendToElevenLabs = async (text) => {
        if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN) {
            console.log('[11LABS] Reconnecting...');
            setupElevenLabs();
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
                text: text + " ",
                try_trigger_generation: true
            }));
            elevenLabsWs.send(JSON.stringify({ text: "" }));
        }
    };

    const sendAudioToGemini = (audioBase64) => {
        if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isSetupComplete) return;

        geminiWs.send(JSON.stringify({
            realtimeInput: {
                mediaChunks: [{
                    mimeType: "audio/pcm;rate=16000",
                    data: audioBase64
                }]
            }
        }));
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

                    // Get call context
                    const state = callState[callSid] || {};
                    currentVoiceId = state.voiceId || process.env.ELEVENLABS_VOICE_ID;

                    const context = `Task: ${state.task || 'general inquiry'}
Business: ${state.businessName || 'unknown'}
Details: ${state.details || 'none provided'}`;

                    setupGemini(context);
                    setupElevenLabs();
                    break;

                case 'media':
                    const audioBuffer = Buffer.from(msg.media.payload, 'base64');
                    const pcmBuffer = mulawToPcm16(audioBuffer);
                    sendAudioToGemini(pcmBuffer.toString('base64'));
                    break;

                case 'stop':
                    console.log('[TWILIO] Stream stopped');
                    if (geminiWs) geminiWs.close();
                    if (elevenLabsWs) elevenLabsWs.close();
                    break;
            }
        } catch (error) {
            console.error('[TWILIO] Message error:', error);
        }
    });

    twilioWs.on('close', () => {
        console.log('[TWILIO] Disconnected');
        if (geminiWs) geminiWs.close();
        if (elevenLabsWs) elevenLabsWs.close();
    });

    twilioWs.on('error', (error) => console.error('[TWILIO] Error:', error));
});

console.log('[CODEC] Server initialized');
