const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const twilio = require('twilio');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// CORS support for local frontend
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

const PORT = process.env.PORT || 8080;

// Initialize Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Store active call state
const callState = {};

// Gemini Live API WebSocket URL
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

// System instruction for the AI caller
const SYSTEM_INSTRUCTION = `You are CODEC, a helpful AI assistant making a phone call to a restaurant to book a reservation.

Your personality:
- Polite, friendly, and professional
- Concise - keep responses to 1-2 sentences max
- Persistent but not pushy about getting the reservation

Your goal:
- Greet the restaurant
- Request a reservation with the specific details provided
- If the requested time isn't available, ask for alternatives
- Confirm all details before ending the call
- Say "Thank you, goodbye" when the reservation is confirmed

Important:
- Listen carefully and respond naturally
- If interrupted, stop speaking and listen
- Handle common scenarios like being put on hold, wrong numbers, etc.`;

/**
 * Convert mu-law (8kHz) to PCM16 (16kHz) for Gemini
 */
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

    // Decode mu-law to PCM at 8kHz
    const pcm8k = new Int16Array(mulawBuffer.length);
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm8k[i] = MULAW_DECODE[mulawBuffer[i]];
    }

    // Upsample from 8kHz to 16kHz (simple linear interpolation)
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + pcm8k[i + 1]) / 2);
    }
    pcm16k[pcm16k.length - 2] = pcm8k[pcm8k.length - 1];
    pcm16k[pcm16k.length - 1] = pcm8k[pcm8k.length - 1];

    return Buffer.from(pcm16k.buffer);
}

/**
 * Convert PCM16 (24kHz from Gemini) to mu-law (8kHz for Twilio)
 */
function pcm16ToMulaw(pcmBuffer, inputSampleRate = 24000) {
    const pcm16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

    // Downsample to 8kHz
    const ratio = inputSampleRate / 8000;
    const outputLength = Math.floor(pcm16.length / ratio);
    const mulaw = Buffer.alloc(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const sample = pcm16[Math.floor(i * ratio)];
        mulaw[i] = linearToMulaw(sample);
    }

    return mulaw;
}

/**
 * Linear PCM to mu-law conversion
 */
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

/**
 * API Route: Frontend triggers the call here.
 */
