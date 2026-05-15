// Package server exposes a tiny HTTP server on the collector's WireGuard IP
// that accepts hub-initiated commands (/refresh, /health).
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/rs/zerolog"
)

const (
	defaultPort    = 9090
	version        = "0.1.0"
	shutdownTimeout = 5 * time.Second
)

// Server is the mini HTTP control plane exposed to the hub.
type Server struct {
	wgIP      string
	port      int
	onRefresh func()
	log       zerolog.Logger
}

// NewServer creates a Server.
//
//   - wgIP is the WireGuard-assigned IP (e.g. "10.100.0.2").
//   - port is the listen port; 0 means use defaultPort (9090).
//   - onRefresh is called when POST /refresh is received.
func NewServer(wgIP string, port int, onRefresh func(), log zerolog.Logger) *Server {
	if port == 0 {
		port = defaultPort
	}
	return &Server{
		wgIP:      wgIP,
		port:      port,
		onRefresh: onRefresh,
		log:       log.With().Str("component", "control_server").Logger(),
	}
}

// Run starts the HTTP server and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/refresh", s.handleRefresh)

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
	if s.onRefresh != nil {
		go s.onRefresh()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status": "refreshing",
	})
}
