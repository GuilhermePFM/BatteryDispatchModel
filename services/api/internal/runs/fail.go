package runs

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	mrand "math/rand/v2"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/quota"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/store"
)

// Fail moves a queued or running run to failed and refunds it. The move and
// the two refunds are one transaction, conditional on the status, so of
// everyone who tries (the API after a failed send, the solver, the DLQ
// Lambda) exactly one gets ok = true, and the counters come back exactly when
// the run fails. A run already finished or unknown gives ok = false. The
// solver (services/solver/handler.py, _fail) does the same transaction.
func Fail(ctx context.Context, db store.DB, table, runID, code, message string, now time.Time) (ok bool, err error) {
	// The transaction cannot return the item, so read what the refund needs first.
	got, err := db.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:                aws.String(table),
		Key:                      store.Key(store.RunKey(runID)),
		ConsistentRead:           aws.Bool(true),
		ProjectionExpression:     aws.String("#status, user_sub, created_at, params_hash"),
		ExpressionAttributeNames: map[string]string{"#status": "status"},
	})
	if err != nil {
		return false, err
	}
	run := got.Item
	if status := store.Str(run, "status"); status != "queued" && status != "running" {
		return false, nil
	}
	created, err := time.Parse(time.RFC3339, store.Str(run, "created_at"))
	if err != nil {
		return false, err
	}

	at := store.S(store.Timestamp(now))
	move := types.TransactWriteItem{Update: &types.Update{
		TableName:           aws.String(table),
		Key:                 store.Key(store.RunKey(runID)),
		UpdateExpression:    aws.String("SET #status = :failed, #error = :error, finished_at = :now, updated_at = :now"),
		ConditionExpression: aws.String("#status IN (:queued, :running)"),
		ExpressionAttributeNames: map[string]string{
			"#status": "status", "#error": "error",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":failed": store.S("failed"), ":queued": store.S("queued"), ":running": store.S("running"), ":now": at,
			":error": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{
				"code": store.S(code), "message": store.S(message),
			}},
		},
	}}
	items := append([]types.TransactWriteItem{move}, quota.Refund(table, store.Str(run, "user_sub"), store.Day(created))...)
	for attempt := range 10 {
		_, err = db.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		if err == nil {
			break
		}
		var tce *types.TransactionCanceledException
		if errors.As(err, &tce) && len(tce.CancellationReasons) > 0 &&
			aws.ToString(tce.CancellationReasons[0].Code) == "ConditionalCheckFailed" {
			return false, nil // someone else failed or finished it first
		}
		if outcome, _ := quota.Classify(err); outcome != quota.Conflict {
			return false, err
		}
		// A concurrent transaction touched the run or the counters: back off and retry.
		time.Sleep(time.Duration(10<<min(attempt, 5)+mrand.IntN(20)) * time.Millisecond)
	}
	if err != nil {
		return false, err
	}

	// Drop the cache pointer, unless a later run of the same params owns it.
	_, err = db.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:                 aws.String(table),
		Key:                       store.Key(store.HashKey(store.Str(run, "params_hash"))),
		ConditionExpression:       aws.String("run_id = :run"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":run": store.S(runID)},
	})
	if err != nil && !store.ConditionFailed(err) {
		return true, err
	}
	return true, nil
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewULID is a ULID: 48 bits of milliseconds then 80 random bits, in 26
// Crockford base32 characters.
func NewULID(t time.Time) string {
	var b [16]byte
	binary.BigEndian.PutUint64(b[:8], uint64(t.UnixMilli())<<16)
	rand.Read(b[6:])
	hi, lo := binary.BigEndian.Uint64(b[:8]), binary.BigEndian.Uint64(b[8:])
	var out [26]byte
	for i := 25; i >= 0; i-- {
		out[i] = crockford[lo&31]
		lo = lo>>5 | hi<<59
		hi >>= 5
	}
	return string(out[:])
}
