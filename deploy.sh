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

# Check if in Cloud Shell or logged in
if [ -n "$CLOUD_SHELL" ] || [ -n "$GOOGLE_CLOUD_PROJECT" ]; then
    echo -e "${GREEN}Running in Cloud Shell - already authenticated${NC}"
elif ! gcloud auth print-identity-token &> /dev/null 2>&1; then
    echo -e "${YELLOW}Please log in to Google Cloud:${NC}"
    gcloud auth login --no-launch-browser
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

# Set quota project for application default credentials (fixes Cloud Shell auth issues)
echo ""
echo -e "${YELLOW}Setting up authentication for Terraform...${NC}"
gcloud auth application-default set-quota-project "$PROJECT_ID" 2>/dev/null || true

# Enable billing check
echo ""
echo -e "${YELLOW}Note: Make sure billing is enabled for project $PROJECT_ID${NC}"
echo "Visit: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
read -p "Press Enter to continue once billing is confirmed..."

# Enable Cloud Resource Manager API first (required for Terraform)
echo ""
echo -e "${YELLOW}Enabling required base APIs (this may take a minute)...${NC}"
gcloud services enable cloudresourcemanager.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable iam.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable serviceusage.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable artifactregistry.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable run.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable secretmanager.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable cloudbuild.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable aiplatform.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud services enable speech.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
echo -e "${GREEN}Base APIs enabled${NC}"

# Wait for APIs to propagate
echo -e "${YELLOW}Waiting for APIs to propagate...${NC}"
sleep 10

# Set region
REGION="australia-southeast1"
echo ""
echo -e "${GREEN}Using region: $REGION (Australia)${NC}"

# Check for existing service account
echo ""
echo -e "${YELLOW}Checking for existing service account...${NC}"
EXISTING_SA=$(gcloud iam service-accounts list --filter="email:codec-backend-sa@$PROJECT_ID.iam.gserviceaccount.com" --format="value(email)" 2>/dev/null || echo "")
if [ -n "$EXISTING_SA" ]; then
    echo -e "${GREEN}Found existing service account: $EXISTING_SA${NC}"
else
    echo -e "${YELLOW}No existing service account found. Terraform will create one.${NC}"
fi

# Check if terraform.tfvars already exists (skip credential prompts if so)
SKIP_CREDENTIALS=false
if [ -f "terraform/terraform.tfvars" ]; then
    echo ""
    echo -e "${GREEN}Found existing terraform.tfvars - credentials already configured${NC}"
    read -p "Use existing credentials? (Y/n): " USE_EXISTING
    if [ "$USE_EXISTING" != "n" ] && [ "$USE_EXISTING" != "N" ]; then
        SKIP_CREDENTIALS=true
        # Extract TWILIO_PHONE from tfvars for final output
        TWILIO_PHONE=$(grep 'twilio_phone_number' terraform/terraform.tfvars | cut -d'"' -f2)
    fi
fi

if [ "$SKIP_CREDENTIALS" = false ]; then
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

    # Google Custom Search (optional)
    echo ""
    echo -e "${YELLOW}GOOGLE CUSTOM SEARCH (Optional)${NC}"
    echo "Get from: https://console.cloud.google.com/apis/credentials"
    echo "Press Enter to skip"
    read -sp "Google Search API Key: " GOOGLE_SEARCH_KEY
    echo ""

    GOOGLE_SEARCH_CX=""
    if [ -n "$GOOGLE_SEARCH_KEY" ]; then
        read -p "Google Search Engine ID: " GOOGLE_SEARCH_CX
    fi

    # Create terraform.tfvars
    echo ""
    echo -e "${GREEN}Creating Terraform configuration...${NC}"

    cd terraform

    cat > terraform.tfvars << EOF
project_id = "$PROJECT_ID"
region     = "$REGION"

# Service Account (empty = create new)
existing_service_account_email = "$EXISTING_SA"

# Twilio
twilio_account_sid  = "$TWILIO_SID"
twilio_auth_token   = "$TWILIO_TOKEN"
twilio_phone_number = "$TWILIO_PHONE"

