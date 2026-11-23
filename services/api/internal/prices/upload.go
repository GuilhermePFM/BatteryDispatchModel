// Package prices handles uploaded price files: the presigned POST the browser
// uploads through, and a structural check of the file before a run is queued.
//
// The check mirrors battery_plan.data_io.check_pld_csv, with messages in the
// same words, so a bad file is turned away at submission rather than as a
// failed run. The solver still reads the file in full and remains the judge.
package prices

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

// MaxBytes is the largest upload accepted, the presigned POST's content-length-range.
const MaxBytes = 5 << 20

var (
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
	uploadKey = regexp.MustCompile(`^uploads/([0-9a-f]{64})\.csv$`)
)

// Key is where an upload with this content hash is stored.
func Key(sum string) string { return "uploads/" + sum + ".csv" }

// KeySHA256 is the content hash a prices_key names, or "" if it is not an upload key.
func KeySHA256(key string) string {
	m := uploadKey.FindStringSubmatch(key)
	if m == nil {
		return ""
	}
	return m[1]
}

// ValidSHA256 reports whether s is a lowercase hex sha256.
func ValidSHA256(s string) bool { return sha256Hex.MatchString(s) }

// PresignedPost is what the browser needs to POST a file straight to S3.
type PresignedPost struct {
	URL       string            `json:"url"`
	Fields    map[string]string `json:"fields"`
	PricesKey string            `json:"prices_key"`
}

// Poster signs S3 POST policies (SigV4). The SDK presigns GET and PUT but not
// POST, and only a POST policy can bound the size with content-length-range.
type Poster struct {
	Credentials aws.CredentialsProvider
	Region      string
	Bucket      string
	// Endpoint, when set (LocalStack), gives a path-style URL on that host.
	Endpoint string
	Expires  time.Duration
	Now      func() time.Time
}

// Presign returns a POST that may write only Key(sum), and at most MaxBytes.
func (p Poster) Presign(ctx context.Context, sum string) (PresignedPost, error) {
	creds, err := p.Credentials.Retrieve(ctx)
	if err != nil {
		return PresignedPost{}, err
	}
	now := time.Now().UTC()
	if p.Now != nil {
		now = p.Now().UTC()
	}
	expires := p.Expires
	if expires == 0 {
		expires = 15 * time.Minute
	}
	day := now.Format("20060102")
	amzDate := now.Format("20060102T150405Z")
	credential := strings.Join([]string{creds.AccessKeyID, day, p.Region, "s3", "aws4_request"}, "/")
	key := Key(sum)

	fields := map[string]string{
		"key":              key,
		"x-amz-algorithm":  "AWS4-HMAC-SHA256",
		"x-amz-credential": credential,
		"x-amz-date":       amzDate,
	}
	if creds.SessionToken != "" {
		fields["x-amz-security-token"] = creds.SessionToken
	}
	conditions := []any{
		map[string]string{"bucket": p.Bucket},
		[]any{"content-length-range", 1, MaxBytes},
	}
	for _, name := range []string{"key", "x-amz-algorithm", "x-amz-credential", "x-amz-date", "x-amz-security-token"} {
		if v, ok := fields[name]; ok {
			conditions = append(conditions, map[string]string{name: v})
		}
	}
	policy, err := json.Marshal(map[string]any{
		"expiration": now.Add(expires).Format("2006-01-02T15:04:05.000Z"),
		"conditions": conditions,
	})
	if err != nil {
		return PresignedPost{}, err
	}
	encoded := base64.StdEncoding.EncodeToString(policy)
	signingKey := []byte("AWS4" + creds.SecretAccessKey)
	for _, part := range []string{day, p.Region, "s3", "aws4_request"} {
		signingKey = hmacSHA256(signingKey, part)
	}
	fields["policy"] = encoded
	fields["x-amz-signature"] = hex.EncodeToString(hmacSHA256(signingKey, encoded))

	url := fmt.Sprintf("https://%s.s3.%s.amazonaws.com/", p.Bucket, p.Region)
	if p.Endpoint != "" {
		url = strings.TrimSuffix(p.Endpoint, "/") + "/" + p.Bucket
	}
	return PresignedPost{URL: url, Fields: fields, PricesKey: key}, nil
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}
