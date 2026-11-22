variable "region" {
  description = "Region of the whole stack."
  type        = string
  default     = "us-east-1"
}

variable "github_repo" {
  description = "The GitHub repository allowed to deploy, as its OIDC subject shows it: <owner>/<name>, or <owner>@<id>/<name>@<id> on repositories with immutable subjects."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+(@[0-9]+)?/[A-Za-z0-9_.-]+(@[0-9]+)?$", var.github_repo))
    error_message = "Use the <owner>/<name> or <owner>@<id>/<name>@<id> form."
  }
}

variable "create_github_oidc_provider" {
  description = "Create GitHub's OIDC provider; set false if the account already has one for token.actions.githubusercontent.com."
  type        = bool
  default     = true
}

variable "enable_guardduty" {
  description = "Turn on GuardDuty in the region; set false if the account already has a detector, or to avoid its usage cost after the 30-day trial."
  type        = bool
  default     = true
}
