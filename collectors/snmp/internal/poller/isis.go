package poller

import (
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/gosnmp/gosnmp"
	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollISISAdjacencies walks ISIS-MIB isisISAdjTable and isisISAdjIPAddrTable.
// It also walks isisCircTable to resolve circuit index → interface name.
// sysUpTimeTicks is used to calculate adjacency uptime from isisISAdjLastUpTime.
func PollISISAdjacencies(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string, sysUpTimeTicks uint32) ([]*model.ISISAdjacency, error) {
	adjPDUs, err := s.BulkWalkAll(oid.ISISAdjTable)
	if err != nil || len(adjPDUs) == 0 {
		return nil, err
	}

	// Build circuit index → ifIndex map from isisCircTable.
	circPDUs, _ := s.BulkWalkAll(oid.ISISCircTable)
	circToIfIdx := make(map[int]int)
	for _, pdu := range circPDUs {
		col, circIdx, _ := splitISISCircIndex(pdu.Name, oid.ISISCircTable)
		if col == 2 { // isisCircIfIndex
			circToIfIdx[circIdx] = client.PDUInt(pdu)
		}
	}

	// Build adjacency IP addresses from isisISAdjIPAddrTable.
	ipPDUs, _ := s.BulkWalkAll(oid.ISISAdjIPTable)
	type adjKey struct{ circ, adj int }
	type adjIPs struct{ ipv4, ipv6 string }
	ipMap := make(map[adjKey]adjIPs)
	for _, pdu := range ipPDUs {
		col, circIdx, adjIdx, _, _ := splitISISAdjIPIndex(pdu.Name, oid.ISISAdjIPTable)
		if col != 3 { // isisISAdjIPAddrAddress
			continue
		}
		k := adjKey{circIdx, adjIdx}
		ip := isisIPFromPDU(pdu)
		if strings.Contains(ip, ":") {
			e := ipMap[k]; e.ipv6 = ip; ipMap[k] = e
		} else if ip != "" {
			e := ipMap[k]; e.ipv4 = ip; ipMap[k] = e
		}
	}

	type adjRow struct {
		instance string
		state    int
		sysID    string
		usage    int
		lastUp   uint32
	}
	rows := make(map[adjKey]*adjRow)
	ensureRow := func(k adjKey, inst string) *adjRow {
		if r, ok := rows[k]; ok {
			return r
		}
		r := &adjRow{instance: inst}
		rows[k] = r
		return r
	}

	for _, pdu := range adjPDUs {
		col, circIdx, adjIdx, inst := splitISISAdjIndex(pdu.Name, oid.ISISAdjTable)
		if col < 0 {
			continue
		}
		k := adjKey{circIdx, adjIdx}
		r := ensureRow(k, inst)
		switch col {
		case 2: // isisISAdjState: 1=down,2=initializing,3=up,4=failed
			r.state = client.PDUInt(pdu)
		case 5: // isisISAdjNeighSysID: 6-byte neighbour system-id
			r.sysID = isisFormatSysID(pdu)
		case 7: // isisISAdjUsage: 1=undefined,2=level-1,3=level-2,4=level-1-2
			r.usage = client.PDUInt(pdu)
		case 10: // isisISAdjLastUpTime: TimeTicks when last entered Up
			r.lastUp = uint32(client.PDUUint64(pdu))
		}
	}

	results := make([]*model.ISISAdjacency, 0, len(rows))
	for k, r := range rows {
		if r.state == 0 {
			continue
		}
		ifName := ifByIndex[circToIfIdx[k.circ]]
		ips := ipMap[k]

		var uptimeSecs int64
		if r.state == 3 && r.lastUp > 0 && sysUpTimeTicks >= r.lastUp {
			// lastUpTime is a TimeTicks timestamp (hundredths of a second since agent start)
			uptimeSecs = int64(sysUpTimeTicks-r.lastUp) / 100
		}

		results = append(results, &model.ISISAdjacency{
			DeviceID:      deviceID,
			Instance:      r.instance,
			SysID:         r.sysID,
			InterfaceName: ifName,
			CircuitType:   isisLevelName(r.usage),
			AdjState:      isisAdjStateName(r.state),
			IPv4Address:   ips.ipv4,
			IPv6Address:   ips.ipv6,
			UptimeSeconds: uptimeSecs,
		})
	}
	return results, nil
}

// ── Index parsers ─────────────────────────────────────────────────────────────
//
// ISIS-MIB indices encode isisSysInstance as a length-prefixed OctetString.
// For the default/empty instance the length is 0 and no characters follow.

// splitISISAdjIndex extracts (col, circIndex, adjIndex, instance) from isisISAdjTable.
// OID tail: col.instLen[.instChars*].circIdx.adjIdx
func splitISISAdjIndex(pduName, tableOID string) (col, circIdx, adjIdx int, instance string) {
	parts, ok := isisStripBase(pduName, tableOID)
	if !ok || len(parts) < 4 {
		return -1, 0, 0, ""
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+2 {
		return -1, 0, 0, ""
	}
	circIdx, _ = strconv.Atoi(parts[2+skip])
	adjIdx, _ = strconv.Atoi(parts[2+skip+1])
	return col, circIdx, adjIdx, inst
}

// splitISISCircIndex extracts (col, circIndex, instance) from isisCircTable.
// OID tail: col.instLen[.instChars*].circIdx
func splitISISCircIndex(pduName, tableOID string) (col, circIdx int, instance string) {
	parts, ok := isisStripBase(pduName, tableOID)
	if !ok || len(parts) < 3 {
		return -1, 0, ""
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+1 {
		return -1, 0, ""
	}
	circIdx, _ = strconv.Atoi(parts[2+skip])
	return col, circIdx, inst
}

// splitISISAdjIPIndex extracts (col, circIdx, adjIdx, ipIdx, instance) from isisISAdjIPAddrTable.
// OID tail: col.instLen[.instChars*].circIdx.adjIdx.ipIdx
func splitISISAdjIPIndex(pduName, tableOID string) (col, circIdx, adjIdx, ipIdx int, instance string) {
	parts, ok := isisStripBase(pduName, tableOID)
	if !ok || len(parts) < 5 {
		return -1, 0, 0, 0, ""
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+3 {
		return -1, 0, 0, 0, ""
	}
	circIdx, _ = strconv.Atoi(parts[2+skip])
	adjIdx, _ = strconv.Atoi(parts[2+skip+1])
	ipIdx, _ = strconv.Atoi(parts[2+skip+2])
	return col, circIdx, adjIdx, ipIdx, inst
}

// isisStripBase strips the table OID prefix and returns the remaining parts.
func isisStripBase(pduName, tableOID string) ([]string, bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableOID, ".")
	if !strings.HasPrefix(full, base+".") {
		return nil, false
	}
	return strings.Split(full[len(base)+1:], "."), true
}

// isisParseInstance reads the length-prefixed OctetString instance from OID parts.
// Returns (instance string, number of parts consumed after the length byte).
// parts[0] is the length integer.
func isisParseInstance(parts []string) (string, int) {
	if len(parts) == 0 {
		return "", -1
	}
	instLen, err := strconv.Atoi(parts[0])
	if err != nil || instLen < 0 || len(parts) < 1+instLen {
		return "", -1
	}
	b := make([]byte, instLen)
	for i := 0; i < instLen; i++ {
		v, e := strconv.Atoi(parts[1+i])
		if e != nil {
			return "", -1
		}
		b[i] = byte(v)
	}
	// consumed parts[0] (length) + instLen chars = instLen chars after the length byte
	return string(b), instLen
}

// ── PDU value helpers ─────────────────────────────────────────────────────────

// isisIPFromPDU decodes an InetAddress PDU value to a dotted or colon notation string.
func isisIPFromPDU(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if !ok {
		return ""
	}
	switch len(b) {
	case 4:
		return fmt.Sprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
	case 16:
		return net.IP(b).String()
	}
	return ""
}

// isisFormatSysID converts a 6-byte IS-IS system-id PDU value to "xxxx.xxxx.xxxx" notation.
func isisFormatSysID(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if !ok || len(b) != 6 {
		return ""
	}
	return fmt.Sprintf("%02x%02x.%02x%02x.%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5])
}

func isisLevelName(usage int) string {
	switch usage {
	case 2:
		return "level-1"
	case 3:
		return "level-2"
	case 4:
		return "level-1-2"
	default:
		return "unknown" // 1=undefined (adjacency still initializing)
	}
}

func isisAdjStateName(state int) string {
	switch state {
	case 1:
		return "down"
	case 2:
		return "initializing"
	case 3:
		return "up"
	case 4:
		return "failed"
	default:
		return "unknown"
	}
}
