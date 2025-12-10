#!/bin/bash
# CODEC AI Caller - GCP Deployment Script
# This script sets up secrets and deploys the application to Cloud Run

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║           CODEC AI CALLER - GCP DEPLOYMENT                ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "Error: gcloud CLI is not installed. Please install it first."
    echo "Visit: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if logged in
if ! gcloud auth print-identity-token &> /dev/null; then
    echo "Please log in to Google Cloud:"
    gcloud auth login
fi

# Get or set project
echo ""
echo "Current GCP projects:"
gcloud projects list --format="table(projectId, name)" 2>/dev/null || true

echo ""
read -p "Enter your GCP Project ID (or press Enter to create 'codec'): " PROJECT_ID
PROJECT_ID=${PROJECT_ID:-codec}

# Check if project exists, if not create it
if ! gcloud projects describe "$PROJECT_ID" &> /dev/null; then
    echo "Project '$PROJECT_ID' not found. Creating..."
    gcloud projects create "$PROJECT_ID" --name="CODEC AI Caller"
fi

gcloud config set project "$PROJECT_ID"
echo "Using project: $PROJECT_ID"

# Enable required APIs
echo ""
echo "Enabling required GCP APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    secretmanager.googleapis.com \
    containerregistry.googleapis.com \
    --quiet

echo "APIs enabled."

# Set region
REGION="australia-southeast1"
echo ""
echo "Using region: $REGION (Australia)"

# Collect API credentials
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                    API CREDENTIALS                         "
echo "═══════════════════════════════════════════════════════════"
echo ""

# Twilio
echo "TWILIO CONFIGURATION"
echo "Get these from: https://console.twilio.com"
echo ""
read -p "Twilio Account SID: " TWILIO_ACCOUNT_SID
read -sp "Twilio Auth Token: " TWILIO_AUTH_TOKEN
echo ""
read -p "Twilio Phone Number (e.g., +61876661130): " TWILIO_PHONE_NUMBER
echo ""

# Gemini
echo ""
echo "GEMINI API"
echo "Get this from: https://aistudio.google.com/app/apikey"
echo ""
read -sp "Gemini API Key: " GEMINI_API_KEY
echo ""

# ElevenLabs
echo ""
echo "ELEVENLABS CONFIGURATION"
echo "Get these from: https://elevenlabs.io -> Profile -> API Keys"
echo ""
read -sp "ElevenLabs API Key: " ELEVENLABS_API_KEY
echo ""
read -p "ElevenLabs Voice ID (e.g., EXAVITQu4vr4xnSDxMaL for 'Eric'): " ELEVENLABS_VOICE_ID
echo ""

# Google Search (optional)
echo ""
echo "GOOGLE CUSTOM SEARCH (Optional - for finding phone numbers)"
echo "Get these from: https://programmablesearchengine.google.com/"
echo "Press Enter to skip if you don't have these."
echo ""
read -sp "Google Search API Key (optional): " GOOGLE_SEARCH_API_KEY
echo ""
read -p "Google Search Engine ID (optional): " GOOGLE_SEARCH_ENGINE_ID

# Create secrets
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                 CREATING SECRETS                           "
echo "═══════════════════════════════════════════════════════════"
echo ""

create_secret() {
    local name=$1
    local value=$2

    if [ -z "$value" ]; then
        echo "Skipping $name (empty value)"
        return
    fi

    # Delete if exists
    gcloud secrets delete "$name" --quiet 2>/dev/null || true

    # Create new secret
    echo -n "$value" | gcloud secrets create "$name" --data-file=- --quiet
    echo "Created secret: $name"

    # Grant access to Cloud Run service account
    PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
    gcloud secrets add-iam-policy-binding "$name" \
        --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
        --role="roles/secretmanager.secretAccessor" \
        --quiet
}

create_secret "twilio-account-sid" "$TWILIO_ACCOUNT_SID"
create_secret "twilio-auth-token" "$TWILIO_AUTH_TOKEN"
create_secret "twilio-phone-number" "$TWILIO_PHONE_NUMBER"
create_secret "gemini-api-key" "$GEMINI_API_KEY"
create_secret "elevenlabs-api-key" "$ELEVENLABS_API_KEY"
create_secret "elevenlabs-voice-id" "$ELEVENLABS_VOICE_ID"
create_secret "google-search-api-key" "${GOOGLE_SEARCH_API_KEY:-none}"
create_secret "google-search-engine-id" "${GOOGLE_SEARCH_ENGINE_ID:-none}"

echo ""
echo "All secrets created."

# Deploy using Cloud Build
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                   DEPLOYING APPLICATION                    "
echo "═══════════════════════════════════════════════════════════"
echo ""

# Grant Cloud Build permission to deploy to Cloud Run
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
    --role="roles/run.admin" \
    --quiet

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser" \
    --quiet

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet

echo "Starting Cloud Build deployment..."
gcloud builds submit --config=cloudbuild.yaml .

# Get deployed URLs
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                  DEPLOYMENT COMPLETE!                      "
echo "═══════════════════════════════════════════════════════════"
echo ""

BACKEND_URL=$(gcloud run services describe codec-backend --region=$REGION --format='value(status.url)' 2>/dev/null || echo "Pending...")
FRONTEND_URL=$(gcloud run services describe codec-frontend --region=$REGION --format='value(status.url)' 2>/dev/null || echo "Pending...")

echo "Backend URL:  $BACKEND_URL"
echo "Frontend URL: $FRONTEND_URL"
echo ""
echo "IMPORTANT: Update your Twilio webhook URL to:"
echo "  Voice URL: $BACKEND_URL/twilio/voice"
echo ""
echo "You can do this at: https://console.twilio.com -> Phone Numbers -> Your Number"
echo ""
echo "Enjoy using CODEC!"
