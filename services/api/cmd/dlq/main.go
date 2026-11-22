// Command dlq fails the runs whose job reached the dead-letter queue: the
// solver raised, so the run is marked solver_failed and refunded (once, by
// runs.Fail's condition). In AWS it is an SQS-triggered Lambda; anywhere else
// it polls DLQ_URL one message at a time, deleting a message only once handled.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/config"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/runs"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/store"
)

const message = "The solver failed on this run. It has not counted against your daily runs; try again, perhaps over a shorter period."

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("dlq", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return err
	}
	h := handler{db: dynamodb.NewFromConfig(awsCfg), table: cfg.TableName}

	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(h.event)
		return nil
	}
	if cfg.DLQURL == "" {
		return errors.New("DLQ_URL is not set")
	}
	return poll(ctx, sqs.NewFromConfig(awsCfg), cfg.DLQURL, h)
}

type handler struct {
	db    store.DB
	table string
}

// event handles a batch from the Lambda event source; an error retries the
// whole batch, which is safe because failing a run is idempotent.
func (h handler) event(ctx context.Context, e events.SQSEvent) error {
	var errs []error
	for _, m := range e.Records {
		errs = append(errs, h.handle(ctx, m.Body))
	}
	return errors.Join(errs...)
}

func (h handler) handle(ctx context.Context, body string) error {
	var job struct {
		RunID string `json:"run_id"`
	}
	if err := json.Unmarshal([]byte(body), &job); err != nil || job.RunID == "" {
		slog.Error("dlq message without a run_id, dropped", "body", body)
		return nil
	}
	ok, err := runs.Fail(ctx, h.db, h.table, job.RunID, "solver_failed", message, time.Now())
	if err != nil {
		return err
	}
	slog.Info("dlq", "run_id", job.RunID, "failed_and_refunded", ok)
	return nil
}

// maxAttempts bounds the local poller's retries of a message whose handling
// fails; after that it is logged and deleted rather than retried forever.
const maxAttempts = 3

func poll(ctx context.Context, q *sqs.Client, url string, h handler) error {
	slog.Info("polling", "queue", url)
	for {
		out, err := q.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl: aws.String(url), MaxNumberOfMessages: 1, WaitTimeSeconds: 20,
			MessageSystemAttributeNames: []sqstypes.MessageSystemAttributeName{
				sqstypes.MessageSystemAttributeNameApproximateReceiveCount,
			},
		})
		if err != nil {
			slog.Error("receive", "err", err)
			time.Sleep(5 * time.Second)
			continue
		}
		for _, m := range out.Messages {
			if err := h.handle(ctx, aws.ToString(m.Body)); err != nil {
				attempt, _ := strconv.Atoi(m.Attributes[string(sqstypes.MessageSystemAttributeNameApproximateReceiveCount)])
				if attempt < maxAttempts {
					slog.Error("handle", "err", err, "attempt", attempt)
					continue // visible again after the queue's visibility timeout
				}
				slog.Error("handle failed, giving up and deleting", "err", err, "attempt", attempt, "body", aws.ToString(m.Body))
			}
			if _, err := q.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: aws.String(url), ReceiptHandle: m.ReceiptHandle}); err != nil {
				slog.Error("delete", "err", err)
			}
		}
	}
}
