package collector

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

// SyslogCollector listens for RFC 3164 syslog messages on UDP and TCP, parses
// them, and forwards them to the hub in JSON batches.
type SyslogCollector struct {
	hub         *hub.Client
	cfg         config.SyslogConfig
	fwdCfg      config.ForwardConfig
	devicesByIP map[string]string // mgmt_ip → device_id
	log         zerolog.Logger

	mu  sync.Mutex
	buf []map[string]any
}

// NewSyslogCollector creates a SyslogCollector.
func NewSyslogCollector(
	hubClient *hub.Client,
	cfg config.SyslogConfig,
	fwdCfg config.ForwardConfig,
	devicesByIP map[string]string,
	log zerolog.Logger,
) *SyslogCollector {
	return &SyslogCollector{
		hub:         hubClient,
		cfg:         cfg,
		fwdCfg:      fwdCfg,
		devicesByIP: devicesByIP,
		log:         log.With().Str("component", "syslog_collector").Logger(),
	}
}

// UpdateDevices replaces the IP→device_id map.
func (c *SyslogCollector) UpdateDevices(devicesByIP map[string]string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devicesByIP = devicesByIP
}

// Run starts UDP and TCP listeners and the flush loop.
// It blocks until ctx is cancelled.
func (c *SyslogCollector) Run(ctx context.Context) {
	go c.listenUDP(ctx)
	go c.listenTCP(ctx)
	c.flushLoop(ctx)
}

// ─── UDP listener ─────────────────────────────────────────────────────────────

func (c *SyslogCollector) listenUDP(ctx context.Context) {
	conn, err := net.ListenPacket("udp", c.cfg.UDPAddr)
	if err != nil {
		c.log.Error().Err(err).Str("addr", c.cfg.UDPAddr).Msg("udp listen failed")
		return
	}
	defer conn.Close()
	c.log.Info().Str("addr", c.cfg.UDPAddr).Msg("syslog udp listening")

	buf := make([]byte, 65535)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, src, err := conn.ReadFrom(buf)
		if err != nil {
			continue
		}
		srcIP := ""
		if ua, ok := src.(*net.UDPAddr); ok {
			srcIP = ua.IP.String()
		}
		c.ingest(string(buf[:n]), srcIP)
	}
}

// ─── TCP listener ─────────────────────────────────────────────────────────────

func (c *SyslogCollector) listenTCP(ctx context.Context) {
	ln, err := net.Listen("tcp", c.cfg.TCPAddr)
	if err != nil {
		c.log.Error().Err(err).Str("addr", c.cfg.TCPAddr).Msg("tcp listen failed")
		return
	}
	defer ln.Close()
	c.log.Info().Str("addr", c.cfg.TCPAddr).Msg("syslog tcp listening")

	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				continue
			}
		}
		go c.handleTCPConn(ctx, conn)
	}
}

func (c *SyslogCollector) handleTCPConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	srcIP := ""
	if ta, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
		srcIP = ta.IP.String()
	}

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		c.ingest(scanner.Text(), srcIP)
	}
}

// ─── Ingest + parse ───────────────────────────────────────────────────────────

func (c *SyslogCollector) ingest(raw, srcIP string) {
	record := parseRFC3164(raw, srcIP)

	c.mu.Lock()
	deviceID := c.devicesByIP[srcIP]
	record["device_id"] = deviceID
	record["device_ip"] = srcIP
	c.buf = append(c.buf, record)
	overflow := len(c.buf) >= c.fwdCfg.BatchSize
	c.mu.Unlock()

	if overflow {
		c.flush(context.Background())
	}
}

