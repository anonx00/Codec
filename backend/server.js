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
    instructions: "Be helpful, professional, and concise."
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

// mu-law decode table (Twilio -> PCM)
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

// PCM to mu-law encode (Gemini -> Twilio)
function linearToMulaw(sample) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let mulaw = ~(sign | (exponent << 4) | mantissa);
    return mulaw & 0xFF;
}

// Twilio mu-law 8kHz -> PCM 16kHz for Gemini
function mulawToPcm16k(mulaw) {
    const pcm8k = new Int16Array(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) {
        pcm8k[i] = MULAW_DECODE[mulaw[i]];
    }
    // Upsample 8kHz to 16kHz
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + pcm8k[i + 1]) / 2);
    }
    pcm16k[pcm16k.length - 2] = pcm8k[pcm8k.length - 1];
    pcm16k[pcm16k.length - 1] = pcm8k[pcm8k.length - 1];
    return Buffer.from(pcm16k.buffer);
}

// Gemini PCM 24kHz -> Twilio mu-law 8kHz
function pcm24kToMulaw8k(pcmBuffer) {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    // Downsample 24kHz to 8kHz (take every 3rd sample)
    const outputLength = Math.floor(samples.length / 3);
    const mulaw = Buffer.alloc(outputLength);
    for (let i = 0; i < outputLength; i++) {
        mulaw[i] = linearToMulaw(samples[i * 3]);
    }
    return mulaw;
}

// ============================================================================
// CHAT PROMPT (for web UI)
// ============================================================================

const CHAT_PROMPT = `You are CODEC, an AI phone assistant. You help users make ANY phone call - personal, business, friends, family, anyone.

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

// ============================================================================
// HELPERS
// ============================================================================

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

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/', (_, res) => res.json({ name: 'CODEC', version: '5.0', mode: 'Gemini Native Audio' }));
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
            task: task || 'have a conversation',
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
        if (callState.has(req.params.sid)) {
            callState.get(req.params.sid).status = 'completed';
        }
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

    console.log(`[TWILIO] ${dir} call: ${sid}`);

    if (dir === 'inbound' && sid && !callState.has(sid)) {
        if (!inboundConfig.enabled) {
            return res.type('text/xml').send(`<?xml version="1.0"?><Response><Say>Not accepting calls.</Say><Hangup/></Response>`);
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
        console.log(`[STATUS] ${CallSid}: ${CallStatus}`);
    }
    res.sendStatus(200);
});

// ============================================================================
// WEBSOCKET - REAL-TIME CALLS (Gemini Native Audio)
// Simple: Twilio <-> Server <-> Gemini (AUDIO mode)
// ============================================================================

const server = app.listen(PORT, () => console.log(`[CODEC] Running on port ${PORT}`));
const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (twilioWs) => {
    console.log('[WS] Twilio connected');

    let callSid = null, streamSid = null, direction = 'outbound';
    let geminiWs = null;
    let isReady = false;

    const connectGemini = (state) => {
        console.log('[GEMINI] Connecting...');
        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[GEMINI] Connected');

            // Build prompt based on call direction
            let systemPrompt;

            if (direction === 'inbound') {
                systemPrompt = `You are answering a phone call for ${state.businessName || 'a business'}.

YOUR GREETING (say this first): "${state.greeting || 'Hello, how can I help you?'}"

YOUR ROLE: ${state.details || 'Help the caller with their needs.'}

RULES:
- Sound natural and human
- Keep responses short (1-2 sentences)
- Listen carefully and respond appropriately
- Be friendly and helpful
- Say goodbye when the conversation is done`;
            } else {
                // OUTBOUND
                systemPrompt = `You are making a phone call on behalf of someone.

WHO YOU ARE: ${state.callerName || 'Alex'}
WHO YOU'RE CALLING: ${state.businessName || 'someone'}
WHY YOU'RE CALLING: ${state.task || 'to have a conversation'}
${state.details ? `DETAILS: ${state.details}` : ''}

YOUR OPENING (say this when they answer):
"Hey! This is ${state.callerName || 'Alex'}. I'm calling about ${state.task || 'something quick'}. Do you have a sec?"

RULES:
- Sound natural and human - warm, casual, friendly
- Keep responses short (1-2 sentences)
- Listen to what they say and respond naturally
- If they're busy, offer to call back
- Stay focused on your purpose
- Thank them and say goodbye when done`;
            }

            // Setup with AUDIO mode - Gemini handles voice directly
            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${GEMINI_MODEL}`,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: "Puck" // Options: Puck, Charon, Kore, Fenrir, Aoede
                                }
                            }
                        }
                    },
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                // Setup complete
                if (msg.setupComplete) {
                    console.log('[GEMINI] Ready - triggering greeting');
                    isReady = true;

                    // Tell Gemini to start the conversation
                    geminiWs.send(JSON.stringify({
                        clientContent: {
                            turns: [{
                                role: "user",
                                parts: [{ text: "The call is now connected. Start with your greeting." }]
                            }],
                            turnComplete: true
                        }
                    }));
                    return;
                }

                // Handle audio from Gemini -> send to Twilio
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        // Audio data
                        if (part.inlineData?.mimeType?.includes('audio') && part.inlineData?.data) {
                            const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
                            const mulawBuffer = pcm24kToMulaw8k(pcmBuffer);

                            // Send to Twilio
                            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
                                twilioWs.send(JSON.stringify({
                                    event: 'media',
                                    streamSid,
                                    media: { payload: mulawBuffer.toString('base64') }
                                }));
                            }
                        }

                        // Text (for logging)
                        if (part.text) {
                            console.log(`[GEMINI] "${part.text}"`);
                        }
                    }
                }

                if (msg.serverContent?.turnComplete) {
                    console.log('[GEMINI] Turn complete');
                }

            } catch (e) {
                console.error('[GEMINI] Parse error:', e.message);
            }
        });

        geminiWs.on('error', (e) => console.error('[GEMINI] Error:', e.message));
        geminiWs.on('close', () => {
            console.log('[GEMINI] Disconnected');
            isReady = false;
        });
    };

    // Handle Twilio messages
    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    streamSid = msg.start.streamSid;
                    callSid = msg.start.customParameters?.callSid || msg.start.callSid;
                    direction = msg.start.customParameters?.direction || 'outbound';

                    const state = callState.get(callSid) || {};
                    console.log(`[CALL] Started: ${callSid} (${direction})`);
                    console.log(`[CALL] Task: ${state.task}`);

                    connectGemini(state);
                    break;

                case 'media':
                    if (!isReady || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;

                    // Convert Twilio audio and send to Gemini
                    const mulawData = Buffer.from(msg.media.payload, 'base64');
                    const pcmData = mulawToPcm16k(mulawData);

                    geminiWs.send(JSON.stringify({
                        realtimeInput: {
                            mediaChunks: [{
                                mimeType: "audio/pcm;rate=16000",
                                data: pcmData.toString('base64')
                            }]
                        }
                    }));
                    break;

                case 'stop':
                    console.log('[CALL] Ended');
                    if (geminiWs) geminiWs.close();
                    break;
            }
        } catch (e) {
            console.error('[WS] Error:', e.message);
        }
    });

    twilioWs.on('close', () => {
        console.log('[WS] Twilio disconnected');
        if (geminiWs) geminiWs.close();
    });

    twilioWs.on('error', (e) => console.error('[WS] Error:', e.message));
});

console.log('[CODEC] Server v5.0 - Gemini Native Audio Mode');
