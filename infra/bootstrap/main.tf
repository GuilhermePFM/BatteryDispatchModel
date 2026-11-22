# One-off resources the main configuration (infra/aws) and the deploy workflow
# stand on, applied once by hand with your own credentials (docs/deploy.md):
#
#   - the S3 bucket holding infra/aws's state (native S3 locking, no DynamoDB);
#   - GitHub's OIDC provider and the role the deploy workflow assumes;
#   - the solver's ECR repository, which must exist before the first image push,
#     that is, before the first `terraform apply` of infra/aws;
#   - the account's audit: a CloudTrail trail and GuardDuty.
#
# This configuration keeps its own state locally (terraform.tfstate here,
# git-ignored). It changes rarely; if the file is lost, `terraform import` the
# named resources back.

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

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.state]
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

# The ceiling of every role the workflow creates: whatever policy a role is
# given, it can do no more than the three Lambdas need. The workflow cannot edit
# this policy, nor create or change a role's inline policy without it.
data "aws_iam_policy_document" "lambda_boundary" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/batteryplan-*:*"]
  }

  statement {
    sid = "Table"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = ["arn:aws:dynamodb:${var.region}:${local.account_id}:table/batteryplan"]
  }

  statement {
    sid = "Queues"
    actions = [
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = ["arn:aws:sqs:${var.region}:${local.account_id}:batteryplan-jobs*"]
  }

  statement {
    sid     = "Data"
    actions = ["s3:GetObject", "s3:PutObject"]
    resources = [
      "arn:aws:s3:::batteryplan-data-${local.account_id}/uploads/*",
      "arn:aws:s3:::batteryplan-data-${local.account_id}/plans/*",
    ]
  }

  statement {
    sid       = "ClientIdParameter"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/batteryplan/*"]
  }
}

resource "aws_iam_policy" "lambda_boundary" {
  name   = "lambda-boundary"
  path   = "/batteryplan/"
  policy = data.aws_iam_policy_document.lambda_boundary.json
}

# What infra/aws and the publish step touch, by resource name wherever the ARN
# is known in advance. CloudFront, Cognito and ACM generate their ids.
data "aws_iam_policy_document" "deploy_stack" {
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }

  # The state file and its lock file.
  statement {
    sid       = "StateObjects"
    actions   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/batteryplan/terraform.tfstate*"]
  }

  statement {
    sid     = "StackBuckets"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::batteryplan-data-${local.account_id}",
      "arn:aws:s3:::batteryplan-data-${local.account_id}/*",
      "arn:aws:s3:::batteryplan-site-${local.account_id}",
      "arn:aws:s3:::batteryplan-site-${local.account_id}/*",
    ]
  }

  statement {
    sid     = "Table"
    actions = ["dynamodb:*"]
    resources = [
      "arn:aws:dynamodb:${var.region}:${local.account_id}:table/batteryplan",
      "arn:aws:dynamodb:${var.region}:${local.account_id}:table/batteryplan/*",
    ]
  }

  statement {
    sid       = "Queues"
    actions   = ["sqs:*"]
    resources = ["arn:aws:sqs:${var.region}:${local.account_id}:batteryplan-jobs*"]
  }

  statement {
    sid     = "Functions"
    actions = ["lambda:*"]
    resources = [
      "arn:aws:lambda:${var.region}:${local.account_id}:function:batteryplan-*",
      "arn:aws:lambda:${var.region}:${local.account_id}:event-source-mapping:*",
    ]
  }

  statement {
    sid = "EventSourceMappings"
    actions = [
      "lambda:CreateEventSourceMapping",
      "lambda:GetEventSourceMapping",
      "lambda:ListEventSourceMappings",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "LogGroups"
    actions   = ["logs:*"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/batteryplan-*"]
  }

  statement {
    sid       = "LogGroupsDescribe"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid       = "RegistryLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Lambda adds its pull permission to the repository's policy when it first
  # takes an image from it, on the caller's credentials.
  statement {
    sid = "SolverImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:GetRepositoryPolicy",
      "ecr:InitiateLayerUpload",
      "ecr:ListTagsForResource",
      "ecr:PutImage",
      "ecr:SetRepositoryPolicy",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.solver.arn]
  }

  statement {
    sid       = "GeneratedIds"
    actions   = ["acm:*", "cloudfront:*", "cognito-idp:*"]
    resources = ["*"]
  }

  statement {
    sid       = "Parameters"
    actions   = ["ssm:*"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/batteryplan/*"]
  }

  statement {
    sid       = "ParametersDescribe"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
    sid       = "Budget"
    actions   = ["budgets:*"]
    resources = ["arn:aws:budgets::${local.account_id}:budget/batteryplan-*"]
  }
}

resource "aws_iam_role_policy" "deploy_stack" {
  name   = "batteryplan-stack"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_stack.json
}

data "aws_iam_policy_document" "deploy_iam" {
  statement {
    sid = "StackRoles"
    actions = [
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    # The stack's roles live under the /batteryplan/ path; this role does not.
    resources = ["arn:aws:iam::${local.account_id}:role/batteryplan/*"]
  }

  # No role gets a policy unless it carries the boundary, so the workflow cannot
  # make a role stronger than the Lambdas need.
  statement {
    sid       = "BoundedRoles"
    actions   = ["iam:CreateRole", "iam:PutRolePolicy"]
    resources = ["arn:aws:iam::${local.account_id}:role/batteryplan/*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.lambda_boundary.arn]
    }
  }

  statement {
    sid       = "PassToLambda"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/batteryplan/*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
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

# --- Account audit -----------------------------------------------------------

# The deploy role has no access to this bucket, so a stolen session cannot erase
# its own trail.
resource "aws_s3_bucket" "audit" {
  bucket = "batteryplan-audit-${local.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}

    expiration {
      days = 90
    }
  }
}

locals {
  audit_trail_arn = "arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/batteryplan-audit"
}

data "aws_iam_policy_document" "audit_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.audit.arn, "${aws_s3_bucket.audit.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id
  policy = data.aws_iam_policy_document.audit_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.audit]
}

# Management events in every region: the account's first such trail is free.
resource "aws_cloudtrail" "audit" {
  name                          = "batteryplan-audit"
  s3_bucket_name                = aws_s3_bucket.audit.id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  depends_on = [aws_s3_bucket_policy.audit]
}

resource "aws_guardduty_detector" "main" {
  count  = var.enable_guardduty ? 1 : 0
  enable = true
}
