#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  CODEC v8.0 - MGS TACTICAL AI - GCP CLOUD SHELL QUICK DEPLOY              ║
# ║  Enhanced Three.js Codec + Gemini Model Fallback                           ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

set -e

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     CODEC v8.0 - TACTICAL COMMUNICATIONS SYSTEM           ║${NC}"
echo -e "${CYAN}║         GCP CLOUD SHELL QUICK DEPLOYMENT                  ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Verify we're in Cloud Shell or have auth
if [ -z "$CLOUD_SHELL" ] && [ -z "$GOOGLE_CLOUD_PROJECT" ]; then
    echo -e "${YELLOW}Not in Cloud Shell. Checking authentication...${NC}"
    if ! gcloud auth print-identity-token &> /dev/null 2>&1; then
        echo -e "${RED}Please run: gcloud auth login${NC}"
        exit 1
    fi
fi

# Get project ID
if [ -z "$1" ]; then
    echo -e "${YELLOW}Available projects:${NC}"
    gcloud projects list --format="table(projectId)" 2>/dev/null | head -5
    echo ""
    read -p "Enter GCP Project ID: " PROJECT_ID
else
    PROJECT_ID=$1
fi

if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Project ID required${NC}"
    exit 1
fi

# Set project
gcloud config set project $PROJECT_ID
export GOOGLE_CLOUD_PROJECT=$PROJECT_ID
export CLOUDSDK_CORE_PROJECT=$PROJECT_ID

REGION="australia-southeast1"
echo -e "${GREEN}Project: $PROJECT_ID${NC}"
echo -e "${GREEN}Region: $REGION${NC}"

# Generate access code
CODEC_ACCESS_CODE=$(openssl rand -hex 8)
echo -e "${CYAN}Access Code: $CODEC_ACCESS_CODE${NC}"
echo ""

# Enable APIs
echo -e "${YELLOW}[1/6] Enabling GCP APIs...${NC}"
gcloud services enable \
    cloudresourcemanager.googleapis.com \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    cloudbuild.googleapis.com \
    aiplatform.googleapis.com \
    speech.googleapis.com \
    --project=$PROJECT_ID --quiet

echo -e "${GREEN}APIs enabled${NC}"

# Create Artifact Registry
echo -e "${YELLOW}[2/6] Setting up Artifact Registry...${NC}"
gcloud artifacts repositories describe codec --location=$REGION 2>/dev/null || \
    gcloud artifacts repositories create codec \
        --repository-format=docker \
        --location=$REGION \
        --description="CODEC Docker images"

gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet
echo -e "${GREEN}Registry ready${NC}"

# Build and push images
echo -e "${YELLOW}[3/6] Building Docker images...${NC}"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/codec"

# Build backend
echo "Building backend..."
docker build -t ${IMAGE_BASE}/codec-backend:latest ./backend
docker push ${IMAGE_BASE}/codec-backend:latest

# Build frontend (placeholder URL first)
echo "Building frontend..."
docker build \
    --build-arg NEXT_PUBLIC_API_URL=https://placeholder.run.app \
    -t ${IMAGE_BASE}/codec-frontend:latest \
    ./frontend
docker push ${IMAGE_BASE}/codec-frontend:latest

echo -e "${GREEN}Images built and pushed${NC}"

# Deploy backend
echo -e "${YELLOW}[4/6] Deploying backend to Cloud Run...${NC}"

# Get or create service account
SA_EMAIL="codec-backend-sa@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe $SA_EMAIL 2>/dev/null; then
    gcloud iam service-accounts create codec-backend-sa \
        --display-name="CODEC Backend Service Account"
fi

# Grant permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/secretmanager.secretAccessor" --quiet 2>/dev/null || true

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/aiplatform.user" --quiet 2>/dev/null || true

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/speech.client" --quiet 2>/dev/null || true

# Deploy backend
gcloud run deploy codec-backend \
    --image ${IMAGE_BASE}/codec-backend:latest \
    --region $REGION \
    --platform managed \
    --allow-unauthenticated \
    --service-account $SA_EMAIL \
    --cpu 1 \
    --memory 512Mi \
    --min-instances 1 \
    --max-instances 1 \
    --timeout 300 \
    --concurrency 80 \
    --set-env-vars "GCP_PROJECT_ID=${PROJECT_ID},CODEC_ACCESS_CODE=${CODEC_ACCESS_CODE},NODE_ENV=production" \
    --quiet

BACKEND_URL=$(gcloud run services describe codec-backend --region=$REGION --format='value(status.url)')
BACKEND_DOMAIN=$(echo "$BACKEND_URL" | sed 's|https://||')

echo -e "${GREEN}Backend deployed: $BACKEND_URL${NC}"

# Update backend with SERVER_DOMAIN
gcloud run services update codec-backend \
    --region $REGION \
    --update-env-vars "SERVER_DOMAIN=$BACKEND_DOMAIN" \
    --quiet

