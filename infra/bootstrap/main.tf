# One-off resources the main configuration (infra/aws) and the deploy workflow
# stand on, applied once by hand with your own credentials (docs/deploy.md):
#
#   - the S3 bucket holding infra/aws's state (native S3 locking, no DynamoDB);
#   - GitHub's OIDC provider and the role the deploy workflow assumes;
#   - the solver's ECR repository, which must exist before the first image push,
#     that is, before the first `terraform apply` of infra/aws.
#
# This configuration keeps its own state locally (terraform.tfstate here,
# git-ignored). It changes rarely; if the file is lost, `terraform import` the
# four named resources back.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "batteryplan"
      ManagedBy = "terraform/bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

# --- Terraform state ---------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = "batteryplan-tfstate-${local.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Old state versions are kept 90 days, then dropped.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# --- Solver image repository -------------------------------------------------

resource "aws_ecr_repository" "solver" {
  name                 = "batteryplan-solver"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Images are tagged with the commit sha and deployed by digest: keep the last
# five, drop anything untagged after a day.
resource "aws_ecr_lifecycle_policy" "solver" {
  repository = aws_ecr_repository.solver.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Drop untagged images after a day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the five most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = { type = "expire" }
      },
    ]
  })
}

# --- GitHub Actions deploy role ----------------------------------------------

# An account has at most one provider per URL: reuse one that already exists.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# Only workflow runs on this repository's main branch may assume the role
# (push to main and workflow_dispatch from main). Pull requests get no AWS access.
data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "batteryplan-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

# PowerUserAccess covers every service the stack uses except IAM; IAM is
# granted below, only on the stack's own roles (path /batteryplan/).
resource "aws_iam_role_policy_attachment" "deploy_power_user" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "deploy_iam" {
  statement {
    sid = "StackRoles"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    # The stack's roles live under the /batteryplan/ path; this role does not,
    # so the workflow cannot widen its own permissions.
    resources = ["arn:aws:iam::${local.account_id}:role/batteryplan/*"]
  }

  # Lambda's service-linked role is created on first use of an SQS event source
  # in some accounts; CloudFront's for logging. Harmless if they already exist.
  statement {
    sid       = "ServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy_iam" {
  name   = "batteryplan-stack-iam"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_iam.json
}
