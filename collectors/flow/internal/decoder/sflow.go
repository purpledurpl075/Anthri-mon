package decoder

import (
	"encoding/binary"
	"fmt"
	"net"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/model"
)

// sFlow sample type codes.
const (
	sfSampleTypeFlowSample         = 1
	sfSampleTypeCounterSample      = 2
	sfSampleTypeExpandedFlowSample = 3
)

// sFlow flow record format codes.
const (
	sfFormatRawPacketHeader  = 1
	sfFormatExtendedRouter   = 1002
	sfFormatExtendedGateway  = 1003
)

// Header protocol codes.
const (
	sfHeaderProtoEthernet = 1
	sfHeaderProtoIPv4     = 11
	sfHeaderProtoIPv6     = 12
)

// ParseSFlow5 decodes an sFlow v5 UDP payload and returns all decoded flow
// records from flow samples. Counter samples are silently skipped.
func ParseSFlow5(pkt []byte, exporterIP net.IP) ([]model.FlowRecord, error) {
	if len(pkt) < 28 {
		return nil, fmt.Errorf("sflow v5: packet too short (%d bytes)", len(pkt))
	}

	version := binary.BigEndian.Uint32(pkt[0:4])
	if version != 5 {
		return nil, fmt.Errorf("sflow v5: unexpected version %d", version)
	}

	agentAddrType := binary.BigEndian.Uint32(pkt[4:8])
	off := 8

	// Parse agent address.
	var agentAddr net.IP
	switch agentAddrType {
	case 1: // IPv4
		if off+4 > len(pkt) {
			return nil, fmt.Errorf("sflow v5: truncated agent address")
		}
		agentAddr = net.IP{pkt[off], pkt[off+1], pkt[off+2], pkt[off+3]}
		off += 4
	case 2: // IPv6
		if off+16 > len(pkt) {
			return nil, fmt.Errorf("sflow v5: truncated agent address")
		}
		agentAddr = make(net.IP, 16)
		copy(agentAddr, pkt[off:off+16])
		off += 16
	default:
		return nil, fmt.Errorf("sflow v5: unknown agent address type %d", agentAddrType)
	}
	_ = agentAddr // agentAddr stored for potential future use

	if off+12 > len(pkt) {
		return nil, fmt.Errorf("sflow v5: packet too short after agent address")
	}
	// subAgentID := binary.BigEndian.Uint32(pkt[off : off+4])
	// seqNum     := binary.BigEndian.Uint32(pkt[off+4 : off+8])
	// uptime     := binary.BigEndian.Uint32(pkt[off+8 : off+12])
	numSamples := binary.BigEndian.Uint32(pkt[off+12 : off+16])
	off += 16

	var records []model.FlowRecord
	for i := uint32(0); i < numSamples; i++ {
		if off+8 > len(pkt) {
			break
		}
		enterpriseType := binary.BigEndian.Uint32(pkt[off : off+4])
		sampleLen := int(binary.BigEndian.Uint32(pkt[off+4 : off+8]))
		off += 8

		if off+sampleLen > len(pkt) {
			break
		}

		sampleData := pkt[off : off+sampleLen]
		off += sampleLen

		// Enterprise 0, type 1 or 3 are flow samples.
		enterprise := enterpriseType >> 12
		sampleType := enterpriseType & 0x0FFF

		if enterprise != 0 {
			continue // non-standard enterprise; skip
		}

		switch sampleType {
		case sfSampleTypeFlowSample, sfSampleTypeExpandedFlowSample:
			recs, err := parseSFlowFlowSample(sampleData, exporterIP, sampleType == sfSampleTypeExpandedFlowSample)
			if err == nil {
				records = append(records, recs...)
			}
		case sfSampleTypeCounterSample:
			// Silently skip counter samples.
		}
	}
	return records, nil
}

