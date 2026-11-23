package prices

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
)

type pldCase struct {
	Name string  `json:"name"`
	CSV  string  `json:"csv"`
	Hex  string  `json:"hex"`
	Code *string `json:"code"`
	Line *int    `json:"line"`
}

func TestCheckPLDSharedVerdicts(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/examples/pld-upload-verdicts.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Messages map[string]string `json:"messages"`
		Cases    []pldCase         `json:"cases"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Cases) == 0 {
		t.Fatal("no shared cases")
	}
	if len(corpus.Messages) != len(pldMessages) {
		t.Fatalf("%d messages here, %d shared", len(pldMessages), len(corpus.Messages))
	}
	for code, message := range corpus.Messages {
		if pldMessages[code] != message {
			t.Errorf("message %s: %q, shared %q", code, pldMessages[code], message)
		}
	}
	for _, c := range corpus.Cases {
		t.Run(c.Name, func(t *testing.T) {
			data := []byte(c.CSV)
			if c.Hex != "" {
				if data, err = hex.DecodeString(c.Hex); err != nil {
					t.Fatal(err)
				}
			}
			got := CheckPLD(data)
			if c.Code == nil {
				if got != nil {
					t.Fatalf("rejected: %v", got)
				}
				return
			}
			var pe *PLDError
			if !errors.As(got, &pe) {
				t.Fatalf("got %v, want %s", got, *c.Code)
			}
			if pe.Code != *c.Code || pe.Line != *c.Line {
				t.Fatalf("got %s at line %d, want %s at line %d", pe.Code, pe.Line, *c.Code, *c.Line)
			}
			if want := fmt.Sprintf("line %d: %s", *c.Line, corpus.Messages[*c.Code]); pe.Error() != want {
				t.Fatalf("message %q, want %q", pe.Error(), want)
			}
		})
	}
}

func TestCheckPLDAcceptsTheCanonicalFile(t *testing.T) {
	raw, err := os.ReadFile("../../../../data/raw/pld_hourly.csv")
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckPLD(raw); err != nil {
		t.Fatal(err)
	}
}
