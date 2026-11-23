package runs

// Tests against DynamoDB Local in a container this file starts (and stops).
// They skip when docker is unavailable, or with -short.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/auth"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/contracts"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/prices"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/quota"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/store"
)

var (
	dynamoOnce      sync.Once
	dynamoClient    *dynamodb.Client
	dynamoContainer string
	dynamoErr       error
	tables          atomic.Int64
)

func TestMain(m *testing.M) {
	code := m.Run()
	if dynamoContainer != "" {
		exec.Command("docker", "rm", "-f", dynamoContainer).Run()
	}
	os.Exit(code)
}

// dynamo returns a client on DynamoDB Local and a fresh table.
func dynamo(t *testing.T) (*dynamodb.Client, string) {
	t.Helper()
	if testing.Short() {
		t.Skip("-short: no DynamoDB Local")
	}
	dynamoOnce.Do(startDynamo)
	if dynamoErr != nil {
		t.Skipf("DynamoDB Local unavailable: %v", dynamoErr)
	}
	table := fmt.Sprintf("batteryplan%d", tables.Add(1))
	_, err := dynamoClient.CreateTable(context.Background(), &dynamodb.CreateTableInput{
		TableName:            aws.String(table),
		BillingMode:          types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS}},
		KeySchema:            []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return dynamoClient, table
}

func startDynamo() {
	if _, err := exec.LookPath("docker"); err != nil {
		dynamoErr = err
		return
	}
	out, err := exec.Command("docker", "run", "-d", "--rm", "-p", "127.0.0.1::8000", "amazon/dynamodb-local:latest").Output()
	if err != nil {
		dynamoErr = fmt.Errorf("docker run: %w", err)
		return
	}
	dynamoContainer = strings.TrimSpace(string(out))
	port, err := exec.Command("docker", "port", dynamoContainer, "8000/tcp").Output()
	if err != nil {
		dynamoErr = err
		return
	}
	addr := strings.TrimSpace(strings.Split(string(port), "\n")[0])
	dynamoClient = dynamodb.New(dynamodb.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String("http://" + addr),
		Credentials:  credentials.NewStaticCredentialsProvider("local", "local", ""),
	})
	deadline := time.Now().Add(60 * time.Second)
	for {
		_, err := dynamoClient.ListTables(context.Background(), &dynamodb.ListTablesInput{})
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			dynamoErr = fmt.Errorf("not ready: %w", err)
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

type fakeQueue struct {
	mu     sync.Mutex
	bodies []string
	fail   bool
}

func (q *fakeQueue) SendMessage(_ context.Context, in *sqs.SendMessageInput, _ ...func(*sqs.Options)) (*sqs.SendMessageOutput, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.fail {
		return nil, fmt.Errorf("queue unavailable")
	}
	q.bodies = append(q.bodies, *in.MessageBody)
	return &sqs.SendMessageOutput{}, nil
}

type fakeObjects map[string][]byte

func (o fakeObjects) GetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	data, ok := o[*in.Key]
	if !ok {
		return nil, &s3types.NoSuchKey{}
	}
	return &s3.GetObjectOutput{Body: io.NopCloser(bytes.NewReader(data))}, nil
}

type env struct {
	t       *testing.T
	srv     *Server
	url     string
	queue   *fakeQueue
	objects fakeObjects
}

func newEnv(t *testing.T, limits quota.Limits, perMinute int) *env {
	db, table := dynamo(t)
	e := &env{t: t, queue: &fakeQueue{}, objects: fakeObjects{}}
	s3c := s3.New(s3.Options{Region: "eu-west-2", Credentials: credentials.NewStaticCredentialsProvider("a", "b", "")})
	e.srv = &Server{
		DB: db, Queue: e.queue, Objects: e.objects, Presigner: s3.NewPresignClient(s3c),
		Poster: prices.Poster{Credentials: s3c.Options().Credentials, Region: "eu-west-2", Bucket: "data"},
		Auth:   auth.NewDev(), Table: table, QueueURL: "q", Bucket: "data", Limits: limits,
		Rate: quota.Rate{DB: db, Table: table, PerMinute: perMinute},
	}
	hs := httptest.NewServer(e.srv.Handler())
	t.Cleanup(hs.Close)
	e.url = hs.URL
	return e
}

type response struct {
	status     int
	retryAfter string
	body       map[string]any
	raw        []byte
}

