// Package lambdaurl serves an http.Handler as a Lambda Function URL, so the
// same routes run in AWS and as a plain server locally.
package lambdaurl

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/aws/aws-lambda-go/events"
)

// Handler adapts h to the Function URL event (payload format 2.0).
func Handler(h http.Handler) func(context.Context, events.LambdaFunctionURLRequest) (events.LambdaFunctionURLResponse, error) {
	return func(ctx context.Context, e events.LambdaFunctionURLRequest) (events.LambdaFunctionURLResponse, error) {
		r, err := Request(ctx, e)
		if err != nil {
			return events.LambdaFunctionURLResponse{}, err
		}
		w := &recorder{header: http.Header{}}
		h.ServeHTTP(w, r)
		return w.response(), nil
	}
}

// Request builds the http.Request an event describes.
func Request(ctx context.Context, e events.LambdaFunctionURLRequest) (*http.Request, error) {
	body := []byte(e.Body)
	if e.IsBase64Encoded {
		var err error
		if body, err = base64.StdEncoding.DecodeString(e.Body); err != nil {
			return nil, err
		}
	}
	u := &url.URL{Path: e.RawPath, RawQuery: e.RawQueryString}
	r, err := http.NewRequestWithContext(ctx, e.RequestContext.HTTP.Method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range e.Headers {
		r.Header.Set(k, v)
	}
	if len(e.Cookies) > 0 {
		r.Header.Set("Cookie", strings.Join(e.Cookies, "; "))
	}
	r.Host = e.Headers["host"]
	r.RemoteAddr = e.RequestContext.HTTP.SourceIP + ":0"
	r.ContentLength = int64(len(body))
	return r, nil
}

type recorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *recorder) Header() http.Header { return w.header }

func (w *recorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(b)
}

func (w *recorder) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *recorder) response() events.LambdaFunctionURLResponse {
	out := events.LambdaFunctionURLResponse{StatusCode: w.status, Headers: map[string]string{}}
	if out.StatusCode == 0 {
		out.StatusCode = http.StatusOK
	}
	for k, v := range w.header {
		if http.CanonicalHeaderKey(k) == "Set-Cookie" {
			out.Cookies = append(out.Cookies, v...)
			continue
		}
		out.Headers[k] = strings.Join(v, ", ")
	}
	if utf8.Valid(w.body.Bytes()) {
		out.Body = w.body.String()
	} else {
		out.Body = base64.StdEncoding.EncodeToString(w.body.Bytes())
		out.IsBase64Encoded = true
	}
	return out
}
