# The three functions: the Go API (Function URL behind CloudFront), the Go DLQ
# handler and the Python solver (container image), all arm64.

locals {
  api_name    = "${var.project}-api"
  dlq_name    = "${var.project}-dlq"
  solver_name = "${var.project}-solver"

  # The API reads the SPA's app client id from here at cold start instead of
  # from COGNITO_CLIENT_ID: the client's callback URLs need the CloudFront
  # domain, CloudFront needs the API's Function URL, and an environment variable
  # holding the client id would close that loop (docs/deploy.md).
  cognito_client_id_parameter = "/${var.project}/cognito-client-id"

  cognito_issuer = "https://${aws_cognito_user_pool.main.endpoint}"
}

data "aws_ecr_repository" "solver" {
  name = "${var.project}-solver"
}

# --- Shared IAM pieces -------------------------------------------------------

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "logs" {
  for_each = toset([local.api_name, local.dlq_name, local.solver_name])

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${each.key}:*"]
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = toset([local.api_name, local.dlq_name, local.solver_name])
  name              = "/aws/lambda/${each.key}"
  retention_in_days = var.log_retention_days
}

locals {
  # Everything a run's lifecycle does to the table: conditional puts and
  # updates, the TransactWriteItems of a submission or a refund (authorised per
  # item action), and the cache pointer's delete.
  table_actions = [
    "dynamodb:ConditionCheckItem",
    "dynamodb:DeleteItem",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
  ]
}

# --- API ---------------------------------------------------------------------

resource "aws_iam_role" "api" {
  name               = local.api_name
  path               = "/${var.project}/"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "api" {
  source_policy_documents = [data.aws_iam_policy_document.logs[local.api_name].json]

  statement {
    actions   = local.table_actions
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }

  # Reads uploads to check them, signs presigned GETs for plans.
  statement {
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.data.arn}/uploads/*",
      "${aws_s3_bucket.data.arn}/plans/*",
    ]
  }

  # The presigned POST is signed with this role's credentials, so the role
  # itself must be allowed the PutObject the browser performs.
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/uploads/*"]
  }

  statement {
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.cognito_client_id_parameter}"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = local.api_name
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_lambda_function" "api" {
  function_name    = local.api_name
  role             = aws_iam_role.api.arn
  runtime          = "provided.al2023"
  architectures    = ["arm64"]
  handler          = "bootstrap"
  filename         = var.api_zip
  source_code_hash = filebase64sha256(var.api_zip)
  memory_size      = 256
  timeout          = 15

  reserved_concurrent_executions = var.api_reserved_concurrency

  environment {
    variables = {
      TABLE_NAME                  = aws_dynamodb_table.main.name
      QUEUE_URL                   = aws_sqs_queue.jobs.url
      DATA_BUCKET                 = aws_s3_bucket.data.bucket
      AUTH_MODE                   = "cognito"
      COGNITO_ISSUER              = local.cognito_issuer
      COGNITO_CLIENT_ID_PARAMETER = local.cognito_client_id_parameter
      DAILY_USER_LIMIT            = tostring(var.daily_user_limit)
      DAILY_GLOBAL_LIMIT          = tostring(var.daily_global_limit)
      IP_RATE_PER_MINUTE          = tostring(var.ip_rate_per_minute)
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.api]
}

# Only CloudFront, signing with OAC, can call the URL.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "BUFFERED"
}

# Both statements are needed for a Function URL behind OAC: InvokeFunctionUrl,
# and InvokeFunction restricted to calls made through the URL (CloudFront's
# OAC guide for Lambda lists both).
resource "aws_lambda_permission" "api_cloudfront_url" {
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "api_cloudfront_invoke" {
  statement_id             = "AllowCloudFrontInvokeFunction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = aws_cloudfront_distribution.site.arn
  invoked_via_function_url = true
}

# --- DLQ handler -------------------------------------------------------------

resource "aws_iam_role" "dlq" {
  name               = local.dlq_name
  path               = "/${var.project}/"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "dlq" {
  source_policy_documents = [data.aws_iam_policy_document.logs[local.dlq_name].json]

  statement {
    actions   = local.table_actions
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.jobs_dlq.arn]
  }
}

resource "aws_iam_role_policy" "dlq" {
  name   = local.dlq_name
  role   = aws_iam_role.dlq.id
  policy = data.aws_iam_policy_document.dlq.json
}

resource "aws_lambda_function" "dlq" {
  function_name    = local.dlq_name
  role             = aws_iam_role.dlq.arn
  runtime          = "provided.al2023"
  architectures    = ["arm64"]
  handler          = "bootstrap"
  filename         = var.dlq_zip
  source_code_hash = filebase64sha256(var.dlq_zip)
  memory_size      = 128
  timeout          = 30

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.main.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.dlq]
}

resource "aws_lambda_event_source_mapping" "dlq" {
  event_source_arn = aws_sqs_queue.jobs_dlq.arn
  function_name    = aws_lambda_function.dlq.arn
  batch_size       = 1
}

# --- Solver ------------------------------------------------------------------

resource "aws_iam_role" "solver" {
  name               = local.solver_name
  path               = "/${var.project}/"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "solver" {
  source_policy_documents = [data.aws_iam_policy_document.logs[local.solver_name].json]

  statement {
    actions   = local.table_actions
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.jobs.arn]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.data.arn}/uploads/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/plans/*"]
  }
}

resource "aws_iam_role_policy" "solver" {
  name   = local.solver_name
  role   = aws_iam_role.solver.id
  policy = data.aws_iam_policy_document.solver.json
}

resource "aws_lambda_function" "solver" {
  function_name = local.solver_name
  role          = aws_iam_role.solver.arn
  package_type  = "Image"
  image_uri     = "${data.aws_ecr_repository.solver.repository_url}@${var.solver_image_digest}"
  architectures = ["arm64"]
  # 1769 MB is one full vCPU.
  memory_size = 1769
  timeout     = 600

  environment {
    variables = {
      TABLE_NAME  = aws_dynamodb_table.main.name
      DATA_BUCKET = aws_s3_bucket.data.bucket
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.solver]
}

resource "aws_lambda_event_source_mapping" "solver" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.solver.arn
  batch_size       = 1

  # At most two solves at once, whatever the queue depth.
  scaling_config {
    maximum_concurrency = var.solver_max_concurrency
  }
}
