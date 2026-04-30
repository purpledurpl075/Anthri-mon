// Package config loads and validates collector settings from a YAML file and
// environment variable overrides. All secrets (DB password, encryption key)
// come from env vars so they never need to appear in the config file.
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config is the top-level configuration for the SNMP collector.
type Config struct {
	Database   DatabaseConfig   `mapstructure:"database"`
	Encryption EncryptionConfig `mapstructure:"encryption"`
	SNMP       SNMPConfig       `mapstructure:"snmp"`
	Polling    PollingConfig    `mapstructure:"polling"`
	Metrics    MetricsConfig    `mapstructure:"metrics"`
	Log        LogConfig        `mapstructure:"log"`
}

// DatabaseConfig holds PostgreSQL connection settings.
type DatabaseConfig struct {
	// Full libpq-style DSN: postgres://user:pass@host:5432/dbname
	// Override individual fields via SNMP_DB_* env vars if preferred.
	DSN      string `mapstructure:"dsn"`
	MaxConns int    `mapstructure:"max_conns"`
	MinConns int    `mapstructure:"min_conns"`
}

// EncryptionConfig controls AES-256-GCM credential decryption.
// If Key is empty, credentials are assumed to be stored as plaintext JSON
// (acceptable for development; always set a key in production).
type EncryptionConfig struct {
	// 32-byte key encoded as 64 lowercase hex characters.
	// Set via env var SNMP_ENCRYPTION_KEY to avoid the key appearing in the
	// config file.
	Key string `mapstructure:"key"`
}

// SNMPConfig controls per-request SNMP behaviour.
type SNMPConfig struct {
	TimeoutSeconds  int `mapstructure:"timeout_seconds"`
	Retries         int `mapstructure:"retries"`
	MaxOids         int `mapstructure:"max_oids"`
	MaxRepetitions  int `mapstructure:"max_repetitions"`
}

// PollingConfig controls collection intervals and concurrency.
type PollingConfig struct {
	// How often to poll interface counters (seconds). Devices can override
	// this individually via devices.polling_interval_s in the DB.
	DefaultIntervalS int `mapstructure:"default_interval_s"`

	// Health metrics (CPU, memory, temp) are polled less frequently.
	// Expressed as a multiplier of DefaultIntervalS.
	HealthMultiplier int `mapstructure:"health_multiplier"`

	// How often to re-read the device list from PostgreSQL (seconds).
	DeviceRefreshS int `mapstructure:"device_refresh_s"`

	// Maximum number of devices being polled concurrently.
	// Each device runs its own goroutine; this caps the total.
	MaxConcurrentDevices int `mapstructure:"max_concurrent_devices"`
}

// MetricsConfig points the collector at the VictoriaMetrics ingest endpoint.
type MetricsConfig struct {
	// e.g. http://localhost:8428
	VictoriaMetricsURL string        `mapstructure:"victoriametrics_url"`
	FlushInterval      time.Duration `mapstructure:"flush_interval"`
	BatchSize          int           `mapstructure:"batch_size"`
}

// LogConfig selects the log level.
type LogConfig struct {
	Level string `mapstructure:"level"` // "debug" | "info" | "warn" | "error"
}

// Load reads configuration from the given file path (YAML / TOML / JSON),
// then applies any SNMP_* environment variable overrides.
func Load(path string) (*Config, error) {
	v := viper.New()

	// Defaults — production-safe baseline values.
	v.SetDefault("database.max_conns", 5)
	v.SetDefault("database.min_conns", 1)
	v.SetDefault("snmp.timeout_seconds", 10)
	v.SetDefault("snmp.retries", 3)
	v.SetDefault("snmp.max_oids", 60)
	v.SetDefault("snmp.max_repetitions", 25)
	v.SetDefault("polling.default_interval_s", 60)
	v.SetDefault("polling.health_multiplier", 5)
	v.SetDefault("polling.device_refresh_s", 300)
	v.SetDefault("polling.max_concurrent_devices", 500)
	v.SetDefault("metrics.victoriametrics_url", "http://localhost:8428")
	v.SetDefault("metrics.flush_interval", 10*time.Second)
	v.SetDefault("metrics.batch_size", 500)
	v.SetDefault("log.level", "info")

	// Config file.
	if path != "" {
		v.SetConfigFile(path)
	} else {
		// Search order: /etc/anthrimon/, then current directory.
		v.SetConfigName("snmp-collector")
		v.SetConfigType("yaml")
		v.AddConfigPath("/etc/anthrimon/")
		v.AddConfigPath(".")
	}

	if err := v.ReadInConfig(); err != nil {
		// A missing file is acceptable — defaults will be used.
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("reading config file: %w", err)
		}
	}

	// Env var overrides: SNMP_DATABASE_DSN → database.dsn, etc.
	v.SetEnvPrefix("SNMP")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// ANTHRIMON_ENCRYPTION_KEY is shared with the Python API.
	v.BindEnv("encryption.key", "ANTHRIMON_ENCRYPTION_KEY") //nolint:errcheck

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshalling config: %w", err)
	}

	if cfg.Database.DSN == "" {
		return nil, fmt.Errorf("database.dsn is required (set SNMP_DATABASE_DSN env var)")
	}

	return &cfg, nil
}
