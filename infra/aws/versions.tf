# BatteryPlan in AWS: the resources of contracts/platform.md, us-east-1 only.
# Applied by .github/workflows/deploy.yml; the state bucket, the deploy role and
# the solver's ECR repository come from infra/bootstrap. See docs/deploy.md.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # The bucket is passed at init (it carries the account id):
  #   terraform init -backend-config="bucket=batteryplan-tfstate-<account id>"
  backend "s3" {
    key          = "batteryplan/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}
