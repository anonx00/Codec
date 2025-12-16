const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const twilio = require('twilio');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS configuration - restrict to frontend domain only
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const ALLOWED_ORIGINS = FRONTEND_URL ? [FRONTEND_URL] : [];

// In dev mode without FRONTEND_URL, allow localhost
if (!FRONTEND_URL && process.env.NODE_ENV !== 'production') {
    ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:8080');
}

app.use((req, res, next) => {
    const origin = req.headers.origin;

    // Check if origin is allowed
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Access-Control-Allow-Credentials", "true");
    } else if (ALLOWED_ORIGINS.length === 0) {
        // Fallback: if no origins configured, allow all (dev mode warning)
        console.warn('[CORS] No FRONTEND_URL configured - allowing all origins (insecure)');
        res.header("Access-Control-Allow-Origin", "*");
    }
    // If origin doesn't match, don't set CORS headers (browser will block)

    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const PORT = process.env.PORT || 8080;

// ============================================================================
// AUTHENTICATION
// ============================================================================

const CODEC_ACCESS_CODE = process.env.CODEC_ACCESS_CODE || 'codec-dev-mode';
const activeSessions = new Map(); // token -> { createdAt, expiresAt }

// Generate a session token
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Validate session token
function validateToken(token) {
    if (!token) return false;
    const session = activeSessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
        activeSessions.delete(token);
        return false;
    }
    return true;
}

// Auth middleware - protects API routes
const requireAuth = (req, res, next) => {
    // Skip auth for health checks and Twilio webhooks
    if (req.path === '/health' || req.path === '/' || req.path.startsWith('/twilio/')) {
        return next();
    }

    // Check for token in Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
    }

    const token = authHeader.substring(7);
    if (!validateToken(token)) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }

    next();
};

// Cleanup expired sessions
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (now > session.expiresAt) {
            activeSessions.delete(token);
        }
    }
}, 60 * 1000);

// ============================================================================
// TWILIO CLIENT & SIGNATURE VALIDATION
// ============================================================================

let twilioClient = null;
const getTwilioClient = () => {
    if (!twilioClient) {
        twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    return twilioClient;
};

// Twilio request signature validation middleware
// Ensures requests to /twilio/* endpoints actually come from Twilio
const validateTwilioSignature = (req, res, next) => {
    // Skip validation in development mode (when no auth token is set)
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
        console.warn('[TWILIO] No auth token - skipping signature validation (dev mode)');
        return next();
    }

    const twilioSignature = req.headers['x-twilio-signature'];
    if (!twilioSignature) {
        console.error('[TWILIO] Missing X-Twilio-Signature header');
        return res.status(403).type('text/plain').send('Forbidden: Missing signature');
    }

    // Build the full URL that Twilio used to sign the request
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = `${protocol}://${host}${req.originalUrl}`;

    // Validate the signature using Twilio's helper
    const isValid = twilio.validateRequest(
        authToken,
        twilioSignature,
        url,
        req.body || {}
    );

    if (!isValid) {
        console.error('[TWILIO] Invalid signature for URL:', url);
        return res.status(403).type('text/plain').send('Forbidden: Invalid signature');
    }

    next();
};

// ============================================================================
// STATE
// ============================================================================

const callState = new Map();
const conversationState = new Map();
const pendingGeminiSessions = new Map(); // Pre-established Gemini connections
const callTranscripts = new Map(); // Store call transcripts
const callAudioBuffers = new Map(); // Store audio for post-call transcription
const callSummaries = new Map(); // Store AI-generated call summaries

let inboundConfig = {
    enabled: true,
    greeting: "Hello, how can I help you?",
    businessName: "CODEC",
    purpose: "general assistance",
    instructions: "Be helpful and concise."
};

// Cleanup old calls, transcripts, conversation state and stale Gemini sessions
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of callState.entries()) {
        if (now - new Date(v.startTime).getTime() > 60 * 60 * 1000) {
            callState.delete(k);
            callTranscripts.delete(k);
            callAudioBuffers.delete(k);
            callSummaries.delete(k);
            callConversationState.delete(k); // Clean up conversation state
        }
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
    // Clean up orphaned conversation states
    for (const [k, v] of callConversationState.entries()) {
        if (!callState.has(k) && now - v.lastSpeakerTime > 5 * 60 * 1000) {
            callConversationState.delete(k);
        }
    }
}, 5 * 60 * 1000);

// ============================================================================
// GEMINI CONFIG
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'codec-480810';

// Vertex AI Native Audio models (only in us-central1)
// Use the LATEST model from Gemini docs
const VERTEX_REGION = 'us-central1';
const GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'; // Latest from docs

// Standard model for text chat (REST API with API key)
const GEMINI_CHAT_MODEL = 'gemini-2.0-flash-exp';
const GEMINI_REST_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================================
// CALL STATE & DETECTION PATTERNS
// ============================================================================

// Patterns for detecting voicemail, IVR systems, and auto-responses
const DETECTION_PATTERNS = {
    // Voicemail detection phrases
    voicemail: [
        'leave a message',
        'leave your message',
        'after the beep',
        'after the tone',
        'record your message',
        'not available',
        'cannot take your call',
        'voicemail',
        'mailbox',
        'please leave',
        'at the beep',
        'press pound',
        'press star'
    ],

    // IVR/Auto-attendant detection
    ivr: [
        'press 1',
        'press 2',
        'press 3',
        'press 4',
        'press 5',
        'press 6',
        'press 7',
        'press 8',
        'press 9',
        'press 0',
        'press one',
        'press two',
        'dial',
        'for sales',
        'for support',
        'for billing',
        'for hours',
        'main menu',
        'automated system',
        'please hold',
        'your call is important',
        'all representatives',
        'wait time',
        'queue'
    ],

    // Call termination phrases (from the other party)
    callEnd: [
        'goodbye',
        'bye bye',
        'bye-bye',
        'have a good',
        'have a great',
        'take care',
        'thank you for calling',
        'thanks for calling',
        'is there anything else',
        'anything else i can help',
        'have a nice day',
        'have a wonderful'
    ],

    // Waiting/hold music detection (silence patterns)
    holdPatterns: [
        'please hold',
        'hold please',
        'one moment',
        'just a moment',
        'hold on',
        'let me check',
        'let me see',
        'bear with me',
        'give me a second',
        'one second'
    ]
};

