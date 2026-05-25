// sFlow v5 parser for the remote collector.
// Adapted from the hub's flow-collector decoder; produces []map[string]any
// records that match the fields expected by POST /api/v1/collectors/flows.
package collector

import (
	"encoding/binary"
	"net"
	"time"
)

// sFlow sample/record type constants.
const (
	sfSampleTypeFlowSample         = 1
	sfSampleTypeCounterSample      = 2
	sfSampleTypeExpandedFlowSample = 3

	sfFormatRawPacketHeader = 1
	sfFormatExtendedRouter  = 1002
	sfFormatExtendedGateway = 1003

	sfHeaderProtoEthernet = 1
	sfHeaderProtoIPv4     = 11
	sfHeaderProtoIPv6     = 12
)

// parseSFlow5 decodes an sFlow v5 UDP payload and returns flow records
// as []map[string]any. Counter samples are silently skipped.
// exporterIP is the UDP source address; deviceID is looked up by the caller.
func parseSFlow5(pkt []byte, exporterIP, deviceID string) []map[string]any {
	if len(pkt) < 28 {
		return nil
	}
	version := binary.BigEndian.Uint32(pkt[0:4])
	if version != 5 {
		return nil
	}

	agentAddrType := binary.BigEndian.Uint32(pkt[4:8])
	off := 8

	switch agentAddrType {
	case 1: // IPv4
		if off+4 > len(pkt) {
			return nil
		}
		off += 4
	case 2: // IPv6
		if off+16 > len(pkt) {
			return nil
		}
		off += 16
	default:
		return nil
	}

	if off+16 > len(pkt) {
		return nil
	}
	// subAgentID(4) + seqNum(4) + uptime(4) + numSamples(4)
	numSamples := binary.BigEndian.Uint32(pkt[off+12 : off+16])
	off += 16

	var records []map[string]any
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

		enterprise := enterpriseType >> 12
		sampleType := enterpriseType & 0x0FFF
		if enterprise != 0 {
			continue
		}

		switch sampleType {
		case sfSampleTypeFlowSample, sfSampleTypeExpandedFlowSample:
			recs := sfParseFlowSample(sampleData, exporterIP, deviceID,
				sampleType == sfSampleTypeExpandedFlowSample)
			records = append(records, recs...)
		}
	}
	return records
}

func sfParseFlowSample(data []byte, exporterIP, deviceID string, expanded bool) []map[string]any {
	minLen := 28
	if expanded {
		minLen = 32
	}
	if len(data) < minLen {
		return nil
	}

	off := 4 // skip sequence number

	if expanded {
		off += 8 // source_id_type + source_id_index
	} else {
		off += 4 // source_id
	}

	samplingRate := binary.BigEndian.Uint32(data[off : off+4])
	off += 4
	if samplingRate == 0 {
		samplingRate = 1
	}
	off += 8 // sample_pool + drops

	var inputIf, outputIf uint32
	if expanded {
		if off+16 > len(data) {
			return nil
		}
		inputIf = binary.BigEndian.Uint32(data[off+4 : off+8])
		off += 8
		outputIf = binary.BigEndian.Uint32(data[off+4 : off+8])
		off += 8
	} else {
		if off+8 > len(data) {
			return nil
		}
		inputIf = binary.BigEndian.Uint32(data[off : off+4])
		outputIf = binary.BigEndian.Uint32(data[off+4 : off+8])
		off += 8
	}

	if off+4 > len(data) {
		return nil
	}
	numRecords := binary.BigEndian.Uint32(data[off : off+4])
	off += 4

	now := time.Now().UTC().Format(time.RFC3339Nano)

	var (
		srcIP       string
		dstIP       string
		srcPort     uint16
		dstPort     uint16
		protocol    uint8
		tcpFlags    uint8
		sampRate    = samplingRate
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
			si, di, sp, dp, proto, flags, flen := sfParseRawPacketHeader(recData)
			if si != "" {
				srcIP = si
			}
			if di != "" {
				dstIP = di
			}
			srcPort = sp
			dstPort = dp
			protocol = proto
			tcpFlags = flags
			if flen > 0 {
				frameLength = flen
			}
		}
	}

	r := buildFlowRecord(exporterIP, deviceID, "sflow_v5")
	r["flow_start"] = now
	r["flow_end"] = now
	r["src_ip"] = srcIP
	r["dst_ip"] = dstIP
	r["src_port"] = int(srcPort)
	r["dst_port"] = int(dstPort)
	r["ip_protocol"] = int(protocol)
	r["tcp_flags"] = int(tcpFlags)
	r["bytes"] = int64(frameLength) * int64(sampRate)
	r["packets"] = int64(1) * int64(sampRate)
	r["input_if_index"] = int(inputIf)
	r["output_if_index"] = int(outputIf)
	r["sampling_rate"] = int(sampRate)
	return []map[string]any{r}
}

