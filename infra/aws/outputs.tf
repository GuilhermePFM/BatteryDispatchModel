# --- What the deploy workflow reads ------------------------------------------

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_url" {
  value = var.site_domain_attach ? "https://${var.site_domain}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

# The SPA's build-time configuration (web/README.md, "Configuration").
output "vite_env" {
  value = {
    VITE_AUTH_MODE         = "cognito"
    VITE_COGNITO_AUTHORITY = local.cognito_issuer
    VITE_COGNITO_CLIENT_ID = aws_cognito_user_pool_client.spa.id
    VITE_COGNITO_DOMAIN    = local.cognito_domain_url
  }
}

# --- What you need by hand (docs/deploy.md) ----------------------------------

output "cloudfront_domain" {
  description = "Target of the site's CNAME in Cloudflare (DNS only)."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "idp_redirect_uris" {
  description = "Authorized redirect URIs to register in the Google and LinkedIn apps."
  value = concat(
    ["${local.cognito_prefix_domain_url}/oauth2/idpresponse"],
    var.auth_domain != "" ? ["https://${var.auth_domain}/oauth2/idpresponse"] : [],
  )
}

output "site_certificate_validation" {
  description = "CNAME to add in Cloudflare (DNS only) to validate the site certificate."
  value = var.site_domain == "" ? [] : [
    for o in aws_acm_certificate.site[0].domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "auth_certificate_validation" {
  description = "CNAME to add in Cloudflare (DNS only) to validate the login domain certificate."
  value = var.auth_domain == "" ? [] : [
    for o in aws_acm_certificate.auth[0].domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "auth_domain_target" {
  description = "Target of the login domain's CNAME in Cloudflare (DNS only), once attached."
  value       = var.auth_domain_attach ? aws_cognito_user_pool_domain.custom[0].cloudfront_distribution : null
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "solver_function" {
  value = aws_lambda_function.solver.function_name
}
