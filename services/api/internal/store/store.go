// Package store names the items of the single DynamoDB table
// (contracts/platform.md) and the client calls the API makes on it.
package store

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// DB is the part of *dynamodb.Client the services use.
type DB interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
}

// Partition keys.
func RunKey(runID string) string       { return "run#" + runID }
func HashKey(paramsHash string) string { return "hash#" + paramsHash }
func QuotaKey(sub, day string) string  { return "quota#" + sub + "#" + day }
func GlobalKey(day string) string      { return "global#" + day }
func RateKey(ip, minute string) string { return "rate#" + ip + "#" + minute }
func UserKey(sub string) string        { return "user#" + sub }

// Lifetimes, counted to the expires_at TTL attribute.
const (
	RunTTL   = 7 * 24 * time.Hour
	QuotaTTL = 2 * 24 * time.Hour
	RateTTL  = 2 * time.Minute
)

// Day is the UTC date quotas are counted by.
func Day(t time.Time) string { return t.UTC().Format(time.DateOnly) }

// NextMidnight is when the day's quotas reset.
func NextMidnight(t time.Time) time.Time {
	return t.UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
}

// Timestamp is the run-record's format: UTC, RFC 3339, to the second.
func Timestamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func S(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }
func N(v int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(v, 10)}
}
func Key(pk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": S(pk)}
}

// Epoch is a TTL value.
func Epoch(t time.Time) types.AttributeValue { return N(t.Unix()) }

// Int reads a number attribute, 0 when absent.
func Int(item map[string]types.AttributeValue, name string) int {
	if n, ok := item[name].(*types.AttributeValueMemberN); ok {
		v, _ := strconv.Atoi(n.Value)
		return v
	}
	return 0
}

// Str reads a string attribute, "" when absent.
func Str(item map[string]types.AttributeValue, name string) string {
	if s, ok := item[name].(*types.AttributeValueMemberS); ok {
		return s.Value
	}
	return ""
}

// ConditionFailed reports a failed ConditionExpression.
func ConditionFailed(err error) bool {
	var ccf *types.ConditionalCheckFailedException
	return errors.As(err, &ccf)
}