// Call conversation state tracking
const callConversationState = new Map();

// Initialize call conversation state
function initCallConversationState(callSid) {
    callConversationState.set(callSid, {
        phase: 'greeting',        // greeting, conversation, waiting, ending
        turnCount: 0,
        lastSpeaker: null,
        lastSpeakerTime: Date.now(),
        silenceDuration: 0,
        detectedVoicemail: false,
        detectedIVR: false,
        waitingForResponse: false,
        goodbyeDetected: false,
        transcriptBuffer: [],
        aiSpokeCount: 0,
        userSpokeCount: 0
    });
    return callConversationState.get(callSid);
}

// Analyze transcript for patterns
function analyzeTranscript(text, patterns) {
    const lowerText = text.toLowerCase();
    for (const pattern of patterns) {
        if (lowerText.includes(pattern)) {
            return { detected: true, pattern };
        }
    }
    return { detected: false, pattern: null };
}

// Process conversation turn and detect patterns
function processConversationTurn(callSid, speaker, text) {
    let state = callConversationState.get(callSid);
    if (!state) {
        state = initCallConversationState(callSid);
    }

    state.turnCount++;
    state.lastSpeaker = speaker;
    state.lastSpeakerTime = Date.now();
    state.transcriptBuffer.push({ speaker, text, time: Date.now() });

    // Keep buffer limited
    if (state.transcriptBuffer.length > 20) {
        state.transcriptBuffer.shift();
    }

    if (speaker === 'AI') {
        state.aiSpokeCount++;
        state.waitingForResponse = true;
    } else {
        state.userSpokeCount++;
        state.waitingForResponse = false;

        // Check for voicemail
        const voicemailCheck = analyzeTranscript(text, DETECTION_PATTERNS.voicemail);
        if (voicemailCheck.detected) {
            console.log(`[DETECT] Voicemail detected: "${voicemailCheck.pattern}"`);
            state.detectedVoicemail = true;
            state.phase = 'voicemail';
        }

        // Check for IVR
        const ivrCheck = analyzeTranscript(text, DETECTION_PATTERNS.ivr);
        if (ivrCheck.detected) {
            console.log(`[DETECT] IVR detected: "${ivrCheck.pattern}"`);
            state.detectedIVR = true;
            state.phase = 'ivr';
        }

        // Check for call end
        const endCheck = analyzeTranscript(text, DETECTION_PATTERNS.callEnd);
        if (endCheck.detected && state.turnCount > 2) {
            console.log(`[DETECT] Call ending detected: "${endCheck.pattern}"`);
            state.goodbyeDetected = true;
            state.phase = 'ending';
        }

        // Check for hold/waiting
        const holdCheck = analyzeTranscript(text, DETECTION_PATTERNS.holdPatterns);
        if (holdCheck.detected) {
            console.log(`[DETECT] Hold/waiting detected: "${holdCheck.pattern}"`);
            state.phase = 'waiting';
        }
    }

    return state;
}

// Get access token from GCP metadata server (for Vertex AI)
async function getAccessToken() {
    try {
        const response = await fetch(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
            { headers: { 'Metadata-Flavor': 'Google' } }
        );
        const data = await response.json();
        return data.access_token;
    } catch (e) {
        console.error('[AUTH] Failed to get access token:', e.message);
        return null;
    }
}

// Build Vertex AI WebSocket URL
function getVertexWsUrl(accessToken) {
    return `wss://${VERTEX_REGION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent?access_token=${accessToken}`;
}

// ============================================================================
// POST-CALL TRANSCRIPTION & SUMMARY (GCP Speech-to-Text + Gemini)
// ============================================================================

// Convert mu-law 8kHz audio buffer to LINEAR16 for Speech-to-Text
function mulawToLinear16(mulawBuffer) {
    const pcm = new Int16Array(mulawBuffer.length);
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm[i] = MULAW_DECODE[mulawBuffer[i]];
    }
    return Buffer.from(pcm.buffer);
}

// Transcribe audio using GCP Speech-to-Text
async function transcribeAudio(audioBuffer, sampleRate = 8000) {
    const accessToken = await getAccessToken();
    if (!accessToken) {
        console.error('[STT] Failed to get access token');
        return null;
    }

    try {
        // Convert mu-law to LINEAR16
        const linearAudio = mulawToLinear16(audioBuffer);
        const audioBase64 = linearAudio.toString('base64');

        console.log(`[STT] Transcribing ${audioBuffer.length} bytes of audio...`);

        const response = await fetch(
            `https://speech.googleapis.com/v1/speech:recognize`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    config: {
                        encoding: 'LINEAR16',
                        sampleRateHertz: sampleRate,
                        languageCode: 'en-US',
                        enableAutomaticPunctuation: true,
                        model: 'phone_call',  // Optimized for phone audio
                        useEnhanced: true
                    },
                    audio: { content: audioBase64 }
                })
            }
        );

        const data = await response.json();

        if (data.error) {
            console.error('[STT] API Error:', data.error.message);
            return null;
        }

        if (data.results?.length) {
            const transcript = data.results
                .map(r => r.alternatives?.[0]?.transcript || '')
                .filter(t => t)
                .join(' ');
            console.log(`[STT] Transcribed: ${transcript.substring(0, 100)}...`);
            return transcript;
        }

        return null;
    } catch (e) {
        console.error('[STT] Error:', e.message);
        return null;
    }
}

