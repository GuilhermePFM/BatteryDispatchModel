# Build context: the repository root, as docker-compose.yml uses it; only
# services/api is sent (Dockerfile.dockerignore).
#   docker build -f services/api/Dockerfile --target local -t batteryplan-api .
#       the API on :8080; the DLQ poller is /dlq in the same image
#   docker build -f services/api/Dockerfile --target zips -o services/api/dist .
#       the Lambda zips, as `make zips` builds them without docker

FROM golang:1.27.4-alpine AS build
WORKDIR /src
COPY services/api/go.mod services/api/go.sum ./
RUN go mod download
COPY services/api/ .
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
 && go build -trimpath -ldflags="-s -w" -o /out/dlq ./cmd/dlq

# Lambda: provided.al2023 on arm64 runs an executable named bootstrap.
FROM build AS lambda
RUN apk add --no-cache zip
ENV GOOS=linux GOARCH=arm64
RUN for cmd in api dlq; do \
      mkdir -p /lambda/$cmd \
      && go build -tags lambda.norpc -trimpath -ldflags="-s -w" -o /lambda/$cmd/bootstrap ./cmd/$cmd \
      && (cd /lambda/$cmd && zip -q -X /lambda/$cmd.zip bootstrap); \
    done

FROM scratch AS zips
COPY --from=lambda /lambda/api.zip /lambda/dlq.zip /

FROM alpine:3.22 AS local
RUN apk add --no-cache ca-certificates
COPY --from=build /out/api /api
COPY --from=build /out/dlq /dlq
EXPOSE 8080
USER nobody
CMD ["/api"]
