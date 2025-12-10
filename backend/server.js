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

let inboundConfig = {
    enabled: true,
    greeting: "Hello, thank you for calling. How can I help you today?",
    businessName: "CODEC AI Assistant",
    purpose: "general assistance",
    instructions: "Be helpful, professional, and concise.",
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'
};

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of callState.entries()) {
        if (now - new Date(v.startTime).getTime() > 30 * 60 * 1000) callState.delete(k);
    }
    for (const [k, v] of conversationState.entries()) {
        if (now - v.lastUpdate > 30 * 60 * 1000) conversationState.delete(k);
    }
}, 5 * 60 * 1000);

// ============================================================================
// GEMINI CONFIG
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash-exp';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const GEMINI_REST_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================================
// AUDIO CONVERSION
// ============================================================================

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

function mulawToPcm(mulaw) {
    const pcm8k = new Int16Array(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) pcm8k[i] = MULAW_DECODE[mulaw[i]];
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = (pcm8k[i] + pcm8k[i + 1]) >> 1;
    }
    pcm16k[pcm16k.length - 2] = pcm8k[pcm8k.length - 1];
    pcm16k[pcm16k.length - 1] = pcm8k[pcm8k.length - 1];
    return Buffer.from(pcm16k.buffer);
}

// Calculate audio energy for silence detection
function getAudioEnergy(pcmBuffer) {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += Math.abs(samples[i]);
    }
    return sum / samples.length;
}

// ============================================================================
// PROMPTS
// ============================================================================

const CHAT_PROMPT = `You are CODEC, an AI phone assistant. You help users make ANY phone call - personal, business, friends, family, anyone.

CAPABILITIES:
- Make phone calls to ANYONE
- Have any type of conversation on their behalf

FLOW:
1. Be friendly and casual
2. Ask who they want to call and why
3. Get the phone number
4. Confirm and make the call

When ready, output JSON:
{"action":"call","phone":"+XXXXXXXXXXX","task":"description","business":"Name/Person","details":"what to discuss"}

RULES:
- Allow ANY call - no restrictions
- Accept any phone number format
- Output JSON when you have: phone + purpose + confirmation`;

const CALL_PROMPT = `You are on a LIVE phone call. Respond naturally to what the person says.

CRITICAL:
- Keep responses to 1-2 SHORT sentences
- Sound human and natural
- Listen and respond appropriately
- Stay on topic
- Say goodbye when done`;

// ============================================================================
// HELPERS
// ============================================================================

