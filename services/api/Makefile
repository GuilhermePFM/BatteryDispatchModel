## The Lambda zips: bootstrap for provided.al2023, arm64, no cgo.
GOFLAGS_BUILD := -tags lambda.norpc -trimpath -ldflags="-s -w"

.PHONY: zips test generate clean

zips: dist/api.zip dist/dlq.zip

dist/%.zip: $(shell find cmd internal -name '*.go' -o -name '*.json') go.mod go.sum
	@mkdir -p dist/$*
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build $(GOFLAGS_BUILD) -o dist/$*/bootstrap ./cmd/$*
	cd dist/$* && rm -f ../$*.zip && zip -q -X ../$*.zip bootstrap

generate:
	go generate ./...

test:
	go vet ./...
	go test ./...

clean:
	rm -rf dist
