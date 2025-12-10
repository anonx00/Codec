# Secret Manager Configuration for CODEC

# Twilio Account SID
resource "google_secret_manager_secret" "twilio_account_sid" {
  secret_id = "twilio-account-sid"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "twilio_account_sid" {
  secret      = google_secret_manager_secret.twilio_account_sid.id
  secret_data = var.twilio_account_sid
}

# Twilio Auth Token
resource "google_secret_manager_secret" "twilio_auth_token" {
  secret_id = "twilio-auth-token"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "twilio_auth_token" {
  secret      = google_secret_manager_secret.twilio_auth_token.id
  secret_data = var.twilio_auth_token
}

# Twilio Phone Number
resource "google_secret_manager_secret" "twilio_phone_number" {
  secret_id = "twilio-phone-number"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "twilio_phone_number" {
  secret      = google_secret_manager_secret.twilio_phone_number.id
  secret_data = var.twilio_phone_number
}

# Gemini API Key
resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "gemini-api-key"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "gemini_api_key" {
  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = var.gemini_api_key
}

# Google Search API Key (optional)
resource "google_secret_manager_secret" "google_search_api_key" {
  count     = var.google_search_api_key != "" ? 1 : 0
  secret_id = "google-search-api-key"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_search_api_key" {
  count       = var.google_search_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.google_search_api_key[0].id
  secret_data = var.google_search_api_key
}

# Grant access to secrets for the service account
resource "google_secret_manager_secret_iam_member" "twilio_sid_access" {
  secret_id = google_secret_manager_secret.twilio_account_sid.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "twilio_token_access" {
  secret_id = google_secret_manager_secret.twilio_auth_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "twilio_phone_access" {
  secret_id = google_secret_manager_secret.twilio_phone_number.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "gemini_access" {
  secret_id = google_secret_manager_secret.gemini_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "google_search_access" {
  count     = var.google_search_api_key != "" ? 1 : 0
  secret_id = google_secret_manager_secret.google_search_api_key[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email}"
}
