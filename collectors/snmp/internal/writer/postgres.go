// Package writer handles persistence of poll results into PostgreSQL and
// VictoriaMetrics. Both writers implement poller.ResultHandler so the poller
// package never needs to import the writer package (dependency inversion).
package writer

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/poller"
	"github.com/rs/zerolog"
)

// PostgresWriter writes poll results to the PostgreSQL database using the
// same schema defined in storage/migrations/postgres/001_init.sql.
type PostgresWriter struct {
	pool *pgxpool.Pool
	log  zerolog.Logger
}

// NewPostgresWriter connects to PostgreSQL and returns a ready writer.
func NewPostgresWriter(ctx context.Context, dsn string, maxConns, minConns int, log zerolog.Logger) (*PostgresWriter, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres DSN: %w", err)
	}
	cfg.MaxConns = int32(maxConns)
	cfg.MinConns = int32(minConns)

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres ping: %w", err)
	}

	log.Info().Str("dsn_prefix", dsn[:min(len(dsn), 30)]).Msg("postgres writer connected")
	return &PostgresWriter{pool: pool, log: log.With().Str("component", "postgres_writer").Logger()}, nil
}

// Close releases the connection pool.
func (w *PostgresWriter) Close() {
	w.pool.Close()
}

// Handle implements poller.ResultHandler.
func (w *PostgresWriter) Handle(ctx context.Context, result *poller.PollResult) error {
	if result.SysInfo != nil {
		if err := w.upsertDevice(ctx, result.SysInfo); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert device failed")
		}
	}

	if len(result.Interfaces) > 0 {
		if err := w.upsertInterfaces(ctx, result.DeviceID, result.Interfaces); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert interfaces failed")
		}
	}

	if result.Health != nil {
		if err := w.upsertHealth(ctx, result.Health); err != nil {
			w.log.Error().Err(err).Str("device_id", result.DeviceID.String()).Msg("upsert health failed")
		}
	}

	return nil
}

// ── Device ────────────────────────────────────────────────────────────────────

// upsertDevice updates the devices row with sysinfo data from the latest poll.
// Only updates fields that the SNMP poller is authoritative for.
func (w *PostgresWriter) upsertDevice(ctx context.Context, info *model.DeviceInfo) error {
	_, err := w.pool.Exec(ctx, `
		UPDATE devices
		SET
			sys_description = $1,
			sys_object_id   = $2,
			vendor          = $3::vendor_type,
			status          = 'up'::device_status,
			last_polled     = $4,
			last_seen       = $4
		WHERE id = $5
	`, info.SysDescr, info.SysObjectID, info.DBVendorType, info.PollTime, info.DeviceID)
	return err
}

// ── Interfaces ────────────────────────────────────────────────────────────────

// upsertInterfaces writes one interface result per row using a pgx batch to
// minimise round trips. It also appends to interface_status_log when
// oper_status has changed since the last stored value.
func (w *PostgresWriter) upsertInterfaces(ctx context.Context, deviceID uuid.UUID, ifaces []*model.InterfaceResult) error {
	// Fetch current oper_status values so we can detect changes.
	currentStatus, err := w.fetchIfaceStatus(ctx, deviceID)
	if err != nil {
		return fmt.Errorf("fetch current interface status: %w", err)
	}

	batch := &pgx.Batch{}

	for _, iface := range ifaces {
		var lastChange *time.Time
		if !iface.LastChange.IsZero() {
			t := iface.LastChange
			lastChange = &t
		}

		// Upsert the interface row.
		batch.Queue(`
			INSERT INTO interfaces (
				device_id, if_index, name, description, if_type,
				speed_bps, mtu, mac_address,
				admin_status, oper_status, last_change,
				updated_at
			) VALUES (
				$1, $2, $3, $4, $5,
				$6, $7, $8,
				$9::if_status, $10::if_status, $11,
				$12
			)
			ON CONFLICT (device_id, if_index) DO UPDATE SET
				name         = EXCLUDED.name,
				description  = EXCLUDED.description,
				if_type      = EXCLUDED.if_type,
				speed_bps    = EXCLUDED.speed_bps,
				mtu          = EXCLUDED.mtu,
				mac_address  = EXCLUDED.mac_address,
				admin_status = EXCLUDED.admin_status,
				oper_status  = EXCLUDED.oper_status,
				last_change  = EXCLUDED.last_change,
				updated_at   = EXCLUDED.updated_at
		`,
			deviceID, iface.IfIndex, ifName(iface), nullStr(iface.IfAlias), nullStr(iface.IfType),
			nullUint64(iface.SpeedBPS), nullInt(iface.MTU), nullStr(iface.MACAddress),
			iface.AdminStatus, iface.OperStatus, lastChange,
			iface.PollTime,
		)

		// Log a status-change event if oper_status changed.
		// We need the interface UUID which is returned by the upsert, but
		// pgx batch results don't give us RETURNING rows. Instead we record
		// the event separately using a sub-query to look up the interface UUID.
		prev, hasPrev := currentStatus[iface.IfIndex]
		if hasPrev && prev != iface.OperStatus {
			batch.Queue(`
				INSERT INTO interface_status_log (interface_id, device_id, prev_status, new_status, recorded_at)
				SELECT id, $1, $2::if_status, $3::if_status, $4
				FROM interfaces
				WHERE device_id = $1 AND if_index = $5
			`,
				deviceID, prev, iface.OperStatus, iface.PollTime, iface.IfIndex,
			)
		}
	}

	br := w.pool.SendBatch(ctx, batch)
	defer br.Close()

	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			w.log.Error().Err(err).Msg("batch exec error")
		}
	}
	return nil
}

