# Optional custom domains (phase 6). DNS is on Cloudflare and its records are
# made by hand, so this happens in two applies per domain:
#
#   1. <x>_domain set: the certificate is requested; its validation CNAME is in
#      the outputs. Add it in Cloudflare and wait for ACM to say ISSUED.
#   2. <x>_domain_attach = true: the validation resource below returns at once
#      (the certificate is already issued), and the domain is attached.
#
# Attaching before the certificate is issued would leave the apply waiting on
# the validation (up to its timeout) instead of failing fast.

resource "aws_acm_certificate" "site" {
  count             = var.site_domain != "" ? 1 : 0
  domain_name       = var.site_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "site" {
  count           = var.site_domain_attach ? 1 : 0
  certificate_arn = aws_acm_certificate.site[0].arn

  timeouts {
    create = "10m"
  }
}

resource "aws_acm_certificate" "auth" {
  count             = var.auth_domain != "" ? 1 : 0
  domain_name       = var.auth_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "auth" {
  count           = var.auth_domain_attach ? 1 : 0
  certificate_arn = aws_acm_certificate.auth[0].arn

  timeouts {
    create = "10m"
  }
}