// Generate AI summary of call transcript
async function generateCallSummary(callSid, callerTranscript, aiTranscript, callInfo) {
    if (!GEMINI_API_KEY) {
        console.error('[SUMMARY] No Gemini API key');
        return null;
    }

    const combinedTranscript = `
CALLER SAID: ${callerTranscript || '(no audio captured)'}

AI ASSISTANT SAID: ${aiTranscript || '(no audio captured)'}
`;

    const prompt = `You are analyzing a phone call transcript. Based on the conversation, provide a brief summary.

CALL CONTEXT:
- Business/Person Called: ${callInfo.businessName || 'Unknown'}
- Purpose: ${callInfo.task || 'General inquiry'}
- Details: ${callInfo.details || 'None provided'}

TRANSCRIPT:
${combinedTranscript}

Provide a summary in this format:
**Call Summary**
[2-3 sentence summary of what happened in the call]

**Outcome**
[What was achieved or the result - e.g., "Reservation confirmed for 7pm", "Information gathered about hours", "Voicemail left", etc.]

**Key Details**
[Any important information from the call - times, dates, names, numbers mentioned]

Keep it concise and focus on what matters to the user.`;

    try {
        console.log(`[SUMMARY] Generating summary for ${callSid}...`);

        const response = await fetch(
            `${GEMINI_REST_URL}/models/${GEMINI_CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 500 }
                })
            }
        );

        const data = await response.json();
        const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (summary) {
            console.log(`[SUMMARY] Generated summary for ${callSid}`);
            return summary;
        }

        return null;
    } catch (e) {
        console.error('[SUMMARY] Error:', e.message);
        return null;
    }
}

// Process call audio after call ends
async function processCallAudio(callSid) {
    const audioData = callAudioBuffers.get(callSid);
    const callInfo = callState.get(callSid);

    if (!audioData || !callInfo) {
        console.log(`[PROCESS] No audio data for ${callSid}`);
        return;
    }

    console.log(`[PROCESS] Processing audio for ${callSid}...`);

    // Mark as processing
    callSummaries.set(callSid, { status: 'processing', summary: null });

    try {
        // Transcribe both sides
        const [callerTranscript, aiTranscript] = await Promise.all([
            audioData.caller.length > 0 ? transcribeAudio(Buffer.concat(audioData.caller)) : null,
            audioData.ai.length > 0 ? transcribeAudio(Buffer.concat(audioData.ai)) : null
        ]);

        // Store raw transcripts
        callTranscripts.set(callSid, {
            caller: callerTranscript,
            ai: aiTranscript
        });

        // Generate AI summary
        const summary = await generateCallSummary(callSid, callerTranscript, aiTranscript, callInfo);

        callSummaries.set(callSid, {
            status: 'complete',
            summary: summary || 'Unable to generate summary. The call may have been too short or unclear.',
            callerTranscript,
            aiTranscript
        });

        // Clean up audio buffer to save memory
        callAudioBuffers.delete(callSid);

        console.log(`[PROCESS] Summary complete for ${callSid}`);
    } catch (e) {
        console.error(`[PROCESS] Error processing ${callSid}:`, e.message);
        callSummaries.set(callSid, {
            status: 'error',
            summary: 'Failed to process call audio.',
            error: e.message
        });
    }
}

// ============================================================================
// ADVANCED AUDIO PROCESSING (Noise Suppression, AGC, VAD Enhancement)
// ============================================================================

// Audio processing configuration for crowded/noisy environments
const AUDIO_CONFIG = {
    // Noise suppression settings
    noiseFloor: 150,           // Minimum signal threshold
    noiseReduction: 0.7,       // Noise reduction factor (0-1)
    spectralSubtraction: 0.5,  // Spectral subtraction factor

    // Automatic Gain Control (AGC)
    agcEnabled: true,
    agcTarget: 16384,          // Target RMS level (mid-range for 16-bit)
    agcMinGain: 0.5,           // Minimum gain multiplier
    agcMaxGain: 4.0,           // Maximum gain multiplier
    agcAttack: 0.1,            // Attack rate (fast response)
    agcRelease: 0.05,          // Release rate (slower decay)

    // Voice Activity Detection enhancement
    vadThreshold: 200,         // Voice activity threshold
    vadHangover: 150,          // Frames to keep after voice stops (150ms)

    // Band-pass filter for voice (300Hz - 3400Hz for telephony)
    voiceLowCut: 300,
    voiceHighCut: 3400,
    sampleRate: 8000
};

// Running state for audio processing
let agcGain = 1.0;
let noiseEstimate = new Float32Array(256).fill(AUDIO_CONFIG.noiseFloor);
let vadCounter = 0;

// Apply noise gate to reduce background noise
function applyNoiseGate(samples) {
    const output = new Int16Array(samples.length);
    const threshold = AUDIO_CONFIG.noiseFloor;

    for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs < threshold) {
            // Below threshold - heavily attenuate
            output[i] = Math.round(samples[i] * 0.1);
        } else {
            // Above threshold - apply soft knee
            const factor = Math.min(1, (abs - threshold * 0.5) / (threshold * 0.5));
            output[i] = Math.round(samples[i] * factor);
        }
    }
    return output;
}

// Automatic Gain Control - normalizes volume for clarity
function applyAGC(samples) {
    if (!AUDIO_CONFIG.agcEnabled) return samples;

    const output = new Int16Array(samples.length);

    // Calculate RMS of current frame
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
        sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    if (rms > AUDIO_CONFIG.vadThreshold) {
        // Voice detected - adjust gain
        const targetGain = AUDIO_CONFIG.agcTarget / Math.max(rms, 1);
        const clampedTarget = Math.max(AUDIO_CONFIG.agcMinGain,
                                       Math.min(AUDIO_CONFIG.agcMaxGain, targetGain));

        // Smooth gain changes
        if (clampedTarget > agcGain) {
            agcGain += (clampedTarget - agcGain) * AUDIO_CONFIG.agcAttack;
        } else {
            agcGain += (clampedTarget - agcGain) * AUDIO_CONFIG.agcRelease;
        }
        vadCounter = AUDIO_CONFIG.vadHangover;
    } else if (vadCounter > 0) {
        // Hangover period - maintain gain
        vadCounter--;
    } else {
        // Silence - gradually reduce gain
        agcGain *= 0.95;
    }

    // Apply gain with soft clipping
    for (let i = 0; i < samples.length; i++) {
        let sample = samples[i] * agcGain;
        // Soft clipping to prevent harsh distortion
        if (sample > 32000) {
            sample = 32000 + (sample - 32000) * 0.1;
        } else if (sample < -32000) {
            sample = -32000 + (sample + 32000) * 0.1;
        }
        output[i] = Math.round(Math.max(-32767, Math.min(32767, sample)));
    }

    return output;
}

// Simple high-pass filter to remove low-frequency rumble
function applyHighPass(samples, cutoff, sampleRate) {
    const output = new Int16Array(samples.length);
    const rc = 1.0 / (cutoff * 2 * Math.PI);
    const dt = 1.0 / sampleRate;
    const alpha = rc / (rc + dt);

    let prevInput = 0;
    let prevOutput = 0;

    for (let i = 0; i < samples.length; i++) {
        output[i] = Math.round(alpha * (prevOutput + samples[i] - prevInput));
        prevInput = samples[i];
        prevOutput = output[i];
    }

    return output;
}

// Low-pass filter to remove high-frequency noise
function applyLowPass(samples, cutoff, sampleRate) {
    const output = new Int16Array(samples.length);
    const rc = 1.0 / (cutoff * 2 * Math.PI);
    const dt = 1.0 / sampleRate;
    const alpha = dt / (rc + dt);

    let prev = 0;
    for (let i = 0; i < samples.length; i++) {
        output[i] = Math.round(prev + alpha * (samples[i] - prev));
        prev = output[i];
    }

    return output;
}

// Full audio enhancement pipeline for incoming caller audio
function enhanceCallerAudio(pcmBuffer) {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

    // Step 1: High-pass filter (remove low rumble < 300Hz)
    let processed = applyHighPass(samples, AUDIO_CONFIG.voiceLowCut, AUDIO_CONFIG.sampleRate * 2);

    // Step 2: Low-pass filter (remove high noise > 3400Hz)
    processed = applyLowPass(processed, AUDIO_CONFIG.voiceHighCut, AUDIO_CONFIG.sampleRate * 2);

    // Step 3: Noise gate
    processed = applyNoiseGate(processed);

    // Step 4: AGC for consistent volume
    processed = applyAGC(processed);

    return Buffer.from(processed.buffer);
}

// Enhanced AI audio output processing
function enhanceAIAudio(pcmBuffer) {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

    // Apply gentle compression to AI voice for clarity
    const output = new Int16Array(samples.length);
    const threshold = 20000;
    const ratio = 0.5; // 2:1 compression above threshold

    for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > threshold) {
            const excess = abs - threshold;
            const compressed = threshold + excess * ratio;
            output[i] = samples[i] > 0 ? Math.round(compressed) : Math.round(-compressed);
        } else {
            output[i] = samples[i];
        }
    }

    return Buffer.from(output.buffer);
}

console.log('[AUDIO] Advanced audio processing initialized - noise suppression, AGC, VAD enhancement');

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
// PRE-ESTABLISH GEMINI SESSION (Vertex AI)
// ============================================================================

// Build voice AI prompt with full context - OPTIMIZED FOR SPEED & NATURALNESS
function buildVoicePrompt(state) {
    if (state.direction === 'inbound') {
        return `You're answering a call for ${state.businessName}. Greet with: "${state.greeting}"

PURPOSE: ${state.task || 'help callers'}
RULES: ${state.details || 'Be helpful'}

BE QUICK:
- Respond in 1-2 SHORT sentences max
- Don't ramble or over-explain
- Listen more than you talk
- When they finish talking, respond IMMEDIATELY
- Match their pace - if they're brief, be brief
- Say goodbye when done: "Thanks, bye!"

VOICE: Friendly, natural, concise. Australian accent.`;
    }

    // Outbound call - FAST & SMART
    return `You're calling ${state.businessName || 'someone'} for: ${state.task || 'a quick question'}

DETAILS: ${state.details || 'None'}
YOUR NAME: ${state.callerName || 'Alex'}

CRITICAL - BE FAST:
- Respond within 1 second of them finishing
- Use SHORT sentences only (5-10 words ideal)
- ONE thought per turn, then STOP and WAIT
- Don't explain yourself or add filler words
- React naturally: "Great!" "Perfect!" "Got it!"

CALL FLOW:
1. "Hey! This is ${state.callerName || 'Alex'}" - STOP, wait for reply
2. State your purpose in ONE sentence - STOP, wait
3. Answer their questions briefly - STOP after each
4. When done: "Perfect, thanks! Bye!"

VOICEMAIL: Leave a 10-second message max with name + reason + "I'll try again later"
HOLD: Wait silently, say "Still here" if they check
IVR MENU: Wait for human, or say "I'm calling about ${state.task}"

ENDINGS - When they say bye:
- Reply "Thanks, bye!" and STOP immediately
- Don't add anything after goodbye
- If YOU'RE done, say "That's all I needed, thanks! Bye!"

VOICE: Warm, quick, natural. Australian accent. No filler words.`;
}

async function preEstablishGemini(sessionId, state) {
    // Get access token for Vertex AI
    console.log(`[GEMINI] Getting access token for ${sessionId}...`);
    const accessToken = await getAccessToken();
    if (!accessToken) {
        throw new Error('Failed to get GCP access token');
    }

    const wsUrl = getVertexWsUrl(accessToken);
    console.log(`[GEMINI] Connecting to Vertex AI with model: ${GEMINI_LIVE_MODEL}`);

    // Initialize transcript for this session
    callTranscripts.set(sessionId, []);

    return new Promise((resolve, reject) => {
        const geminiWs = new WebSocket(wsUrl);
        let setupSent = false;

        const timeout = setTimeout(() => {
            console.error(`[GEMINI] Connection timeout for ${sessionId}`);
            geminiWs.close();
            pendingGeminiSessions.delete(sessionId);
            reject(new Error('Gemini connection timeout'));
        }, 30000); // 30s timeout

        geminiWs.on('open', () => {
            console.log(`[GEMINI] WebSocket open for ${sessionId}, sending setup...`);

            const prompt = buildVoicePrompt(state);

            // Vertex AI model path format
            const modelPath = `projects/${GCP_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_LIVE_MODEL}`;

            // Initialize conversation state for this call
            initCallConversationState(sessionId);

            // Optimized config for FAST responses
            const setupMsg = {
                setup: {
                    model: modelPath,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } // Clear female voice
                        }
                    },
                    systemInstruction: { parts: [{ text: prompt }] },
                    // FAST VAD - respond quickly after user stops speaking
                    realtimeInputConfig: {
                        automaticActivityDetection: {
                            disabled: false,
                            // Faster end-of-speech detection
                            startOfSpeechSensitivity: "START_OF_SPEECH_SENSITIVITY_HIGH",
                            endOfSpeechSensitivity: "END_OF_SPEECH_SENSITIVITY_HIGH",
                            // Short silence = they're done talking
                            prefixPaddingMs: 100,
                            silenceDurationMs: 700  // 0.7 sec silence = respond
                        }
                    }
                }
            };

            console.log(`[GEMINI] Setup msg: model=${currentModel}`);
            geminiWs.send(JSON.stringify(setupMsg));
            setupSent = true;
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                console.log(`[GEMINI] Received:`, Object.keys(msg));

                if (msg.setupComplete) {
                    clearTimeout(timeout);
                    console.log(`[GEMINI] Setup complete for ${sessionId}`);

                    // Store the ready session
                    pendingGeminiSessions.set(sessionId, {
                        geminiWs,
                        ready: true,
                        state,
                        createdAt: Date.now()
                    });

                    resolve(geminiWs);
                }

                // Log any errors from Gemini
                if (msg.error) {
                    console.error(`[GEMINI] Error:`, msg.error);
                    clearTimeout(timeout);
                    geminiWs.close();
                    reject(new Error(msg.error.message || 'Gemini setup failed'));
                }
            } catch (e) {
                console.error(`[GEMINI] Parse error:`, e.message);
            }
        });

        geminiWs.on('error', (e) => {
            console.error(`[GEMINI] WebSocket error for ${sessionId}:`, e.message);
            clearTimeout(timeout);
            pendingGeminiSessions.delete(sessionId);
            reject(e);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`[GEMINI] WebSocket closed for ${sessionId}: ${code} ${reason}`);
            if (!setupSent) {
                clearTimeout(timeout);
                reject(new Error(`Connection closed before setup: ${code}`));
            }
        });
    });
}

// ============================================================================
// CHAT (Web UI) - With Google Search for finding businesses/numbers
// ============================================================================

const CHAT_PROMPT = `You are CODEC, an agentic AI phone assistant that makes calls on behalf of users.

CAPABILITIES:
- Make phone calls to anyone (restaurants, businesses, friends, services)
- Search the web to find phone numbers and business info
- Handle any calling task: reservations, inquiries, appointments, etc.

WHEN USER WANTS TO CALL:
1. If they provide a phone number, use it
2. If they mention a business/restaurant name, search for its phone number
3. Ask for any missing details needed for the call

OUTPUT FORMAT - When ready to call, output this JSON (no markdown):
{"action":"call","phone":"+XXX","task":"brief task description","business":"name","details":"all relevant context"}

IMPORTANT:
- Always include full international phone number with country code
- The "details" field should contain EVERYTHING the AI caller needs to know
- Be conversational and helpful
- If searching, tell the user what you found`;

// Google Search helper for finding business numbers
async function searchWeb(query) {
    const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
    const cx = process.env.GOOGLE_SEARCH_ENGINE_ID;
    if (!apiKey || !cx) return null;

    try {
        const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=3`);
        const d = await r.json();
        if (d.items?.length) {
            return d.items.map(i => `${i.title}: ${i.snippet}`).join('\n\n');
        }
    } catch (e) {
        console.error('[SEARCH] Error:', e.message);
    }
    return null;
}

