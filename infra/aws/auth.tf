# Cognito: social sign-in only (Google, LinkedIn), managed login on the free
# prefix domain, one public app client for the SPA (authorization code + PKCE).

resource "aws_cognito_user_pool" "main" {
  name = var.project
  # Managed login (the new hosted UI) needs Essentials; free up to 10,000
  # monthly active users.
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = "ACTIVE"

  # Nobody signs up with a password: users arrive only through the federated
  # providers, which still create their profiles on first sign-in.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # email is a standard attribute, left optional: LinkedIn may omit it, and a
  # required attribute it does not send would fail the sign-in outright.

  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_domain" "prefix" {
  domain                = var.cognito_domain_prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  # The endpoint fields are what Cognito fills in for Google anyway; spelling
  # them out keeps the plan free of a permanent diff.
  provider_details = {
    client_id                     = var.google_client_id
    client_secret                 = var.google_client_secret
    authorize_scopes              = "openid email profile"
    attributes_url                = "https://people.googleapis.com/v1/people/me?personFields="
    attributes_url_add_attributes = "true"
    authorize_url                 = "https://accounts.google.com/o/oauth2/v2/auth"
    oidc_issuer                   = "https://accounts.google.com"
    token_request_method          = "POST"
    token_url                     = "https://www.googleapis.com/oauth2/v4/token"
  }

  attribute_mapping = {
    username       = "sub"
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
  }
}

# LinkedIn as a generic OIDC provider ("Sign In with LinkedIn using OpenID
# Connect"). The endpoints are given by hand rather than discovered, so only
# the issuer string has to match what LinkedIn puts in its ID tokens.
resource "aws_cognito_identity_provider" "linkedin" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "LinkedIn"
  provider_type = "OIDC"

  provider_details = {
    client_id                 = var.linkedin_client_id
    client_secret             = var.linkedin_client_secret
    authorize_scopes          = "openid profile email"
    attributes_request_method = "GET"
    oidc_issuer               = var.linkedin_oidc_issuer
    authorize_url             = "https://www.linkedin.com/oauth/v2/authorization"
    token_url                 = "https://www.linkedin.com/oauth/v2/accessToken"
    attributes_url            = "https://api.linkedin.com/v2/userinfo"
    jwks_uri                  = "https://www.linkedin.com/oauth/openid/jwks"
  }

  # Cognito maps sub to username by itself for OIDC providers. Without an
  # email_verified mapping Cognito marks every federated email unverified.
  attribute_mapping = {
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
  }
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.project}-spa"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers = [
    aws_cognito_identity_provider.google.provider_name,
    aws_cognito_identity_provider.linkedin.provider_name,
  ]

  # web/src/auth: <origin>/auth/callback and <origin>/. The local stack signs in
  # with AUTH_MODE=dev and never comes through here.
  callback_urls = [for o in local.site_origins : "${o}/auth/callback"]
  logout_urls   = [for o in local.site_origins : "${o}/"]

  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  # The SPA keeps the ID token in memory and signs in again after an hour.
  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 1

  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
}

# Cognito's default look for the managed login pages of this client.
resource "aws_cognito_managed_login_branding" "spa" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.spa.id
  use_cognito_provided_values = true
}

resource "aws_ssm_parameter" "cognito_client_id" {
  name  = local.cognito_client_id_parameter
  type  = "String"
  value = aws_cognito_user_pool_client.spa.id
}

# --- Optional custom login domain (phase 6) ----------------------------------

resource "aws_cognito_user_pool_domain" "custom" {
  count                 = var.auth_domain_attach ? 1 : 0
  domain                = var.auth_domain
  user_pool_id          = aws_cognito_user_pool.main.id
  certificate_arn       = aws_acm_certificate_validation.auth[0].certificate_arn
  managed_login_version = 2
}

locals {
  cognito_prefix_domain_url = "https://${aws_cognito_user_pool_domain.prefix.domain}.auth.${local.region}.amazoncognito.com"
  cognito_domain_url        = var.auth_domain_attach ? "https://${var.auth_domain}" : local.cognito_prefix_domain_url
}
