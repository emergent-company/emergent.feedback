package memory

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"
)

// SafeHTTPClient returns a client for user-supplied Memory base URLs. Unless
// allowPrivate is set, the dialer refuses loopback, RFC1918/ULA, link-local,
// CGNAT and other non-public addresses. The check happens after DNS resolution
// and the connection is made to the resolved IP, so a hostname cannot be used
// to bypass the guard (DNS rebinding).
func SafeHTTPClient(allowPrivate bool) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		// Never let an environment proxy turn the guard into a no-op.
		Proxy:                 nil,
		DialContext:           guardedDialContext(dialer, allowPrivate),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &http.Client{Timeout: 15 * time.Second, Transport: transport}
}

func guardedDialContext(dialer *net.Dialer, allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, ipa := range ips {
			if !allowPrivate && blockedIP(ipa.IP) {
				lastErr = fmt.Errorf("memory: refusing non-public address %s", ipa.IP)
				continue
			}
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ipa.IP.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		if lastErr == nil {
			lastErr = fmt.Errorf("memory: no addresses for %s", host)
		}
		return nil, lastErr
	}
}

// blockedIP reports whether ip is outside the public internet or otherwise
// unsuitable as an SSRF target. IPv4-mapped IPv6 addresses are reduced first.
func blockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 0: // "this network"
			return true
		case v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127: // CGNAT 100.64/10
			return true
		case v4[0] == 127: // loopback
			return true
		case v4[0] == 169 && v4[1] == 254: // link-local
			return true
		case v4[0] >= 224: // multicast + reserved 240/4
			return true
		}
		return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
}
