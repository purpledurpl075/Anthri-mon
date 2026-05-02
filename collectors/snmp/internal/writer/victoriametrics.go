package writer

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/poller"
	"github.com/rs/zerolog"
)

// VMWriter buffers Prometheus-format metrics and flushes them to VictoriaMetrics
// using the /api/v1/import/prometheus endpoint.
//
// Wire format per line:
//
//	metric_name{label="value",...} numeric_value unix_timestamp_ms
type VMWriter struct {
	baseURL       string
	flushInterval time.Duration
	batchSize     int
	client        *http.Client
	log           zerolog.Logger

	mu  sync.Mutex
	buf []string
}

// NewVMWriter creates a writer that flushes to the given VictoriaMetrics base URL.
func NewVMWriter(baseURL string, flushInterval time.Duration, batchSize int, log zerolog.Logger) *VMWriter {
	return &VMWriter{
		baseURL:       strings.TrimRight(baseURL, "/"),
		flushInterval: flushInterval,
		batchSize:     batchSize,
		client:        &http.Client{Timeout: 10 * time.Second},
		log:           log.With().Str("component", "vm_writer").Logger(),
		buf:           make([]string, 0, batchSize),
	}
}

// Run starts the background flush loop. Blocks until ctx is cancelled.
func (w *VMWriter) Run(ctx context.Context) {
	ticker := time.NewTicker(w.flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			w.flush(context.Background()) // drain remaining metrics on shutdown
			return
		case <-ticker.C:
			w.flush(ctx)
		}
	}
}

// Handle implements poller.ResultHandler. Encodes poll results as Prometheus
// text lines and buffers them for the next flush.
func (w *VMWriter) Handle(_ context.Context, result *poller.PollResult) error {
	deviceID := result.DeviceID.String()

	w.mu.Lock()

	if len(result.Interfaces) > 0 {
		ts := result.Interfaces[0].PollTime.UnixMilli()
		for _, iface := range result.Interfaces {
			vendor := ""
			if result.SysInfo != nil {
				vendor = result.SysInfo.DBVendorType
			}
			labels := fmt.Sprintf(
				`device_id="%s",if_index="%d",if_name="%s",vendor="%s"`,
				deviceID, iface.IfIndex, escapeLabelValue(ifName(iface)), vendor,
			)
			w.appendf(`anthrimon_if_in_octets_total{%s} %d %d`, labels, iface.InOctets, ts)
			w.appendf(`anthrimon_if_out_octets_total{%s} %d %d`, labels, iface.OutOctets, ts)
			w.appendf(`anthrimon_if_in_errors_total{%s} %d %d`, labels, iface.InErrors, ts)
			w.appendf(`anthrimon_if_out_errors_total{%s} %d %d`, labels, iface.OutErrors, ts)
			w.appendf(`anthrimon_if_in_discards_total{%s} %d %d`, labels, iface.InDiscards, ts)
			w.appendf(`anthrimon_if_out_discards_total{%s} %d %d`, labels, iface.OutDiscards, ts)
			w.appendf(`anthrimon_if_speed_bps{%s} %d %d`, labels, iface.SpeedBPS, ts)
			w.appendf(`anthrimon_if_oper_status{%s} %d %d`, labels, boolInt(iface.OperStatus == "up"), ts)
		}
	}

	if result.Health != nil {
		h := result.Health
		ts := h.PollTime.UnixMilli()
		baseLbls := fmt.Sprintf(`device_id="%s"`, deviceID)

		for _, cpu := range h.CPUSamples {
			cpuLbls := fmt.Sprintf(`%s,cpu_index="%d"`, baseLbls, cpu.CPUIndex)
			w.appendf(`anthrimon_device_cpu_util_pct{%s} %.2f %d`, cpuLbls, cpu.LoadPct, ts)
		}

		for _, mem := range h.MemSamples {
			memLbls := fmt.Sprintf(`%s,mem_type="%s"`, baseLbls, mem.Type)
			w.appendf(`anthrimon_device_mem_total_bytes{%s} %d %d`, memLbls, mem.TotalBytes, ts)
			w.appendf(`anthrimon_device_mem_used_bytes{%s} %d %d`, memLbls, mem.UsedBytes, ts)
		}

		for _, temp := range h.TempSamples {
			tempLbls := fmt.Sprintf(`%s,sensor="%s"`, baseLbls, escapeLabelValue(temp.SensorName))
			w.appendf(`anthrimon_device_temp_celsius{%s} %.1f %d`, tempLbls, temp.Celsius, ts)
		}

		w.appendf(`anthrimon_device_uptime_seconds{%s} %d %d`, baseLbls, h.UptimeSecs, ts)
	}

	// Drain the buffer under the lock so no other goroutine can append while
	// we're deciding to flush, then send outside the lock so we don't block
	// concurrent Handle calls during the HTTP round-trip.
	var toFlush []string
	if len(w.buf) >= w.batchSize {
		toFlush = w.drain()
	}
	w.mu.Unlock()

	if len(toFlush) > 0 {
		if err := w.sendLines(context.Background(), toFlush); err != nil {
			w.log.Error().Err(err).Msg("eager flush to VictoriaMetrics failed")
		}
	}
	return nil
}

// flush drains the buffer and sends to VictoriaMetrics.
func (w *VMWriter) flush(ctx context.Context) {
	w.mu.Lock()
	lines := w.drain()
	w.mu.Unlock()

	if len(lines) == 0 {
		return
	}
	if err := w.sendLines(ctx, lines); err != nil {
		w.log.Error().Err(err).Int("lines", len(lines)).Msg("flush to VictoriaMetrics failed")
	} else {
		w.log.Debug().Int("lines", len(lines)).Msg("flushed metrics to VictoriaMetrics")
	}
}

func (w *VMWriter) sendLines(ctx context.Context, lines []string) error {
	body := strings.Join(lines, "\n") + "\n"
	url := w.baseURL + "/api/v1/import/prometheus"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBufferString(body))
	if err != nil {
		return fmt.Errorf("create VM request: %w", err)
	}
	req.Header.Set("Content-Type", "text/plain")

	resp, err := w.client.Do(req)
	if err != nil {
		return fmt.Errorf("send to VM: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("VM returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// drain moves all buffered lines out and returns them. Caller must hold mu.
func (w *VMWriter) drain() []string {
	if len(w.buf) == 0 {
		return nil
	}
	lines := w.buf
	w.buf = make([]string, 0, w.batchSize)
	return lines
}

func (w *VMWriter) appendf(format string, args ...interface{}) {
	w.buf = append(w.buf, fmt.Sprintf(format, args...))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func escapeLabelValue(s string) string {
	// Prometheus label values must not contain unescaped double-quotes or newlines.
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
