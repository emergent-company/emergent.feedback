package handler

import (
	"errors"
	"net/http"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/labstack/echo/v4"
)

func TestEncryptDecryptToken(t *testing.T) {
	enc, err := encryptToken("hello", "fake-secret")
	if err != nil {
		t.Fatalf("encryptToken: %v", err)
	}
	got, err := decryptToken(enc, "fake-secret")
	if err != nil {
		t.Fatalf("decryptToken: %v", err)
	}
	if got != "hello" {
		t.Fatalf("decrypted = %q, want %q", got, "hello")
	}
}

func TestDecryptTokenGarbage(t *testing.T) {
	if _, err := decryptToken([]byte("garbage"), "fake-secret"); err == nil {
		t.Fatal("expected error decrypting garbage, got nil")
	}
}

func TestDecryptTokenWrongSecret(t *testing.T) {
	enc, err := encryptToken("hello", "secret-a")
	if err != nil {
		t.Fatalf("encryptToken: %v", err)
	}
	if _, err := decryptToken(enc, "secret-b"); err == nil {
		t.Fatal("expected error with wrong secret, got nil")
	}
}

func TestRepoListErrorMapsAuthTo401(t *testing.T) {
	err := repoListError(&github.APIError{Op: "list user repos", Status: http.StatusUnauthorized})
	var he *echo.HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("err = %v, want *echo.HTTPError", err)
	}
	if he.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", he.Code)
	}
}

func TestRepoListErrorKeepsUpstreamAs502(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusInternalServerError, http.StatusBadGateway} {
		err := repoListError(&github.APIError{Op: "list user repos", Status: status})
		var he *echo.HTTPError
		if !errors.As(err, &he) {
			t.Fatalf("status %d: err = %v, want *echo.HTTPError", status, err)
		}
		if he.Code != http.StatusBadGateway {
			t.Fatalf("status %d mapped to %d, want 502", status, he.Code)
		}
	}
}
