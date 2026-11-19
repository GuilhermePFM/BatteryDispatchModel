// Package contracts holds the API's side of contracts/: the JSON Schemas, the
// cross-field rules of contracts/README.md, and the params hash.
//
// Go's embed cannot reach ../../../../contracts, so the schemas are copied
// into schemas/ by go generate; TestSchemasMatchContracts fails when the
// copies drift from the originals.
package contracts

//go:generate sh -c "cp ../../../../contracts/*.schema.json schemas/"

import (
	"bytes"
	"embed"
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed schemas/*.schema.json
var schemaFiles embed.FS

// SchemaFiles is the embedded copy of contracts/*.schema.json.
func SchemaFiles() embed.FS { return schemaFiles }

const idPrefix = "https://batteryplan.invalid/contracts/"

// Schemas are compiled once: all four files go into the compiler's registry
// under their $id, so the relative $refs resolve without fetching anything.
var (
	RunRequest = mustCompile("run-request.schema.json")
	JobMessage = mustCompile("job-message.schema.json")
	RunRecord  = mustCompile("run-record.schema.json")
)

func mustCompile(name string) *jsonschema.Schema {
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	entries, err := schemaFiles.ReadDir("schemas")
	if err != nil {
		panic(err)
	}
	for _, e := range entries {
		raw, err := schemaFiles.ReadFile("schemas/" + e.Name())
		if err != nil {
			panic(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			panic(fmt.Errorf("%s: %w", e.Name(), err))
		}
		if err := c.AddResource(idPrefix+e.Name(), doc); err != nil {
			panic(err)
		}
	}
	return c.MustCompile(idPrefix + name)
}

// Validate checks a JSON document against a schema and returns an error
// written for the user, naming at most a few offending fields.
func Validate(schema *jsonschema.Schema, raw []byte) error {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("the body is not valid JSON")
	}
	err = schema.Validate(doc)
	if err == nil {
		return nil
	}
	ve, ok := err.(*jsonschema.ValidationError)
	if !ok {
		return err
	}
	var msgs []string
	var walk func(u jsonschema.OutputUnit)
	walk = func(u jsonschema.OutputUnit) {
		if len(u.Errors) == 0 && u.Error != nil {
			field := strings.ReplaceAll(strings.TrimPrefix(u.InstanceLocation, "/"), "/", ".")
			if field == "" {
				field = "body"
			}
			msgs = append(msgs, field+": "+u.Error.String())
		}
		for _, c := range u.Errors {
			walk(c)
		}
	}
	walk(*ve.BasicOutput())
	if len(msgs) == 0 {
		return fmt.Errorf("the body does not match the schema")
	}
	if len(msgs) > 5 {
		msgs = append(msgs[:5], fmt.Sprintf("and %d more", len(msgs)-5))
	}
	return fmt.Errorf("%s", strings.Join(msgs, "; "))
}
