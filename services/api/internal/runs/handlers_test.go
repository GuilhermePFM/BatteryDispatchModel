package runs

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/auth"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/lambdaurl"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/quota"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/store"
)

// emptyDB answers every call as if the table were empty; enough for the
// paths that end before touching a run.
type emptyDB struct{ store.DB }

func (emptyDB) GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return &dynamodb.GetItemOutput{}, nil
}

func (emptyDB) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	return &dynamodb.UpdateItemOutput{Attributes: map[string]types.AttributeValue{"count": store.N(1)}}, nil
}

func unitServer() http.Handler {
	s := &Server{DB: emptyDB{}, Auth: auth.NewDev(), Table: "t", Limits: quota.Limits{User: 3, Global: 60}}
	s.Rate = quota.Rate{DB: s.DB, Table: "t", PerMinute: 60}
	return s.Handler()
}

func call(h http.Handler, method, path, token, body string) (int, map[string]any) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func code(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func TestUnitRoutes(t *testing.T) {
	h := unitServer()
	cases := []struct {
		method, path, token, body string
		status                    int
		code                      string
	}{
		{"GET", "/api/health", "", "", 200, ""},
		{"GET", "/api/me", "", "", 401, "unauthorized"},
		{"GET", "/api/me", "eyJhbGciOiJSUzI1NiJ9.e30.x", "", 401, "unauthorized"},
		{"POST", "/api/runs", "", "{}", 401, "unauthorized"},
		{"POST", "/api/uploads", "", "{}", 401, "unauthorized"},
		{"POST", "/api/runs", "dev:u:u@x", "{", 400, "request_invalid"},
		{"POST", "/api/runs", "dev:u:u@x", `{"start":"2018-01-01"}`, 400, "request_invalid"},
		{"POST", "/api/runs", "dev:u:u@x", strings.Repeat(" ", 20<<10), 400, "request_invalid"},
		{"POST", "/api/uploads", "dev:u:u@x", `{"sha256":"abc","size":10}`, 400, "request_invalid"},
		{"POST", "/api/uploads", "dev:u:u@x", `{"sha256":"` + strings.Repeat("a", 64) + `","size":1.5}`, 400, "request_invalid"},
		{"POST", "/api/uploads", "dev:u:u@x", `{"sha256":"` + strings.Repeat("a", 64) + `","size":6000000}`, 400, "prices_invalid"},
		{"GET", "/api/runs/not-a-ulid", "", "", 404, "not_found"},
		{"GET", "/api/runs/01JD3X7Q8RZK5V2N4M6P9T0WYA", "", "", 404, "not_found"},
		{"GET", "/api/nothing", "", "", 404, "not_found"},
	}
	for _, c := range cases {
		status, body := call(h, c.method, c.path, c.token, c.body)
		if status != c.status || code(body) != c.code {
			t.Errorf("%s %s: %d %v, want %d %s", c.method, c.path, status, body, c.status, c.code)
		}
	}
}

func TestClientIP(t *testing.T) {
	for header, want := range map[string]string{
		"":                  "192.0.2.1",
		"203.0.113.7:51234": "203.0.113.7",
		"2001:db8::1:443":   "2001:db8::1",
		"[2001:db8::1]:443": "2001:db8::1",
		"198.51.100.2:0":    "198.51.100.2",
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "192.0.2.1:1234"
		if header != "" {
			r.Header.Set("CloudFront-Viewer-Address", header)
		}
		if got := ClientIP(r); got != want {
			t.Errorf("%q: %s, want %s", header, got, want)
		}
	}
}

func TestULID(t *testing.T) {
	at := time.Date(2026, 11, 18, 9, 30, 0, 0, time.UTC)
	a, b := NewULID(at), NewULID(at)
	if !ulidPattern.MatchString(a) || a == b {
		t.Fatalf("%s %s", a, b)
	}
	// The first ten characters are the time, so ids sort by creation.
	if a[:10] != b[:10] || NewULID(at.Add(time.Millisecond))[:10] <= a[:10] {
		t.Fatal("time prefix")
	}
	if NewULID(time.UnixMilli(0))[:10] != "0000000000" || NewULID(time.UnixMilli(1<<48 - 1))[:10] != "7ZZZZZZZZZ" {
		t.Fatal("time encoding")
	}
}

func TestLambdaURL(t *testing.T) {
	h := lambdaurl.Handler(unitServer())
	e := events.LambdaFunctionURLRequest{
		RawPath: "/api/me",
		Headers: map[string]string{"authorization": "Bearer dev:alice:a@x", "cloudfront-viewer-address": "203.0.113.7:1"},
		RequestContext: events.LambdaFunctionURLRequestContext{
			HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{Method: "GET", SourceIP: "10.0.0.1"},
		},
	}
	resp, err := h(context.Background(), e)
	if err != nil || resp.StatusCode != 200 || resp.Headers["Content-Type"] != "application/json" {
		t.Fatalf("%v %+v", err, resp)
	}
	var me map[string]any
	json.Unmarshal([]byte(resp.Body), &me)
	if me["sub"] != "alice" {
		t.Fatalf("%s", resp.Body)
	}

	e.RawPath, e.Headers = "/api/runs", nil
	e.RequestContext.HTTP.Method = "POST"
	e.Body, e.IsBase64Encoded = "e30=", true // {}
	resp, _ = h(context.Background(), e)
	if resp.StatusCode != 401 {
		t.Fatalf("%+v", resp)
	}
	r, _ := lambdaurl.Request(context.Background(), events.LambdaFunctionURLRequest{
		RawPath: "/x", RawQueryString: "a=1", Body: "hi",
		RequestContext: events.LambdaFunctionURLRequestContext{HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{Method: "PUT", SourceIP: "10.0.0.2"}},
	})
	body, _ := io.ReadAll(r.Body)
	if r.URL.RawQuery != "a=1" || string(body) != "hi" || ClientIP(r) != "10.0.0.2" {
		t.Fatalf("%+v", r)
	}
}

// Behind CloudFront, OAC replaces Authorization with its SigV4 signature: the
// bearer travels in X-Authorization, which wins over Authorization.
func TestXAuthorization(t *testing.T) {
	h := unitServer()
	for _, c := range []struct {
		xauth, authz string
		status       int
	}{
		{"Bearer dev:u:u@x", "AWS4-HMAC-SHA256 Credential=AKIA/20260101/us-east-1/lambda/aws4_request, SignedHeaders=host, Signature=abc", 200},
		{"Bearer dev:u:u@x", "", 200},
		{"", "Bearer dev:u:u@x", 200},
		{"", "AWS4-HMAC-SHA256 Credential=x", 401},
		{"Bearer nope", "Bearer dev:u:u@x", 401},
	} {
		r := httptest.NewRequest("GET", "/api/me", nil)
		if c.xauth != "" {
			r.Header.Set("X-Authorization", c.xauth)
		}
		if c.authz != "" {
			r.Header.Set("Authorization", c.authz)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.status {
			t.Errorf("X-Authorization %q, Authorization %q: %d, want %d", c.xauth, c.authz, w.Code, c.status)
		}
	}
}

// A token without email still signs in; /api/me answers email null.
func TestMeWithoutEmail(t *testing.T) {
	h := unitServer()
	status, body := call(h, "GET", "/api/me", "dev:u:", "")
	if status != 200 {
		t.Fatalf("status %d %v", status, body)
	}
	if v, ok := body["email"]; !ok || v != nil {
		t.Errorf("email %v (present %v), want null", v, ok)
	}
	_, body = call(h, "GET", "/api/me", "dev:u:u@x", "")
	if body["email"] != "u@x" {
		t.Errorf("email %v", body["email"])
	}
}
