// Package lookup provides a periodic-refresh device lookup from PostgreSQL.
// It maps management IP addresses to device UUIDs and also exposes the local
// collector's IP address.
package lookup

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// DeviceLookup caches the devices table from PostgreSQL and provides fast
// IP-to-UUID lookups. It refreshes the cache on a configurable interval.
type DeviceLookup struct {
	pool           *pgxpool.Pool
	refreshSeconds int
	log            zerolog.Logger

	mu   sync.RWMutex
	byIP map[string]uuid.UUID // mgmt_ip_string → device UUID

	collectorIP net.IP // first non-loopback IPv4 of this host
}

// NewDeviceLookup creates a DeviceLookup, performs the initial device load,
// and starts a background refresh goroutine. The goroutine stops when ctx is
// cancelled.
func NewDeviceLookup(ctx context.Context, pgDSN string, refreshSeconds int, log zerolog.Logger) (*DeviceLookup, error) {
	cfg, err := pgxpool.ParseConfig(pgDSN)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}

	dl := &DeviceLookup{
		pool:           pool,
		refreshSeconds: refreshSeconds,
		log:            log.With().Str("component", "device_lookup").Logger(),
		byIP:           make(map[string]uuid.UUID),
		collectorIP:    localIPv4(),
	}

	if err := dl.load(ctx); err != nil {
		dl.log.Warn().Err(err).Msg("initial device load failed; will retry on next tick")
	} else {
		dl.log.Info().Int("count", dl.count()).Msg("device cache loaded")
	}

	go dl.refreshLoop(ctx)
	return dl, nil
}

// Lookup returns the device UUID for the given IP address, or uuid.Nil if no
// matching device is found.
func (dl *DeviceLookup) Lookup(ip net.IP) uuid.UUID {
	if ip == nil {
		return uuid.Nil
	}
	dl.mu.RLock()
	id, ok := dl.byIP[normaliseIP(ip)]
	dl.mu.RUnlock()
	if !ok {
		return uuid.Nil
	}
	return id
}

// CollectorIP returns the local machine's first non-loopback IPv4 address.
func (dl *DeviceLookup) CollectorIP() net.IP {
	return dl.collectorIP
}

// Close releases the underlying PostgreSQL pool.
func (dl *DeviceLookup) Close() {
	dl.pool.Close()
}

// ---- internal ---------------------------------------------------------------

func (dl *DeviceLookup) refreshLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(dl.refreshSeconds) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := dl.load(ctx); err != nil {
				dl.log.Warn().Err(err).Msg("device cache refresh failed")
			} else {
				dl.log.Debug().Int("count", dl.count()).Msg("device cache refreshed")
			}
		}
	}
}

func (dl *DeviceLookup) load(ctx context.Context) error {
	rows, err := dl.pool.Query(ctx,
		`SELECT id::text, host(mgmt_ip) FROM devices WHERE is_active = true`)
	if err != nil {
		return err
	}
	defer rows.Close()

	m := make(map[string]uuid.UUID, 256)
	for rows.Next() {
		var idStr, ipStr string
		if err := rows.Scan(&idStr, &ipStr); err != nil {
			continue
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			continue
		}
		m[ipStr] = id
	}
	if err := rows.Err(); err != nil {
		return err
	}

	dl.mu.Lock()
	dl.byIP = m
	dl.mu.Unlock()
	return nil
}

func (dl *DeviceLookup) count() int {
	dl.mu.RLock()
	n := len(dl.byIP)
	dl.mu.RUnlock()
	return n
}

// normaliseIP converts a net.IP to its canonical string representation so that
// both IPv4-in-IPv6 (16-byte) and native IPv4 (4-byte) forms compare equal.
func normaliseIP(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// localIPv4 returns the first non-loopback IPv4 address of this host.
func localIPv4() net.IP {
	ifaces, err := net.Interfaces()
	if err != nil {
		return net.IPv4zero
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if v4 := ip.To4(); v4 != nil && !v4.IsLoopback() {
				return v4
			}
		}
	}
	return net.IPv4zero
}
