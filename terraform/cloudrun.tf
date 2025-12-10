# Cloud Run Services for CODEC

# Backend Service
resource "google_cloud_run_v2_service" "backend" {
  name     = "codec-backend"
  location = var.region
  project  = var.project_id

  template {
    service_account = local.service_account_email

    scaling {
      # Keep 1 instance warm to prevent cold start delays on voice calls
      min_instance_count = 1
      max_instance_count = var.backend_max_instances
    }

    # Session affinity ensures WebSocket stays on same instance
    session_affinity = true

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/codec/codec-backend:latest"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.backend_cpu
          memory = var.backend_memory
        }
      }

      # Environment variables (non-sensitive)
      env {
        name  = "GEMINI_MODEL"
        value = var.gemini_model
      }

      env {
        name  = "GOOGLE_SEARCH_ENGINE_ID"
        value = var.google_search_engine_id
      }

      # SERVER_DOMAIN will be set after first deployment
      env {
        name  = "SERVER_DOMAIN"
        value = "codec-backend-${data.google_project.project.number}.${var.region}.run.app"
      }

      # Secrets from Secret Manager
      env {
        name = "TWILIO_ACCOUNT_SID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.twilio_account_sid.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "TWILIO_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.twilio_auth_token.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "TWILIO_PHONE_NUMBER"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.twilio_phone_number.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini_api_key.secret_id
            version = "latest"
          }
        }
      }

      # Optional: Google Search API Key
      dynamic "env" {
        for_each = var.google_search_api_key != "" ? [1] : []
        content {
          name = "GOOGLE_SEARCH_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.google_search_api_key[0].secret_id
              version = "latest"
            }
          }
        }
      }

      # Startup and liveness probes
      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        period_seconds = 30
      }
    }

    # WebSocket support requires HTTP/2
    annotations = {
      "run.googleapis.com/client-name" = "terraform"
    }
  }

  traffic {
    percent = 100
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_version.twilio_account_sid,
    google_secret_manager_secret_version.twilio_auth_token,
    google_secret_manager_secret_version.gemini_api_key,
  ]
}

# Allow unauthenticated access to backend (Twilio needs this)
resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Frontend Service
resource "google_cloud_run_v2_service" "frontend" {
  name     = "codec-frontend"
  location = var.region
  project  = var.project_id

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = var.frontend_max_instances
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/codec/codec-frontend:latest"

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = var.frontend_memory
        }
      }

      env {
        name  = "NEXT_PUBLIC_API_URL"
        value = google_cloud_run_v2_service.backend.uri
      }
    }
  }

  traffic {
    percent = 100
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
  }

  depends_on = [google_cloud_run_v2_service.backend]
}

# Allow unauthenticated access to frontend
resource "google_cloud_run_v2_service_iam_member" "frontend_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.frontend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
