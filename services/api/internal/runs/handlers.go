package runs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/contracts"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/prices"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/quota"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/store"
)

type quotaBody struct {
	Used      int    `json:"used"`
	Limit     int    `json:"limit"`
	Remaining int    `json:"remaining"`
	ResetsAt  string `json:"resets_at"`
}

func (s *Server) quotaBody(used int, now time.Time) quotaBody {
	return quotaBody{used, s.Limits.User, max(0, s.Limits.User-used), store.Timestamp(store.NextMidnight(now))}
}

// GET /api/me: who is signed in and what is left of the day; records the user.
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	user, now := userOf(r), s.now()
	// An ID token may lack email: the user item then has none, and /api/me
	// answers "email": null.
	update := "SET last_seen = :now, first_seen = if_not_exists(first_seen, :now) REMOVE email"
	values := map[string]types.AttributeValue{":now": store.S(store.Timestamp(now))}
	var email any
	if user.Email != "" {
		update = "SET email = :email, last_seen = :now, first_seen = if_not_exists(first_seen, :now)"
		values[":email"] = store.S(user.Email)
		email = user.Email
	}
	_, err := s.DB.UpdateItem(r.Context(), &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       store.Key(store.UserKey(user.Sub)),
		UpdateExpression:          aws.String(update),
		ExpressionAttributeValues: values,
	})
	if err != nil {
		s.internal(w, "upsert user", err)
		return
	}
	usage, err := quota.Read(r.Context(), s.DB, s.Table, user.Sub, now)
	if err != nil {
		s.internal(w, "read quota", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sub":    user.Sub,
		"email":  email,
		"quota":  s.quotaBody(usage.User, now),
		"global": map[string]int{"remaining": max(0, s.Limits.Global-usage.Global)},
	})
}

// POST /api/uploads: a presigned POST for a price file, keyed by its hash.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(w, r, 4<<10)
	var body struct {
		SHA256 string          `json:"sha256"`
		Size   json.RawMessage `json:"size"`
	}
	if err == nil {
		err = json.Unmarshal(raw, &body)
	}
	if err != nil || !prices.ValidSHA256(body.SHA256) {
		writeError(w, http.StatusBadRequest, "request_invalid", "Send {\"sha256\": <the file's sha256, lowercase hex>, \"size\": <bytes>}.")
		return
	}
	size, err := strconv.ParseInt(string(body.Size), 10, 64)
	if err != nil || size < 1 {
		writeError(w, http.StatusBadRequest, "request_invalid", "size must be the file's length in bytes.")
		return
	}
	if size > prices.MaxBytes {
		writeError(w, http.StatusBadRequest, "prices_invalid", "The file is larger than 5 MB.")
		return
	}
	post, err := s.Poster.Presign(r.Context(), body.SHA256)
	if err != nil {
		s.internal(w, "presign upload", err)
		return
	}
	writeJSON(w, http.StatusOK, post)
}

type submitted struct {
	RunID  string `json:"run_id"`
	Status string `json:"status"`
	Cached bool   `json:"cached"`
}

// POST /api/runs: validate, answer from the cache, or spend the quota and queue.
func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	ctx, user, now := r.Context(), userOf(r), s.now()
	raw, err := readBody(w, r, 16<<10)
	if err != nil {
		writeError(w, http.StatusBadRequest, "request_invalid", "The body could not be read: "+err.Error()+".")
		return
	}
	req, err := contracts.ParseRequest(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "request_invalid", err.Error())
		return
	}

	if req.PricesKey == "" && !s.BundledPrices {
		writeError(w, http.StatusBadRequest, "request_invalid", "Upload a price file: this deployment has no bundled prices.")
		return
	}
	pricesSHA, jobPrices := contracts.BundledPricesSHA256, map[string]string{"source": "bundled"}
	if req.PricesKey != "" {
		pricesSHA = prices.KeySHA256(req.PricesKey)
		if pricesSHA == "" {
			writeError(w, http.StatusBadRequest, "request_invalid", "prices_key must be the key POST /api/uploads returned.")
			return
		}
		if msg, err := s.checkUpload(ctx, req.PricesKey, pricesSHA); err != nil {
			s.internal(w, "read upload", err)
			return
		} else if msg != "" {
			writeError(w, http.StatusBadRequest, "prices_invalid", msg)
			return
		}
		jobPrices = map[string]string{"source": "s3", "bucket": s.Bucket, "key": req.PricesKey}
	}
	hash, err := contracts.ParamsHash(req.Fields, pricesSHA)
	if err != nil {
		s.internal(w, "params hash", err)
		return
	}

	if runID, status, err := s.cached(ctx, hash); err != nil {
		s.internal(w, "cache lookup", err)
		return
	} else if runID != "" {
		writeJSON(w, http.StatusOK, submitted{runID, status, true})
		return
	}

	runID := NewULID(now)
	created := store.Timestamp(now)
	expires := store.Epoch(now.Add(store.RunTTL))
	run, err := attributevalue.MarshalMap(map[string]any{
		"version": contracts.ContractVersion, "run_id": runID, "user_sub": user.Sub, "params_hash": hash,
		"status": "queued", "request": req.Fields, "created_at": created, "updated_at": created,
	})
	if err != nil {
		s.internal(w, "marshal run", err)
		return
	}
	run["pk"], run["expires_at"] = store.S(store.RunKey(runID)), expires
	items := append(quota.Spend(s.Table, user.Sub, now, s.Limits),
		types.TransactWriteItem{Put: &types.Put{
			TableName: aws.String(s.Table), Item: run, ConditionExpression: aws.String("attribute_not_exists(pk)"),
		}},
		types.TransactWriteItem{Put: &types.Put{
			TableName: aws.String(s.Table),
			Item: map[string]types.AttributeValue{
				"pk": store.S(store.HashKey(hash)), "run_id": store.S(runID), "expires_at": expires,
			},
		}},
	)
	var outcome quota.Outcome
	var used int
	for attempt := range 10 {
		_, err = s.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		if outcome, used = quota.Classify(err); outcome != quota.Conflict {
			break
		}
		// A concurrent submission touched the same counters: back off and retry.
		time.Sleep(time.Duration(10<<min(attempt, 5)+rand.IntN(20)) * time.Millisecond)
	}
	switch {
	case err == nil:
	case outcome == quota.UserExhausted:
		w.Header().Set("Retry-After", strconv.Itoa(quota.UntilMidnight(now)))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": apiError{"quota_exceeded", "You have used your " + strconv.Itoa(s.Limits.User) + " runs for today; they reset at midnight UTC."},
			"quota": s.quotaBody(max(used, s.Limits.User), now),
		})
		return
	case outcome == quota.GlobalCap:
		w.Header().Set("Retry-After", strconv.Itoa(quota.UntilMidnight(now)))
		writeError(w, http.StatusTooManyRequests, "global_cap", "The site has run its "+strconv.Itoa(s.Limits.Global)+" runs for today; try again after midnight UTC.")
		return
	default:
		s.internal(w, "queue run", err)
		return
	}

	job, _ := json.Marshal(map[string]any{
		"version": contracts.ContractVersion, "model_version": contracts.ModelVersion,
		"run_id": runID, "params_hash": hash, "user_sub": user.Sub,
		"request": req.Fields, "prices": jobPrices,
	})
	if _, err := s.Queue.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl: aws.String(s.QueueURL), MessageBody: aws.String(string(job)),
	}); err != nil {
		s.log().Error("send job", "run_id", runID, "err", err)
		if _, ferr := Fail(context.WithoutCancel(ctx), s.DB, s.Table, runID, "solver_failed", "The run could not be queued.", s.now()); ferr != nil {
			s.log().Error("refund after send failure", "run_id", runID, "err", ferr)
		}
		writeError(w, http.StatusServiceUnavailable, "unavailable", "The run could not be queued and has not counted against your quota; try again shortly.")
		return
	}
	writeJSON(w, http.StatusAccepted, submitted{runID, "queued", false})
}

