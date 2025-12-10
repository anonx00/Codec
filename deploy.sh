#!/bin/bash
# CODEC AI Caller - GCP Deployment Script using Terraform
# This script sets up infrastructure and deploys the application

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║           CODEC AI CALLER - GCP DEPLOYMENT                ║"
echo "║                  Using Terraform                          ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
check_command() {
    if ! command -v $1 &> /dev/null; then
        echo -e "${RED}Error: $1 is not installed${NC}"
        echo "Please install $1 first"
        exit 1
    fi
}

echo "Checking prerequisites..."
check_command gcloud
check_command terraform
check_command docker

# Check if logged in to GCP
if ! gcloud auth print-identity-token &> /dev/null 2>&1; then
    echo -e "${YELLOW}Please log in to Google Cloud:${NC}"
    gcloud auth login
    gcloud auth application-default login
fi

# Get or set project
echo ""
echo -e "${YELLOW}Available GCP projects:${NC}"
gcloud projects list --format="table(projectId, name)" 2>/dev/null | head -10 || true

echo ""
read -p "Enter your GCP Project ID: " PROJECT_ID

if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Project ID is required${NC}"
    exit 1
fi

# Verify project exists
if ! gcloud projects describe "$PROJECT_ID" &> /dev/null; then
    echo -e "${YELLOW}Project '$PROJECT_ID' not found. Creating...${NC}"
    gcloud projects create "$PROJECT_ID" --name="CODEC AI Caller" || {
        echo -e "${RED}Failed to create project. Please create it manually.${NC}"
        exit 1
    }
fi

gcloud config set project "$PROJECT_ID"
echo -e "${GREEN}Using project: $PROJECT_ID${NC}"

# Enable billing check
echo ""
echo -e "${YELLOW}Note: Make sure billing is enabled for project $PROJECT_ID${NC}"
echo "Visit: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
read -p "Press Enter to continue once billing is confirmed..."

# Set region
REGION="australia-southeast1"
echo ""
echo -e "${GREEN}Using region: $REGION (Australia)${NC}"

# Collect API credentials
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                    API CREDENTIALS                         "
echo "═══════════════════════════════════════════════════════════"

# Twilio
echo ""
echo -e "${YELLOW}TWILIO CONFIGURATION${NC}"
echo "Get from: https://console.twilio.com"
read -p "Twilio Account SID: " TWILIO_SID
if [ -z "$TWILIO_SID" ]; then
    echo -e "${RED}Twilio Account SID is required${NC}"
    exit 1
fi

read -sp "Twilio Auth Token: " TWILIO_TOKEN
echo ""
if [ -z "$TWILIO_TOKEN" ]; then
    echo -e "${RED}Twilio Auth Token is required${NC}"
    exit 1
fi

read -p "Twilio Phone Number (e.g., +14155551234): " TWILIO_PHONE
if [ -z "$TWILIO_PHONE" ]; then
    echo -e "${RED}Twilio Phone Number is required${NC}"
    exit 1
fi

# Gemini
echo ""
echo -e "${YELLOW}GEMINI API${NC}"
echo "Get from: https://aistudio.google.com/app/apikey"
read -sp "Gemini API Key: " GEMINI_KEY
echo ""
if [ -z "$GEMINI_KEY" ]; then
    echo -e "${RED}Gemini API Key is required${NC}"
    exit 1
fi

# ElevenLabs
echo ""
echo -e "${YELLOW}ELEVENLABS CONFIGURATION${NC}"
echo "Get from: https://elevenlabs.io -> Profile -> API Keys"
read -sp "ElevenLabs API Key: " ELEVENLABS_KEY
echo ""
if [ -z "$ELEVENLABS_KEY" ]; then
    echo -e "${RED}ElevenLabs API Key is required${NC}"
    exit 1
fi

read -p "ElevenLabs Voice ID [EXAVITQu4vr4xnSDxMaL]: " ELEVENLABS_VOICE
ELEVENLABS_VOICE=${ELEVENLABS_VOICE:-EXAVITQu4vr4xnSDxMaL}

# Google Search (optional)
echo ""
echo -e "${YELLOW}GOOGLE CUSTOM SEARCH (Optional)${NC}"
echo "Get from: https://console.cloud.google.com/apis/credentials"
echo "Press Enter to skip"
read -sp "Google Search API Key: " GOOGLE_SEARCH_KEY
echo ""
read -p "Google Search Engine ID [3145e6eb05b6c4de8]: " GOOGLE_SEARCH_CX
GOOGLE_SEARCH_CX=${GOOGLE_SEARCH_CX:-3145e6eb05b6c4de8}

# Create terraform.tfvars
echo ""
echo -e "${GREEN}Creating Terraform configuration...${NC}"

cd terraform

