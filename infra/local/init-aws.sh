#!/usr/bin/env bash
# LocalStack ready hook: the AWS resources of contracts/platform.md, locally.
# Mounted into /etc/localstack/init/ready.d/ by docker-compose.yml.
set -euo pipefail

TABLE=batteryplan
QUEUE=batteryplan-jobs
BUCKET=batteryplan-data
# The SPA's dev server, which uploads prices through a presigned POST.
ORIGIN=http://localhost:5173

awslocal dynamodb create-table \
  --table-name "$TABLE" \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST >/dev/null
awslocal dynamodb update-time-to-live \
  --table-name "$TABLE" \
  --time-to-live-specification Enabled=true,AttributeName=expires_at >/dev/null

dlq_url=$(awslocal sqs create-queue --queue-name "$QUEUE-dlq" --query QueueUrl --output text)
dlq_arn=$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
# One receive, then the DLQ. The visibility timeout (900 s) outlasts the
# Lambda's 10 minutes, as in AWS (contracts/platform.md).
awslocal sqs create-queue --queue-name "$QUEUE" --attributes "$(cat <<EOF
{"VisibilityTimeout": "900",
 "RedrivePolicy": "{\"deadLetterTargetArn\":\"$dlq_arn\",\"maxReceiveCount\":\"1\"}"}
EOF
)" >/dev/null

awslocal s3api create-bucket --bucket "$BUCKET" \
  --create-bucket-configuration "LocationConstraint=$AWS_DEFAULT_REGION" >/dev/null
awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "$(cat <<EOF
{"CORSRules": [{"AllowedOrigins": ["$ORIGIN"], "AllowedMethods": ["POST"],
                "AllowedHeaders": ["*"], "MaxAgeSeconds": 3000}]}
EOF
)"

echo "batteryplan: table $TABLE, queue $QUEUE (+ dlq), bucket $BUCKET ready"
