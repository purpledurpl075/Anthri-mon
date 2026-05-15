// Package writer provides a buffered ClickHouse batch writer for flow records.
package writer

import (
	"context"
	"net"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/model"
)

// Writer buffers FlowRecords and flushes them to ClickHouse in batches.
type Writer struct {
	conn          clickhouse.Conn
	ch            chan model.FlowRecord
	batchSize     int
	flushInterval time.Duration
	log           zerolog.Logger
}

// NewWriter opens a ClickHouse connection and returns a Writer ready to accept
// records via Write(). Call Run(ctx) in a goroutine to start the flush loop.
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
		ch:            make(chan model.FlowRecord, batchSize*2),
		batchSize:     batchSize,
		flushInterval: time.Duration(flushIntervalS) * time.Second,
		log:           log.With().Str("component", "ch_writer").Logger(),
	}, nil
}

// Write enqueues a FlowRecord for batch insertion. If the internal channel is
// full the record is dropped and a warning is logged.
func (w *Writer) Write(rec model.FlowRecord) {
	select {
	case w.ch <- rec:
	default:
		w.log.Warn().Msg("clickhouse write channel full; dropping flow record")
	}
}

// Run is the flush loop. It collects records from the channel and writes them
// to ClickHouse when the batch reaches batchSize or the flush ticker fires.
// It returns when ctx is cancelled, flushing any remaining records first.
func (w *Writer) Run(ctx context.Context) {
	ticker := time.NewTicker(w.flushInterval)
	defer ticker.Stop()

	batch := make([]model.FlowRecord, 0, w.batchSize)

	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := w.flush(batch); err != nil {
			w.log.Error().Err(err).Int("count", len(batch)).Msg("clickhouse flush failed")
		} else {
			w.log.Debug().Int("count", len(batch)).Msg("flushed flow records to clickhouse")
		}
		batch = batch[:0]
	}

	for {
		select {
		case rec := <-w.ch:
			rec.ReceivedAt = time.Now().UTC()
			batch = append(batch, rec)
			if len(batch) >= w.batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-ctx.Done():
			// Drain any remaining records in the channel.
		drain:
			for {
				select {
				case rec := <-w.ch:
					rec.ReceivedAt = time.Now().UTC()
					batch = append(batch, rec)
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

// flush performs the actual INSERT INTO flow_records batch operation.
func (w *Writer) flush(records []model.FlowRecord) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	b, err := w.conn.PrepareBatch(ctx,
		`INSERT INTO flow_records (
			collector_device_id,
			collector_ip,
			exporter_ip,
			flow_type,
			flow_start,
			flow_end,
			src_ip,
			dst_ip,
			src_ip6,
			dst_ip6,
			next_hop,
			src_port,
			dst_port,
			ip_protocol,
			tcp_flags,
			bytes,
			packets,
			input_if_index,
			output_if_index,
			src_asn,
			dst_asn,
			src_prefix_len,
			dst_prefix_len,
			tos,
			dscp,
			sampling_rate,
			received_at
		) VALUES`)
	if err != nil {
		return err
	}

	for _, r := range records {
		err := b.Append(
			r.CollectorDeviceID,             // UUID
			ip4ToStr(r.CollectorIP),         // IPv4 as string for ClickHouse IPv4 type
			ip4ToStr(r.ExporterIP),
			r.FlowType,
			r.FlowStart,
			r.FlowEnd,
			ip4ToStr(r.SrcIP),
			ip4ToStr(r.DstIP),
			ip6ToStr(r.SrcIP6),
			ip6ToStr(r.DstIP6),
			ip4ToStr(r.NextHop),
			r.SrcPort,
			r.DstPort,
			r.IPProtocol,
			r.TCPFlags,
			r.Bytes,
			r.Packets,
			r.InputIfIndex,
			r.OutputIfIndex,
			r.SrcASN,
			r.DstASN,
			r.SrcPrefixLen,
			r.DstPrefixLen,
			r.TOS,
			r.DSCP,
			r.SamplingRate,
			r.ReceivedAt,
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

// ip6ToStr converts a net.IP to its IPv6 string representation.
func ip6ToStr(ip net.IP) string {
	if ip == nil {
		return "::"
	}
	if len(ip) == 16 {
		return ip.String()
	}
	return "::"
}
