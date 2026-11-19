// Package quota counts runs per user and per site each UTC day, and requests
// per IP each minute.
//
// The day counters are spent inside the transaction that queues a run (the
// caller adds its own items to Spend's), so a run is queued exactly when both
// counters had room; Refund gives them back.
package quota

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/store"
)

// Limits are DAILY_USER_LIMIT and DAILY_GLOBAL_LIMIT.
type Limits struct {
	User   int
	Global int
}

// Spend is the two conditional increments, in this order: the user's
// counter, then the site's. Outcome reads a cancellation by that order.
func Spend(table, sub string, now time.Time, l Limits) []types.TransactWriteItem {
	day := store.Day(now)
	expires := store.Epoch(store.NextMidnight(now).Add(store.QuotaTTL - 24*time.Hour))
	inc := func(pk string, limit int) types.TransactWriteItem {
		return types.TransactWriteItem{Update: &types.Update{
			TableName:           aws.String(table),
			Key:                 store.Key(pk),
			UpdateExpression:    aws.String("SET used = if_not_exists(used, :zero) + :one, expires_at = :ttl"),
			ConditionExpression: aws.String("attribute_not_exists(used) OR used < :limit"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":zero": store.N(0), ":one": store.N(1), ":limit": store.N(int64(limit)), ":ttl": expires,
			},
			ReturnValuesOnConditionCheckFailure: types.ReturnValuesOnConditionCheckFailureAllOld,
		}}
	}
	return []types.TransactWriteItem{
		inc(store.QuotaKey(sub, day), l.User),
		inc(store.GlobalKey(day), l.Global),
	}
}

// Outcome of a cancelled transaction that began with Spend's items.
type Outcome int

const (
	Other         Outcome = iota // not a cancellation, or one Spend did not cause
	UserExhausted                // the user's runs of the day are spent
	GlobalCap                    // the site's runs of the day are spent
	Conflict                     // a concurrent transaction touched the same items: retry
)

// Classify reads a TransactWriteItems error. used is the user's counter as
// it stood, when the user's condition failed.
func Classify(err error) (o Outcome, used int) {
	var tce *types.TransactionCanceledException
	if !errors.As(err, &tce) {
		return Other, 0
	}
	reasons := tce.CancellationReasons
	code := func(i int) string {
		if i < len(reasons) && reasons[i].Code != nil {
			return *reasons[i].Code
		}
		return ""
	}
	switch {
	case code(0) == "ConditionalCheckFailed":
		return UserExhausted, store.Int(reasons[0].Item, "used")
	case code(1) == "ConditionalCheckFailed":
		return GlobalCap, 0
	}
	for i := range reasons {
		if c := code(i); c == "TransactionConflict" || c == "ThrottlingError" {
			return Conflict, 0
		}
	}
	return Other, 0
}

// Usage is the day's counters as /api/me reports them.
type Usage struct {
	User, Global int
}

// Read returns the day's counters, strongly consistent.
func Read(ctx context.Context, db store.DB, table, sub string, now time.Time) (Usage, error) {
	day := store.Day(now)
	var u Usage
	for pk, dst := range map[string]*int{store.QuotaKey(sub, day): &u.User, store.GlobalKey(day): &u.Global} {
		out, err := db.GetItem(ctx, &dynamodb.GetItemInput{
			TableName: aws.String(table), Key: store.Key(pk), ConsistentRead: aws.Bool(true),
		})
		if err != nil {
			return u, err
		}
		*dst = store.Int(out.Item, "used")
	}
	return u, nil
}

// Refund is the two decrements that give back one run to the user's and the
// site's counters of day (the UTC date of the run's created_at), for the
// caller to put in the same transaction as the run's move to failed: the
// decrements happen exactly when that move does.
func Refund(table, sub, day string) []types.TransactWriteItem {
	dec := func(pk string) types.TransactWriteItem {
		return types.TransactWriteItem{Update: &types.Update{
			TableName:                 aws.String(table),
			Key:                       store.Key(pk),
			UpdateExpression:          aws.String("ADD used :minus_one"),
			ExpressionAttributeValues: map[string]types.AttributeValue{":minus_one": store.N(-1)},
		}}
	}
	return []types.TransactWriteItem{dec(store.QuotaKey(sub, day)), dec(store.GlobalKey(day))}
}

// UntilMidnight is the Retry-After of a daily limit, in whole seconds.
func UntilMidnight(now time.Time) int { return ceilSeconds(store.NextMidnight(now).Sub(now)) }

// UntilNextMinute is the Retry-After of the per-IP limit.
func UntilNextMinute(now time.Time) int {
	return ceilSeconds(now.Truncate(time.Minute).Add(time.Minute).Sub(now))
}

func ceilSeconds(d time.Duration) int { return max(1, int(math.Ceil(d.Seconds()))) }

// Rate counts requests per IP per UTC minute.
type Rate struct {
	DB        store.DB
	Table     string
	PerMinute int // 0 turns the limit off
}

// Allow counts one request from ip and reports whether it is within the limit.
func (r Rate) Allow(ctx context.Context, ip string, now time.Time) (bool, error) {
	if r.PerMinute <= 0 {
		return true, nil
	}
	minute := now.UTC().Truncate(time.Minute)
	out, err := r.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                aws.String(r.Table),
		Key:                      store.Key(store.RateKey(ip, minute.Format("2006-01-02T15:04"))),
		UpdateExpression:         aws.String("ADD #count :one SET expires_at = :ttl"),
		ExpressionAttributeNames: map[string]string{"#count": "count"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":one": store.N(1), ":ttl": store.Epoch(minute.Add(store.RateTTL)),
		},
		ReturnValues: types.ReturnValueUpdatedNew,
	})
	if err != nil {
		return false, err
	}
	return store.Int(out.Attributes, "count") <= r.PerMinute, nil
}