// parseRFC3164 parses a syslog message in RFC 3164 format:
//
//	<PRI>TIMESTAMP HOSTNAME PROGRAM[PID]: MESSAGE
//
// It is deliberately lenient — fields missing from the message are left as
// zero values.
func parseRFC3164(raw, srcIP string) map[string]any {
	record := map[string]any{
		"facility":  0,
		"severity":  0,
		"ts":        time.Now().UTC().Format(time.RFC3339),
		"hostname":  srcIP,
		"program":   "",
		"pid":       "",
		"message":   raw,
		"raw":       raw,
	}

	s := raw

	// Parse priority: <PRI>
	facility, severity, rest, ok := parsePriority(s)
	if ok {
		record["facility"] = facility
		record["severity"] = severity
		s = rest
	}

	// Parse timestamp (RFC 3164 style: "Jan  2 15:04:05" or ISO8601).
	ts, rest2, ok2 := parseTimestamp(s)
	if ok2 {
		record["ts"] = ts
		s = rest2
	}

	// Parse HOSTNAME PROGRAM[PID]: MESSAGE
	parts := strings.SplitN(s, " ", 3)
	if len(parts) >= 1 {
		record["hostname"] = strings.TrimSpace(parts[0])
	}
	if len(parts) >= 2 {
		prog, pid := splitProgPID(parts[1])
		record["program"] = prog
		record["pid"] = pid
	}
	if len(parts) >= 3 {
		msg := strings.TrimPrefix(parts[2], ": ")
		record["message"] = strings.TrimSpace(msg)
	}

	return record
}

// parsePriority extracts <N> from the front of s.
func parsePriority(s string) (facility, severity int, rest string, ok bool) {
	if len(s) < 3 || s[0] != '<' {
		return 0, 0, s, false
	}
	end := strings.IndexByte(s, '>')
	if end < 0 {
		return 0, 0, s, false
	}
	pri, err := strconv.Atoi(s[1:end])
	if err != nil {
		return 0, 0, s, false
	}
	return pri >> 3, pri & 7, strings.TrimSpace(s[end+1:]), true
}

// parseTimestamp tries to parse the leading timestamp from s.
// Supports "Jan  2 15:04:05" (RFC 3164) and "2006-01-02T15:04:05" (ISO 8601).
func parseTimestamp(s string) (ts, rest string, ok bool) {
	// Try ISO 8601 / RFC 3339 first.
	if len(s) >= 19 {
		t, err := time.Parse(time.RFC3339, s[:19])
		if err == nil {
			return t.UTC().Format(time.RFC3339), strings.TrimSpace(s[19:]), true
		}
	}

	// Try RFC 3164 "Jan  2 15:04:05" (15 chars).
	if len(s) >= 15 {
		layout := "Jan  2 15:04:05"
		t, err := time.Parse(layout, s[:15])
		if err == nil {
			// RFC 3164 has no year; assume current year.
			now := time.Now()
			t = t.AddDate(now.Year(), 0, 0)
			return t.UTC().Format(time.RFC3339), strings.TrimSpace(s[15:]), true
		}
		// Try single-digit day with space: "Jan 02 15:04:05".
		layout2 := "Jan 02 15:04:05"
		t, err = time.Parse(layout2, s[:15])
		if err == nil {
			now := time.Now()
			t = t.AddDate(now.Year(), 0, 0)
			return t.UTC().Format(time.RFC3339), strings.TrimSpace(s[15:]), true
		}
	}

	return "", s, false
}

// splitProgPID splits "sshd[1234]:" into ("sshd", "1234").
func splitProgPID(token string) (prog, pid string) {
	token = strings.TrimSuffix(token, ":")
	if idx := strings.Index(token, "["); idx >= 0 {
		prog = token[:idx]
		pid = strings.Trim(token[idx:], "[]")
		return
	}
	return token, ""
}

// ─── Flush ────────────────────────────────────────────────────────────────────

func (c *SyslogCollector) flushLoop(ctx context.Context) {
	interval := time.Duration(c.fwdCfg.FlushIntervalS) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.flush(context.Background())
			return
		case <-ticker.C:
			c.flush(ctx)
		}
	}
}

func (c *SyslogCollector) flush(ctx context.Context) {
	c.mu.Lock()
	if len(c.buf) == 0 {
		c.mu.Unlock()
		return
	}
	batch := c.buf
	c.buf = nil
	c.mu.Unlock()

	if err := c.hub.PostSyslog(ctx, batch); err != nil {
		c.log.Error().Err(err).Int("records", len(batch)).Msg("failed to post syslog")
	} else {
		c.log.Debug().Int("records", len(batch)).
			Str("sample", fmt.Sprintf("%v", batch[0]["message"])).Msg("syslog posted")
	}
}
