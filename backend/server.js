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
    greeting: "Hello, how can I help you?",
    businessName: "CODEC",
    purpose: "general assistance",
    instructions: "Be helpful and concise."
};

// Cleanup old calls
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

        const call = await getTwilioClient().calls.create({
            url: `https://${domain}/twilio/voice?direction=outbound`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `https://${domain}/twilio/status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });

        callState.set(call.sid, {
            direction: 'outbound',
            task: task || 'chat',
            businessName: businessName || 'Someone',
            details: details || '',
            callerName: callerName || 'Alex',
            status: 'initiated',
            startTime: new Date().toISOString()
        });

        res.json({ success: true, callSid: call.sid });
    } catch (e) {
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

    if (dir === 'inbound' && sid && !callState.has(sid)) {
        if (!inboundConfig.enabled) {
            return res.type('text/xml').send(`<?xml version="1.0"?><Response><Say>Not available.</Say><Hangup/></Response>`);
        }
        callState.set(sid, {
            direction: 'inbound',
            from: req.body.From,
            to: req.body.To,
            task: inboundConfig.purpose,
            businessName: inboundConfig.businessName,
            details: inboundConfig.instructions,
            greeting: inboundConfig.greeting,
            status: 'answered',
            startTime: new Date().toISOString()
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
    }
    res.sendStatus(200);
});

// ============================================================================
// REAL-TIME VOICE WEBSOCKET
// ============================================================================

const server = app.listen(PORT, () => console.log(`[CODEC] Port ${PORT}`));
const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (twilioWs) => {
    console.log('[WS] Connected');

    let callSid = null, streamSid = null, direction = 'outbound';
    let geminiWs = null;
    let ready = false;

    const startGemini = (state) => {
        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[GEMINI] Connected');

            // Simple, direct prompt - no fluff
            const prompt = direction === 'inbound'
                ? `You're answering a call for ${state.businessName}. Say: "${state.greeting}" then help them. Be natural, brief.`
                : `You're calling ${state.businessName} about: ${state.task}. Say hi, introduce yourself as ${state.callerName}, explain why you're calling briefly, then have a natural conversation. Be casual and human.`;

            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
                        }
                    },
                    systemInstruction: { parts: [{ text: prompt }] },
                    realtimeInputConfig: {
                        automaticActivityDetection: {}
                    }
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete) {
                    console.log('[GEMINI] Ready');
                    ready = true;

                    // Immediately trigger greeting - no delay
                    geminiWs.send(JSON.stringify({
                        clientContent: {
                            turns: [{ role: "user", parts: [{ text: "Start now." }] }],
                            turnComplete: true
                        }
                    }));
                    return;
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
            } catch (e) {
                // Ignore parse errors
            }
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

                console.log(`[CALL] ${callSid} started`);
                startGemini(callState.get(callSid) || {});
            }
            else if (msg.event === 'media' && ready && geminiWs?.readyState === WebSocket.OPEN) {
                // Stream audio to Gemini immediately
                const pcm = mulawToPcm16k(Buffer.from(msg.media.payload, 'base64'));
                geminiWs.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm.toString('base64') }]
                    }
                }));
            }
            else if (msg.event === 'stop') {
                if (geminiWs) geminiWs.close();
            }
        } catch (e) {}
    });

    twilioWs.on('close', () => { if (geminiWs) geminiWs.close(); });
});

console.log('[CODEC] v5.1 Ready');
