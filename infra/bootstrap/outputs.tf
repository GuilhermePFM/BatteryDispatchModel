output "state_bucket" {
  description = "GitHub variable TF_STATE_BUCKET; also -backend-config=bucket=... for a local infra/aws init."
  value       = aws_s3_bucket.state.bucket
}

output "deploy_role_arn" {
  description = "GitHub variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "solver_repository_url" {
  description = "Where the deploy workflow pushes the solver image."
  value       = aws_ecr_repository.solver.repository_url
}
