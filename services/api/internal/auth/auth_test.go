package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const clientID = "spa-client"

// pool serves a JWKS holding one RSA key, as Cognito does.
func pool(t *testing.T) (issuer string, key *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pool/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(jwks)
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/pool", key
}

func sign(t *testing.T, key *rsa.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = "k1"
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestCognito(t *testing.T) {
	issuer, key := pool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	v, err := NewCognito(ctx, issuer, clientID)
	if err != nil {
		t.Fatal(err)
	}
	other, _ := rsa.GenerateKey(rand.Reader, 2048)

	good := func() jwt.MapClaims {
		return jwt.MapClaims{
			"sub": "user-1", "email": "a@example.com", "iss": issuer, "aud": clientID,
			"token_use": "id", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
		}
	}
	changed := func(k string, val any) jwt.MapClaims {
		c := good()
		if val == nil {
			delete(c, k)
		} else {
			c[k] = val
		}
		return c
	}

	user, err := v.Verify("Bearer " + sign(t, key, good()))
	if err != nil || user != (User{"user-1", "a@example.com"}) {
		t.Fatalf("valid token: %v %+v", err, user)
	}

	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, good())
	hs.Header["kid"] = "k1"
	hsToken, _ := hs.SignedString([]byte("secret"))

	bad := map[string]string{
		"expired":        sign(t, key, changed("exp", time.Now().Add(-time.Hour).Unix())),
		"no exp":         sign(t, key, changed("exp", nil)),
		"wrong aud":      sign(t, key, changed("aud", "another-client")),
		"wrong iss":      sign(t, key, changed("iss", "https://cognito-idp.eu-west-2.amazonaws.com/other")),
		"access token":   sign(t, key, changed("token_use", "access")),
		"no token_use":   sign(t, key, changed("token_use", nil)),
		"other key":      sign(t, other, good()),
		"hs256":          hsToken,
		"dev token":      "dev:user-1:a@example.com",
		"garbage":        "abc.def.ghi",
		"empty":          "",
		"no bearer word": "",
	}
	for name, token := range bad {
		header := "Bearer " + token
		if name == "no bearer word" {
			header = sign(t, key, good())
		}
		if _, err := v.Verify(header); err != ErrUnauthorized {
			t.Errorf("%s: accepted (err=%v)", name, err)
		}
	}
}

func TestDev(t *testing.T) {
	v := NewDev()
	user, err := v.Verify("Bearer dev:alice:alice@example.com")
	if err != nil || user != (User{"alice", "alice@example.com"}) {
		t.Fatalf("dev token: %v %+v", err, user)
	}
	for _, h := range []string{"", "Bearer ", "Bearer dev:", "Bearer dev::x@y", "Bearer prod:alice:a@b", "dev:alice:a@b", "Bearer eyJ.a.b"} {
		if _, err := v.Verify(h); err != ErrUnauthorized {
			t.Errorf("%q accepted", h)
		}
	}
}