// parseSFlowFlowSample decodes one sFlow Flow Sample or Expanded Flow Sample.
func parseSFlowFlowSample(data []byte, exporterIP net.IP, expanded bool) ([]model.FlowRecord, error) {
	minLen := 28
	if expanded {
		minLen = 32
	}
	if len(data) < minLen {
		return nil, fmt.Errorf("sflow flow sample: too short (%d)", len(data))
	}

	off := 0
	// sequence(u32)
	off += 4
	// source_id
	if expanded {
		// source_id_type(u32) + source_id_index(u32)
		off += 8
	} else {
		off += 4
	}

	samplingRate := binary.BigEndian.Uint32(data[off : off+4])
	off += 4
	if samplingRate == 0 {
		samplingRate = 1
	}

	// sample_pool(u32), drops(u32)
	off += 8

	// input interface
	var inputIf, outputIf uint32
	if expanded {
		// input_format(u32) + input_value(u32)
		if off+8 > len(data) {
			return nil, fmt.Errorf("sflow flow sample: truncated at input interface")
		}
		// format := binary.BigEndian.Uint32(data[off : off+4])
		inputIf = binary.BigEndian.Uint32(data[off+4 : off+8])
		off += 8
		// output_format(u32) + output_value(u32)
		if off+8 > len(data) {
			return nil, fmt.Errorf("sflow flow sample: truncated at output interface")
		}
		outputIf = binary.BigEndian.Uint32(data[off+4 : off+8])
		off += 8
	} else {
		if off+8 > len(data) {
			return nil, fmt.Errorf("sflow flow sample: truncated at interface indices")
		}
		inputIf = binary.BigEndian.Uint32(data[off : off+4])
		outputIf = binary.BigEndian.Uint32(data[off+4 : off+8])
		off += 8
	}

	if off+4 > len(data) {
		return nil, fmt.Errorf("sflow flow sample: truncated at num_records")
	}
	numRecords := binary.BigEndian.Uint32(data[off : off+4])
	off += 4

	// Synthesize timestamps — sFlow does not carry per-flow timestamps.
	now := time.Now().UTC()

	// Base record template shared by all flow records from this sample.
	base := model.FlowRecord{
		ExporterIP:    cloneIP(exporterIP),
		FlowType:      "sflow_v5",
		FlowStart:     now,
		FlowEnd:       now,
		InputIfIndex:  inputIf,
		OutputIfIndex: outputIf,
		SamplingRate:  samplingRate,
	}

	// Per-record overlay fields parsed from flow record structures.
	var (
		srcIP       net.IP
		dstIP       net.IP
		srcIP6      net.IP
		dstIP6      net.IP
		nextHop     net.IP
		srcPort     uint16
		dstPort     uint16
		protocol    uint8
		tcpFlags    uint8
		srcASN      uint32
		dstASN      uint32
		srcMask     uint8
		dstMask     uint8
		frameLength uint32
	)

	for i := uint32(0); i < numRecords; i++ {
		if off+8 > len(data) {
			break
		}
		recType := binary.BigEndian.Uint32(data[off : off+4])
		recLen := int(binary.BigEndian.Uint32(data[off+4 : off+8]))
		off += 8

		if off+recLen > len(data) {
			break
		}
		recData := data[off : off+recLen]
		off += recLen

		enterprise := recType >> 12
		format := recType & 0x0FFF

		if enterprise != 0 {
			continue
		}

		switch format {
		case sfFormatRawPacketHeader:
			si, di, si6, di6, sp, dp, proto, flags, flen := parseRawPacketHeader(recData)
			if si != nil {
				srcIP = si
			}
			if di != nil {
				dstIP = di
			}
			if si6 != nil {
				srcIP6 = si6
			}
			if di6 != nil {
				dstIP6 = di6
			}
			srcPort = sp
			dstPort = dp
			protocol = proto
			tcpFlags = flags
			if flen > 0 {
				frameLength = flen
			}

		case sfFormatExtendedRouter:
			nh, sm, dm := parseExtendedRouter(recData)
			if nh != nil {
				nextHop = nh
			}
			srcMask = sm
			dstMask = dm

		case sfFormatExtendedGateway:
			sa, da := parseExtendedGateway(recData)
			srcASN = sa
			dstASN = da
		}
	}

	rec := base
	rec.SrcIP = srcIP
	rec.DstIP = dstIP
	rec.SrcIP6 = srcIP6
	rec.DstIP6 = dstIP6
	rec.NextHop = nextHop
	rec.SrcPort = srcPort
	rec.DstPort = dstPort
	rec.IPProtocol = protocol
	rec.TCPFlags = tcpFlags
	rec.SrcASN = srcASN
	rec.DstASN = dstASN
	rec.SrcPrefixLen = srcMask
	rec.DstPrefixLen = dstMask
	rec.Bytes = uint64(frameLength)
	rec.Packets = 1 // sFlow samples one packet per flow record

	return []model.FlowRecord{rec}, nil
}

// parseRawPacketHeader extracts L3/L4 fields from a Raw Packet Header record.
func parseRawPacketHeader(data []byte) (srcIP, dstIP, srcIP6, dstIP6 net.IP, srcPort, dstPort uint16, protocol uint8, tcpFlags uint8, frameLength uint32) {
	if len(data) < 16 {
		return
	}
	headerProtocol := binary.BigEndian.Uint32(data[0:4])
	frameLength = binary.BigEndian.Uint32(data[4:8])
	// stripped     := binary.BigEndian.Uint32(data[8:12])
	headerSize := int(binary.BigEndian.Uint32(data[12:16]))
	if 16+headerSize > len(data) {
		headerSize = len(data) - 16
	}
	if headerSize <= 0 {
		return
	}
	hdr := data[16 : 16+headerSize]

	switch headerProtocol {
	case sfHeaderProtoEthernet:
		srcIP, dstIP, srcIP6, dstIP6, srcPort, dstPort, protocol, tcpFlags = parseEthernetHeader(hdr)
	case sfHeaderProtoIPv4:
		srcIP, dstIP, srcPort, dstPort, protocol, tcpFlags = parseIPv4Header(hdr)
	case sfHeaderProtoIPv6:
		srcIP6, dstIP6, srcPort, dstPort, protocol, tcpFlags = parseIPv6Header(hdr)
	}
	return
}