func (e *env) do(method, path, user, body string, headers ...string) response {
	req, _ := http.NewRequest(method, e.url+path, strings.NewReader(body))
	if user != "" {
		req.Header.Set("Authorization", "Bearer dev:"+user+":"+user+"@example.com")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	json.Unmarshal(raw, &out)
	return response{resp.StatusCode, resp.Header.Get("Retry-After"), out, raw}
}

// request is the example run request with the volume set to tell runs apart.
func request(n int, extra ...string) string {
	return fmt.Sprintf(`{"battery":{"power_mw":30,"volume_mwh":%d,"max_charge_mw":24,"max_discharge_mw":32.5,
"charge_efficiency":0.92,"discharge_efficiency":0.92,"degradation_pct_per_cycle":0.001},
"start":"2025-02-01","end":"2026-01-31"%s}`, n%59000+1, strings.Join(extra, ""))
}

// pldYear is a valid hourly PLD file for the whole of 2025.
func pldYear() []byte {
	var b strings.Builder
	b.WriteString("hora,submercado,pld\n")
	at := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	for h := range 365 * 24 {
		for _, submarket := range []string{"SE", "S", "NE", "N"} {
			fmt.Fprintf(&b, "%s,%s,%d.50\n", at.Add(time.Duration(h)*time.Hour).Format("2006-01-02T15:04"), submarket, 100+h%24)
		}
	}
	return []byte(b.String())
}

func (e *env) usage(user string) quota.Usage {
	u, err := quota.Read(context.Background(), e.srv.DB, e.srv.Table, user, time.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	return u
}

// fire sends n submissions at once and returns the responses.
func (e *env) fire(n int, user func(i int) string, body func(i int) string) []response {
	out := make([]response, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			out[i] = e.do("POST", "/api/runs", user(i), body(i))
		}()
	}
	close(start)
	wg.Wait()
	return out
}

func tally(t *testing.T, rs []response) map[string]int {
	counts := map[string]int{}
	for _, r := range rs {
		key := fmt.Sprint(r.status)
		if c := code(r.body); c != "" {
			key += " " + c
		}
		counts[key]++
	}
	t.Logf("outcomes: %v", counts)
	return counts
}

func TestQuotaUnderConcurrency(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 3, Global: 60}, 1000)
	rs := e.fire(10, func(int) string { return "alice" }, func(i int) string { return request(500000 + i) })
	counts := tally(t, rs)
	if counts["202"] != 3 || counts["429 quota_exceeded"] != 7 {
		t.Fatalf("want 3 accepted and 7 quota_exceeded, got %v", counts)
	}
	for _, r := range rs {
		if r.status != 429 {
			continue
		}
		q, _ := r.body["quota"].(map[string]any)
		if r.retryAfter == "" || r.retryAfter == "0" || q["used"] != 3.0 || q["remaining"] != 0.0 || q["limit"] != 3.0 {
			t.Errorf("429 without Retry-After or quota: %s (Retry-After %q)", r.raw, r.retryAfter)
		}
	}
	if u := e.usage("alice"); u.User != 3 || u.Global != 3 {
		t.Fatalf("counters %+v, want 3 and 3", u)
	}
	if len(e.queue.bodies) != 3 {
		t.Fatalf("%d jobs sent, want 3", len(e.queue.bodies))
	}
	for _, b := range e.queue.bodies {
		if err := contracts.Validate(contracts.JobMessage, []byte(b)); err != nil {
			t.Errorf("job-message invalid: %v\n%s", err, b)
		}
	}
	me := e.do("GET", "/api/me", "alice", "")
	q := me.body["quota"].(map[string]any)
	if me.status != 200 || q["used"] != 3.0 || q["remaining"] != 0.0 || me.body["email"] != "alice@example.com" {
		t.Fatalf("me: %s", me.raw)
	}
}

func TestGlobalCap(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 3, Global: 4}, 1000)
	rs := e.fire(10, func(i int) string { return fmt.Sprintf("user%d", i) }, func(i int) string { return request(600000 + i) })
	counts := tally(t, rs)
	if counts["202"] != 4 || counts["429 global_cap"] != 6 {
		t.Fatalf("want 4 accepted and 6 global_cap, got %v", counts)
	}
	for _, r := range rs {
		if r.status == 429 && r.retryAfter == "" {
			t.Errorf("global_cap without Retry-After")
		}
	}
	// /api/me reports the site's remaining runs.
	if r := e.do("GET", "/api/me", "user0", ""); r.body["global"].(map[string]any)["remaining"] != 0.0 {
		t.Fatalf("me: %s", r.raw)
	}
}

