package memory

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBlockedIP(t *testing.T) {
	tests := []struct {
		ip      string
		blocked bool
	}{
		{"127.0.0.1", true},
		{"10.1.2.3", true},
		{"172.16.0.1", true},
		{"192.168.1.1", true},
		{"169.254.169.254", true},
		{"100.64.0.1", true},
		{"0.0.0.0", true},
		{"224.0.0.1", true},
		{"::1", true},
		{"fc00::1", true},
		{"fe80::1", true},
		{"8.8.8.8", false},
		{"203.0.114.1", false},
		{"2606:4700:4700::1111", false},
	}
	for _, tt := range tests {
		if got := blockedIP(net.ParseIP(tt.ip)); got != tt.blocked {
			t.Errorf("blockedIP(%s) = %v, want %v", tt.ip, got, tt.blocked)
		}
	}
}

func TestSafeHTTPClientGuardsLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()

	if _, err := SafeHTTPClient(false).Get(srv.URL); err == nil {
		t.Fatal("guarded client reached a loopback address")
	}

	res, err := SafeHTTPClient(true).Get(srv.URL)
	if err != nil {
		t.Fatalf("allow-private client: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	if string(body) != "ok" {
		t.Fatalf("body = %q", body)
	}
}