// fetchIfaceStatus returns a map of ifIndex → current oper_status for a device.
func (w *PostgresWriter) fetchIfaceStatus(ctx context.Context, deviceID uuid.UUID) (map[int]string, error) {
	rows, err := w.pool.Query(ctx,
		`SELECT if_index, oper_status::text FROM interfaces WHERE device_id = $1`,
		deviceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	m := make(map[int]string)
	for rows.Next() {
		var idx int
		var status string
		if err := rows.Scan(&idx, &status); err != nil {
			return nil, err
		}
		m[idx] = status
	}
	return m, rows.Err()
}

// ── Health ────────────────────────────────────────────────────────────────────

// upsertHealth writes the health snapshot to device_health_latest.
// The authoritative history lives in VictoriaMetrics; this row serves the
// dashboard health cards without requiring a time-series query.
func (w *PostgresWriter) upsertHealth(ctx context.Context, h *model.HealthResult) error {
	cpuPct := avgCPU(h.CPUSamples)
	memUsed, memTotal := sumMemory(h.MemSamples)
	tempsJSON := marshalTemps(h.TempSamples)

	_, err := w.pool.Exec(ctx, `
		INSERT INTO device_health_latest (
			device_id, collected_at, cpu_util_pct, mem_used_bytes, mem_total_bytes,
			temperatures, uptime_seconds, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $2)
		ON CONFLICT (device_id) DO UPDATE SET
			collected_at    = EXCLUDED.collected_at,
			cpu_util_pct    = EXCLUDED.cpu_util_pct,
			mem_used_bytes  = EXCLUDED.mem_used_bytes,
			mem_total_bytes = EXCLUDED.mem_total_bytes,
			temperatures    = EXCLUDED.temperatures,
			uptime_seconds  = EXCLUDED.uptime_seconds,
			updated_at      = EXCLUDED.updated_at
	`,
		h.DeviceID, h.PollTime, cpuPct, nullUint64(memUsed), nullUint64(memTotal),
		tempsJSON, h.UptimeSecs,
	)
	return err
}

// ── DeviceSource implementation ───────────────────────────────────────────────

// LoadDevices reads all active SNMP-capable devices and their first-priority
// credential from PostgreSQL. It implements poller.DeviceSource.
func (w *PostgresWriter) LoadDevices(ctx context.Context) ([]model.DeviceRow, error) {
	rows, err := w.pool.Query(ctx, `
		SELECT
			d.id,
			d.mgmt_ip::text,
			d.snmp_version::text,
			d.snmp_port,
			d.polling_interval_s,
			c.type::text   AS cred_type,
			c.data::text   AS cred_data
		FROM devices d
		JOIN device_credentials dc ON dc.device_id = d.id
		JOIN credentials c ON c.id = dc.credential_id
		WHERE
			d.is_active = true
			AND d.collection_method IN ('snmp', 'both')
			AND c.type IN ('snmp_v2c', 'snmp_v3')
		ORDER BY d.id, dc.priority ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("query devices: %w", err)
	}
	defer rows.Close()

	// Multiple credential rows per device — keep only the first (lowest priority).
	seen := make(map[uuid.UUID]bool)
	var devices []model.DeviceRow

	for rows.Next() {
		var dr model.DeviceRow
		var ipStr, versionStr, credType, credDataStr string
		if err := rows.Scan(&dr.ID, &ipStr, &versionStr, &dr.SNMPPort,
			&dr.PollingIntervalS, &credType, &credDataStr); err != nil {
			return nil, fmt.Errorf("scan device row: %w", err)
		}
		if seen[dr.ID] {
			continue
		}
		seen[dr.ID] = true
		dr.MgmtIP = ipStr
		dr.SNMPVersion = versionStr
		dr.CredentialType = credType
		dr.CredentialData = []byte(credDataStr)
		devices = append(devices, dr)
	}
	return devices, rows.Err()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func avgCPU(samples []model.CPUSample) *float64 {
	if len(samples) == 0 {
		return nil
	}
	var sum float64
	for _, s := range samples {
		sum += s.LoadPct
	}
	avg := sum / float64(len(samples))
	return &avg
}

func sumMemory(samples []model.MemorySample) (used, total uint64) {
	for _, s := range samples {
		if s.Type == "ram" {
			used += s.UsedBytes
			total += s.TotalBytes
		}
	}
	return
}

func marshalTemps(samples []model.TempSample) []byte {
	type entry struct {
		Sensor  string  `json:"sensor"`
		Celsius float64 `json:"celsius"`
		OK      bool    `json:"ok"`
	}
	entries := make([]entry, 0, len(samples))
	for _, s := range samples {
		entries = append(entries, entry{Sensor: s.SensorName, Celsius: s.Celsius, OK: s.StatusOK})
	}
	b, _ := json.Marshal(entries)
	return b
}

// ifName returns the best available interface name (ifName preferred, then ifDescr).
func ifName(i *model.InterfaceResult) string {
	if i.IfName != "" {
		return i.IfName
	}
	return i.IfDescr
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nullUint64(v uint64) *uint64 {
	if v == 0 {
		return nil
	}
	return &v
}

func nullInt(v int) *int {
	if v == 0 {
		return nil
	}
	return &v
}