// parseEthernetHeader skips the 14-byte Ethernet header (or 18 for 802.1Q)
// and delegates to IPv4/IPv6 parsers.
func parseEthernetHeader(data []byte) (srcIP, dstIP, srcIP6, dstIP6 net.IP, srcPort, dstPort uint16, protocol uint8, tcpFlags uint8) {
	if len(data) < 14 {
		return
	}
	etherType := binary.BigEndian.Uint16(data[12:14])
	payload := data[14:]

	// Handle 802.1Q VLAN tag.
	if etherType == 0x8100 {
		if len(payload) < 4 {
			return
		}
		etherType = binary.BigEndian.Uint16(payload[2:4])
		payload = payload[4:]
	}

	switch etherType {
	case 0x0800:
		srcIP, dstIP, srcPort, dstPort, protocol, tcpFlags = parseIPv4Header(payload)
	case 0x86DD:
		srcIP6, dstIP6, srcPort, dstPort, protocol, tcpFlags = parseIPv6Header(payload)
	}
	return
}

// parseIPv4Header extracts src/dst IPs and L4 fields from a raw IPv4 header.
func parseIPv4Header(data []byte) (srcIP, dstIP net.IP, srcPort, dstPort uint16, protocol uint8, tcpFlags uint8) {
	if len(data) < 20 {
		return
	}
	ihl := int(data[0]&0x0F) * 4
	if ihl < 20 || ihl > len(data) {
		ihl = 20
	}
	protocol = data[9]
	srcIP = net.IP{data[12], data[13], data[14], data[15]}
	dstIP = net.IP{data[16], data[17], data[18], data[19]}

	l4 := data[ihl:]
	srcPort, dstPort, tcpFlags = parseL4(l4, protocol)
	return
}

// parseIPv6Header extracts src/dst IPs and L4 fields from a raw IPv6 header.
func parseIPv6Header(data []byte) (srcIP6, dstIP6 net.IP, srcPort, dstPort uint16, protocol uint8, tcpFlags uint8) {
	if len(data) < 40 {
		return
	}
	protocol = data[6] // Next Header
	srcIP6 = make(net.IP, 16)
	copy(srcIP6, data[8:24])
	dstIP6 = make(net.IP, 16)
	copy(dstIP6, data[24:40])

	l4 := data[40:]
	srcPort, dstPort, tcpFlags = parseL4(l4, protocol)
	return
}

// parseL4 extracts source port, destination port, and TCP flags from the L4
// payload for TCP (6) and UDP (17) protocols.
func parseL4(data []byte, protocol uint8) (srcPort, dstPort uint16, tcpFlags uint8) {
	switch protocol {
	case 6: // TCP
		if len(data) < 14 {
			return
		}
		srcPort = binary.BigEndian.Uint16(data[0:2])
		dstPort = binary.BigEndian.Uint16(data[2:4])
		tcpFlags = data[13]
	case 17: // UDP
		if len(data) < 4 {
			return
		}
		srcPort = binary.BigEndian.Uint16(data[0:2])
		dstPort = binary.BigEndian.Uint16(data[2:4])
	}
	return
}

// parseExtendedRouter extracts next-hop and prefix lengths from an Extended
// Router flow record (format 1002).
func parseExtendedRouter(data []byte) (nextHop net.IP, srcMask, dstMask uint8) {
	if len(data) < 8 {
		return
	}
	nhType := binary.BigEndian.Uint32(data[0:4])
	off := 4
	switch nhType {
	case 1: // IPv4
		if off+4 > len(data) {
			return
		}
		nextHop = net.IP{data[off], data[off+1], data[off+2], data[off+3]}
		off += 4
	case 2: // IPv6
		if off+16 > len(data) {
			return
		}
		nextHop = make(net.IP, 16)
		copy(nextHop, data[off:off+16])
		off += 16
	default:
		return
	}
	if off+8 > len(data) {
		return
	}
	srcMask = uint8(binary.BigEndian.Uint32(data[off : off+4]))
	dstMask = uint8(binary.BigEndian.Uint32(data[off+4 : off+8]))
	return
}

// parseExtendedGateway extracts src_as and dst_as from an Extended Gateway
// flow record (format 1003).
func parseExtendedGateway(data []byte) (srcASN, dstASN uint32) {
	// next_hop_type(u32) + next_hop_addr(4 or 16) + src_as(u32) + dst_as(u32)
	if len(data) < 4 {
		return
	}
	nhType := binary.BigEndian.Uint32(data[0:4])
	off := 4
	switch nhType {
	case 1:
		off += 4
	case 2:
		off += 16
	default:
		return
	}
	if off+8 > len(data) {
		return
	}
	srcASN = binary.BigEndian.Uint32(data[off : off+4])
	dstASN = binary.BigEndian.Uint32(data[off+4 : off+8])
	// Remaining fields (dst_as_path, communities, local_pref) are skipped.
	return
}
