package prices

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/credentials"
)

// day builds a valid file of n days from 2018-01-01, one row per half hour.
func days(n int) []string {
	lines := []string{"timestamp,market_1,market_2"}
	start := time.Date(2018, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < n*48; i++ {
		at := start.Add(time.Duration(i) * halfHour)
		lines = append(lines, fmt.Sprintf("%s,%d.5,%d", at.Format("2006-01-02T15:04:05"), 40+i%7, 50+i/2%5))
	}
	return lines
}

func file(lines []string) []byte { return []byte(strings.Join(lines, "\n") + "\n") }

func TestCheckTemplate(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/examples/prices-template.csv")
	if os.IsNotExist(err) {
		t.Skip("not inside the repository")
	}
	if err := Check(raw); err != nil {
		t.Fatalf("the template is rejected: %v", err)
	}
}

func TestCheck(t *testing.T) {
	edit := func(f func([]string) []string) []byte { return file(f(days(2))) }
	set := func(i int, line string) func([]string) []string {
		return func(l []string) []string { l[i] = line; return l }
	}
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"valid", file(days(2)), ""},
		{"BOM, CRLF, upper-case header, spaces", []byte("\xef\xbb\xbfTimestamp, Market_1, Market_2\r\n" +
			strings.Join(days(1)[1:], "\r\n")), ""},
		{"columns in another order", []byte("market_2,timestamp,market_1\n50,2018-01-01T00:00:00,1\n50,2018-01-01T00:30:00,2\n"), ""},
		{"offsets converted to UTC", []byte("timestamp,market_1,market_2\n2018-01-01T01:00:00+01:00,1,5\n2018-01-01T00:30:00Z,2,5\n"), ""},
		{"space separator, minutes only", []byte("timestamp,market_1,market_2\n2018-01-01 00:00,1,5\n2018-01-01 00:30,2,5\n"), ""},
		{"basic ISO 8601", []byte("timestamp,market_1,market_2\n20180101T000000,1,5\n20180101T003000,2,5\n"), ""},
		{"a year and a day", file(days(367)), ""},
		{"too long", file(days(368)), "more than 367 days"},
		{"empty", []byte(""), "empty"},
		{"header only", []byte("timestamp,market_1,market_2\n"), "no prices"},
		{"missing column", []byte("timestamp,market_1\n2018-01-01T00:00:00,1\n"), "Missing column(s): market_2"},
		{"not UTF-8", []byte("timestamp,market_1,market_2\n\xff,1,2\n"), "UTF-8"},
		{"bad timestamp", edit(set(3, "yesterday,1,2")), `line 4 ("yesterday")`},
		{"bad price", edit(set(3, "2018-01-01T01:00:00,abc,50")), "market_1 must be a number"},
		{"empty price", edit(set(3, "2018-01-01T01:00:00,1,")), "market_2 must be a number"},
		{"nan price", edit(set(3, "2018-01-01T01:00:00,nan,50")), "market_1 must be a number"},
		{"off the half hour", edit(set(3, "2018-01-01T01:15:00,1,50")), "on the hour or the half hour"},
		{"duplicate", edit(set(3, "2018-01-01T00:30:00,1,50")), "duplicate timestamp"},
		{"out of order", edit(func(l []string) []string { l[3], l[4] = l[4], l[3]; return l }), "time order"},
		{"gap", edit(func(l []string) []string { return append(l[:5], l[6:]...) }), "no gaps; the file jumps from 2018-01-01T01:30:00 to 2018-01-01T02:30:00"},
		{"starts on the half hour", edit(func(l []string) []string { return append(l[:1], l[2:]...) }), "whole hours"},
		{"ends on the hour", edit(func(l []string) []string { return l[:len(l)-1] }), "whole hours"},
		{"market_2 uneven", edit(set(2, "2018-01-01T00:30:00,1,99")), "hour(s) starting 2018-01-01 00:00"},
		{"too many fields", edit(set(3, "2018-01-01T01:00:00,1,50,7")), "not readable as CSV"},
		{"too large", make([]byte, MaxBytes+1), "larger than 5 MB"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Check(c.data)
			switch {
			case c.want == "" && err != nil:
				t.Fatalf("rejected: %v", err)
			case c.want != "" && err == nil:
				t.Fatalf("accepted, want %q", c.want)
			case c.want != "" && !strings.Contains(err.Error(), c.want):
				t.Fatalf("error %q does not contain %q", err, c.want)
			}
		})
	}
}

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