func sfParseRawPacketHeader(data []byte) (srcIP, dstIP string, srcPort, dstPort uint16, protocol, tcpFlags uint8, frameLength uint32) {
	if len(data) < 16 {
		return
	}
	headerProtocol := binary.BigEndian.Uint32(data[0:4])
	frameLength = binary.BigEndian.Uint32(data[4:8])
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
		srcIP, dstIP, srcPort, dstPort, protocol, tcpFlags = sfParseEthernetHeader(hdr)
	case sfHeaderProtoIPv4:
		srcIP, dstIP, srcPort, dstPort, protocol, tcpFlags = sfParseIPv4Header(hdr)
	case sfHeaderProtoIPv6:
		srcIP, dstIP, srcPort, dstPort, protocol, tcpFlags = sfParseIPv6Header(hdr)
	}
	return
}

func sfParseEthernetHeader(data []byte) (srcIP, dstIP string, srcPort, dstPort uint16, protocol, tcpFlags uint8) {
	if len(data) < 14 {
		return
	}
	etherType := binary.BigEndian.Uint16(data[12:14])
	payload := data[14:]
	if etherType == 0x8100 { // 802.1Q
		if len(payload) < 4 {
			return
		}
		etherType = binary.BigEndian.Uint16(payload[2:4])
		payload = payload[4:]
	}
	switch etherType {
	case 0x0800:
		srcIP, dstIP, srcPort, dstPort, protocol, tcpFlags = sfParseIPv4Header(payload)
	case 0x86DD:
		srcIP, dstIP, srcPort, dstPort, protocol, tcpFlags = sfParseIPv6Header(payload)
	}
	return
}

func sfParseIPv4Header(data []byte) (srcIP, dstIP string, srcPort, dstPort uint16, protocol, tcpFlags uint8) {
	if len(data) < 20 {
		return
	}
	ihl := int(data[0]&0x0F) * 4
	if ihl < 20 {
		ihl = 20
	}
	protocol = data[9]
	srcIP = net.IP{data[12], data[13], data[14], data[15]}.String()
	dstIP = net.IP{data[16], data[17], data[18], data[19]}.String()
	if ihl < len(data) {
		srcPort, dstPort, tcpFlags = sfParseL4(data[ihl:], protocol)
	}
	return
}

func sfParseIPv6Header(data []byte) (srcIP, dstIP string, srcPort, dstPort uint16, protocol, tcpFlags uint8) {
	if len(data) < 40 {
		return
	}
	protocol = data[6]
	src := make(net.IP, 16)
	copy(src, data[8:24])
	dst := make(net.IP, 16)
	copy(dst, data[24:40])
	srcIP = src.String()
	dstIP = dst.String()
	srcPort, dstPort, tcpFlags = sfParseL4(data[40:], protocol)
	return
}

func sfParseL4(data []byte, protocol uint8) (srcPort, dstPort uint16, tcpFlags uint8) {
	switch protocol {
	case 6: // TCP
		if len(data) >= 14 {
			srcPort = binary.BigEndian.Uint16(data[0:2])
			dstPort = binary.BigEndian.Uint16(data[2:4])
			tcpFlags = data[13]
		}
	case 17: // UDP
		if len(data) >= 4 {
			srcPort = binary.BigEndian.Uint16(data[0:2])
			dstPort = binary.BigEndian.Uint16(data[2:4])
		}
	}
	return
}
