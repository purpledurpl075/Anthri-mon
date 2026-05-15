// remote-collector is the Anthrimon distributed polling agent.
//
// It bootstraps a WireGuard VPN tunnel to the central hub, then polls local
// network devices via SNMP, receives NetFlow/sFlow, and collects syslog — all
// forwarded to the hub over the encrypted tunnel.
//
// Usage:
//
//	remote-collector [--config /path/to/remote-collector.yaml]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/bootstrap"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/collector"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/server"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/state"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/tunnel"
)

const version = "0.1.0"

func main() {
	cfgPath := flag.String("config", "", "path to config file (default: /etc/anthrimon/remote-collector.yaml)")
	showVer := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVer {
		fmt.Printf("remote-collector %s\n", version)
		os.Exit(0)
	}

	zerolog.TimeFieldFormat = time.RFC3339
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	if err := run(*cfgPath); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal().Err(err).Msg("remote-collector exited with error")
	}
}

func run(cfgPath string) error {
	// ── Config ────────────────────────────────────────────────────────────────

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	level, err := zerolog.ParseLevel(cfg.Log.Level)
	if err != nil {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)
	logger := zerolog.New(os.Stderr).With().
		Timestamp().
		Str("service", "remote-collector").
		Str("version", version).
		Logger()

	logger.Info().Str("log_level", level.String()).Msg("starting")

	// ── Signal context ────────────────────────────────────────────────────────

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// ── Bootstrap / state ─────────────────────────────────────────────────────

	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}

	st, err := loadOrBootstrap(ctx, cfg, hostname, logger)
	if err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}

	// ── WireGuard tunnel ──────────────────────────────────────────────────────

	if !tunnel.IsUp() {
		logger.Info().Msg("bringing up WireGuard tunnel")
		if err := tunnel.Setup(st); err != nil {
			return fmt.Errorf("tunnel setup: %w", err)
		}
	} else {
		logger.Info().Msg("WireGuard tunnel already up")
	}

	defer func() {
		logger.Info().Msg("tearing down WireGuard tunnel")
		_ = tunnel.Teardown()
	}()

	// ── Hub client ────────────────────────────────────────────────────────────
	//
	// The hub URL after bootstrap is the WireGuard hub address.
	hubURL := "https://10.100.0.1"
	hubClient := hub.NewClient(hubURL, st.APIKey, cfg.CACert)

	// ── Collectors ────────────────────────────────────────────────────────────

	snmpCol := collector.NewSNMPCollector(hubClient, cfg.SNMP, logger)

	devicesByIP := make(map[string]string)
	flowCol := collector.NewFlowCollector(hubClient, cfg.Flow, cfg.Forward, devicesByIP, logger)
	syslogCol := collector.NewSyslogCollector(hubClient, cfg.Syslog, cfg.Forward, devicesByIP, logger)

	// Initial config fetch.
	if err := refreshDevices(ctx, hubClient, snmpCol, flowCol, syslogCol, logger); err != nil {
		logger.Warn().Err(err).Msg("initial config fetch failed — will retry")
	}

	// ── Control server refresh callback ───────────────────────────────────────

	onRefresh := func() {
		if err := refreshDevices(ctx, hubClient, snmpCol, flowCol, syslogCol, logger); err != nil {
			logger.Warn().Err(err).Msg("on-demand config refresh failed")
		}
	}

	// ── Mini HTTP server on the WireGuard IP ─────────────────────────────────

	controlSrv := server.NewServer(st.WGAssignedIP, 9090, onRefresh, logger)

	// ── Launch all goroutines ─────────────────────────────────────────────────

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		heartbeatLoop(ctx, hubClient, version, logger)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		configRefreshLoop(ctx, hubClient, snmpCol, flowCol, syslogCol, logger)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		snmpCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		flowCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		syslogCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := controlSrv.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error().Err(err).Msg("control server error")
		}
	}()

	// Wait for context cancellation.
	<-ctx.Done()
	logger.Info().Msg("shutdown signal received — draining goroutines")
	wg.Wait()
	logger.Info().Msg("remote-collector stopped")
	return nil
}

// ─── Bootstrap helper ─────────────────────────────────────────────────────────

// loadOrBootstrap loads the state file if it exists, or performs a one-time
// bootstrap registration with the hub and persists the resulting state.
func loadOrBootstrap(ctx context.Context, cfg *config.Config, hostname string, logger zerolog.Logger) (*state.State, error) {
	st, err := state.Load(cfg.StateFile)
	if err != nil {
		return nil, fmt.Errorf("load state: %w", err)
	}

	if st != nil {
		logger.Info().
			Str("collector_id", st.CollectorID).
			Str("wg_ip", st.WGAssignedIP).
			Msg("loaded existing state")
		return st, nil
	}

	// State file absent — perform bootstrap.
	logger.Info().Str("hub", cfg.HubURL).Msg("no state file — bootstrapping with hub")

	if cfg.Token == "" {
		return nil, fmt.Errorf("ANTHRIMON_TOKEN is required for first-time bootstrap")
	}

	st, err = bootstrap.Bootstrap(cfg, hostname, version)
	if err != nil {
		return nil, fmt.Errorf("bootstrap request: %w", err)
	}

	if err := st.Save(cfg.StateFile); err != nil {
		return nil, fmt.Errorf("save state: %w", err)
	}

	logger.Info().
		Str("collector_id", st.CollectorID).
		Str("wg_ip", st.WGAssignedIP).
		Msg("bootstrap complete — state saved")

	return st, nil
}

// ─── Heartbeat loop ───────────────────────────────────────────────────────────

func heartbeatLoop(ctx context.Context, hubClient *hub.Client, ver string, logger zerolog.Logger) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	send := func() {
		stats := map[string]any{
			"uptime_s": time.Now().Unix(),
		}
		if err := hubClient.Heartbeat(ctx, ver, stats); err != nil {
			logger.Warn().Err(err).Msg("heartbeat failed")
		} else {
			logger.Debug().Msg("heartbeat sent")
		}
	}

	// Send immediately on startup.
	send()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			send()
		}
	}
}

// ─── Config refresh loop ──────────────────────────────────────────────────────

func configRefreshLoop(
	ctx context.Context,
	hubClient *hub.Client,
	snmpCol *collector.SNMPCollector,
	flowCol *collector.FlowCollector,
	syslogCol *collector.SyslogCollector,
	logger zerolog.Logger,
) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := refreshDevices(ctx, hubClient, snmpCol, flowCol, syslogCol, logger); err != nil {
				logger.Warn().Err(err).Msg("periodic config refresh failed")
			}
		}
	}
}

// refreshDevices fetches the device list from the hub and updates all collectors.
func refreshDevices(
	ctx context.Context,
	hubClient *hub.Client,
	snmpCol *collector.SNMPCollector,
	flowCol *collector.FlowCollector,
	syslogCol *collector.SyslogCollector,
	logger zerolog.Logger,
) error {
	devCfg, err := hubClient.FetchConfig(ctx)
	if err != nil {
		return fmt.Errorf("fetch config: %w", err)
	}

	// Build IP→device_id map for flow and syslog.
	byIP := make(map[string]string, len(devCfg.Devices))
	for _, d := range devCfg.Devices {
		byIP[d.MgmtIP] = d.ID
	}

	snmpCol.SetDevices(devCfg.Devices)
	flowCol.UpdateDevices(byIP)
	syslogCol.UpdateDevices(byIP)

	logger.Info().
		Int("devices", len(devCfg.Devices)).
		Str("generated_at", devCfg.GeneratedAt).
		Msg("device config refreshed")

	return nil
}
