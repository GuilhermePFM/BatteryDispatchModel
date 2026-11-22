# Deploying BatteryPlan to AWS

The stack of [`contracts/platform.md`](../contracts/platform.md), in `us-east-1`:
one CloudFront distribution (the SPA from a private S3 bucket, `/api/*` to the
Go API's Lambda Function URL, both through origin access control), the solver
Lambda (container image) fed by SQS with a DLQ and its Go handler, one DynamoDB
table, one data bucket, Cognito with Google, and a US$ 5 budget alert.

| Path | What |
| --- | --- |
| `infra/bootstrap/` | Applied by you: state bucket, GitHub OIDC provider, deploy role and its boundary, the solver's ECR repository, CloudTrail, GuardDuty |
| `infra/aws/` | Everything else, applied by `.github/workflows/deploy.yml` on every push to `main` |
| `.github/workflows/ci.yml` | Python, Go, web and Terraform checks on pull requests and pushes |

## 1. Prerequisites

- An AWS account, and an admin profile for the AWS CLI on your machine.
- The toolchain: `mise install` (terraform, go, node, pnpm), plus `uv`.
- The GitHub repository (expected `<owner>/batteryplan`), public if you want the
  free arm64 runners `ubuntu-24.04-arm`.
- Lambda's account concurrency quota. New accounts sometimes get 10 concurrent
  executions, which leaves nothing for the API's reserved 10. Check *Service
  Quotas → AWS Lambda → Concurrent executions*; ask for 1000 (free, usually
  granted within a day). The workflow deploys the API unreserved until you set
  the GitHub variable `API_RESERVED_CONCURRENCY=10`, which needs the higher quota.
- `web/public/scenarios/full-2018-2020.json` committed: the SPA build ships it,
  and CI builds from the checkout.

## 2. Bootstrap (once, locally)

```sh
cd infra/bootstrap
terraform init
terraform apply -var 'github_repo=<owner>/batteryplan'
#   add -var create_github_oidc_provider=false if the account already has
#   GitHub's OIDC provider
terraform output
```

Keep `infra/bootstrap/terraform.tfstate` (git-ignored) somewhere safe; the
resources rarely change, and if it is lost they can be imported back.

`github_repo` is compared case-sensitively: write it exactly as GitHub shows it.

The deploy role trusts only `repo:<owner>/<name>:ref:refs/heads/main`, so pushes
to `main` and manual runs from `main`. Pull requests get no AWS access (CI
validates Terraform offline). Its permissions are limited to the stack's own
resources. It can create IAM roles only under `/batteryplan/` and only with the
`lambda-boundary` permissions boundary, cannot attach managed policies, and can
pass roles only to Lambda, so it cannot raise its own access.

The bootstrap also turns on a multi-region CloudTrail trail (kept 90 days in a
bucket the deploy role can't reach) and GuardDuty. GuardDuty is billed by usage
after a 30-day trial; pass `-var enable_guardduty=false` to leave it off.

Protect `main` with a ruleset requiring a pull request and the `python`, `go`,
`web` and `terraform` checks, because every push to it deploys.

## 3. Google app

Google sends users back to Cognito's managed login domain. With the default
`cognito_domain_prefix` the redirect URI is:

```
https://batteryplan.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

(The prefix must be free in `us-east-1`; pick another with
`TF_VAR_cognito_domain_prefix` if it is taken. `terraform output idp_redirect_uris`
lists the URIs after the first apply.)

**Google** (Google Cloud console):
1. *Google Auth Platform → Branding*: app name, support email; *Audience*:
   External, then **Publish app** (in "Testing" only listed test users can sign in).
2. *Data access*: scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
3. *Clients → Create client → Web application*; authorized redirect URI: the
   URI above. Note the client id and secret.

## 4. GitHub secrets and variables

*Settings → Secrets and variables → Actions.*

| Kind | Name | Value |
| --- | --- | --- |
| variable | `AWS_DEPLOY_ROLE_ARN` | `deploy_role_arn` from the bootstrap |
| variable | `TF_STATE_BUCKET` | `state_bucket` from the bootstrap |
| variable | `GOOGLE_CLIENT_ID` | Google client id |
| secret | `GOOGLE_CLIENT_SECRET` | Google client secret |
| secret | `BUDGET_EMAIL` | where budget alerts go |
| variable (optional) | `API_RESERVED_CONCURRENCY` | `10` once the Lambda quota is raised (§1); unset means unreserved |
| variable (phase 6) | `SITE_DOMAIN`, `SITE_DOMAIN_ATTACH`, `AUTH_DOMAIN`, `AUTH_DOMAIN_ATTACH` | see §7 |

## 5. First deploy

Push to `main`, or run **deploy** from the Actions tab. It:

1. builds the solver image natively on `ubuntu-24.04-arm` and pushes it to ECR
   (single-platform manifest, no provenance attestation: Lambda rejects image
   indexes);
2. builds `api.zip` and `dlq.zip` (`make zips`);
3. `terraform apply` in `infra/aws` with the image digest and the zips;
4. builds the SPA with `VITE_*` from the Terraform outputs, in a job with no AWS
   credentials because `pnpm` runs third-party code;
5. syncs it to the site bucket (`assets/*` immutable for a year, other files 5
   minutes, `index.html` `no-cache`), and invalidates `/index.html`.

The summary of the run shows the URL (`https://dxxxx.cloudfront.net`). Check:
`/api/health`, sign-in with Google, a short run, an upload.

Budget alerts need no confirmation: they arrive at 80 % of actual and 100 % of
forecast monthly spend. The budget counts only resources tagged
`Project=batteryplan`, and **reads zero until that tag is activated**. The tag
can take up to 24 hours to appear in billing; then, from the management account:

```sh
aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status TagKey=Project,Status=Active
```

Activation is not retroactive: costs before it are not counted.

To run Terraform from your machine (e.g. `terraform plan`):

```sh
cd infra/aws
terraform init -backend-config="bucket=batteryplan-tfstate-<account id>"
```

and set the same `TF_VAR_*` the workflow sets, including the image digest and
built zips.

## 6. How the pieces fit (gotchas)

**API requests through OAC.** CloudFront signs each request to the Function
URL with SigV4, which means:

- It overwrites the viewer's `Authorization` header with its own signature.
  The SPA's `Authorization: Bearer <id token>` never reaches the API, so the
  SPA sends the token as `X-Authorization: Bearer <id token>` and the API reads
  that header first, then `Authorization` (for the local stack).
- Lambda doesn't accept unsigned payloads. For `POST` and `PUT` the
  browser must send `x-amz-content-sha256: <lowercase hex sha256 of the exact
  body bytes>`, and CloudFront includes it in the signature. GETs need nothing.
  A missing or wrong hash gives a 403 from Lambda, not from the API.

**Client IP.** The `/api/*` behaviour uses the managed origin request policy
`AllViewerExceptHostHeader`. It forwards every viewer header but `Host`, plus
CloudFront's viewer-location headers, `CloudFront-Viewer-Address` among them.
CloudFront writes that header itself, so a client can't forge it.

**SPA routes.** A CloudFront Function on the default behaviour rewrites any
path whose last segment has no dot to `/index.html`. Custom error responses
would apply to the whole distribution and turn the API's 404 for an unknown
run into the SPA page.

**The client id loop.** The app client's callback URLs need the CloudFront
domain, CloudFront needs the API's Function URL, and the API needs the client
id. An environment variable would make that a cycle, so Terraform writes the
client id to SSM (`/batteryplan/cognito-client-id`). The API reads it at cold
start (`COGNITO_CLIENT_ID_PARAMETER`).

## 7. Custom domain (phase 6, optional)

DNS stays on Cloudflare and you create the records by hand. Every record
below is **DNS only (grey cloud)**. A proxied (orange) record would put
Cloudflare between the browser and CloudFront. `CloudFront-Viewer-Address`
would then carry a Cloudflare edge IP and the per-IP rate limit would lump
users together. It would also stack a second CDN and TLS termination in front
of the first.

Each domain is two applies, so an apply never sits waiting on DNS you haven't
created yet.

**Site, `batteryplan.gmachado.dev`:**

1. Set the GitHub variable `SITE_DOMAIN=batteryplan.gmachado.dev`, run deploy.
   The certificate is requested; take its record from
   `terraform output site_certificate_validation` (or the ACM console).
2. Cloudflare: `CNAME  _<hash>.batteryplan  →  _<hash>.<...>.acm-validations.aws`,
   DNS only. Wait for ACM to show **Issued** (minutes).
3. Set `SITE_DOMAIN_ATTACH=true`, run deploy. CloudFront gets the alias and the
   certificate; Cognito's callback/sign-out URLs and the data bucket's CORS gain
   `https://batteryplan.gmachado.dev`; the SPA is rebuilt.
4. Cloudflare: `CNAME  batteryplan  →  dxxxx.cloudfront.net`
   (`terraform output cloudfront_domain`), DNS only.

**Login, `auth.batteryplan.gmachado.dev` (optional):**

1. With the site attached and its CNAME live, set
   `AUTH_DOMAIN=auth.batteryplan.gmachado.dev`, run deploy, add the validation
   CNAME from `terraform output auth_certificate_validation`, wait for **Issued**.
2. Add `https://auth.batteryplan.gmachado.dev/oauth2/idpresponse` to the Google
   redirect URIs.
3. Set `AUTH_DOMAIN_ATTACH=true`, run deploy.
4. Cloudflare: `CNAME  auth.batteryplan  →  <xxxx>.cloudfront.net`
   (`terraform output auth_domain_target`), DNS only.

Cognito refuses a custom domain whose parent (`batteryplan.gmachado.dev`) does
not resolve to an IP. The parent here is a CNAME to CloudFront, which resolves
to A records and should pass, but the check is documented as "an A record". If
step 3 fails on it, leave `AUTH_DOMAIN_ATTACH` unset (and optionally clear
`AUTH_DOMAIN`): the prefix domain keeps working, and only the sign-in page's
address shows `amazoncognito.com`. With both domains, Cognito serves the OIDC
discovery document only on the custom one. The SPA's authority is the
`cognito-idp` issuer URL, so it is unaffected.

## 8. Cost

At portfolio traffic most of it sits in free tiers: CloudFront (1 TB, 10 M
requests a month), Lambda (400 000 GB-s, 1 M requests), DynamoDB on demand, SQS,
S3, Cognito Essentials (10 000 monthly active users), ACM, SSM standard
parameters, and the first two budgets. Expect cents: ECR image storage (about
US$ 0.10 per GB-month, five images kept), S3 and log storage (14-day retention).

The solver is the one real lever. A run at 1769 MB costs about 1.7 GB-s per
second. The free tier covers roughly 65 hours of solving a month. The worst case
the caps allow (60 runs a day, each the full 10 minutes) is about 1.9 M GB-s,
around US$ 20 a month. The budget alert at US$ 5 (80 % actual, 100 % forecast)
is there to catch that; lower `DAILY_GLOBAL_LIMIT` if it fires.

To tear down: `terraform destroy` in `infra/aws` after turning off the deletion
protection of the DynamoDB table and the user pool and emptying both buckets.
Then do the same in `infra/bootstrap`, whose state bucket is `prevent_destroy`.