# Gemini
gemini_api_key = "$GEMINI_KEY"

# Google Search (optional)
google_search_api_key   = "$GOOGLE_SEARCH_KEY"
google_search_engine_id = "$GOOGLE_SEARCH_CX"
EOF

    echo -e "${GREEN}terraform.tfvars created${NC}"
else
    cd terraform
fi

# Create Artifact Registry repository if it doesn't exist
echo ""
echo -e "${YELLOW}Setting up Artifact Registry...${NC}"
if ! gcloud artifacts repositories describe codec --location=$REGION 2>/dev/null; then
    gcloud artifacts repositories create codec \
        --repository-format=docker \
        --location=$REGION \
        --description="Docker repository for CODEC AI Caller" 2>/dev/null || true
fi
echo -e "${GREEN}Artifact Registry ready${NC}"

# Configure Docker for Artifact Registry
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

echo -e "${GREEN}Configuration ready${NC}"

# Initialize Terraform
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "              INITIALIZING INFRASTRUCTURE                   "
echo "═══════════════════════════════════════════════════════════"

# Export project for Terraform (fixes Cloud Shell credential issues)
export GOOGLE_CLOUD_PROJECT="$PROJECT_ID"
export GOOGLE_CLOUD_QUOTA_PROJECT="$PROJECT_ID"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

terraform init -upgrade

# Import existing resources if they exist (prevents duplication errors)
echo -e "${YELLOW}Checking for existing resources to import...${NC}"

# Import service account if exists
if [ -n "$EXISTING_SA" ]; then
    echo "Using existing service account: $EXISTING_SA"
elif [ -z "$(terraform state list google_service_account.codec_backend 2>/dev/null)" ]; then
    SA_CHECK=$(gcloud iam service-accounts list --filter="email:codec-backend-sa@$PROJECT_ID.iam.gserviceaccount.com" --format="value(email)" 2>/dev/null || echo "")
    if [ -n "$SA_CHECK" ]; then
        echo "Importing existing service account..."
        terraform import "google_service_account.codec_backend[0]" "projects/$PROJECT_ID/serviceAccounts/codec-backend-sa@$PROJECT_ID.iam.gserviceaccount.com" 2>/dev/null || true
    fi
fi

# Import existing secrets
import_secret_if_exists() {
    SECRET_NAME=$1
    TF_RESOURCE=$2

    # Check if already in state
    if terraform state list "$TF_RESOURCE" 2>/dev/null | grep -q "$TF_RESOURCE"; then
        return 0
    fi

    # Check if exists in GCP
    if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" 2>/dev/null; then
        echo "Importing existing secret: $SECRET_NAME"
        terraform import "$TF_RESOURCE" "projects/$PROJECT_ID/secrets/$SECRET_NAME" 2>/dev/null || true
    fi
}

import_secret_if_exists "twilio-account-sid" "google_secret_manager_secret.twilio_account_sid"
import_secret_if_exists "twilio-auth-token" "google_secret_manager_secret.twilio_auth_token"
import_secret_if_exists "twilio-phone-number" "google_secret_manager_secret.twilio_phone_number"
import_secret_if_exists "gemini-api-key" "google_secret_manager_secret.gemini_api_key"
if [ -n "$GOOGLE_SEARCH_KEY" ]; then
    import_secret_if_exists "google-search-api-key" "google_secret_manager_secret.google_search_api_key[0]"
fi

# Import Artifact Registry if exists
if [ -z "$(terraform state list google_artifact_registry_repository.codec 2>/dev/null)" ]; then
    if gcloud artifacts repositories describe codec --location=$REGION 2>/dev/null; then
        echo "Importing existing Artifact Registry repository..."
        terraform import google_artifact_registry_repository.codec "projects/$PROJECT_ID/locations/$REGION/repositories/codec" 2>/dev/null || true
    fi
fi

echo -e "${GREEN}Resource check complete${NC}"