app.post('/make-call', async (req, res) => {
    const { phoneNumber, restaurantName, reservationDetails } = req.body;

    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    try {
        const call = await twilioClient.calls.create({
            url: `https://${process.env.SERVER_DOMAIN}/xml-handler`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
        });

        // Initialize state for this call
        callState[call.sid] = {
            restaurantName,
            reservationDetails,
            streamSid: null,
            contextPrompt: `You are calling ${restaurantName}. Reservation details: ${reservationDetails}. Start by greeting the restaurant and stating your purpose.`
        };

        console.log(`Call initiated: ${call.sid} to ${phoneNumber}`);
        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error("Error creating call:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * TwiML Handler: Tells Twilio to open a WebSocket stream.
 */
app.post('/xml-handler', (req, res) => {
    res.type('text/xml');
    const twiml = `
    <Response>
        <Connect>
            <Stream url="wss://${process.env.SERVER_DOMAIN}/voice" />
        </Connect>
    </Response>
    `;
    res.send(twiml);
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// START HTTP SERVER
const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Webhook URL should be: https://${process.env.SERVER_DOMAIN}`);
});

// START WEBSOCKET SERVER
const wss = new WebSocketServer({ server });

wss.on('connection', (twilioWs) => {
    console.log('New Twilio WebSocket connection');

    let callSid = null;
    let streamSid = null;
    let geminiWs = null;
    let elevenLabsWs = null;
    let isSetupComplete = false;
    let audioBuffer = [];

    /**
     * Setup Gemini Live API WebSocket connection
     */
    const setupGemini = (contextPrompt) => {
        console.log('Connecting to Gemini Live API...');

        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('Gemini WebSocket connected');

            // Send setup message with configuration
            const setupMessage = {
                setup: {
                    model: `models/${process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp'}`,
                    generationConfig: {
                        responseModalities: ["TEXT"], // We'll use ElevenLabs for audio
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: "Aoede"
                                }
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{
                            text: SYSTEM_INSTRUCTION + "\n\nContext: " + contextPrompt
                        }]
                    }
                }
            };

            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data.toString());

                // Handle setup completion
                if (response.setupComplete) {
                    console.log('Gemini setup complete');
                    isSetupComplete = true;

                    // Send initial prompt to start conversation
                    const initialMessage = {
                        clientContent: {
                            turns: [{
                                role: "user",
                                parts: [{ text: "The call has connected. Greet the restaurant." }]
                            }],
                            turnComplete: true
                        }
                    };
                    geminiWs.send(JSON.stringify(initialMessage));
                    return;
                }

                // Handle text response from Gemini
                if (response.serverContent?.modelTurn?.parts) {
                    for (const part of response.serverContent.modelTurn.parts) {
                        if (part.text) {
                            console.log('Gemini response:', part.text);
                            // Send text to ElevenLabs for speech synthesis
                            await sendToElevenLabs(part.text);
                        }
                    }
                }

                // Handle turn complete
                if (response.serverContent?.turnComplete) {
                    console.log('Gemini turn complete');
                }

            } catch (error) {
                console.error('Error processing Gemini message:', error);
            }
        });

        geminiWs.on('error', (error) => {
            console.error('Gemini WebSocket error:', error);
        });

        geminiWs.on('close', () => {
            console.log('Gemini WebSocket closed');
            isSetupComplete = false;
        });
    };

    /**
     * Setup ElevenLabs WebSocket for streaming TTS
     */
    const setupElevenLabs = () => {
        const voiceId = process.env.ELEVENLABS_VOICE_ID;
        const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2';

        const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=ulaw_8000`;

        elevenLabsWs = new WebSocket(wsUrl, {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY
            }
        });

        elevenLabsWs.on('open', () => {
            console.log('ElevenLabs WebSocket connected');

            // Send initial configuration
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

                if (response.audio) {
                    // Audio is base64 encoded mu-law, send directly to Twilio
                    const mediaMessage = {
                        event: 'media',
                        streamSid: streamSid,
                        media: {
                            payload: response.audio
                        }
                    };

                    if (twilioWs.readyState === WebSocket.OPEN) {
                        twilioWs.send(JSON.stringify(mediaMessage));
                    }
                }

                if (response.isFinal) {
                    console.log('ElevenLabs audio complete');
                }
            } catch (error) {
                // Might be binary data or other format
                console.error('Error processing ElevenLabs message:', error.message);
            }
        });

        elevenLabsWs.on('error', (error) => {
            console.error('ElevenLabs WebSocket error:', error);
        });

        elevenLabsWs.on('close', () => {
            console.log('ElevenLabs WebSocket closed');
        });
    };

    /**
     * Send text to ElevenLabs for speech synthesis
     */
    const sendToElevenLabs = async (text) => {
        if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN) {
            console.log('ElevenLabs not connected, reconnecting...');
            setupElevenLabs();
            // Wait for connection
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            // Send text chunk
            const textMessage = {
                text: text + " ",
                try_trigger_generation: true
            };
            elevenLabsWs.send(JSON.stringify(textMessage));

            // Send flush to generate remaining audio
            const flushMessage = {
                text: ""
            };
            elevenLabsWs.send(JSON.stringify(flushMessage));
        }
    };

    /**
     * Send audio to Gemini for processing
     */
    const sendAudioToGemini = (audioBase64) => {
        if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isSetupComplete) {
            return;
        }

        const audioMessage = {
            realtimeInput: {
                mediaChunks: [{
                    mimeType: "audio/pcm;rate=16000",
                    data: audioBase64
                }]
            }
        };

        geminiWs.send(JSON.stringify(audioMessage));
    };

    /**
     * Send transcribed text to Gemini
     */
    const sendTextToGemini = (text) => {
        if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isSetupComplete) {
            return;
        }

        const textMessage = {
            clientContent: {
                turns: [{
                    role: "user",
                    parts: [{ text: text }]
                }],
                turnComplete: true
            }
        };

        geminiWs.send(JSON.stringify(textMessage));
    };

    // Handle messages from Twilio
    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    console.log('Twilio Stream Started');
                    streamSid = msg.start.streamSid;
                    callSid = msg.start.callSid;

                    // Get context for this call
                    const context = callState[callSid]?.contextPrompt ||
                        'You are calling to make a general inquiry.';

                    // Setup connections
                    setupGemini(context);
                    setupElevenLabs();
                    break;

                case 'media':
                    // Convert mu-law to PCM and send to Gemini
                    const audioBuffer = Buffer.from(msg.media.payload, 'base64');
                    const pcmBuffer = mulawToPcm16(audioBuffer);
                    const pcmBase64 = pcmBuffer.toString('base64');
                    sendAudioToGemini(pcmBase64);
                    break;

                case 'stop':
                    console.log('Twilio Stream Stopped');
                    // Cleanup
                    if (geminiWs) {
                        geminiWs.close();
                    }
                    if (elevenLabsWs) {
                        elevenLabsWs.close();
                    }
                    if (callSid && callState[callSid]) {
                        delete callState[callSid];
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing Twilio message:', error);
        }
    });

    twilioWs.on('close', () => {
        console.log('Twilio WebSocket closed');
        if (geminiWs) geminiWs.close();
        if (elevenLabsWs) elevenLabsWs.close();
    });

    twilioWs.on('error', (error) => {
        console.error('Twilio WebSocket error:', error);
    });
});

console.log('CODEC AI Caller Server initialized');
