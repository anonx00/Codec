# CODEC - AI Caller Prototype

A real-time AI caller that can phone restaurants and negotiate reservations using **Gemini Multimodal Live API** for ultra-low latency audio processing.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│  Node.js    │────▶│   Twilio    │────▶ Phone Call
│  (Next.js)  │     │  Server     │◀────│  (Media     │
└─────────────┘     └──────┬──────┘     │  Streams)   │
                           │            └─────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       ┌─────────────┐          ┌─────────────┐
       │   Gemini    │          │  ElevenLabs │
       │  Live API   │          │    TTS      │
       │ (Listens)   │          │  (Speaks)   │
       └─────────────┘          └─────────────┘
```

### Data Flow
1. **User** clicks "Call" → Frontend triggers backend
2. **Twilio** dials the number and opens WebSocket to server
3. **Audio In**: Twilio → Server → Gemini (processes speech natively)
4. **AI Response**: Gemini generates text response
5. **Audio Out**: Text → ElevenLabs → Twilio → Human hears it

### Why This Stack?

| Component | Role | Why |
|-----------|------|-----|
| **Gemini 2.0 Flash** | Listens + Thinks | Native audio understanding, <500ms latency, built-in VAD |
| **ElevenLabs** | Speaks | High-quality, natural voices with streaming TTS |
| **Twilio** | Telephony | Reliable media streams, global phone coverage |

## Setup

### Prerequisites
- Node.js 18+
- Twilio account with phone number
- Google Cloud / AI Studio account (for Gemini API)
- ElevenLabs account
- ngrok (for local development)

### 1. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your credentials
```

### 2. Get Your API Keys

**Twilio:**
- Account SID & Auth Token: https://console.twilio.com
- Phone Number: Buy one in the console

**Gemini API:**
- Get API key: https://aistudio.google.com/app/apikey
- Or use Vertex AI in GCP

**ElevenLabs:**
- API Key: https://elevenlabs.io → Profile → API Keys
- Voice ID: VoiceLab → Select voice → Copy ID from URL

### 3. Expose Local Server

```bash
# Terminal 1: Start ngrok
ngrok http 8080

# Copy the https URL (e.g., https://abc123.ngrok-free.app)
# Update SERVER_DOMAIN in .env (without https://)
```

### 4. Run the Server

```bash
npm run dev
```

### 5. Frontend Setup

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

## Configuration

Edit `backend/.env`:

```env
PORT=8080
SERVER_DOMAIN=your-ngrok-url.ngrok-free.app

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1234567890

# Gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash-exp

# ElevenLabs
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_MODEL_ID=eleven_turbo_v2
```

## Making a Test Call

1. On Twilio Trial, verify your phone number first
2. Enter your phone number in the dashboard
3. Click "Call Now"
4. Answer and talk to CODEC!

## Technical Notes

### Audio Format Conversion
- **Twilio** uses 8kHz mu-law audio
- **Gemini** expects 16kHz PCM
- Server handles conversion both ways

### Latency Optimization
- Gemini processes audio natively (no separate STT)
- ElevenLabs `eleven_turbo_v2` model for fast TTS
- Direct `ulaw_8000` output format matches Twilio (no transcoding)

### Interruption Handling
- Gemini's Live API has built-in Voice Activity Detection
- Naturally handles turn-taking and interruptions