func TestCachedResubmission(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 3, Global: 60}, 1000)
	first := e.do("POST", "/api/runs", "bob", request(1))
	if first.status != 202 || first.body["cached"] != false || first.body["status"] != "queued" {
		t.Fatalf("first: %d %s", first.status, first.raw)
	}
	// Same params, other user, other key order: the same run, at no cost.
	var m map[string]any
	json.Unmarshal([]byte(request(1)), &m)
	reordered, _ := json.MarshalIndent(m, "", "  ")
	for _, user := range []string{"bob", "carol"} {
		again := e.do("POST", "/api/runs", user, string(reordered))
		if again.status != 200 || again.body["cached"] != true || again.body["run_id"] != first.body["run_id"] {
			t.Fatalf("resubmission by %s: %d %s", user, again.status, again.raw)
		}
	}
	if u := e.usage("bob"); u.User != 1 || u.Global != 1 {
		t.Fatalf("counters %+v, want 1 and 1", u)
	}
	if u := e.usage("carol"); u.User != 0 {
		t.Fatalf("carol spent quota on a cached run")
	}

	// Once the run fails, its pointer is ignored and a new run is queued.
	runID := first.body["run_id"].(string)
	if ok, err := Fail(context.Background(), e.srv.DB, e.srv.Table, runID, "solver_failed", "boom", time.Now()); !ok || err != nil {
		t.Fatalf("fail: %v %v", ok, err)
	}
	third := e.do("POST", "/api/runs", "bob", request(1))
	if third.status != 202 || third.body["run_id"] == runID {
		t.Fatalf("after failure: %d %s", third.status, third.raw)
	}
	if u := e.usage("bob"); u.User != 1 {
		t.Fatalf("counters %+v, want the failed run refunded", u)
	}
}

func TestRefundOnceUnderRace(t *testing.T) {
	const n = 25
	e := newEnv(t, quota.Limits{User: n, Global: n}, 1000)
	ctx := context.Background()
	var wins atomic.Int64
	for i := range n {
		r := e.do("POST", "/api/runs", "dave", request(700000+i))
		if r.status != 202 {
			t.Fatalf("submit: %s", r.raw)
		}
		runID := r.body["run_id"].(string)
		// The solver picked it up (queued -> running) ...
		_, err := e.srv.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName: aws.String(e.srv.Table), Key: store.Key(store.RunKey(runID)),
			UpdateExpression:          aws.String("SET #s = :running, started_at = :now"),
			ConditionExpression:       aws.String("#s = :queued"),
			ExpressionAttributeNames:  map[string]string{"#s": "status"},
			ExpressionAttributeValues: map[string]types.AttributeValue{":running": store.S("running"), ":queued": store.S("queued"), ":now": store.S(store.Timestamp(time.Now()))},
		})
		if err != nil {
			t.Fatal(err)
		}
		// ... and now fails it itself while the DLQ Lambda fails it too.
		var wg sync.WaitGroup
		results := make([]bool, 2)
		for j, failure := range []string{"prices_invalid", "solver_failed"} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ok, err := Fail(ctx, e.srv.DB, e.srv.Table, runID, failure, "failed", time.Now())
				if err != nil {
					t.Error(err)
				}
				results[j] = ok
			}()
		}
		wg.Wait()
		if results[0] == results[1] {
			t.Fatalf("run %s: both or neither failed it: %v", runID, results)
		}
		wins.Add(1)
		got := e.do("GET", "/api/runs/"+runID, "", "")
		if got.body["status"] != "failed" {
			t.Fatalf("%s", got.raw)
		}
		if err := contracts.Validate(contracts.RunRecord, got.raw); err != nil {
			t.Fatalf("failed run-record invalid: %v", err)
		}
	}
	if u := e.usage("dave"); u.User != 0 || u.Global != 0 {
		t.Fatalf("after %d races counters are %+v, want 0 and 0", wins.Load(), u)
	}
	t.Logf("%d races, each refunded exactly once", wins.Load())
	// A third attempt, after the fact, changes nothing.
	if ok, _ := Fail(ctx, e.srv.DB, e.srv.Table, NewULID(time.Now()), "solver_failed", "x", time.Now()); ok {
		t.Fatal("failed an unknown run")
	}
}

