// Package config reads the environment variables of contracts/platform.md.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	TableName  string
	QueueURL   string
	DLQURL     string // local dlq poller only
	DataBucket string

	AuthMode        string // "cognito" or "dev"
	CognitoIssuer   string
	CognitoClientID string
	// CognitoClientIDParameter names an SSM parameter holding the client id,
	// read once at cold start when CognitoClientID is empty (Terraform sets
	// it this way to break a dependency cycle).
	CognitoClientIDParameter string

	DailyUserLimit   int
	DailyGlobalLimit int
	IPRatePerMinute  int

	// EndpointURL is AWS_ENDPOINT_URL, set only against LocalStack; the SDK
	// reads it itself, the API uses it for path-style S3 URLs and the POST
	// URL. The browser must reach it too: docker-compose.yml uses
	// localhost.localstack.cloud, which resolves on both sides.
	EndpointURL string
}

// FromEnv reads the configuration both Lambdas share.
func FromEnv() (Config, error) {
	c := Config{
		TableName:                os.Getenv("TABLE_NAME"),
		QueueURL:                 os.Getenv("QUEUE_URL"),
		DLQURL:                   os.Getenv("DLQ_URL"),
		DataBucket:               os.Getenv("DATA_BUCKET"),
		AuthMode:                 os.Getenv("AUTH_MODE"),
		CognitoIssuer:            os.Getenv("COGNITO_ISSUER"),
		CognitoClientID:          os.Getenv("COGNITO_CLIENT_ID"),
		CognitoClientIDParameter: os.Getenv("COGNITO_CLIENT_ID_PARAMETER"),
		EndpointURL:              os.Getenv("AWS_ENDPOINT_URL"),
	}
	var err error
	if c.DailyUserLimit, err = intEnv("DAILY_USER_LIMIT", 3); err != nil {
		return c, err
	}
	if c.DailyGlobalLimit, err = intEnv("DAILY_GLOBAL_LIMIT", 60); err != nil {
		return c, err
	}
	if c.IPRatePerMinute, err = intEnv("IP_RATE_PER_MINUTE", 60); err != nil {
		return c, err
	}
	if c.TableName == "" {
		return c, fmt.Errorf("TABLE_NAME is not set")
	}
	return c, nil
}

// CheckAPI refuses a configuration the API cannot serve with. There is no
// default AUTH_MODE: dev tokens are accepted only when asked for by name.
func (c Config) CheckAPI() error {
	if c.QueueURL == "" || c.DataBucket == "" {
		return fmt.Errorf("QUEUE_URL and DATA_BUCKET must be set")
	}
	switch c.AuthMode {
	case "dev":
		return nil
	case "cognito":
		if c.CognitoIssuer == "" || (c.CognitoClientID == "" && c.CognitoClientIDParameter == "") {
			return fmt.Errorf("AUTH_MODE=cognito needs COGNITO_ISSUER and COGNITO_CLIENT_ID or COGNITO_CLIENT_ID_PARAMETER")
		}
		return nil
	default:
		return fmt.Errorf("AUTH_MODE must be cognito or dev, got %q", c.AuthMode)
	}
}

func intEnv(name string, fallback int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer, got %q", name, v)
	}
	return n, nil
}
