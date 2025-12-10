# Outputs for CODEC Infrastructure

output "backend_url" {
  description = "URL of the backend Cloud Run service"
  value       = google_cloud_run_v2_service.backend.uri
}

output "frontend_url" {
  description = "URL of the frontend Cloud Run service"
  value       = google_cloud_run_v2_service.frontend.uri
}

output "twilio_webhook_url" {
  description = "URL to configure in Twilio for voice webhooks"
  value       = "${google_cloud_run_v2_service.backend.uri}/twilio/voice"
}

output "service_account_email" {
  description = "Service account email for the backend"
  value       = google_service_account.codec_backend.email
}

output "project_number" {
  description = "GCP Project Number"
  value       = data.google_project.project.number
}

output "instructions" {
  description = "Post-deployment instructions"
  value       = <<-EOT

    ╔═══════════════════════════════════════════════════════════════╗
    ║                 CODEC DEPLOYMENT COMPLETE!                     ║
    ╠═══════════════════════════════════════════════════════════════╣

    Frontend URL: ${google_cloud_run_v2_service.frontend.uri}
    Backend URL:  ${google_cloud_run_v2_service.backend.uri}

    ═══════════════════════════════════════════════════════════════
    IMPORTANT: Configure Twilio Webhook
    ═══════════════════════════════════════════════════════════════

    1. Go to: https://console.twilio.com/us1/develop/phone-numbers/manage/incoming
    2. Click on your number: ${var.twilio_phone_number}
    3. Under "Voice Configuration":
       - Set "A call comes in" webhook to:
         ${google_cloud_run_v2_service.backend.uri}/twilio/voice
       - Method: POST
    4. Save

    ═══════════════════════════════════════════════════════════════

    You can now open the Frontend URL and start making calls!

    ╚═══════════════════════════════════════════════════════════════╝
  EOT
}
