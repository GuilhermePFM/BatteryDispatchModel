// Package runs is the HTTP API of contracts/platform.md: the routes, run
// submission with its cache and quota, run status, and the refund that
// whoever fails a run applies.
package runs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/GuilhermePFM/BatteryCase/services/api/internal/auth"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/prices"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/quota"
	"github.com/GuilhermePFM/BatteryCase/services/api/internal/store"
)

// Queue is the part of *sqs.Client the API uses.
type Queue interface {
	SendMessage(context.Context, *sqs.SendMessageInput, ...func(*sqs.Options)) (*sqs.SendMessageOutput, error)
}

// Objects is the part of *s3.Client the API uses.
type Objects interface {
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

// Presigner is the part of *s3.PresignClient the API uses.
type Presigner interface {
	PresignGetObject(context.Context, *s3.GetObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
}

// Server holds the API's dependencies; Handler serves it.
type Server struct {
	DB        store.DB
	Queue     Queue
	Objects   Objects
	Presigner Presigner
	Poster    prices.Poster
	Auth      *auth.Verifier

	Table    string
	QueueURL string
	Bucket   string
	Limits   quota.Limits
	Rate     quota.Rate

	// BundledPrices allows a run with no upload; the solver image must carry them.
	BundledPrices bool

	Now func() time.Time
	Log *slog.Logger
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// Handler routes /api.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.Handle("GET /api/me", s.limited(s.authed(s.me)))
	mux.Handle("POST /api/uploads", s.limited(s.authed(s.upload)))
	mux.Handle("POST /api/runs", s.limited(s.authed(s.submit)))
	mux.Handle("GET /api/runs/{run_id}", s.limited(http.HandlerFunc(s.get)))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "There is nothing here.")
	})
	return mux
}

type userKey struct{}

func userOf(r *http.Request) auth.User { return r.Context().Value(userKey{}).(auth.User) }

// bearerHeader is X-Authorization if present, else Authorization. Behind
// CloudFront, OAC overwrites Authorization with its own SigV4 signature for the
// Function URL, so the SPA sends its bearer in X-Authorization; locally either
// works.
func bearerHeader(r *http.Request) string {
	if h := r.Header.Get("X-Authorization"); h != "" {
		return h
	}
	return r.Header.Get("Authorization")
}

func (s *Server) authed(next func(http.ResponseWriter, *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.Auth.Verify(bearerHeader(r))
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in again: your session is missing or has expired.")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey{}, user)))
	})
}

// limited applies the per-IP rate limit. A failure to count lets the request
// through: the limit protects the site, it should not take it down.
func (s *Server) limited(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := s.now()
		ok, err := s.Rate.Allow(r.Context(), ClientIP(r), now)
		if err != nil {
			s.log().Error("rate limit", "err", err)
		} else if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(quota.UntilNextMinute(now)))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests from your address; wait a minute and try again.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP is the viewer's address: CloudFront's CloudFront-Viewer-Address
// (<ip>:<port>, trusted because the Function URL only accepts CloudFront),
// else the connection's remote address.
func ClientIP(r *http.Request) string {
	if v := r.Header.Get("CloudFront-Viewer-Address"); v != "" {
		if i := strings.LastIndexByte(v, ':'); i > 0 {
			return strings.Trim(v[:i], "[]")
		}
		return v
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": apiError{code, message}})
}

func (s *Server) internal(w http.ResponseWriter, what string, err error) {
	s.log().Error(what, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on our side; try again.")
}

// readBody reads a request body of at most limit bytes.
func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return nil, errors.New("the body is too large")
	}
	return body, err
}