cat > terraform.tfvars << EOF
project_id = "$PROJECT_ID"
region     = "$REGION"

# Twilio
twilio_account_sid  = "$TWILIO_SID"
twilio_auth_token   = "$TWILIO_TOKEN"
twilio_phone_number = "$TWILIO_PHONE"

# Gemini
gemini_api_key = "$GEMINI_KEY"

# ElevenLabs
elevenlabs_api_key  = "$ELEVENLABS_KEY"
elevenlabs_voice_id = "$ELEVENLABS_VOICE"

# Google Search
google_search_api_key   = "$GOOGLE_SEARCH_KEY"
google_search_engine_id = "$GOOGLE_SEARCH_CX"
EOF

echo -e "${GREEN}terraform.tfvars created${NC}"

# Initialize and apply Terraform (first pass - just secrets and APIs)
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "              INITIALIZING INFRASTRUCTURE                   "
echo "═══════════════════════════════════════════════════════════"

terraform init

# Apply just the secrets first
echo -e "${YELLOW}Creating secrets in Secret Manager...${NC}"
terraform apply -target=google_project_service.apis -auto-approve
terraform apply -target=google_service_account.codec_backend -auto-approve
terraform apply -target=google_secret_manager_secret.twilio_account_sid -auto-approve
terraform apply -target=google_secret_manager_secret.twilio_auth_token -auto-approve
terraform apply -target=google_secret_manager_secret.twilio_phone_number -auto-approve
terraform apply -target=google_secret_manager_secret.gemini_api_key -auto-approve
terraform apply -target=google_secret_manager_secret.elevenlabs_api_key -auto-approve
terraform apply -target=google_secret_manager_secret.elevenlabs_voice_id -auto-approve

# Build and push Docker images
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                 BUILDING DOCKER IMAGES                     "
echo "═══════════════════════════════════════════════════════════"

cd ..

# Configure Docker for GCR
gcloud auth configure-docker gcr.io --quiet

# Build backend
echo -e "${YELLOW}Building backend...${NC}"
docker build -t gcr.io/$PROJECT_ID/codec-backend:latest ./backend
docker push gcr.io/$PROJECT_ID/codec-backend:latest

# Build frontend (need backend URL first, use placeholder)
echo -e "${YELLOW}Building frontend...${NC}"
docker build \
    --build-arg NEXT_PUBLIC_API_URL=https://codec-backend-placeholder.run.app \
    -t gcr.io/$PROJECT_ID/codec-frontend:latest \
    ./frontend
docker push gcr.io/$PROJECT_ID/codec-frontend:latest

# Now apply full Terraform
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                 DEPLOYING TO CLOUD RUN                     "
echo "═══════════════════════════════════════════════════════════"

cd terraform
terraform apply -auto-approve

# Get outputs
BACKEND_URL=$(terraform output -raw backend_url 2>/dev/null || echo "")
FRONTEND_URL=$(terraform output -raw frontend_url 2>/dev/null || echo "")

# Rebuild frontend with actual backend URL
if [ -n "$BACKEND_URL" ]; then
    echo ""
    echo -e "${YELLOW}Rebuilding frontend with correct backend URL...${NC}"
    cd ..
    docker build \
        --build-arg NEXT_PUBLIC_API_URL=$BACKEND_URL \
        -t gcr.io/$PROJECT_ID/codec-frontend:latest \
        ./frontend
    docker push gcr.io/$PROJECT_ID/codec-frontend:latest

    # Update Cloud Run
    gcloud run deploy codec-frontend \
        --image gcr.io/$PROJECT_ID/codec-frontend:latest \
        --region $REGION \
        --set-env-vars "NEXT_PUBLIC_API_URL=$BACKEND_URL" \
        --quiet

    # Get final frontend URL
    FRONTEND_URL=$(gcloud run services describe codec-frontend --region=$REGION --format='value(status.url)')
fi

# Print final output
echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e "${GREEN}            DEPLOYMENT COMPLETE!${NC}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo -e "Frontend URL: ${GREEN}$FRONTEND_URL${NC}"
echo -e "Backend URL:  ${GREEN}$BACKEND_URL${NC}"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e "${YELLOW}IMPORTANT: Configure Twilio Webhook${NC}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "1. Go to: https://console.twilio.com"
echo "2. Navigate to: Phone Numbers -> Manage -> Active Numbers"
echo "3. Click on: $TWILIO_PHONE"
echo "4. Under 'Voice Configuration', set:"
echo ""
echo -e "   Webhook URL: ${GREEN}$BACKEND_URL/twilio/voice${NC}"
echo "   Method: POST"
echo ""
echo "5. Save the configuration"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo -e "${GREEN}You can now open the Frontend URL and start making calls!${NC}"
