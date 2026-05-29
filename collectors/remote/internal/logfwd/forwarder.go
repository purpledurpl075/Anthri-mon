// Package logfwd forwards the collector's own zerolog output to the hub's
// collector-logs endpoint, so operators can view process logs in the UI.
package logfwd

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
	"github.com/rs/zerolog"
)

const (
	maxBuffer  = 500
	flushEvery = 15 * time.Second
)

// Forwarder implements io.Writer for zerolog and periodically flushes buffered
// log entries to the hub via POST /api/v1/collectors/collector-logs.
type Forwarder struct {
	hub zerolog.Logger // stderr-only logger — used for internal errors to avoid loops
	hc  *hub.Client
	mu  sync.Mutex
	buf []map[string]any
}

// New creates a Forwarder.  log must write only to stderr (not back through this
// Forwarder) to avoid infinite loops when logging flush failures.
func New(hubClient *hub.Client, log zerolog.Logger) *Forwarder {
	return &Forwarder{hc: hubClient, hub: log}
}

// Write implements io.Writer.  Each call from zerolog is exactly one JSON object
// followed by a newline.
func (f *Forwarder) Write(p []byte) (int, error) {
	line := bytes.TrimRight(p, "\n")
	if len(line) == 0 {
		return len(p), nil
	}

	var entry map[string]any
	if err := json.Unmarshal(line, &entry); err != nil {
		return len(p), nil
	}

	// zerolog uses "time"; hub table expects "ts"
	if ts, ok := entry["time"]; ok {
		entry["ts"] = ts
		delete(entry, "time")
	}

	f.mu.Lock()
	if len(f.buf) >= maxBuffer {
		f.buf = f.buf[1:] // drop oldest on overflow
	}
	f.buf = append(f.buf, entry)
	f.mu.Unlock()

	return len(p), nil
}

// Run starts the periodic flush loop, blocking until ctx is cancelled.
// On shutdown it performs one final flush to capture any buffered entries.
func (f *Forwarder) Run(ctx context.Context) {
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			f.flush(context.Background())
			return
		case <-ticker.C:
			f.flush(ctx)
		}
	}
}

func (f *Forwarder) flush(ctx context.Context) {
	f.mu.Lock()
	if len(f.buf) == 0 {
		f.mu.Unlock()
		return
	}
	batch := f.buf
	f.buf = nil
	f.mu.Unlock()

	if err := f.hc.PostLogs(ctx, batch); err != nil {
		f.hub.Warn().Err(err).Int("count", len(batch)).Msg("log forward flush failed")
	}
}
