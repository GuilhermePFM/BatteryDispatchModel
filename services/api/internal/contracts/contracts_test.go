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

// The embedded schemas must be byte-for-byte the files in contracts/v2; run
// `go generate ./...` after editing them.
func TestSchemasMatchContracts(t *testing.T) {
	originals, _ := filepath.Glob(filepath.Join(repoContracts, "v2", "*.schema.json"))
	if len(originals) == 0 {
		t.Skip("contracts/ not found: not running inside the repository")
	}
	const dir = "schemas/v2"
	entries, err := SchemaFiles().ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(originals) {
		t.Fatalf("%d schemas embedded in %s, %d in contracts: run go generate ./...", len(entries), dir, len(originals))
	}
	for _, path := range originals {
		name := filepath.Base(path)
		want, _ := os.ReadFile(path)
		got, err := SchemaFiles().ReadFile(dir + "/" + name)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s/%s differs from contracts: run go generate ./...", dir, name)
		}
	}
}

type hashVectors struct {
	ModelVersion string `json:"model_version"`
	Vectors      []struct {
		Name         string         `json:"name"`
		Request      map[string]any `json:"request"`
		PricesSHA256 string         `json:"prices_sha256"`
		Canonical    string         `json:"canonical"`
		ParamsHash   string         `json:"params_hash"`
	} `json:"vectors"`
}

func TestParamsHashVectors(t *testing.T) {
	var file hashVectors
	if err := json.Unmarshal(readRepo(t, "examples/v2/params-hash.json"), &file); err != nil {
		t.Fatal(err)
	}
	if file.ModelVersion != ModelVersion {
		t.Fatalf("vectors are for %s, the API is %s", file.ModelVersion, ModelVersion)
	}
	if len(file.Vectors) != 2 {
		t.Fatalf("want 2 vectors, got %d", len(file.Vectors))
	}
	for _, v := range file.Vectors {
		body := map[string]any{"model_version": ModelVersion, "prices_sha256": v.PricesSHA256, "request": withoutKey(v.Request)}
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

func TestConstantsMatchTheSchemas(t *testing.T) {
	var job struct {
		Properties struct {
			Version      struct{ Const int }    `json:"version"`
			ModelVersion struct{ Const string } `json:"model_version"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(readRepo(t, "v2/job-message.schema.json"), &job); err != nil {
		t.Fatal(err)
	}
	if job.Properties.Version.Const != ContractVersion || job.Properties.ModelVersion.Const != ModelVersion {
		t.Fatalf("schema pins %+v, the API has %d and %s", job.Properties, ContractVersion, ModelVersion)
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
		"examples/v2/run-request.example.json": RunRequest,
		"examples/v2/job-message.example.json": JobMessage,
		"examples/v2/run-record.example.json":  RunRecord,
		"examples/v2/result.example.json":      Result,
	} {
		if err := Validate(schema, readRepo(t, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A message of the retired contract, as a queue could still hold one.
const v1Message = `{"version":1,"run_id":"01JD3X7Q8RZK5V2N4M6P9T0WYA",
"params_hash":"42b8449a308cbe544c9edefe454778d553e6dc1ea369a60b7a5dfabf51a1c774",
"user_sub":"3f1c9a2e-7b4d-4e8a-9c61-2d5f0b8e7a43",
"request":{"battery":{"max_charge_rate_mw":2,"max_discharge_rate_mw":2,"max_storage_volume_mwh":4,
"charging_loss_fraction":0.05,"discharging_loss_fraction":0.05,"lifetime_years":10,
"lifetime_cycles":5000,"degradation_pct_per_cycle":0.001},
"start":"2025-01-20","end":"2025-01-22"},"prices":{"source":"bundled"}}`

// A v1 message is not a v2 one, so the contract itself refuses it.
func TestV1MessageIsNotV2(t *testing.T) {
	if err := Validate(JobMessage, []byte(v1Message)); err == nil {
		t.Fatal("the v1 job message validated against v2")
	}
}

const example = `{"battery":{"power_mw":30,"volume_mwh":130,"max_charge_mw":24,"max_discharge_mw":32.5,
"charge_efficiency":0.92,"discharge_efficiency":0.92,"degradation_pct_per_cycle":0.001},
"start":"2025-02-01","end":"2026-01-31"}`

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
		{"upload outside the bundled dates", with(t, map[string]any{"start": "2023-01-01", "end": "2023-12-31", "prices_key": "uploads/" + strings.Repeat("a", 64) + ".csv"}), ""},
		{"a full leap year", with(t, map[string]any{"start": "2024-01-01", "end": "2024-12-31", "prices_key": "uploads/" + strings.Repeat("a", 64) + ".csv"}), ""},
		{"the shortest span", with(t, map[string]any{"start": "2025-02-01", "end": "2026-01-31"}), ""},
		{"the longest span", with(t, map[string]any{"start": "2023-01-01", "end": "2024-12-31", "prices_key": "uploads/" + strings.Repeat("a", 64) + ".csv"}), ""},
		{"the whole bundled file", with(t, map[string]any{"start": "2025-01-20", "end": "2026-11-20"}), ""},
		{"not JSON", []byte("{"), "not valid JSON"},
		{"missing field", with(t, map[string]any{"end": nil}), "end"},
		{"unknown field", with(t, map[string]any{"search": "exact"}), "search"},
		{"financial input", with(t, map[string]any{"capex_brl": 1000}), "capex_brl"},
		{"null optional", []byte(strings.Replace(example, `"start"`, `"cycle_budget":null,"start"`, 1)), "cycle_budget"},
		{"over maximum", with(t, map[string]any{"battery": battery("power_mw", 2001)}), "battery.power_mw"},
		{"string number", with(t, map[string]any{"battery": battery("volume_mwh", "1")}), "battery.volume_mwh"},
		{"window scheme is fixed", with(t, map[string]any{"commit_days": 1}), "commit_days"},
		{"lookahead is fixed", with(t, map[string]any{"lookahead_days": 2}), "lookahead_days"},
		{"bad date", with(t, map[string]any{"start": "2025-02-30"}), "start"},
		{"end before start", with(t, map[string]any{"end": "2025-01-31"}), "before start"},
		{"under a year", with(t, map[string]any{"end": "2026-01-30"}), "at least 365"},
		{"over two years", with(t, map[string]any{"start": "2023-01-01", "end": "2025-01-01", "prices_key": "uploads/" + strings.Repeat("a", 64) + ".csv"}), "at most 730"},
		{"before bundled", with(t, map[string]any{"start": "2025-01-19", "end": "2026-01-31"}), "bundled prices"},
		{"after bundled", with(t, map[string]any{"start": "2025-11-21", "end": "2026-11-21"}), "bundled prices"},
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
