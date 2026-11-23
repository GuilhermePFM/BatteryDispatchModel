package contracts

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// BundledPricesSHA256 is the content hash of the bundled hourly PLD,
// battery_plan.contracts.BUNDLED_PLD_SHA256.
const BundledPricesSHA256 = "2431c61473ae39b0ed949364306974e6ee8b5b88d8d051d6bedb19a688c9b839"

// ContractVersion and ModelVersion are battery_plan.contracts.CONTRACT_VERSION
// and MODEL_VERSION; the v2 schemas pin both.
const (
	ContractVersion = 2
	ModelVersion    = "pld-hourly-1"
)

var (
	bundledFirst = time.Date(2025, 1, 20, 0, 0, 0, 0, time.UTC)
	bundledLast  = time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
)

// MinSpanDays and MaxSpanDays bound end - start. Any 365 consecutive days hold
// all twelve calendar months, which the balanced year needs; the ceiling keeps
// the worst case inside the solver Lambda's 600 s.
const (
	MinSpanDays = 364
	MaxSpanDays = 730
)

// Request is a run request that passed the schema and the cross-field rules.
type Request struct {
	Fields    map[string]any // the body as decoded, numbers as float64
	Start     time.Time
	End       time.Time
	PricesKey string // empty: the bundled prices
}

// InvalidError is a request the user has to fix; Message is written for them.
type InvalidError struct{ Message string }

func (e *InvalidError) Error() string { return e.Message }

// ParseRequest validates a POST /api/runs body against run-request and the
// rules of contracts/README.md that the API checks. The rule that the dates
// fall inside an uploaded file's span is the solver's.
func ParseRequest(body []byte) (*Request, error) {
	if err := Validate(RunRequest, body); err != nil {
		return nil, &InvalidError{err.Error()}
	}
	var fields map[string]any
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, &InvalidError{"the body is not valid JSON"}
	}
	start, err := time.Parse(time.DateOnly, fields["start"].(string))
	if err != nil {
		return nil, &InvalidError{"start: not a date"}
	}
	end, err := time.Parse(time.DateOnly, fields["end"].(string))
	if err != nil {
		return nil, &InvalidError{"end: not a date"}
	}
	if end.Before(start) {
		return nil, &InvalidError{"end must not be before start."}
	}
	span := end.Sub(start)
	if span < MinSpanDays*24*time.Hour {
		return nil, &InvalidError{fmt.Sprintf("A run covers at least %d days, so that every calendar month is in it; extend the dates.", MinSpanDays+1)}
	}
	if span > MaxSpanDays*24*time.Hour {
		return nil, &InvalidError{fmt.Sprintf("A run covers at most %d days after its start; shorten the dates.", MaxSpanDays)}
	}
	key, _ := fields["prices_key"].(string)
	if key == "" && (start.Before(bundledFirst) || end.After(bundledLast)) {
		return nil, &InvalidError{"The bundled prices run from 2025-01-20 to 2026-11-20; pick dates inside them or upload a price file."}
	}
	return &Request{Fields: fields, Start: start, End: end, PricesKey: key}, nil
}

// ParamsHash is the hash of contracts/README.md: sha256 of the canonical
// JSON of {"model_version": ..., "prices_sha256": ..., "request": ...},
// prices_key left out.
func ParamsHash(request map[string]any, pricesSHA256 string) (string, error) {
	canonical, err := CanonicalJSON(map[string]any{
		"model_version": ModelVersion,
		"prices_sha256": pricesSHA256,
		"request":       withoutPricesKey(request),
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func withoutPricesKey(request map[string]any) map[string]any {
	body := make(map[string]any, len(request))
	for k, v := range request {
		if k != "prices_key" {
			body[k] = v
		}
	}
	return body
}

// CanonicalJSON writes the JCS form (RFC 8785) of the values a request holds.
// encoding/json already sorts map keys and prints float64 as ECMAScript does;
// HTML escaping is the one default to turn off. Key order is by bytes rather
// than UTF-16 units, which agree for the ASCII keys the schema allows.
func CanonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
