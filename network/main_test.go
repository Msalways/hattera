package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestPeerTransportIsRestrictedToTailnetApplicationEndpoint(t *testing.T) {
	for _, origin := range []string{"http://127.0.0.1", "http://169.254.169.254", "https://100.64.0.1", "http://100.128.0.1", "http://100.64.0.1:8799", "http://user:secret@100.64.0.1", "http://100.64.0.1/api/config", "http://100.64.0.1?key=secret", "http://example.com"} {
		called := false
		_, err := peerExchange(context.Background(), func(context.Context, string, string) (net.Conn, error) { called = true; return nil, nil }, origin, json.RawMessage(`{}`))
		if err == nil || called {
			t.Fatalf("accepted peer origin %q", origin)
		}
	}
}

func TestPeerTransportNeverFollowsRedirectsOrChangesApplicationPath(t *testing.T) {
	count := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		count++
		if req.Method != http.MethodPost || req.URL.Path != "/api/collaboration/peer" {
			t.Errorf("unexpected peer request %s %s", req.Method, req.URL.Path)
		}
		w.Header().Set("Location", "http://127.0.0.1/private")
		w.WriteHeader(http.StatusFound)
		_, _ = w.Write([]byte(`{"redirected":false}`))
	}))
	defer upstream.Close()
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "100.64.0.1:80" {
			t.Errorf("unexpected peer target %q", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	}
	result, err := peerExchange(context.Background(), dial, "http://100.64.0.1", json.RawMessage(`{"signed":"opaque"}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if count != 1 || !strings.Contains(string(encoded), `"status":302`) {
		t.Fatalf("followed a redirect: %s", encoded)
	}
}

func TestPeerTransportBoundsResponses(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write([]byte(`{"data":"` + strings.Repeat("x", 768*1024) + `"}`))
	}))
	defer upstream.Close()
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	}
	if _, err := peerExchange(context.Background(), dial, "http://100.64.0.1", json.RawMessage(`{}`)); err == nil {
		t.Fatal("accepted an oversized peer response")
	}
}

func TestProxyCannotTurnRemotePeerIntoLoopbackOwner(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if got := req.Header.Get("X-Forwarded-For"); got != "100.90.1.2" {
			t.Errorf("forwarded remote identity: %q", got)
		}
		if req.Header.Get("X-Forwarded-Proto") != "http" {
			t.Error("missing remote ingress marker")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	request := httptest.NewRequest("GET", "http://127.0.0.1:8799/api/bots", nil)
	request.RemoteAddr = "100.90.1.2:32100"
	request.Header.Set("X-Forwarded-For", "127.0.0.1")
	recorder := httptest.NewRecorder()
	networkProxy(target).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("proxy status %d", recorder.Code)
	}
}

func TestRejectsNonlocalUpstreamBeforeStartingNetwork(t *testing.T) {
	for _, upstream := range []string{"https://evil.example", "http://127.0.0.1", "http://user:secret@127.0.0.1:8799", "http://127.0.0.1:8799/other"} {
		var out bytes.Buffer
		input := `{"stateDir":"unused","hostname":"fixture","upstream":"` + upstream + `"}` + "\n"
		if run(strings.NewReader(input), &out) == nil {
			t.Fatalf("accepted %q", upstream)
		}
		if out.Len() != 0 {
			t.Fatal("unexpected network response")
		}
	}
}
