// Isolated transport fixture, never shipped. It maps synthetic tailnet origins
// only to explicitly listed loopback fixture servers; it performs no VPN login.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type fixtureRequest struct {
	ID       int             `json:"id"`
	Method   string          `json:"method"`
	Endpoint string          `json:"endpoint"`
	Body     json.RawMessage `json:"body"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	if !scanner.Scan() {
		return
	}
	var config struct {
		StateDir string `json:"stateDir"`
	}
	if json.Unmarshal(scanner.Bytes(), &config) != nil {
		return
	}
	var workers sync.WaitGroup
	defer workers.Wait()
	var output sync.Mutex
	emit := func(reply map[string]any) {
		encoded, _ := json.Marshal(reply)
		output.Lock()
		defer output.Unlock()
		fmt.Println(string(encoded))
	}
	// Match the shipping helper: an outgoing peer request must never block
	// status reads needed to authenticate a simultaneous incoming exchange.
	peerSlots := make(chan struct{}, 2)
	for scanner.Scan() {
		var request fixtureRequest
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			continue
		}
		if request.Method == "peer" {
			select {
			case peerSlots <- struct{}{}:
			default:
				emit(map[string]any{"id": request.ID, "error": "Fixture peer transport is busy"})
				continue
			}
		}
		workers.Add(1)
		go func(request fixtureRequest) {
			defer workers.Done()
			if request.Method == "peer" {
				defer func() { <-peerSlots }()
			}
			var settings struct {
				Origin string            `json:"origin"`
				Peers  map[string]string `json:"peers"`
			}
			data, err := os.ReadFile(filepath.Join(config.StateDir, "fixture.json"))
			if err != nil || json.Unmarshal(data, &settings) != nil {
				return
			}
			var result any
			var failure string
			switch request.Method {
			case "status":
				result = map[string]any{"state": "Running", "serving": true, "origin": settings.Origin, "peerTransport": true, "peers": []any{}}
			case "login", "logout":
				result = map[string]any{}
			case "peer":
				target, parseErr := url.Parse(settings.Peers[request.Endpoint])
				if parseErr != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.Port() == "" || target.RawQuery != "" {
					failure = "Fixture destination is not an owned loopback server"
					break
				}
				req, _ := http.NewRequest(http.MethodPost, target.String()+"/api/collaboration/peer", bytes.NewReader(request.Body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-Forwarded-For", strings.TrimPrefix(settings.Origin, "http://"))
				req.Header.Set("X-Forwarded-Proto", "http")
				response, requestErr := (&http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
				if requestErr != nil {
					failure = "Fixture peer is offline"
					break
				}
				body, readErr := io.ReadAll(io.LimitReader(response.Body, 768*1024+1))
				response.Body.Close()
				if readErr != nil || len(body) > 768*1024 || !json.Valid(body) {
					failure = "Invalid fixture response"
					break
				}
				result = map[string]any{"status": response.StatusCode, "body": json.RawMessage(body)}
			default:
				failure = "Unknown fixture request"
			}
			reply := map[string]any{"id": request.ID, "result": result}
			if failure != "" {
				reply["error"] = failure
			}
			emit(reply)
		}(request)
	}
}
