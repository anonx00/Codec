# Variables for CODEC AI Caller Infrastructure

variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "existing_service_account_email" {
  description = "Email of an existing service account to use (leave empty to create new)"
  type        = string
  default     = ""
}

variable "region" {
  description = "GCP Region for deployment"
  type        = string
  default     = "australia-southeast1"
}

# Twilio Credentials
variable "twilio_account_sid" {
  description = "Twilio Account SID"
  type        = string
  sensitive   = true
}

variable "twilio_auth_token" {
  description = "Twilio Auth Token"
  type        = string
  sensitive   = true
}

variable "twilio_phone_number" {
  description = "Twilio Phone Number (E.164 format)"
  type        = string
  sensitive   = true
}

# Gemini API
variable "gemini_api_key" {
  description = "Google Gemini API Key"
  type        = string
  sensitive   = true
}

variable "gemini_model" {
  description = "Gemini model to use"
  type        = string
  default     = "gemini-2.0-flash-exp"
}

# Google Custom Search
variable "google_search_api_key" {
  description = "Google Custom Search API Key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_search_engine_id" {
  description = "Google Custom Search Engine ID"
  type        = string
  default     = ""
}

# Cloud Run Configuration
variable "backend_cpu" {
  description = "CPU allocation for backend"
  type        = string
  default     = "1"
}

variable "backend_memory" {
  description = "Memory allocation for backend"
  type        = string
  default     = "512Mi"
}

variable "backend_max_instances" {
  description = "Maximum number of backend instances"
  type        = number
  default     = 10
}

variable "frontend_memory" {
  description = "Memory allocation for frontend"
  type        = string
  default     = "512Mi"
}

variable "frontend_max_instances" {
  description = "Maximum number of frontend instances"
  type        = number
  default     = 5
}
