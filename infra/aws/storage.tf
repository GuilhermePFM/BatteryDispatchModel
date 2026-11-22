locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Origins the browser runs the SPA from: CloudFront's own domain always, the
  # custom domain once attached. The data bucket's CORS and Cognito's redirect
  # URIs follow this list.
  site_origins = concat(
    ["https://${aws_cloudfront_distribution.site.domain_name}"],
    var.site_domain_attach ? ["https://${var.site_domain}"] : [],
  )
}

# --- DynamoDB: the single table ----------------------------------------------

resource "aws_dynamodb_table" "main" {
  name         = var.project
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  # The user items have no TTL and are the only thing worth keeping.
  deletion_protection_enabled = true
}

# --- SQS: jobs and their dead letters ----------------------------------------

resource "aws_sqs_queue" "jobs_dlq" {
  name                       = "${var.project}-jobs-dlq"
  message_retention_seconds  = 14 * 24 * 3600
  visibility_timeout_seconds = 60 # at least the DLQ Lambda's timeout
  sqs_managed_sse_enabled    = true
}

resource "aws_sqs_queue" "jobs" {
  name = "${var.project}-jobs"
  # Lambda requires at least the function timeout (600 s); the margin covers
  # the event source's own retries.
  visibility_timeout_seconds = 900
  message_retention_seconds  = 4 * 24 * 3600
  sqs_managed_sse_enabled    = true

  # One receive: a raised error sends the job to the DLQ, whose Lambda fails
  # the run and refunds it (contracts/platform.md, "Finishing a run").
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 1
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "jobs_dlq" {
  queue_url = aws_sqs_queue.jobs_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

# --- S3: uploads/ and plans/ -------------------------------------------------

resource "aws_s3_bucket" "data" {
  bucket = "${var.project}-data-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "data_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"]

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

resource "aws_s3_bucket_policy" "data" {
  bucket = aws_s3_bucket.data.id
  policy = data.aws_iam_policy_document.data_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.data]
}

resource "aws_s3_bucket_ownership_controls" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  dynamic "rule" {
    for_each = toset(["uploads/", "plans/"])

    content {
      id     = "expire-${trimsuffix(rule.value, "/")}"
      status = "Enabled"

      filter {
        prefix = rule.value
      }

      expiration {
        days = 7
      }

      abort_incomplete_multipart_upload {
        days_after_initiation = 1
      }
    }
  }
}

# The browser posts uploads straight to the bucket (the API's presigned POST),
# from the site's origins only. Plans download through a plain link to a
# presigned GET, which needs no CORS.
resource "aws_s3_bucket_cors_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  cors_rule {
    allowed_origins = local.site_origins
    allowed_methods = ["POST"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}
