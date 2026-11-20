package contracts

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const repoContracts = "../../../../contracts"

func readRepo(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(repoContracts, name))
	if os.IsNotExist(err) {
		t.Skipf("%s not found: not running inside the repository", name)
	}
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// The embedded schemas must be byte-for-byte the files in contracts/; run
// `go generate ./...` after editing them.
func TestSchemasMatchContracts(t *testing.T) {
	originals, _ := filepath.Glob(filepath.Join(repoContracts, "*.schema.json"))
	if len(originals) == 0 {
		t.Skip("contracts/ not found: not running inside the repository")
	}
	copies, err := SchemaFiles().ReadDir("schemas")
	if err != nil {
		t.Fatal(err)
	}
	if len(copies) != len(originals) {
		t.Fatalf("%d schemas embedded, %d in contracts/: run go generate ./...", len(copies), len(originals))
	}
	for _, path := range originals {
		name := filepath.Base(path)
		want, _ := os.ReadFile(path)
		got, err := SchemaFiles().ReadFile("schemas/" + name)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("schemas/%s differs from contracts/%s: run go generate ./...", name, name)
		}
	}
}

func TestParamsHashVectors(t *testing.T) {
	var file struct {
		Vectors []struct {
			Name         string         `json:"name"`
			Request      map[string]any `json:"request"`
			PricesSHA256 string         `json:"prices_sha256"`
			Canonical    string         `json:"canonical"`
			ParamsHash   string         `json:"params_hash"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(readRepo(t, "examples/params-hash.json"), &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Vectors) != 2 {
		t.Fatalf("want 2 vectors, got %d", len(file.Vectors))
	}
	for _, v := range file.Vectors {
		body := map[string]any{"prices_sha256": v.PricesSHA256, "request": withoutKey(v.Request)}
		canonical, err := CanonicalJSON(body)
		if err != nil {
			t.Fatal(err)
		}
		if string(canonical) != v.Canonical {
			t.Errorf("%s: canonical\n got %s\nwant %s", v.Name, canonical, v.Canonical)
		}
		got, err := ParamsHash(v.Request, v.PricesSHA256)
		if err != nil {
			t.Fatal(err)
		}
		if got != v.ParamsHash {
			t.Errorf("%s: hash %s, want %s", v.Name, got, v.ParamsHash)
		}
	}
}

func withoutKey(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		if k != "prices_key" {
			out[k] = v
		}
	}
	return out
}

func TestExamplesValidate(t *testing.T) {
	for name, schema := range map[string]*jsonschema.Schema{
		"examples/run-request.example.json": RunRequest,
		"examples/job-message.example.json": JobMessage,
		"examples/run-record.example.json":  RunRecord,
	} {
		if err := Validate(schema, readRepo(t, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

const example = `{"battery":{"max_charge_rate_mw":2,"max_discharge_rate_mw":2,"max_storage_volume_mwh":4,
"charging_loss_fraction":0.05,"discharging_loss_fraction":0.05,"lifetime_years":10,"lifetime_cycles":5000,
"degradation_pct_per_cycle":0.001,"capex_gbp":500000,"fixed_opex_gbp_per_year":5000},
"start":"2018-01-01","end":"2018-01-03"}`

// with replaces top-level fields of the example; a nil value removes one.
func with(t *testing.T, changes map[string]any) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(example), &m); err != nil {
		t.Fatal(err)
	}
	for k, v := range changes {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	raw, _ := json.Marshal(m)
	return raw
}

func TestParseRequest(t *testing.T) {
	battery := func(field string, value any) map[string]any {
		var m map[string]any
		json.Unmarshal([]byte(example), &m)
		b := m["battery"].(map[string]any)
		b[field] = value
		return b
	}
	cases := []struct {
		name string
		body []byte
		want string // substring of the error; "" means valid
	}{
		{"example", []byte(example), ""},
		{"upload outside the bundled years", with(t, map[string]any{"start": "2023-01-01", "end": "2023-12-31", "prices_key": "uploads/x.csv"}), ""},
		{"a full leap year", with(t, map[string]any{"start": "2020-01-01", "end": "2020-12-31"}), ""},
		{"not JSON", []byte("{"), "not valid JSON"},
		{"missing field", with(t, map[string]any{"end": nil}), "end"},
		{"unknown field", with(t, map[string]any{"search": "bisection"}), "search"},
		{"null optional", []byte(strings.Replace(example, `"start"`, `"cycle_budget":null,"start"`, 1)), "cycle_budget"},
		{"over maximum", with(t, map[string]any{"battery": battery("max_charge_rate_mw", 101)}), "battery.max_charge_rate_mw"},
		{"string number", with(t, map[string]any{"battery": battery("capex_gbp", "1")}), "battery.capex_gbp"},
		{"window scheme is fixed", with(t, map[string]any{"commit_days": 1}), "commit_days"},
		{"lookahead is fixed", with(t, map[string]any{"lookahead_days": 2}), "lookahead_days"},
		{"bad date", with(t, map[string]any{"start": "2018-02-30"}), "start"},
		{"end before start", with(t, map[string]any{"end": "2017-12-31"}), "before start"},
		{"over a year", with(t, map[string]any{"start": "2018-01-01", "end": "2019-01-02"}), "at most 365"},
		{"before bundled", with(t, map[string]any{"start": "2017-12-31"}), "bundled prices"},
		{"after bundled", with(t, map[string]any{"start": "2020-12-01", "end": "2021-01-01"}), "bundled prices"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseRequest(c.body)
			switch {
			case c.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case c.want != "" && err == nil:
				t.Fatalf("accepted, want error containing %q", c.want)
			case c.want != "" && !strings.Contains(err.Error(), c.want):
				t.Fatalf("error %q does not mention %q", err, c.want)
			}
		})
	}
}
