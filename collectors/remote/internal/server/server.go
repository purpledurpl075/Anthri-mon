// Package server exposes a tiny HTTP server on the collector's WireGuard IP
// that accepts hub-initiated commands (/refresh, /health, /update).
package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

const (
	defaultPort     = 9090
	version         = "0.1.0"
	shutdownTimeout = 5 * time.Second
)

// Server is the mini HTTP control plane exposed to the hub.
type Server struct {
	wgIP      string
	port      int
	authToken string // sha256hex(apiKey) — expected Bearer token on mutating endpoints
	onRefresh func()
	onUpdate  func() error
	log       zerolog.Logger
}

// NewServer creates a Server.
//
//   - wgIP      is the WireGuard-assigned IP (e.g. "10.100.0.2").
//   - port      is the listen port; 0 means use defaultPort (9090).
//   - apiKey    is the collector's plaintext API key; its SHA-256 hex is used
//               as the expected Bearer token on mutating endpoints so the hub
//               can authenticate without storing the plaintext key.
//   - onRefresh is called when POST /refresh is received.
//   - onUpdate  is called when POST /update is received; nil disables the endpoint.
func NewServer(wgIP string, port int, apiKey string, onRefresh func(), onUpdate func() error, log zerolog.Logger) *Server {
	if port == 0 {
		port = defaultPort
	}
	h := sha256.Sum256([]byte(apiKey))
	authToken := fmt.Sprintf("%x", h)
	return &Server{
		wgIP:      wgIP,
		port:      port,
		authToken: authToken,
		onRefresh: onRefresh,
		onUpdate:  onUpdate,
		log:       log.With().Str("component", "control_server").Logger(),
	}
}

// checkAuth validates the Authorization: Bearer header against the expected
// token using a constant-time comparison to prevent timing side-channels.
// Returns false and writes a 401 response if auth fails.
func (s *Server) checkAuth(w http.ResponseWriter, r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	token, ok := strings.CutPrefix(auth, "Bearer ")
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.authToken)) != 1 {
		s.log.Warn().
			Str("remote_addr", r.RemoteAddr).
			Str("path", r.URL.Path).
			Msg("control server: unauthorized request")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

// Run starts the HTTP server and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/refresh", s.handleRefresh)
	mux.HandleFunc("/update", s.handleUpdate)

	addr := net.JoinHostPort(s.wgIP, fmt.Sprintf("%d", s.port))
	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	s.log.Info().Str("addr", addr).Msg("control server starting")

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("control server: %w", err)
	case <-ctx.Done():
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		s.log.Warn().Err(err).Msg("control server shutdown error")
	}
	s.log.Info().Msg("control server stopped")
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"version": version,
		"wg_ip":   s.wgIP,
	})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	if s.onRefresh != nil {
		go s.onRefresh()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status": "refreshing",
	})
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	if s.onUpdate == nil {
		http.Error(w, "update not configured", http.StatusNotImplemented)
		return
	}
	s.log.Info().Msg("self-update requested by hub")
	// Kick off asynchronously so the HTTP response is sent before the process restarts.
	go func() {
		if err := s.onUpdate(); err != nil {
			s.log.Error().Err(err).Msg("self-update failed")
		}
	}()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status": "updating",
	})
}
