// Command api is the BatteryPlan HTTP API: a Lambda Function URL handler in
// AWS, a plain HTTP server on :8080 anywhere else.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/auth"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/config"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/lambdaurl"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/prices"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/quota"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/runs"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("api", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	if err := cfg.CheckAPI(); err != nil {
		return err
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return err
	}

	verifier := auth.NewDev()
	if cfg.AuthMode == "cognito" {
		if cfg.CognitoClientID == "" {
			if cfg.CognitoClientID, err = ssmParameter(ctx, ssm.NewFromConfig(awsCfg), cfg.CognitoClientIDParameter); err != nil {
				return err
			}
		}
		if verifier, err = auth.NewCognito(ctx, cfg.CognitoIssuer, cfg.CognitoClientID); err != nil {
			return err
		}
	}

	// Against LocalStack, S3 is addressed path-style.
	// A plan link is a plain download, without the SDK's checksum-mode parameter.
	s3c := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.UsePathStyle = cfg.EndpointURL != ""
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	db := dynamodb.NewFromConfig(awsCfg)

	srv := &runs.Server{
		DB:        db,
		Queue:     sqs.NewFromConfig(awsCfg),
		Objects:   s3c,
		Presigner: s3.NewPresignClient(s3c),
		Poster: prices.Poster{
			Credentials: awsCfg.Credentials, Region: awsCfg.Region, Bucket: cfg.DataBucket,
			Endpoint: cfg.EndpointURL, // empty in AWS
		},
		Auth:     verifier,
		Table:    cfg.TableName,
		QueueURL: cfg.QueueURL,
		Bucket:   cfg.DataBucket,
		Limits:   quota.Limits{User: cfg.DailyUserLimit, Global: cfg.DailyGlobalLimit},
		Rate:     quota.Rate{DB: db, Table: cfg.TableName, PerMinute: cfg.IPRatePerMinute},
		// The solver image carries the CCEE prices.
		BundledPrices: true,
	}

	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(lambdaurl.Handler(srv.Handler()))
		return nil
	}
	slog.Info("listening", "addr", ":8080", "auth_mode", cfg.AuthMode)
	server := &http.Server{Addr: ":8080", Handler: logged(srv.Handler()), ReadHeaderTimeout: 10 * time.Second}
	return server.ListenAndServe()
}

type parameterGetter interface {
	GetParameter(context.Context, *ssm.GetParameterInput, ...func(*ssm.Options)) (*ssm.GetParameterOutput, error)
}

// ssmParameter reads one parameter's value, failing on an empty one.
func ssmParameter(ctx context.Context, c parameterGetter, name string) (string, error) {
	out, err := c.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name), WithDecryption: aws.Bool(true)})
	if err != nil {
		return "", fmt.Errorf("COGNITO_CLIENT_ID_PARAMETER %s: %w", name, err)
	}
	if out.Parameter == nil || aws.ToString(out.Parameter.Value) == "" {
		return "", fmt.Errorf("COGNITO_CLIENT_ID_PARAMETER %s is empty", name)
	}
	return aws.ToString(out.Parameter.Value), nil
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(s int) { w.status = s; w.ResponseWriter.WriteHeader(s) }

func logged(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start, sw := time.Now(), &statusWriter{w, http.StatusOK}
		h.ServeHTTP(sw, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", sw.status, "ms", time.Since(start).Milliseconds())
	})
}
