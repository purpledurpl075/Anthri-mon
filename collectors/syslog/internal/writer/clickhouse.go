// Package writer provides a buffered ClickHouse batch writer for syslog messages.
package writer

import (
	"context"
	"net"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/syslog/internal/model"
)

// Writer buffers SyslogMessages and flushes them to ClickHouse in batches.
type Writer struct {
	conn          clickhouse.Conn
	ch            chan model.SyslogMessage
	batchSize     int
	flushInterval time.Duration
	log           zerolog.Logger
}

// NewWriter opens a ClickHouse connection and returns a Writer ready to accept
// messages via Write(). Call Run(ctx) in a goroutine to start the flush loop.
func NewWriter(ctx context.Context, dsn string, batchSize int, flushIntervalS int, log zerolog.Logger) (*Writer, error) {
	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}

	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, err
	}
	if err := conn.Ping(ctx); err != nil {
		return nil, err
	}

	return &Writer{
		conn:          conn,
		ch:            make(chan model.SyslogMessage, batchSize*2),
		batchSize:     batchSize,
		flushInterval: time.Duration(flushIntervalS) * time.Second,
		log:           log.With().Str("component", "ch_writer").Logger(),
	}, nil
}

// Write enqueues a SyslogMessage for batch insertion. If the internal channel
// is full the message is dropped and a warning is logged.
func (w *Writer) Write(msg model.SyslogMessage) {
	select {
	case w.ch <- msg:
	default:
		w.log.Warn().Msg("clickhouse write channel full; dropping syslog message")
	}
}

// Run is the flush loop. It collects messages from the channel and writes them
// to ClickHouse when the batch reaches batchSize or the flush ticker fires.
// It returns when ctx is cancelled, flushing any remaining messages first.
func (w *Writer) Run(ctx context.Context) {
	ticker := time.NewTicker(w.flushInterval)
	defer ticker.Stop()

	batch := make([]model.SyslogMessage, 0, w.batchSize)

	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := w.flush(batch); err != nil {
			w.log.Error().Err(err).Int("count", len(batch)).Msg("clickhouse flush failed")
		} else {
			w.log.Debug().Int("count", len(batch)).Msg("flushed syslog messages to clickhouse")
		}
		batch = batch[:0]
	}

	for {
		select {
		case msg := <-w.ch:
			msg.ReceivedAt = time.Now().UTC()
			batch = append(batch, msg)
			if len(batch) >= w.batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-ctx.Done():
			// Drain any remaining messages in the channel.
		drain:
			for {
				select {
				case msg := <-w.ch:
					msg.ReceivedAt = time.Now().UTC()
					batch = append(batch, msg)
				default:
					break drain
				}
			}
			flush()
			return
		}
	}
}

// Close releases the ClickHouse connection.
func (w *Writer) Close() {
	_ = w.conn.Close()
}

// flush performs the actual INSERT INTO syslog_messages batch operation.
func (w *Writer) flush(msgs []model.SyslogMessage) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	b, err := w.conn.PrepareBatch(ctx,
		`INSERT INTO syslog_messages (
			device_id,
			device_ip,
			facility,
			severity,
			ts,
			hostname,
			program,
			pid,
			message,
			raw,
			received_at
		) VALUES`)
	if err != nil {
		return err
	}

	for _, r := range msgs {
		err := b.Append(
			r.DeviceID,           // UUID
			ip4ToStr(r.DeviceIP), // IPv4 as string for ClickHouse IPv4 type
			r.Facility,           // UInt8
			r.Severity,           // UInt8
			r.Ts,                 // DateTime64(3,'UTC')
			r.Hostname,           // LowCardinality(String)
			r.Program,            // LowCardinality(String)
			r.PID,                // String
			r.Message,            // String
			r.Raw,                // String
			r.ReceivedAt,         // DateTime
		)
		if err != nil {
			w.log.Warn().Err(err).Msg("failed to append row to batch; skipping")
		}
	}

	return b.Send()
}

// ip4ToStr converts a net.IP to its IPv4 string representation.
// ClickHouse accepts IPv4 column values as strings.
func ip4ToStr(ip net.IP) string {
	if ip == nil {
		return "0.0.0.0"
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return "0.0.0.0"
}
