# Agentic AI Caller Prototype

A functional prototype for a web-based AI Caller that negotiates restaurant reservations using Twilio, Deepgram, OpenAI GPT-4, and ElevenLabs.

## 📂 Project Structure

- **`backend/`**: Node.js + Express + WebSocket server. Handles the telephony and AI logic.
- **`frontend/`**: Next.js + React dashboard. Triggers the calls.

## 🚀 Setup Guide

### 1. Prerequisites
- **Twilio Account**: Get a Phone Number, Account SID, and Auth Token.
- **Deepgram Key**: For fast speech-to-text.
- **OpenAI Key**: For the brain (GPT-4o).
- **ElevenLabs Key**: For realistic voice generation.
- **Ngrok**: To expose your local server to Twilio.

### 2. Backend Setup
1. Navigate to `backend/`
2. Run `npm install`
3. Copy `.env.example` to `.env` and fill in your keys.
4. **Important**: You need a public URL for Twilio to hit.
    - Start Ngrok: `ngrok http 8080`
    - Copy the forwarding URL (e.g., `https://abcd-123.ngrok-free.app`).
    - Update `SERVER_DOMAIN` in `.env` (remove `https://` prefix, just the domain).
5. Start the server: `npm run dev`

### 3. Frontend Setup
1. This folder assumes a Next.js App Router structure.
2. If you haven't initialized Next.js, run: `npx create-next-app@latest frontend` in the root (accept defaults, including Tailwind).
3. Place `components/CallDashboard.tsx` and `app/page.tsx` into the created project.
4. Run `npm run dev`.
5. Open `http://localhost:3000`.

### 4. Making a Call
1. In the Dashboard, enter your own phone number (if on Twilio Trial, you must verify it first).
2. Enter a dummy restaurant name (e.g., "Luigi's Pizza").
3. Click **Call Now**.
4. Your phone should ring.
5. Pick up and speak to the AI. "Hello, I'd like a table for 2..."

## 🛠️ Architecture Notes

- **One-way Audio Latency**: To lower latency further, `server.js` uses `eleven_turbo_v2` and `ulaw_8000` format which Twilio plays natively without transcoding.
- **WebSocket**: The `/xml-handler` endpoint returns TwiML `<Stream>` which connects the call media directly to your WebSocket.
