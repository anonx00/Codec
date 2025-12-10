const express = require('express');
const { WebSocketServer } = require('ws');
const { Deepgram } = require('@deepgram/sdk');
const OpenAI = require('openai');
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

// Initialize SDKs
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Store active call state
// In a real app, use a database or Redis
const callState = {};

/**
 * 1. API Route: Frontend triggers the call here.
 */
app.post('/make-call', async (req, res) => {
    const { phoneNumber, restaurantName, reservationDetails } = req.body;

    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    try {
        const call = await twilioClient.calls.create({
            url: `https://${process.env.SERVER_DOMAIN}/xml-handler`, // Webhook for TwiML
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
        });

        // Initialize state for this call
        callState[call.sid] = {
            restaurantName,
            reservationDetails,
            streamSid: null,
            openAiHistory: [
                {
                    role: 'system',
                    content: `You are an AI assistant calling ${restaurantName} to make a reservation. 
                    Details: ${reservationDetails}. 
                    Role: Be polite, friendly, but persistent. 
                    Goal: Secure the reservation or find the nearest available slot.
                    Constraint: Keep responses short (under 2 sentences) for conversation flow.
                    If the user confirms the reservation, say "Thank you, goodbye" and end the conversation.`
                }
            ]
        };

        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error("Error creating call:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 2. TwiML Handler: Tells Twilio to open a WebSocket stream.
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

// START HTTP SERVER
const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

// START WEBSOCKET SERVER
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('New Client Connected to WebSocket');
    let callSid = null;
    let streamSid = null;
    let deepgramLive = null;
    let openAiStream = null;

    // --- SETUP DEEPGRAM (Inbound Audio -> Text) ---
    const setupDeepgram = () => {
        deepgramLive = deepgram.transcription.live({
            encoding: 'mulaw',
            sample_rate: 8000,
            model: 'nova-2', // Fast model
            punctuate: true,
            interim_results: false,
            endpointing: 300 // ms of silence to mark end of utterance
        });

        deepgramLive.addListener('open', () => console.log('Deepgram connected'));

        deepgramLive.addListener('error', (err) => console.error('Deepgram error:', err));

        deepgramLive.addListener('transcriptReceived', async (message) => {
            const data = JSON.parse(message);
            const transcript = data.channel?.alternatives[0]?.transcript;

            if (transcript && data.is_final) {
                console.log("User said:", transcript);
                if (!callSid || !callState[callSid]) return;

                // Add to history
                callState[callSid].openAiHistory.push({ role: 'user', content: transcript });

                // Generate AI Response
                await generateAIResponse(callSid, ws);
            }
        });
    };

    // --- GENERATE RESPONSE (Text -> LLM -> Audio) ---
    const generateAIResponse = async (currentCallSid, websocket) => {
        try {
            const messages = callState[currentCallSid].openAiHistory;

            const gptResponse = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                stream: false, // For simplicity in MVP, logic can be non-streaming LLM -> streaming TTS
                max_tokens: 150
            });

            const replyText = gptResponse.choices[0].message.content;
            console.log("AI replying:", replyText);
            callState[currentCallSid].openAiHistory.push({ role: 'assistant', content: replyText });

            // Send to ElevenLabs for Text-to-Speech Streaming
            // Note: ElevenLabs WebSocket API is best for true streaming, 
            // but HTTP streaming is easier to implement for a prototype.
            // We'll fetch the audio and stream it to Twilio as chunks.

            if (!streamSid) return;

            const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'xi-api-key': process.env.ELEVENLABS_API_KEY
                },
                body: JSON.stringify({
                    text: replyText,
                    model_id: "eleven_turbo_v2", // Low latency model
                    output_format: "ulaw_8000" // Matches Twilio format directly!
                })
            });

            const reader = ttsResponse.body.getReader();

            // Stream audio chunks back to Twilio
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Value is a Uint8Array of mulaw audio
                const payload = Buffer.from(value).toString('base64');

                const mediaMessage = {
                    event: 'media',
                    streamSid: streamSid,
                    media: {
                        payload: payload
                    }
                };
                websocket.send(JSON.stringify(mediaMessage));
            }

        } catch (error) {
            console.error("AI Generation Error:", error);
        }
    };

    setupDeepgram();

    // --- HANDLE INBOUND MESSAGES FROM TWILIO ---
    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        switch (msg.event) {
            case 'start':
                console.log('Twilio Stream Started');
                streamSid = msg.start.streamSid;
                callSid = msg.start.callSid;
                // Ideally, trigger an initial greeting from the AI here
                if (callSid && callState[callSid]) {
                    // Inject a "start" trigger to get the AI to say hello
                    callState[callSid].openAiHistory.push({ role: 'user', content: 'The call has connected. Say hello to the restaurant.' });
                    generateAIResponse(callSid, ws);
                }
                break;

            case 'media':
                // Send raw audio to Deepgram
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    const audioBuffer = Buffer.from(msg.media.payload, 'base64');
                    deepgramLive.send(audioBuffer);
                }
                break;

            case 'stop':
                console.log('Twilio Stream Stopped');
                if (deepgramLive) {
                    deepgramLive.finish();
                    deepgramLive = null;
                }
                break;
        }
    });

    ws.on('close', () => {
        console.log('Client Disconnected');
        if (deepgramLive) deepgramLive.finish();
    });
});