func TestQueueFailureRefunds(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 3, Global: 60}, 1000)
	e.queue.fail = true
	r := e.do("POST", "/api/runs", "erin", request(2))
	if r.status != 503 || code(r.body) != "unavailable" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if u := e.usage("erin"); u.User != 0 || u.Global != 0 {
		t.Fatalf("counters %+v after a failed send", u)
	}
	// The failed run does not answer a retry from the cache.
	e.queue.fail = false
	if r := e.do("POST", "/api/runs", "erin", request(2)); r.status != 202 {
		t.Fatalf("retry: %d %s", r.status, r.raw)
	}
}

func TestGetRun(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 3, Global: 60}, 1000)
	r := e.do("POST", "/api/runs", "frank", request(3, `,"cycle_budget":4.5`))
	runID := r.body["run_id"].(string)
	got := e.do("GET", "/api/runs/"+runID, "", "")
	if got.status != 200 || got.body["status"] != "queued" || got.body["run_id"] != runID {
		t.Fatalf("%d %s", got.status, got.raw)
	}
	if err := contracts.Validate(contracts.RunRecord, got.raw); err != nil {
		t.Fatalf("queued run-record invalid: %v\n%s", err, got.raw)
	}
	if _, ok := got.body["pk"]; ok {
		t.Fatal("pk leaked")
	}

	// Succeed it as the solver does: result as a JSON string, plan in S3.
	result, err := os.ReadFile("../../../../contracts/examples/v2/result.example.json")
	if err != nil {
		t.Skip("not inside the repository")
	}
	var compact bytes.Buffer
	json.Compact(&compact, result)
	now := store.S(store.Timestamp(time.Now()))
	_, err = e.srv.DB.UpdateItem(context.Background(), &dynamodb.UpdateItemInput{
		TableName: aws.String(e.srv.Table), Key: store.Key(store.RunKey(runID)),
		UpdateExpression:         aws.String("SET #s = :s, started_at = :now, finished_at = :now, updated_at = :now, result_json = :r, plan_csv_key = :k"),
		ExpressionAttributeNames: map[string]string{"#s": "status"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":s": store.S("succeeded"), ":now": now, ":r": store.S(compact.String()), ":k": store.S("plans/" + runID + ".csv"),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got = e.do("GET", "/api/runs/"+runID, "", "")
	url, _ := got.body["plan_csv_url"].(string)
	if !strings.Contains(url, "plans/"+runID+".csv") || !strings.Contains(url, "X-Amz-Expires=3600") {
		t.Fatalf("plan_csv_url %q", url)
	}
	if res, _ := got.body["result"].(map[string]any); res["version"] != 2.0 || res["model_version"] != contracts.ModelVersion {
		t.Fatalf("result not parsed back: %.200s", got.raw)
	}
	// The response, plan_csv_url included, is a valid run-record.
	var record map[string]any
	json.Unmarshal(got.raw, &record)
	if err := contracts.Validate(contracts.RunRecord, got.raw); err != nil {
		t.Fatalf("succeeded run-record invalid: %v", err)
	}
	if req := record["request"].(map[string]any); req["cycle_budget"] != 4.5 {
		t.Fatalf("request round trip: %v", req)
	}
}

func TestUploadedPrices(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 10, Global: 60}, 1000)
	template := pldYear()
	put := func(data []byte) string {
		sum := sha256.Sum256(data)
		key := "uploads/" + hex.EncodeToString(sum[:]) + ".csv"
		e.objects[key] = data
		return key
	}
	key := put(template)
	upload := func(key, start, end string) response {
		body := strings.Replace(request(4, `,"prices_key":"`+key+`"`), `"start":"2025-02-01","end":"2026-01-31"`,
			`"start":"`+start+`","end":"`+end+`"`, 1)
		return e.do("POST", "/api/runs", "gina", body)
	}

	if r := upload(key, "2025-01-01", "2025-12-31"); r.status != 202 {
		t.Fatalf("valid upload: %d %s", r.status, r.raw)
	}
	var job map[string]any
	json.Unmarshal([]byte(e.queue.bodies[0]), &job)
	if p := job["prices"].(map[string]any); p["source"] != "s3" || p["key"] != key || p["bucket"] != "data" {
		t.Fatalf("job prices %v", p)
	}
	if job["version"] != 2.0 || job["model_version"] != contracts.ModelVersion {
		t.Fatalf("job version %v, model %v", job["version"], job["model_version"])
	}
	// The hash is computed on the file's content, as in the second vector of
	// contracts/examples/v2/params-hash.json.
	sum := sha256.Sum256(template)
	if want, _ := contracts.ParamsHash(job["request"].(map[string]any), hex.EncodeToString(sum[:])); job["params_hash"] != want {
		t.Fatalf("params_hash %v, want %s", job["params_hash"], want)
	}

	bad := put([]byte("hora,submercado,pld\n2025-01-01T00:30,SE,100.00\n"))
	cases := []struct{ key, want string }{
		{bad, "hora must fall on the hour"},
		{"uploads/" + strings.Repeat("0", 64) + ".csv", "not found"},
		{"uploads/" + strings.Repeat("1", 64) + ".csv", "does not match"},
	}
	e.objects["uploads/"+strings.Repeat("1", 64)+".csv"] = template
	for _, c := range cases {
		r := upload(c.key, "2025-01-01", "2025-12-31")
		if r.status != 400 || code(r.body) != "prices_invalid" || !strings.Contains(r.body["error"].(map[string]any)["message"].(string), c.want) {
			t.Errorf("%s: %d %s", c.want, r.status, r.raw)
		}
	}
	if r := upload("somewhere/else.csv", "2025-01-01", "2025-12-31"); r.status != 400 || code(r.body) != "request_invalid" {
		t.Errorf("foreign key: %d %s", r.status, r.raw)
	}
	if u := e.usage("gina"); u.User != 1 {
		t.Fatalf("rejected uploads spent quota: %+v", u)
	}

	pre := e.do("POST", "/api/uploads", "gina", fmt.Sprintf(`{"sha256":"%x","size":%d}`, sum, len(template)))
	if pre.status != 200 || pre.body["prices_key"] != key || pre.body["fields"].(map[string]any)["key"] != key {
		t.Fatalf("presign: %d %s", pre.status, pre.raw)
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 3, Global: 60}, 3)
	ip := func(a string) []string { return []string{"CloudFront-Viewer-Address", a + ":443"} }
	for i := range 3 {
		if r := e.do("GET", "/api/runs/"+NewULID(time.Now()), "", "", ip("203.0.113.9")...); r.status != 404 {
			t.Fatalf("request %d: %d", i, r.status)
		}
	}
	r := e.do("GET", "/api/me", "hal", "", ip("203.0.113.9")...)
	if r.status != 429 || code(r.body) != "rate_limited" || r.retryAfter == "" {
		t.Fatalf("4th request: %d %q %s", r.status, r.retryAfter, r.raw)
	}
	if secs := r.retryAfter; len(secs) > 2 {
		t.Fatalf("Retry-After %s is past the minute", secs)
	}
	if r := e.do("GET", "/api/me", "hal", "", ip("203.0.113.10")...); r.status != 200 {
		t.Fatalf("another address: %d", r.status)
	}
	if r := e.do("GET", "/api/health", "", "", ip("203.0.113.9")...); r.status != 200 {
		t.Fatalf("health is not rate limited: %d", r.status)
	}
}

// A token without email: the user item keeps none, even if it had one before.
func TestUserWithoutEmail(t *testing.T) {
	e := newEnv(t, quota.Limits{User: 3, Global: 60}, 0)
	if r := e.do("GET", "/api/me", "ivy", ""); r.status != 200 || r.body["email"] != "ivy@example.com" {
		t.Fatalf("with email: %d %s", r.status, r.raw)
	}
	r := e.do("GET", "/api/me", "", "", "Authorization", "Bearer dev:ivy:")
	if v, ok := r.body["email"]; r.status != 200 || !ok || v != nil {
		t.Fatalf("without email: %d %s", r.status, r.raw)
	}
	out, err := e.srv.DB.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(e.srv.Table), Key: store.Key(store.UserKey("ivy")),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, has := out.Item["email"]; has || out.Item["last_seen"] == nil {
		t.Fatalf("user item %v", out.Item)
	}
}
