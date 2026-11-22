variable "project" {
  description = "Name prefix of every resource; also the DynamoDB table name (TABLE_NAME)."
  type        = string
  default     = "batteryplan"
}

# --- Build artefacts (set by the deploy workflow) ----------------------------

variable "solver_image_digest" {
  description = "Digest (sha256:...) of the solver image in the batteryplan-solver ECR repository."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.solver_image_digest))
    error_message = "Expected sha256:<64 hex>, as docker/build-push-action reports it."
  }
}

variable "api_zip" {
  description = "Path to the API Lambda zip (services/api: make zips)."
  type        = string
  default     = "../../services/api/dist/api.zip"
}

variable "dlq_zip" {
  description = "Path to the DLQ Lambda zip (services/api: make zips)."
  type        = string
  default     = "../../services/api/dist/dlq.zip"
}

# --- Limits (contracts/platform.md) ------------------------------------------

variable "daily_user_limit" {
  type    = number
  default = 3
}

variable "daily_global_limit" {
  type    = number
  default = 60
}

variable "ip_rate_per_minute" {
  type    = number
  default = 60
}

variable "api_reserved_concurrency" {
  description = "Reserved concurrency of the API Lambda. New accounts may have a 10-execution account quota, which leaves nothing to reserve: then use -1 (unreserved) until the quota is raised."
  type        = number
  default     = 10
}

variable "solver_max_concurrency" {
  description = "Maximum concurrent solver invocations from the jobs queue (SQS event source minimum is 2)."
  type        = number
  default     = 2
}

variable "log_retention_days" {
  type    = number
  default = 14
}

# --- Sign-in -----------------------------------------------------------------

variable "cognito_domain_prefix" {
  description = "Prefix of the managed login domain, <prefix>.auth.us-east-1.amazoncognito.com. Unique per region; may not contain aws, amazon or cognito."
  type        = string
  default     = "batteryplan"
}

variable "google_client_id" {
  description = "OAuth client id of the Google Cloud web application."
  type        = string
}

variable "google_client_secret" {
  type      = string
  sensitive = true
}

# --- Budget ------------------------------------------------------------------

variable "budget_email" {
  description = "Where the monthly cost alerts go."
  type        = string
  sensitive   = true
}

variable "monthly_budget_usd" {
  type    = number
  default = 5
}

# --- Custom domains (phase 6, optional; docs/deploy.md) ----------------------

variable "site_domain" {
  description = "Custom domain of the site, e.g. batteryplan.gmachado.dev. Empty: the CloudFront domain only. Setting it creates the ACM certificate and outputs its validation record."
  type        = string
  default     = ""
}

variable "site_domain_attach" {
  description = "Second step: once the certificate is ISSUED, attach the domain and certificate to CloudFront."
  type        = bool
  default     = false

  validation {
    condition     = !var.site_domain_attach || var.site_domain != ""
    error_message = "site_domain_attach needs site_domain."
  }
}

variable "auth_domain" {
  description = "Custom domain of the managed login, e.g. auth.batteryplan.gmachado.dev. Empty: the prefix domain only."
  type        = string
  default     = ""
}

variable "auth_domain_attach" {
  description = "Second step: once its certificate is ISSUED (and site_domain resolves), create the Cognito custom domain."
  type        = bool
  default     = false

  validation {
    condition     = !var.auth_domain_attach || var.auth_domain != ""
    error_message = "auth_domain_attach needs auth_domain."
  }
}
