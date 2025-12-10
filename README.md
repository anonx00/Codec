# CODEC - Agentic AI Caller

An intelligent AI caller that can make phone calls on your behalf. Just tell it what you need, and CODEC will find the phone number, plan the call, and handle the conversation.

## Features

- **Agentic AI**: Describe what you want in natural language
- **Auto Phone Lookup**: Automatically finds phone numbers via web search
- **Voice Selection**: Choose from multiple ElevenLabs voices and accents
- **Real-time Conversation**: Powered by Gemini's Multimodal Live API
- **Smart Planning**: Reviews the call plan before dialing

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CODEC System                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User: "Book a table at Luigi's for 2 people Friday 7pm"       │
│                           ↓                                      │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    AGENT PLANNER                         │   │
│   │  • Parse user intent                                     │   │
│   │  • Search web for phone number                           │   │
│   │  • Create call plan                                      │   │
│   └─────────────────────────────────────────────────────────┘   │
│                           ↓                                      │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    CALL ENGINE                           │   │
│   │                                                          │   │
│   │  Twilio ←──→ Node.js ←──→ Gemini (Listens + Thinks)     │   │
│   │                  ↓                                       │   │
│   │            ElevenLabs (Speaks)                           │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Option 1: Deploy to GCP (Recommended)

```bash
# Clone and deploy
git clone <repo>
cd Codec
./deploy.sh
```

The deployment script will:
1. Prompt for all required API keys
2. Store them securely in GCP Secret Manager
3. Build and deploy to Cloud Run
4. Provide you with the live URLs

### Option 2: Local Development

#### Prerequisites
- Node.js 18+
- ngrok account
- API keys (see below)

#### Backend Setup
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your credentials

# Start ngrok
ngrok http 8080
# Copy the ngrok URL to SERVER_DOMAIN in .env

npm run dev
```

#### Frontend Setup
```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

## Required API Keys

| Service | Purpose | Get It From |
|---------|---------|-------------|
| **Twilio** | Phone calls | https://console.twilio.com |
| **Gemini** | AI brain | https://aistudio.google.com/app/apikey |
| **ElevenLabs** | Voice synthesis | https://elevenlabs.io → Profile → API Keys |
| **Google Search** (optional) | Find phone numbers | https://programmablesearchengine.google.com |

## Environment Variables

```env
# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+61876661130

# Gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash-exp

# ElevenLabs
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_MODEL_ID=eleven_turbo_v2

# Google Search (optional)
GOOGLE_SEARCH_API_KEY=...
GOOGLE_SEARCH_ENGINE_ID=...

# Server
PORT=8080
SERVER_DOMAIN=your-domain.run.app
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/voices` | GET | List available ElevenLabs voices |
| `/api/agent/plan` | POST | AI analyzes request and creates call plan |
| `/api/search` | POST | Web search |
| `/api/find-phone` | POST | Find business phone number |
| `/api/call` | POST | Initiate a phone call |
| `/api/call/:sid` | GET | Get call status |

## How It Works

1. **User Input**: Describe what you want in natural language
2. **AI Planning**: Gemini analyzes your request, extracts details
3. **Phone Lookup**: Searches the web for the business phone number
4. **Plan Review**: Shows you the plan before calling
5. **Make Call**: Twilio dials, Gemini listens and responds
6. **Voice Output**: ElevenLabs speaks with your chosen voice

## CI/CD

The project includes a `cloudbuild.yaml` for automatic deployments:

```bash
# Trigger a build manually
gcloud builds submit --config=cloudbuild.yaml .
```

Automatic builds can be configured via:
- Cloud Build triggers on Git push
- GitHub Actions (add workflow file)

## Project Structure

```
Codec/
├── backend/
│   ├── server.js          # Main server with WebSocket handling
│   ├── Dockerfile          # Container configuration
│   └── package.json
├── frontend/
│   ├── app/
│   │   ├── page.tsx       # Main agentic UI
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── Dockerfile
│   └── package.json
├── cloudbuild.yaml         # GCP Cloud Build config
├── deploy.sh              # One-click deployment script
└── README.md
```

## Troubleshooting

### "Audio sounds like static"
- Check audio format conversion (mu-law ↔ PCM)
- Verify sample rates match (8kHz for Twilio, 16kHz for Gemini)

### "Call connects but no audio"
- Verify SERVER_DOMAIN is set correctly
- Check WebSocket connection in browser console
- Ensure ngrok/Cloud Run URL is accessible

### "Phone number not found"
- Provide a more specific location
- Enter the phone number manually

## License

MIT
