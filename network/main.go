// Hattera's app-specific tailnet node. Control is private stdin/stdout JSON;
// only the existing authenticated web app is forwarded onto the tailnet.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tailscale.com/tsnet"
)

type config struct {
	StateDir string `json:"stateDir"`
	Hostname string `json:"hostname"`
	Upstream string `json:"upstream"`
}
type request struct {
	ID       int             `json:"id"`
	Method   string          `json:"method"`
	Endpoint string          `json:"endpoint"`
	Body     json.RawMessage `json:"body"`
}
type response struct {
	ID     int    `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("hattera-network 2 tailscale-v1.104.2")
		return
	}
	if err := run(os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}

func run(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	if !scanner.Scan() {
		return fmt.Errorf("configuration missing")
	}
	var cfg config
	if json.Unmarshal(scanner.Bytes(), &cfg) != nil {
		return fmt.Errorf("invalid configuration")
	}
	upstream, err := url.Parse(cfg.Upstream)
	if err != nil || upstream.Scheme != "http" || upstream.Hostname() != "127.0.0.1" || upstream.Port() == "" || upstream.User != nil || upstream.Path != "" {
		return fmt.Errorf("upstream must be a local server")
	}
	if cfg.StateDir == "" || cfg.Hostname == "" {
		return fmt.Errorf("state and hostname required")
	}
	var lock sync.Mutex
	encoder := json.NewEncoder(output)
	emit := func(r response) { lock.Lock(); defer lock.Unlock(); _ = encoder.Encode(r) }
	srv := &tsnet.Server{Dir: cfg.StateDir, Hostname: cfg.Hostname, Logf: func(string, ...any) {}}
	defer srv.Close()
	if err := srv.Start(); err != nil {
		return err
	}
	local, err := srv.LocalClient()
	if err != nil {
		return err
	}
	proxy := networkProxy(upstream)
	var serving atomic.Bool
	go func() {
		listener, err := srv.Listen("tcp", ":80")
		if err != nil {
			return
		}
		serving.Store(true)
		defer serving.Store(false)
		web := &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
		_ = web.Serve(listener)
	}()
	peerSlots := make(chan struct{}, 2)
	var peerRequests sync.WaitGroup
	defer peerRequests.Wait()
	for scanner.Scan() {
		var req request
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			continue
		}
		if req.Method == "peer" {
			select {
			case peerSlots <- struct{}{}:
				peerRequests.Add(1)
				go func(req request) {
					defer peerRequests.Done()
					defer func() { <-peerSlots }()
					ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
					defer cancel()
					result, err := peerExchange(ctx, srv.Dial, req.Endpoint, req.Body)
					if err != nil {
						emit(response{ID: req.ID, Error: "Could not exchange shared group data."})
					} else {
						emit(response{ID: req.ID, Result: result})
					}
				}(req)
			default:
				emit(response{ID: req.ID, Error: "Shared group transport is busy. Retry later."})
			}
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		switch req.Method {
		case "status":
			status, err := local.Status(ctx)
			if err != nil {
				emit(response{ID: req.ID, Error: "Could not read private network status."})
				break
			}
			peers := []map[string]any{}
			for _, peer := range status.Peer {
				peers = append(peers, map[string]any{"id": string(peer.ID), "name": strings.TrimSuffix(peer.DNSName, "."), "online": peer.Online, "addresses": peer.TailscaleIPs})
			}
			origin := ""
			if status.Self != nil && len(status.Self.TailscaleIPs) > 0 {
				ip := status.Self.TailscaleIPs[0]
				if ip.Is4() {
					origin = "http://" + ip.String()
				} else {
					origin = "http://[" + ip.String() + "]"
				}
			}
			emit(response{ID: req.ID, Result: map[string]any{"state": status.BackendState, "serving": serving.Load(), "authorizationUrl": status.AuthURL, "origin": origin, "peers": peers, "peerTransport": true}})
		case "login":
			if err := local.StartLoginInteractive(ctx); err != nil {
				emit(response{ID: req.ID, Error: "Could not start Tailscale sign-in."})
			} else {
				emit(response{ID: req.ID, Result: map[string]bool{"started": true}})
			}
		case "logout":
			if err := local.Logout(ctx); err != nil {
				emit(response{ID: req.ID, Error: "Could not disconnect this Hattera network identity."})
			} else {
				emit(response{ID: req.ID, Result: map[string]bool{"disconnected": true}})
			}
		default:
			emit(response{ID: req.ID, Error: "Unsupported network action."})
		}
		cancel()
	}
	return scanner.Err()
}

// The helper is not a general HTTP proxy: it can POST only to a Hattera peer
// endpoint on a literal tailnet address, through this app's userspace network.
func peerExchange(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error), endpoint string, body json.RawMessage) (any, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Port() != "" && u.Port() != "80") {
		return nil, fmt.Errorf("invalid peer origin")
	}
	ip, err := netip.ParseAddr(u.Hostname())
	if err != nil || !(netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)) {
		return nil, fmt.Errorf("peer must be a literal tailnet address")
	}
	if len(body) == 0 || len(body) > 768*1024 || !json.Valid(body) {
		return nil, fmt.Errorf("invalid peer payload")
	}
	u.Path = "/api/collaboration/peer"
	transport := &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dial(ctx, network, net.JoinHostPort(ip.String(), "80"))
	}, DisableKeepAlives: true, MaxResponseHeaderBytes: 16 * 1024}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 768*1024+1))
	if err != nil || len(data) > 768*1024 || !json.Valid(data) {
		return nil, fmt.Errorf("invalid peer response")
	}
	return struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	}{res.StatusCode, data}, nil
}

func networkProxy(upstream *url.URL) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(p *httputil.ProxyRequest) {
			p.SetURL(upstream)
			p.Out.Host = p.In.Host
			// Always mark ingress as remote, including requests with forged localhost Host.
			p.SetXForwarded()
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Hattera is restarting. Try again shortly.", http.StatusServiceUnavailable)
		},
	}
}
