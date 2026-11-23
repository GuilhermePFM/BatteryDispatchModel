package prices

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/credentials"
)

func TestKeys(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	if KeySHA256(Key(sum)) != sum || !ValidSHA256(sum) {
		t.Fatal("key round trip")
	}
	for _, k := range []string{"uploads/" + sum, "uploads/x.csv", "plans/" + sum + ".csv", "uploads/" + strings.ToUpper(sum) + ".csv"} {
		if KeySHA256(k) != "" {
			t.Errorf("%s accepted as an upload key", k)
		}
	}
}

func TestPresign(t *testing.T) {
	p := Poster{
		Credentials: credentials.NewStaticCredentialsProvider("AKID", "SECRET", "TOKEN"),
		Region:      "eu-west-2",
		Bucket:      "data",
		Now:         func() time.Time { return time.Date(2026, 11, 18, 9, 30, 0, 0, time.UTC) },
	}
	sum := strings.Repeat("0", 64)
	post, err := p.Presign(context.Background(), sum)
	if err != nil {
		t.Fatal(err)
	}
	if post.URL != "https://data.s3.eu-west-2.amazonaws.com/" || post.PricesKey != "uploads/"+sum+".csv" {
		t.Fatalf("%+v", post)
	}
	if post.Fields["x-amz-credential"] != "AKID/20261118/eu-west-2/s3/aws4_request" || post.Fields["x-amz-security-token"] != "TOKEN" {
		t.Fatalf("%+v", post.Fields)
	}
	raw, _ := base64.StdEncoding.DecodeString(post.Fields["policy"])
	var policy struct {
		Expiration string `json:"expiration"`
		Conditions []any  `json:"conditions"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		t.Fatal(err)
	}
	if policy.Expiration != "2026-11-18T09:45:00.000Z" {
		t.Errorf("expiration %s", policy.Expiration)
	}
	if !strings.Contains(string(raw), `["content-length-range",1,5242880]`) || !strings.Contains(string(raw), `{"key":"uploads/`+sum+`.csv"}`) {
		t.Errorf("policy %s", raw)
	}
	if len(post.Fields["x-amz-signature"]) != 64 {
		t.Errorf("signature %q", post.Fields["x-amz-signature"])
	}

	p.Endpoint = "http://localhost:4566/"
	post, _ = p.Presign(context.Background(), sum)
	if post.URL != "http://localhost:4566/data" {
		t.Errorf("path-style url %s", post.URL)
	}
}