# Deploy frontend
echo -e "${YELLOW}[5/6] Deploying frontend to Cloud Run...${NC}"

# Rebuild with actual backend URL
docker build \
    --build-arg NEXT_PUBLIC_API_URL=$BACKEND_URL \
    -t ${IMAGE_BASE}/codec-frontend:latest \
    ./frontend
docker push ${IMAGE_BASE}/codec-frontend:latest

gcloud run deploy codec-frontend \
    --image ${IMAGE_BASE}/codec-frontend:latest \
    --region $REGION \
    --platform managed \
    --allow-unauthenticated \
    --cpu 1 \
    --memory 512Mi \
    --min-instances 0 \
    --max-instances 5 \
    --set-env-vars "NEXT_PUBLIC_API_URL=$BACKEND_URL" \
    --quiet

FRONTEND_URL=$(gcloud run services describe codec-frontend --region=$REGION --format='value(status.url)')

# Update backend CORS
gcloud run services update codec-backend \
    --region $REGION \
    --update-env-vars "FRONTEND_URL=$FRONTEND_URL" \
    --quiet

echo -e "${GREEN}Frontend deployed: $FRONTEND_URL${NC}"

# Setup secrets (interactive)
echo ""
echo -e "${YELLOW}[6/6] Configure API Secrets${NC}"
echo "You need to set up secrets for Twilio and Gemini."
echo ""
read -p "Configure secrets now? (Y/n): " SETUP_SECRETS

if [ "$SETUP_SECRETS" != "n" ] && [ "$SETUP_SECRETS" != "N" ]; then
    echo ""
    echo -e "${CYAN}TWILIO CONFIGURATION${NC}"
    echo "Get from: https://console.twilio.com"

    read -p "Twilio Account SID: " TWILIO_SID
    read -sp "Twilio Auth Token: " TWILIO_TOKEN
    echo ""
    read -p "Twilio Phone Number (+E.164 format): " TWILIO_PHONE

    echo ""
    echo -e "${CYAN}GEMINI API${NC}"
    echo "Get from: https://aistudio.google.com/app/apikey"
    read -sp "Gemini API Key: " GEMINI_KEY
    echo ""

    # Create secrets
    echo "$TWILIO_SID" | gcloud secrets create twilio-account-sid --data-file=- 2>/dev/null || \
        echo "$TWILIO_SID" | gcloud secrets versions add twilio-account-sid --data-file=-

    echo "$TWILIO_TOKEN" | gcloud secrets create twilio-auth-token --data-file=- 2>/dev/null || \
        echo "$TWILIO_TOKEN" | gcloud secrets versions add twilio-auth-token --data-file=-

    echo "$TWILIO_PHONE" | gcloud secrets create twilio-phone-number --data-file=- 2>/dev/null || \
        echo "$TWILIO_PHONE" | gcloud secrets versions add twilio-phone-number --data-file=-

    echo "$GEMINI_KEY" | gcloud secrets create gemini-api-key --data-file=- 2>/dev/null || \
        echo "$GEMINI_KEY" | gcloud secrets versions add gemini-api-key --data-file=-

    # Grant access
    for SECRET in twilio-account-sid twilio-auth-token twilio-phone-number gemini-api-key; do
        gcloud secrets add-iam-policy-binding $SECRET \
            --member="serviceAccount:$SA_EMAIL" \
            --role="roles/secretmanager.secretAccessor" --quiet 2>/dev/null || true
    done

    # Update backend with secrets
    gcloud run services update codec-backend \
        --region $REGION \
        --update-secrets="TWILIO_ACCOUNT_SID=twilio-account-sid:latest,TWILIO_AUTH_TOKEN=twilio-auth-token:latest,TWILIO_PHONE_NUMBER=twilio-phone-number:latest,GEMINI_API_KEY=gemini-api-key:latest" \
        --quiet

    echo -e "${GREEN}Secrets configured${NC}"
fi

# Final output
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              CODEC v8.0 DEPLOYMENT COMPLETE               ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Frontend URL:  ${CYAN}$FRONTEND_URL${NC}"
echo -e "Backend URL:   ${CYAN}$BACKEND_URL${NC}"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}                    LOGIN CREDENTIALS                       ${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Access Code:   ${GREEN}$CODEC_ACCESS_CODE${NC}"
echo ""
echo -e "${RED}SAVE THIS CODE! You'll need it to log in.${NC}"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}           CONFIGURE TWILIO WEBHOOK                         ${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "1. Go to: https://console.twilio.com"
echo "2. Navigate to: Phone Numbers → Manage → Active Numbers"
echo "3. Click your number"
echo "4. Under 'Voice Configuration':"
echo -e "   Webhook URL: ${GREEN}${BACKEND_URL}/twilio/voice${NC}"
echo "   Method: POST"
echo "5. Save"
echo ""
echo -e "${GREEN}Open $FRONTEND_URL and enter your access code!${NC}"
echo ""