// checkUpload reads an uploaded price file and returns why it cannot be
// used, or "" if it can.
func (s *Server) checkUpload(ctx context.Context, key, sum string) (string, error) {
	out, err := s.Objects.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(key)})
	var noKey *s3types.NoSuchKey
	if errors.As(err, &noKey) {
		return "The uploaded price file was not found (uploads are kept 7 days); upload it again.", nil
	}
	if err != nil {
		return "", err
	}
	defer out.Body.Close()
	data, err := io.ReadAll(io.LimitReader(out.Body, prices.MaxBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > prices.MaxBytes {
		return "The file is larger than 5 MB.", nil
	}
	got := sha256.Sum256(data)
	if hex.EncodeToString(got[:]) != sum {
		return "The uploaded file does not match its sha256; upload it again.", nil
	}
	if err := prices.CheckPLD(data); err != nil {
		return err.Error(), nil
	}
	return "", nil
}

// cached returns the run a params hash points to, if that run is not failed.
func (s *Server) cached(ctx context.Context, hash string) (runID, status string, err error) {
	ptr, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table), Key: store.Key(store.HashKey(hash)), ConsistentRead: aws.Bool(true),
	})
	if err != nil || ptr.Item == nil {
		return "", "", err
	}
	runID = store.Str(ptr.Item, "run_id")
	run, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table), Key: store.Key(store.RunKey(runID)), ConsistentRead: aws.Bool(true),
		ProjectionExpression: aws.String("#s"), ExpressionAttributeNames: map[string]string{"#s": "status"},
	})
	if err != nil {
		return "", "", err
	}
	switch status = store.Str(run.Item, "status"); status {
	case "queued", "running", "succeeded":
		return runID, status, nil
	}
	return "", "", nil
}

var ulidPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

// GET /api/runs/{run_id}: the run-record, result parsed, plus a plan link.
func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	notFound := func() {
		writeError(w, http.StatusNotFound, "not_found", "There is no run with that id; runs are kept 7 days.")
	}
	if !ulidPattern.MatchString(runID) {
		notFound()
		return
	}
	out, err := s.DB.GetItem(r.Context(), &dynamodb.GetItemInput{
		TableName: aws.String(s.Table), Key: store.Key(store.RunKey(runID)), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		s.internal(w, "get run", err)
		return
	}
	if out.Item == nil {
		notFound()
		return
	}
	resultJSON := store.Str(out.Item, "result_json")
	for _, name := range []string{"pk", "expires_at", "result_json"} {
		delete(out.Item, name)
	}
	var record map[string]any
	if err := attributevalue.UnmarshalMap(out.Item, &record); err != nil {
		s.internal(w, "unmarshal run", err)
		return
	}
	if resultJSON != "" {
		record["result"] = json.RawMessage(resultJSON)
	}
	if key, _ := record["plan_csv_key"].(string); key != "" && record["status"] == "succeeded" {
		req, err := s.Presigner.PresignGetObject(r.Context(),
			// The link is cross-origin, where <a download> is ignored: the
			// response itself says "save as dispatch_plan.csv".
			&s3.GetObjectInput{
				Bucket:                     aws.String(s.Bucket),
				Key:                        aws.String(key),
				ResponseContentDisposition: aws.String(`attachment; filename="dispatch_plan.csv"`),
			},
			s3.WithPresignExpires(time.Hour))
		if err != nil {
			s.internal(w, "presign plan", err)
			return
		}
		record["plan_csv_url"] = req.URL
	}
	writeJSON(w, http.StatusOK, record)
}
