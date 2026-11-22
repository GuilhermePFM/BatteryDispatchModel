// Package auth turns a bearer header (X-Authorization or Authorization) into a
// user.
//
// In AWS the header carries a Cognito ID token, checked against the pool's
// JWKS (fetched once, refreshed in the background): signature, iss, aud,
// token_use = id, and exp. With AUTH_MODE=dev, and only then, it may instead
// carry "dev:<sub>:<email>", which the frontend's dev build sends.
package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// User is who made a request. Email is empty when the token has none.
type User struct {
	Sub   string
	Email string
}

// ErrUnauthorized covers a missing, expired or invalid token.
var ErrUnauthorized = errors.New("unauthorized")

// Verifier checks bearer tokens.
type Verifier struct {
	dev      bool
	keys     jwt.Keyfunc
	issuer   string
	clientID string
}

// NewDev accepts only "dev:<sub>:<email>" tokens.
func NewDev() *Verifier { return &Verifier{dev: true} }

// NewCognito verifies ID tokens of the pool at issuer, for the app client
// clientID. The JWKS is read from issuer + "/.well-known/jwks.json".
func NewCognito(ctx context.Context, issuer, clientID string) (*Verifier, error) {
	issuer = strings.TrimSuffix(issuer, "/")
	k, err := keyfunc.NewDefaultCtx(ctx, []string{issuer + "/.well-known/jwks.json"})
	if err != nil {
		return nil, fmt.Errorf("jwks: %w", err)
	}
	return &Verifier{keys: k.Keyfunc, issuer: issuer, clientID: clientID}, nil
}

type idClaims struct {
	jwt.RegisteredClaims
	TokenUse string `json:"token_use"`
	Email    string `json:"email"`
}

// Verify reads the bearer header's value ("Bearer <token>").
func (v *Verifier) Verify(header string) (User, error) {
	token, ok := strings.CutPrefix(header, "Bearer ")
	token = strings.TrimSpace(token)
	if !ok || token == "" {
		return User{}, ErrUnauthorized
	}
	if v.dev {
		parts := strings.SplitN(token, ":", 3)
		if len(parts) != 3 || parts[0] != "dev" || parts[1] == "" {
			return User{}, ErrUnauthorized
		}
		return User{Sub: parts[1], Email: parts[2]}, nil
	}

	var claims idClaims
	_, err := jwt.ParseWithClaims(token, &claims, v.keys,
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.clientID),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil || claims.TokenUse != "id" || claims.Subject == "" {
		return User{}, ErrUnauthorized
	}
	return User{Sub: claims.Subject, Email: claims.Email}, nil
}
