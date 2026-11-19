package config

import "testing"

func TestCheckAPI(t *testing.T) {
	t.Setenv("TABLE_NAME", "batteryplan")
	t.Setenv("QUEUE_URL", "q")
	t.Setenv("DATA_BUCKET", "b")
	for mode, ok := range map[string]bool{"": false, "Dev": false, "dev": true, "cognito": false} {
		t.Setenv("AUTH_MODE", mode)
		c, err := FromEnv()
		if err != nil {
			t.Fatal(err)
		}
		if err := c.CheckAPI(); (err == nil) != ok {
			t.Errorf("AUTH_MODE=%q: %v", mode, err)
		}
	}
	t.Setenv("COGNITO_ISSUER", "https://cognito-idp.eu-west-2.amazonaws.com/pool")
	t.Setenv("COGNITO_CLIENT_ID", "client")
	t.Setenv("AUTH_MODE", "cognito")
	c, _ := FromEnv()
	if err := c.CheckAPI(); err != nil {
		t.Error(err)
	}
	if c.DailyUserLimit != 3 || c.DailyGlobalLimit != 60 || c.IPRatePerMinute != 60 {
		t.Errorf("defaults %+v", c)
	}
	t.Setenv("DAILY_USER_LIMIT", "x")
	if _, err := FromEnv(); err == nil {
		t.Error("bad limit accepted")
	}
}

func TestCognitoClientIDParameter(t *testing.T) {
	t.Setenv("TABLE_NAME", "batteryplan")
	t.Setenv("QUEUE_URL", "q")
	t.Setenv("DATA_BUCKET", "b")
	t.Setenv("AUTH_MODE", "cognito")
	t.Setenv("COGNITO_ISSUER", "https://cognito-idp.us-east-1.amazonaws.com/pool")
	t.Setenv("COGNITO_CLIENT_ID", "")
	t.Setenv("COGNITO_CLIENT_ID_PARAMETER", "")
	c, _ := FromEnv()
	if err := c.CheckAPI(); err == nil {
		t.Error("cognito without a client id accepted")
	}
	t.Setenv("COGNITO_CLIENT_ID_PARAMETER", "/batteryplan/cognito-client-id")
	c, _ = FromEnv()
	if err := c.CheckAPI(); err != nil || c.CognitoClientIDParameter != "/batteryplan/cognito-client-id" {
		t.Errorf("parameter: %v %+v", err, c)
	}
}
