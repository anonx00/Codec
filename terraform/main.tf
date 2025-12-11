# CODEC AI Caller - Terraform Configuration
# Manages GCP infrastructure for the agentic AI calling system

terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  # Uncomment to use GCS backend for state
  # backend "gcs" {
  #   bucket = "codec-terraform-state"
  #   prefix = "terraform/state"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "customsearch.googleapis.com",
    "aiplatform.googleapis.com",
    "speech.googleapis.com",  # Speech-to-Text for post-call transcription
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# Service account for Cloud Run
# Use existing service account if provided, otherwise create new one
resource "google_service_account" "codec_backend" {
  count        = var.existing_service_account_email == "" ? 1 : 0
  account_id   = "codec-backend-sa"
  display_name = "CODEC Backend Service Account"
  description  = "Service account for CODEC AI Caller backend"
}

locals {
  service_account_email = var.existing_service_account_email != "" ? var.existing_service_account_email : google_service_account.codec_backend[0].email
}

# Grant Secret Manager access to service account (only if we created it)
resource "google_project_iam_member" "secret_accessor" {
  count   = var.existing_service_account_email == "" ? 1 : 0
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${local.service_account_email}"
}

# Grant Vertex AI User access for native audio model (ALWAYS apply - needed for Live API)
resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${local.service_account_email}"
}

# Artifact Registry repository for Docker images
resource "google_artifact_registry_repository" "codec" {
  location      = var.region
  repository_id = "codec"
  description   = "Docker repository for CODEC AI Caller"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

# Data source for project number
data "google_project" "project" {
  project_id = var.project_id
}