async function chat(convId, msg) {
    let conv = conversationState.get(convId);
    if (!conv) {
        conv = { messages: [], lastUpdate: Date.now() };
        conversationState.set(convId, conv);
    }
    conv.messages.push({ role: 'user', content: msg });
    conv.lastUpdate = Date.now();

    try {
        // Check if user is asking about a business - do a search
        let searchContext = '';
        const needsSearch = /phone|number|call|book|reserve|contact/i.test(msg) &&
                          /restaurant|cafe|shop|store|business|hotel|clinic|doctor/i.test(msg);

        if (needsSearch) {
            const searchResults = await searchWeb(`${msg} phone number contact`);
            if (searchResults) {
                searchContext = `\n\n[Search Results]\n${searchResults}`;
            }
        }

        const messagesWithContext = [...conv.messages];
        if (searchContext) {
            messagesWithContext[messagesWithContext.length - 1] = {
                role: 'user',
                content: msg + searchContext
            };
        }

        const r = await fetch(`${GEMINI_REST_URL}/models/${GEMINI_CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: messagesWithContext.map(m => ({
                    role: m.role === 'user' ? 'user' : 'model',
                    parts: [{ text: m.content }]
                })),
                systemInstruction: { parts: [{ text: CHAT_PROMPT }] },
                generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
            })
        });
        const d = await r.json();
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, try again.";
        conv.messages.push({ role: 'assistant', content: text });

        // Extract call data - handle various JSON formats
        let callData = null;
        const jsonMatch = text.match(/\{"action"\s*:\s*"call"[\s\S]*?\}/);
        if (jsonMatch) {
            try {
                callData = JSON.parse(jsonMatch[0]);
            } catch {
                // Try to extract fields manually
                const phone = text.match(/["']phone["']\s*:\s*["']([^"']+)["']/)?.[1];
                const task = text.match(/["']task["']\s*:\s*["']([^"']+)["']/)?.[1];
                const business = text.match(/["']business["']\s*:\s*["']([^"']+)["']/)?.[1];
                if (phone) callData = { action: 'call', phone, task: task || '', business: business || '' };
            }
        }

        return { response: text, callData };
    } catch (e) {
        console.error('[CHAT] Error:', e.message);
        return { response: "Error occurred.", callData: null };
    }
}

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/', (_, res) => res.json({ name: 'CODEC', version: '8.1', mode: 'Fast VAD + Smart Prompts + Minimalist UI' }));
app.get('/health', (_, res) => res.json({ status: 'ok', calls: callState.size, sessions: activeSessions.size }));

// Login endpoint - validates access code and returns session token
app.post('/api/auth/login', (req, res) => {
    const { accessCode } = req.body;

    if (!accessCode) {
        return res.status(400).json({ error: 'Access code required' });
    }

    if (accessCode !== CODEC_ACCESS_CODE) {
        console.log('[AUTH] Failed login attempt');
        return res.status(401).json({ error: 'Invalid access code' });
    }

    // Generate session token (valid for 24 hours)
    const token = generateToken();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    activeSessions.set(token, {
        createdAt: Date.now(),
        expiresAt
    });

    console.log('[AUTH] Successful login, token issued');
    res.json({ success: true, token, expiresAt });
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        activeSessions.delete(token);
    }
    res.json({ success: true });
});

// Verify token endpoint
app.get('/api/auth/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }

    const token = authHeader.substring(7);
    const valid = validateToken(token);
    res.json({ valid });
});

// Apply auth middleware to all /api/* routes (except /api/auth/*)
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) {
        return next();
    }
    requireAuth(req, res, next);
});

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
    // Include transcript and summary if available
    const transcript = callTranscripts.get(req.params.sid) || null;
    const summaryData = callSummaries.get(req.params.sid) || null;
    res.json({
        sid: req.params.sid,
        ...s,
        transcript,
        summaryStatus: summaryData?.status || null,
        summary: summaryData?.summary || null
    });
});

app.get('/api/calls', (_, res) => {
    const calls = [];
    for (const [sid, s] of callState.entries()) calls.push({ sid, ...s });
    res.json({ success: true, calls });
});

// ============================================================================
// TWILIO WEBHOOKS (Protected by signature validation)
// ============================================================================

// Apply Twilio signature validation to all /twilio/* routes
app.use('/twilio', validateTwilioSignature);

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

    // Helper to add to transcript (kept for any text we might capture)
    const addToTranscript = (speaker, text) => {
        if (callSid && text) {
            const transcript = callTranscripts.get(callSid) || [];
            transcript.push({ speaker, text, time: new Date().toISOString() });
            callTranscripts.set(callSid, transcript);
        }
    };

    // Helper to record audio for post-call transcription
    const recordAudio = (source, mulawBuffer) => {
        if (!callSid) return;
        let audioData = callAudioBuffers.get(callSid);
        if (!audioData) {
            audioData = { caller: [], ai: [] };
            callAudioBuffers.set(callSid, audioData);
        }
        // Limit buffer size to ~60 seconds per side (8000 bytes/sec at 8kHz mu-law)
        const maxSize = 8000 * 60;
        const currentSize = audioData[source].reduce((sum, b) => sum + b.length, 0);
        if (currentSize < maxSize) {
            audioData[source].push(mulawBuffer);
        }
    };

    // Auto-hangup timer for detected call endings
    let goodbyeHangupTimer = null;

    // Helper to trigger call hangup
    const triggerCallEnd = (reason) => {
        if (goodbyeHangupTimer) return; // Already scheduled
        console.log(`[CALL] Scheduling hangup in 3s - reason: ${reason}`);

        goodbyeHangupTimer = setTimeout(async () => {
            if (callSid) {
                console.log(`[CALL] Auto-hanging up call ${callSid}: ${reason}`);
                try {
                    const client = getTwilioClient();
                    await client.calls(callSid).update({ status: 'completed' });
                } catch (e) {
                    console.error(`[CALL] Auto-hangup failed:`, e.message);
                }
            }
        }, 3000); // 3 second delay after goodbye
    };

    // Wire up Gemini message handler to stream audio to Twilio
    const wireGeminiToTwilio = (gWs) => {
        gWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                // Handle interruption - user started speaking
                if (msg.serverContent?.interrupted) {
                    console.log('[GEMINI] Interrupted by user speech');
                    // Update conversation state
                    if (callSid) {
                        const convState = callConversationState.get(callSid);
                        if (convState) {
                            convState.waitingForResponse = false;
                        }
                    }
                    return;
                }

                // Process OUTPUT transcription (AI speech text)
                if (msg.serverContent?.outputTranscription?.text) {
                    const aiText = msg.serverContent.outputTranscription.text;
                    console.log(`[TRANSCRIPT] AI: ${aiText}`);
                    addToTranscript('AI', aiText);

                    // Process conversation turn and check for patterns
                    if (callSid) {
                        const convState = processConversationTurn(callSid, 'AI', aiText);

                        // Check if AI said goodbye - schedule hangup
                        const goodbyeCheck = analyzeTranscript(aiText, DETECTION_PATTERNS.callEnd);
                        if (goodbyeCheck.detected && convState.turnCount > 2) {
                            console.log(`[DETECT] AI said goodbye: "${goodbyeCheck.pattern}"`);
                            triggerCallEnd('AI said goodbye');
                        }
                    }
                }

                // Process INPUT transcription (user/caller speech text)
                if (msg.serverContent?.inputTranscription?.text) {
                    const userText = msg.serverContent.inputTranscription.text;
                    console.log(`[TRANSCRIPT] User: ${userText}`);
                    addToTranscript('User', userText);

                    // Process conversation turn and detect patterns
                    if (callSid) {
                        const convState = processConversationTurn(callSid, 'User', userText);

                        // If goodbye detected from user, AI should respond then we hangup
                        if (convState.goodbyeDetected) {
                            console.log(`[DETECT] User said goodbye - call will end after AI responds`);
                        }

                        // If voicemail detected, log it
                        if (convState.detectedVoicemail) {
                            console.log(`[DETECT] Voicemail system detected for call ${callSid}`);
                            if (callState.has(callSid)) {
                                callState.get(callSid).hitVoicemail = true;
                            }
                        }

                        // If IVR detected, log it
                        if (convState.detectedIVR) {
                            console.log(`[DETECT] IVR/auto-attendant detected for call ${callSid}`);
                            if (callState.has(callSid)) {
                                callState.get(callSid).hitIVR = true;
                            }
                        }
                    }
                }

                // Legacy: capture text from model turn parts (fallback)
                if (msg.serverContent?.inputTranscript) {
                    const inputText = msg.serverContent.inputTranscript;
                    console.log(`[TRANSCRIPT] User (legacy): ${inputText}`);
                    addToTranscript('User', inputText);
                    if (callSid) {
                        processConversationTurn(callSid, 'User', inputText);
                    }
                }

                // Stream audio to Twilio
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        // Capture text for transcript (if transcription not available)
                        if (part.text) {
                            // Only add if we haven't already captured via outputTranscription
                            if (!msg.serverContent?.outputTranscription?.text) {
                                addToTranscript('AI', part.text);
                                if (callSid) {
                                    processConversationTurn(callSid, 'AI', part.text);
                                }
                            }
                        }
                        // Stream audio to Twilio and record for transcription
                        if (part.inlineData?.data) {
                            const pcmRaw = Buffer.from(part.inlineData.data, 'base64');
                            // Enhance AI audio for better clarity
                            const pcmEnhanced = enhanceAIAudio(pcmRaw);
                            const mulaw = pcm24kToMulaw8k(pcmEnhanced);

                            // Record AI audio for post-call transcription
                            recordAudio('ai', mulaw);

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

                // Turn complete - AI finished speaking
                if (msg.serverContent?.turnComplete) {
                    console.log('[GEMINI] Turn complete - waiting for user');
                    if (callSid) {
                        const convState = callConversationState.get(callSid);
                        if (convState) {
                            convState.waitingForResponse = true;
                            convState.lastSpeakerTime = Date.now();

                            // If we detected goodbye in this turn, schedule hangup
                            if (convState.goodbyeDetected && convState.phase === 'ending') {
                                triggerCallEnd('Goodbye exchange complete');
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[GEMINI] Parse error:', e.message);
            }
        });

        gWs.on('error', (e) => {
            console.error('[GEMINI] Error:', e.message);
            ready = false;
            // Update call status to indicate AI error
            if (callSid && callState.has(callSid)) {
                const state = callState.get(callSid);
                state.aiError = e.message;
            }
        });

        gWs.on('close', (code, reason) => {
            ready = false;
            const reasonStr = reason?.toString() || 'unknown';
            console.log(`[GEMINI] Closed: code=${code} reason=${reasonStr}`);

            // If this was unexpected (not a normal close), log it
            if (code !== 1000 && code !== 1001) {
                console.warn(`[GEMINI] Unexpected disconnect for call ${callSid}`);
                if (callSid && callState.has(callSid)) {
                    const state = callState.get(callSid);
                    state.aiDisconnected = true;
                    state.aiDisconnectReason = `Code ${code}: ${reasonStr}`;
                }
            }

            // Trigger post-call processing if we have audio
            if (callSid && callAudioBuffers.has(callSid) && !callSummaries.has(callSid)) {
                console.log(`[GEMINI] Triggering post-call processing after disconnect for ${callSid}`);
                processCallAudio(callSid).catch(e => {
                    console.error(`[GEMINI] Post-call processing failed:`, e.message);
                });
            }
        });
    };

    // Fallback: create Gemini on-the-fly if no pre-established session
    const startGeminiFallback = async (state) => {
        console.log('[GEMINI] No pre-established session, creating new one via Vertex AI...');

        // Initialize transcript
        if (callSid) callTranscripts.set(callSid, []);

        // Get access token for Vertex AI
        const accessToken = await getAccessToken();
        if (!accessToken) {
            console.error('[GEMINI] Failed to get access token for fallback');
            return;
        }

        const wsUrl = getVertexWsUrl(accessToken);
        geminiWs = new WebSocket(wsUrl);

        geminiWs.on('open', () => {
            console.log(`[GEMINI] Fallback connected to Vertex AI with model: ${GEMINI_LIVE_MODEL}`);

            // Initialize conversation state for this call
            if (callSid) initCallConversationState(callSid);

            // Use the improved prompt builder
            const prompt = buildVoicePrompt({ ...state, direction });

            // Vertex AI model path format
            const modelPath = `projects/${GCP_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_LIVE_MODEL}`;

            // Optimized config for FAST responses
            geminiWs.send(JSON.stringify({
                setup: {
                    model: modelPath,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                        }
                    },
                    systemInstruction: { parts: [{ text: prompt }] },
                    realtimeInputConfig: {
                        automaticActivityDetection: {
                            disabled: false,
                            startOfSpeechSensitivity: "START_OF_SPEECH_SENSITIVITY_HIGH",
                            endOfSpeechSensitivity: "END_OF_SPEECH_SENSITIVITY_HIGH",
                            prefixPaddingMs: 100,
                            silenceDurationMs: 700
                        }
                    }
                }
            }));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete) {
                    console.log('[GEMINI] Fallback ready');
                    ready = true;

                    // Trigger AI to speak first
                    geminiWs.send(JSON.stringify({
                        clientContent: { turnComplete: true }
                    }));
                    return;
                }

                // Handle interruption
                if (msg.serverContent?.interrupted) {
                    console.log('[GEMINI] Fallback interrupted by user');
                    if (callSid) {
                        const convState = callConversationState.get(callSid);
                        if (convState) convState.waitingForResponse = false;
                    }
                    return;
                }

                // Process OUTPUT transcription (AI speech)
                if (msg.serverContent?.outputTranscription?.text) {
                    const aiText = msg.serverContent.outputTranscription.text;
                    console.log(`[TRANSCRIPT] AI (fallback): ${aiText}`);
                    addToTranscript('AI', aiText);
                    if (callSid) {
                        const convState = processConversationTurn(callSid, 'AI', aiText);
                        // Check for goodbye
                        const goodbyeCheck = analyzeTranscript(aiText, DETECTION_PATTERNS.callEnd);
                        if (goodbyeCheck.detected && convState.turnCount > 2) {
                            triggerCallEnd('AI said goodbye (fallback)');
                        }
                    }
                }

                // Process INPUT transcription (user speech)
                if (msg.serverContent?.inputTranscription?.text) {
                    const userText = msg.serverContent.inputTranscription.text;
                    console.log(`[TRANSCRIPT] User (fallback): ${userText}`);
                    addToTranscript('User', userText);
                    if (callSid) {
                        processConversationTurn(callSid, 'User', userText);
                    }
                }

                // Legacy input transcript
                if (msg.serverContent?.inputTranscript) {
                    addToTranscript('User', msg.serverContent.inputTranscript);
                    if (callSid) {
                        processConversationTurn(callSid, 'User', msg.serverContent.inputTranscript);
                    }
                }

                // Stream audio to Twilio
                if (msg.serverContent?.modelTurn?.parts) {
                    for (const part of msg.serverContent.modelTurn.parts) {
                        if (part.text && !msg.serverContent?.outputTranscription?.text) {
                            addToTranscript('AI', part.text);
                            if (callSid) processConversationTurn(callSid, 'AI', part.text);
                        }
                        if (part.inlineData?.data) {
                            const pcmRaw = Buffer.from(part.inlineData.data, 'base64');
                            // Enhance AI audio for better clarity
                            const pcmEnhanced = enhanceAIAudio(pcmRaw);
                            const mulaw = pcm24kToMulaw8k(pcmEnhanced);

                            // Record AI audio for post-call transcription
                            recordAudio('ai', mulaw);

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

                // Turn complete
                if (msg.serverContent?.turnComplete) {
                    console.log('[GEMINI] Fallback turn complete');
                    if (callSid) {
                        const convState = callConversationState.get(callSid);
                        if (convState) {
                            convState.waitingForResponse = true;
                            if (convState.goodbyeDetected && convState.phase === 'ending') {
                                triggerCallEnd('Goodbye exchange complete (fallback)');
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[GEMINI] Parse error:', e.message);
            }
        });

        geminiWs.on('error', (e) => {
            console.error('[GEMINI] Fallback error:', e.message);
            ready = false;
            if (callSid && callState.has(callSid)) {
                callState.get(callSid).aiError = e.message;
            }
        });

        geminiWs.on('close', (code, reason) => {
            ready = false;
            const reasonStr = reason?.toString() || 'unknown';
            console.log(`[GEMINI] Fallback closed: code=${code} reason=${reasonStr}`);

            if (code !== 1000 && code !== 1001) {
                console.warn(`[GEMINI] Unexpected fallback disconnect for call ${callSid}`);
                if (callSid && callState.has(callSid)) {
                    const state = callState.get(callSid);
                    state.aiDisconnected = true;
                    state.aiDisconnectReason = `Code ${code}: ${reasonStr}`;
                }
            }

            // Process call audio on disconnect
            if (callSid && callAudioBuffers.has(callSid) && !callSummaries.has(callSid)) {
                processCallAudio(callSid).catch(e => {
                    console.error(`[GEMINI] Post-call processing failed:`, e.message);
                });
            }
        });
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
                // Record caller audio for post-call transcription
                const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
                recordAudio('caller', mulawBuffer);

                // Convert to PCM and apply audio enhancement for noisy environments
                const pcmRaw = mulawToPcm16k(mulawBuffer);
                const pcmEnhanced = enhanceCallerAudio(pcmRaw);

                // Stream enhanced caller audio to Gemini
                geminiWs.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcmEnhanced.toString('base64') }]
                    }
                }));
            }
            else if (msg.event === 'stop') {
                console.log(`[CALL] ${callSid} stream stopped`);
                if (geminiWs) geminiWs.close();

                // Trigger post-call transcription and summary generation
                if (callSid && callAudioBuffers.has(callSid)) {
                    console.log(`[CALL] Starting post-call processing for ${callSid}`);
                    processCallAudio(callSid).catch(e => {
                        console.error(`[CALL] Post-call processing failed:`, e.message);
                    });
                }
            }
        } catch (e) {}
    });

    twilioWs.on('close', () => {
        console.log('[WS] Twilio disconnected');
        if (geminiWs) geminiWs.close();
    });
});

console.log('[CODEC] v8.1 Ready - Fast VAD (0.7s) + Smart Prompts + Minimalist UI');