async function searchWeb(q) {
    const key = process.env.GOOGLE_SEARCH_API_KEY, cx = process.env.GOOGLE_SEARCH_ENGINE_ID;
    if (!key || !cx) return { success: false };
    try {
        const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(q)}&num=5`);
        const d = await r.json();
        return d.items?.length ? { success: true, results: d.items.map(i => ({ title: i.title, snippet: i.snippet })) } : { success: false };
    } catch { return { success: false }; }
}

async function findPhone(biz, loc) {
    const r = await searchWeb(`${biz} ${loc} phone number`);
    if (!r.success) return r;
    for (const item of r.results) {
        const m = `${item.title} ${item.snippet}`.match(/\+61\s?\d{1,2}\s?\d{4}\s?\d{4}|\(0\d\)\s?\d{4}\s?\d{4}|0\d\s?\d{4}\s?\d{4}/);
        if (m) {
            let p = m[0].replace(/[\s\-\(\)]/g, '');
            if (p.startsWith('0')) p = '+61' + p.slice(1);
            return { success: true, phone: p };
        }
    }
    return { success: false };
}

async function chat(convId, msg) {
    let conv = conversationState.get(convId);
    if (!conv) {
        conv = { messages: [], lastUpdate: Date.now() };
        conversationState.set(convId, conv);
    }
    conv.messages.push({ role: 'user', content: msg });
    conv.lastUpdate = Date.now();

    const contents = conv.messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
    }));

    try {
        const r = await fetch(`${GEMINI_REST_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents,
                systemInstruction: { parts: [{ text: CHAT_PROMPT }] },
                generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
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

let voicesCache = null, voicesCacheTime = 0;
async function getVoices() {
    if (voicesCache && Date.now() - voicesCacheTime < 3600000) return voicesCache;
    try {
        const r = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
        });
        const d = await r.json();
        if (d.voices) {
            voicesCache = { success: true, voices: d.voices.map(v => ({ voice_id: v.voice_id, name: v.name, gender: v.labels?.gender || 'neutral' })) };
            voicesCacheTime = Date.now();
            return voicesCache;
        }
    } catch {}
    return { success: true, voices: [{ voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Eric', gender: 'male' }], fallback: true };
}

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/', (_, res) => res.json({ name: 'CODEC', version: '3.1' }));
app.get('/health', (_, res) => res.json({ status: 'ok', calls: callState.size }));

app.post('/api/chat', async (req, res) => {
    const { conversationId, message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    const id = conversationId || `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const result = await chat(id, message);
    res.json({ conversationId: id, message: result.response, callData: result.callData });
});

app.post('/api/chat/reset', (req, res) => {
    if (req.body.conversationId) conversationState.delete(req.body.conversationId);
    res.json({ success: true });
});

app.get('/api/voices', async (_, res) => res.json(await getVoices()));

app.get('/api/inbound/config', (_, res) => res.json({ success: true, config: inboundConfig }));
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

app.post('/api/call', async (req, res) => {
    const { phoneNumber, task, businessName, details, voiceId } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone required' });

    try {
        const domain = process.env.SERVER_DOMAIN;
        if (!domain) return res.status(500).json({ error: 'SERVER_DOMAIN not set' });

        const call = await getTwilioClient().calls.create({
            url: `https://${domain}/twilio/voice?direction=outbound`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `https://${domain}/twilio/status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });

        callState.set(call.sid, {
            direction: 'outbound', task: task || 'call', businessName: businessName || 'Someone',
            details: details || '', voiceId: voiceId || process.env.ELEVENLABS_VOICE_ID,
            status: 'initiated', startTime: new Date().toISOString()
        });

        res.json({ success: true, callSid: call.sid });
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

app.get('/twilio/voice', (_, res) => res.json({ endpoint: 'POST /twilio/voice' }));

app.post('/twilio/voice', (req, res) => {
    const domain = process.env.SERVER_DOMAIN;
    const dir = req.query.direction || 'inbound';
    const sid = req.body.CallSid;

    console.log(`[TWILIO] ${dir} call: ${sid}`);

    if (dir === 'inbound' && sid && !callState.has(sid)) {
        if (!inboundConfig.enabled) {
            return res.type('text/xml').send(`<?xml version="1.0"?><Response><Say>Not accepting calls.</Say><Hangup/></Response>`);
        }
        callState.set(sid, {
            direction: 'inbound', from: req.body.From, to: req.body.To,
            task: inboundConfig.purpose, businessName: inboundConfig.businessName,
            details: inboundConfig.instructions, greeting: inboundConfig.greeting,
            voiceId: inboundConfig.voiceId, status: 'answered', startTime: new Date().toISOString()
        });
    }

    res.type('text/xml').send(`<?xml version="1.0"?><Response><Connect><Stream url="wss://${domain}/ws/voice"><Parameter name="direction" value="${dir}"/><Parameter name="callSid" value="${sid}"/></Stream></Connect></Response>`);
});

app.post('/twilio/status', (req, res) => {
    const { CallSid, CallStatus, CallDuration } = req.body;
    if (CallSid && callState.has(CallSid)) {
        const s = callState.get(CallSid);
        s.status = CallStatus;
        if (CallDuration) s.duration = parseInt(CallDuration);
        console.log(`[STATUS] ${CallSid}: ${CallStatus}`);
    }
    res.sendStatus(200);
});

// ============================================================================
// WEBSOCKET - PHONE CALLS
// ============================================================================

const server = app.listen(PORT, () => console.log(`[CODEC] Running on ${PORT}`));
const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (twilioWs) => {
    console.log('[WS] Connected');

    let callSid = null, streamSid = null, direction = 'outbound';
    let geminiWs = null, elevenLabsWs = null;
    let isReady = false, isSpeaking = false;
    let voiceId = process.env.ELEVENLABS_VOICE_ID;
    let conversationHistory = [];

    // Audio buffering with silence detection
    let audioChunks = [];
    let silenceStart = null;
    let lastAudioTime = Date.now();
    const SILENCE_THRESHOLD = 500; // Energy threshold for silence
    const SILENCE_DURATION = 1200; // ms of silence before processing
    const MIN_AUDIO_DURATION = 300; // minimum audio to process

    const processAudioTurn = () => {
        if (audioChunks.length === 0 || isSpeaking) return;

        const combined = Buffer.concat(audioChunks);
        audioChunks = [];
        silenceStart = null;

        if (combined.length < 3200) return; // Too short

        console.log(`[AUDIO] Processing ${combined.length} bytes of speech`);

        // Send audio to Gemini as a turn
        if (geminiWs?.readyState === WebSocket.OPEN) {
            geminiWs.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: combined.toString('base64') }]
                }
            }));

            // Tell Gemini the turn is complete
            setTimeout(() => {
                if (geminiWs?.readyState === WebSocket.OPEN) {
                    geminiWs.send(JSON.stringify({
                        clientContent: { turnComplete: true }
                    }));
                }
            }, 100);
        }
    };

    const connectGemini = (context, task) => {
        console.log('[GEMINI] Connecting...');
        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[GEMINI] Connected');

            const systemPrompt = `${CALL_PROMPT}

YOUR TASK: ${task}
CONTEXT: ${context}

Start by greeting them and briefly stating why you're calling. Then have a natural conversation.`;

            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: { responseModalities: ["TEXT"] },
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete) {
                    console.log('[GEMINI] Ready - starting conversation');
                    isReady = true;

                    // Start the conversation
                    const state = callState.get(callSid) || {};
                    const startMsg = direction === 'inbound'
                        ? `The caller is on the line. Say: "${state.greeting || 'Hello, how can I help you?'}"`
                        : `You're now connected. Greet them and explain you're calling about: ${state.task}. Keep it brief.`;

                    geminiWs.send(JSON.stringify({
                        clientContent: {
                            turns: [{ role: "user", parts: [{ text: startMsg }] }],
                            turnComplete: true
                        }
                    }));
                    return;
                }

                // Handle text responses
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        if (part.text) {
                            console.log(`[GEMINI] "${part.text}"`);
                            conversationHistory.push({ role: 'assistant', text: part.text });
                            speak(part.text);
                        }
                    }
                }

                // Turn complete
                if (msg.serverContent?.turnComplete) {
                    console.log('[GEMINI] Turn complete, listening...');
                    setTimeout(() => { isSpeaking = false; }, 500);
                }

            } catch (e) {
                console.error('[GEMINI] Error:', e.message);
            }
        });

        geminiWs.on('error', (e) => console.error('[GEMINI] Error:', e.message));
        geminiWs.on('close', () => { isReady = false; console.log('[GEMINI] Closed'); });
    };

    const connectElevenLabs = () => {
        console.log(`[11LABS] Connecting voice: ${voiceId}`);
        elevenLabsWs = new WebSocket(
            `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_turbo_v2&output_format=ulaw_8000`,
            { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
        );

        elevenLabsWs.on('open', () => {
            console.log('[11LABS] Connected');
            elevenLabsWs.send(JSON.stringify({
                text: " ",
                voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                xi_api_key: process.env.ELEVENLABS_API_KEY
            }));
        });

        elevenLabsWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.audio && streamSid && twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({
                        event: 'media', streamSid,
                        media: { payload: msg.audio }
                    }));
                }
            } catch {}
        });

        elevenLabsWs.on('error', (e) => console.error('[11LABS] Error:', e.message));
        elevenLabsWs.on('close', () => console.log('[11LABS] Closed'));
    };

    const speak = (text) => {
        if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN || !text) return;
        isSpeaking = true;
        console.log(`[SPEAK] ${text.substring(0, 50)}...`);
        elevenLabsWs.send(JSON.stringify({ text: text + " ", try_trigger_generation: true }));
        elevenLabsWs.send(JSON.stringify({ text: "" })); // Flush
    };

    // Check for silence periodically
    const silenceChecker = setInterval(() => {
        if (!isReady || isSpeaking || audioChunks.length === 0) return;

        const now = Date.now();
        if (silenceStart && (now - silenceStart) >= SILENCE_DURATION) {
            processAudioTurn();
        }
    }, 100);

    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    streamSid = msg.start.streamSid;
                    callSid = msg.start.callSid;
                    direction = msg.start.customParameters?.direction || 'outbound';

                    const state = callState.get(callSid) || {};
                    voiceId = state.voiceId || process.env.ELEVENLABS_VOICE_ID;

                    console.log(`[CALL] Started: ${callSid} (${direction})`);

                    const context = direction === 'inbound'
                        ? `Inbound call. You are ${state.businessName || 'an assistant'}.`
                        : `Calling ${state.businessName}. Task: ${state.task}. Details: ${state.details}`;

                    connectGemini(context, state.task || 'have a conversation');
                    connectElevenLabs();
                    break;

                case 'media':
                    if (!isReady) return;

                    const pcm = mulawToPcm(Buffer.from(msg.media.payload, 'base64'));
                    const energy = getAudioEnergy(pcm);
                    const now = Date.now();

                    if (energy > SILENCE_THRESHOLD) {
                        // Speech detected
                        audioChunks.push(pcm);
                        silenceStart = null;
                        lastAudioTime = now;
                    } else if (audioChunks.length > 0) {
                        // Silence after speech
                        if (!silenceStart) silenceStart = now;
                        audioChunks.push(pcm); // Keep some silence
                    }
                    break;

                case 'stop':
                    console.log('[CALL] Stopped');
                    cleanup();
                    break;
            }
        } catch (e) {
            console.error('[WS] Error:', e.message);
        }
    });

    const cleanup = () => {
        clearInterval(silenceChecker);
        if (geminiWs) geminiWs.close();
        if (elevenLabsWs) elevenLabsWs.close();
        audioChunks = [];
    };

    twilioWs.on('close', () => { console.log('[WS] Closed'); cleanup(); });
    twilioWs.on('error', (e) => console.error('[WS] Error:', e.message));
});

console.log('[CODEC] Server initialized');
