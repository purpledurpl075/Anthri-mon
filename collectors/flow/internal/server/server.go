// Package server implements the UDP listeners for NetFlow v5/v9, IPFIX, and
// sFlow v5 packets. A single Server instance manages two UDP sockets — one on
// the NetFlow port (default :2055) and one on the sFlow port (default :6343).
package server

import (
	"context"
	"encoding/binary"
	"net"
	"sync"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/decoder"
	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/lookup"
	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/writer"
)

// Server owns the UDP listeners and dispatches decoded flow records.
type Server struct {
	cfg           *config.Config
	templateCache *decoder.TemplateCache
	lookup        *lookup.DeviceLookup
	writer        *writer.Writer
	log           zerolog.Logger
}

// NewServer constructs a Server. Call Run(ctx) to start listening.
func NewServer(cfg *config.Config, lkp *lookup.DeviceLookup, w *writer.Writer, log zerolog.Logger) *Server {
	return &Server{
		cfg:           cfg,
		templateCache: decoder.NewTemplateCache(),
		lookup:        lkp,
		writer:        w,
		log:           log.With().Str("component", "udp_server").Logger(),
	}
}

// Run starts both UDP listeners and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		s.listenNetFlow(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		s.listenSFlow(ctx)
	}()

	wg.Wait()
	return nil
}

// listenUDP is the shared UDP listen loop. It closes the connection when ctx
// is cancelled, which immediately unblocks any pending ReadFrom call.
func (s *Server) listenUDP(ctx context.Context, addr string, handler func([]byte, net.IP)) {
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		s.log.Error().Err(err).Str("addr", addr).Msg("failed to bind udp listener")
		return
	}

	// Close the connection when the context is cancelled so ReadFrom unblocks.
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	s.log.Info().Str("addr", addr).Msg("udp listener ready")
	buf := make([]byte, s.cfg.Listener.BufferSize)
	for {
		n, remote, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return // clean shutdown
			}
			s.log.Debug().Err(err).Str("addr", addr).Msg("udp read error")
			continue
		}
		pkt := make([]byte, n)
		copy(pkt, buf[:n])
		go handler(pkt, remoteToIPv4(remote))
	}
}

// listenNetFlow binds the NetFlow/IPFIX UDP socket and reads packets.
func (s *Server) listenNetFlow(ctx context.Context) {
	s.listenUDP(ctx, s.cfg.Listener.NetFlowAddr, s.handleNetFlowPacket)
}

// listenSFlow binds the sFlow UDP socket and reads packets.
func (s *Server) listenSFlow(ctx context.Context) {
	s.listenUDP(ctx, s.cfg.Listener.SFlowAddr, s.handleSFlowPacket)
}

// handleNetFlowPacket detects the protocol version and dispatches accordingly.
//
// Protocol detection from the first 4 bytes:
//   - uint16 at offset 0 == 5  → NetFlow v5
//   - uint16 at offset 0 == 9  → NetFlow v9
//   - uint16 at offset 0 == 10 → IPFIX
func (s *Server) handleNetFlowPacket(pkt []byte, exporterIP net.IP) {
	if len(pkt) < 4 {
		s.log.Debug().Msg("netflow: packet too short to detect version")
		return
	}

	version := binary.BigEndian.Uint16(pkt[0:2])

	var records []model.FlowRecord
	var err error

	switch version {
	case 5:
		records, err = decoder.ParseNetFlow5(pkt, exporterIP)
	case 9:
		records, err = decoder.ParseNetFlow9(pkt, exporterIP, s.templateCache)
	case 10:
		records, err = decoder.ParseIPFIX(pkt, exporterIP, s.templateCache)
	default:
		s.log.Debug().Uint16("version", version).Str("exporter", exporterIP.String()).
			Msg("netflow: unknown version; dropping packet")
		return
	}

	if err != nil {
		s.log.Debug().Err(err).Str("exporter", exporterIP.String()).Msg("netflow decode error")
		return
	}

	s.dispatchRecords(records, exporterIP)
}

// handleSFlowPacket checks that the packet is sFlow v5 and dispatches it.
//
// sFlow version is carried as a uint32 at offset 0; value 5 = sFlow v5.
func (s *Server) handleSFlowPacket(pkt []byte, exporterIP net.IP) {
	if len(pkt) < 4 {
		s.log.Debug().Msg("sflow: packet too short to detect version")
		return
	}

	version := binary.BigEndian.Uint32(pkt[0:4])
	if version != 5 {
		s.log.Debug().Uint32("version", version).Msg("sflow: unknown version; dropping packet")
		return
	}

	records, err := decoder.ParseSFlow5(pkt, exporterIP)
	if err != nil {
		s.log.Debug().Err(err).Str("exporter", exporterIP.String()).Msg("sflow decode error")
		return
	}

	s.dispatchRecords(records, exporterIP)
}

// dispatchRecords enriches each record with lookup data and forwards to the
// ClickHouse writer.
func (s *Server) dispatchRecords(records []model.FlowRecord, exporterIP net.IP) {
	collectorIP := s.lookup.CollectorIP()
	deviceID := s.lookup.Lookup(exporterIP)

	for i := range records {
		records[i].CollectorIP = collectorIP
		records[i].ExporterIP = exporterIP
		records[i].CollectorDeviceID = deviceID
		s.writer.Write(records[i])
	}
}

// remoteToIPv4 extracts a 4-byte IPv4 net.IP from a net.Addr (UDP remote addr).
func remoteToIPv4(addr net.Addr) net.IP {
	switch v := addr.(type) {
	case *net.UDPAddr:
		if v4 := v.IP.To4(); v4 != nil {
			return v4
		}
		return v.IP
	}
	// Fallback: parse from string.
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return nil
	}
	ip := net.ParseIP(host)
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	return ip
}
