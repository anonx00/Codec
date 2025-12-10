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
    "containerregistry.googleapis.com",
    "customsearch.googleapis.com",
    "generativelanguage.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# Service account for Cloud Run
resource "google_service_account" "codec_backend" {
  account_id   = "codec-backend-sa"
  display_name = "CODEC Backend Service Account"
  description  = "Service account for CODEC AI Caller backend"
}

# Grant Secret Manager access to service account
resource "google_project_iam_member" "secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.codec_backend.email}"
}

# Data source for project number
data "google_project" "project" {
  project_id = var.project_id
}