# Apply Terraform (infrastructure only, no Cloud Run yet)
echo ""
echo -e "${YELLOW}Creating infrastructure (secrets, service account, IAM)...${NC}"
terraform apply \
    -target=google_project_service.apis \
    -target=google_service_account.codec_backend \
    -target=google_project_iam_member.secret_accessor \
    -target=google_project_iam_member.vertex_ai_user \
    -target=google_artifact_registry_repository.codec \
    -target=google_secret_manager_secret.twilio_account_sid \
    -target=google_secret_manager_secret.twilio_auth_token \
    -target=google_secret_manager_secret.twilio_phone_number \
    -target=google_secret_manager_secret.gemini_api_key \
    -target=google_secret_manager_secret_version.twilio_account_sid \
    -target=google_secret_manager_secret_version.twilio_auth_token \
    -target=google_secret_manager_secret_version.twilio_phone_number \
    -target=google_secret_manager_secret_version.gemini_api_key \
    -target=google_secret_manager_secret_iam_member.twilio_sid_access \
    -target=google_secret_manager_secret_iam_member.twilio_token_access \
    -target=google_secret_manager_secret_iam_member.twilio_phone_access \
    -target=google_secret_manager_secret_iam_member.gemini_access \
    -auto-approve

# Build and push Docker images
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                 BUILDING DOCKER IMAGES                     "
echo "═══════════════════════════════════════════════════════════"

cd ..

IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/codec"

# Build backend
echo -e "${YELLOW}Building backend...${NC}"
docker build -t ${IMAGE_BASE}/codec-backend:latest ./backend
docker push ${IMAGE_BASE}/codec-backend:latest

# Build frontend (with placeholder URL initially)
echo -e "${YELLOW}Building frontend...${NC}"
docker build \
    --build-arg NEXT_PUBLIC_API_URL=https://codec-backend-placeholder.run.app \
    -t ${IMAGE_BASE}/codec-frontend:latest \
    ./frontend
docker push ${IMAGE_BASE}/codec-frontend:latest

# Deploy to Cloud Run
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "                 DEPLOYING TO CLOUD RUN                     "
echo "═══════════════════════════════════════════════════════════"

cd terraform
terraform apply -auto-approve

# Get outputs
BACKEND_URL=$(terraform output -raw backend_url 2>/dev/null || echo "")
FRONTEND_URL=$(terraform output -raw frontend_url 2>/dev/null || echo "")

# Fix SERVER_DOMAIN for backend (extract domain from URL)
if [ -n "$BACKEND_URL" ]; then
    BACKEND_DOMAIN=$(echo "$BACKEND_URL" | sed 's|https://||')
    echo ""
    echo -e "${YELLOW}Updating backend SERVER_DOMAIN to: $BACKEND_DOMAIN${NC}"
    gcloud run services update codec-backend \
        --region $REGION \
        --update-env-vars "SERVER_DOMAIN=$BACKEND_DOMAIN" \
        --quiet
    echo -e "${GREEN}SERVER_DOMAIN updated${NC}"
fi

# Rebuild frontend with actual backend URL
if [ -n "$BACKEND_URL" ]; then
    echo ""
    echo -e "${YELLOW}Rebuilding frontend with correct backend URL...${NC}"
    cd ..
    docker build \
        --build-arg NEXT_PUBLIC_API_URL=$BACKEND_URL \
        -t ${IMAGE_BASE}/codec-frontend:latest \
        ./frontend
    docker push ${IMAGE_BASE}/codec-frontend:latest

    # Update Cloud Run
    gcloud run deploy codec-frontend \
        --image ${IMAGE_BASE}/codec-frontend:latest \
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
echo "2. Navigate to: Phone Numbers → Manage → Active Numbers"
echo "3. Click on your number: $TWILIO_PHONE"
echo "4. Under 'Voice Configuration':"
echo "   - Set 'A call comes in' webhook to:"
echo -e "     ${GREEN}${BACKEND_URL}/twilio/voice${NC}"
echo "   - Method: POST"
echo "5. Save"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo -e "${GREEN}You can now open the Frontend URL and start making calls!${NC}"
