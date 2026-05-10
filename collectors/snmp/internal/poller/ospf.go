package poller

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/gosnmp/gosnmp"
	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollOSPFNeighbours walks ospfNbrTable and ospfIfTable.
func PollOSPFNeighbours(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.OSPFNeighbour, error) {
	nbrPDUs, err := s.BulkWalkAll(oid.OSPFNbrTable)
	if err != nil || len(nbrPDUs) == 0 {
		return nil, err
	}

	// Walk ospfIfTable to map interface IP → area.
	ifPDUs, _ := s.BulkWalkAll(oid.OSPFIfTable)
	ifAreaMap := make(map[string]string) // interfaceIP → area dotted-decimal
	for _, pdu := range ifPDUs {
		col, ifIP, _ := splitOSPF4Index(pdu.Name, oid.OSPFIfTable)
		if col == 3 { // ospfIfAreaId
			if area := ospfIPFromPDU(pdu); area != "" {
				ifAreaMap[ifIP] = area
			}
		}
	}

	type rowKey struct {
		ip      string
		addrless int
	}
	type row struct {
		routerID string
		state    int
		priority int
		events   int64
	}
	rows := make(map[rowKey]*row)
	ensure := func(k rowKey) *row {
		if r, ok := rows[k]; ok { return r }
		r := &row{}; rows[k] = r; return r
	}

	for _, pdu := range nbrPDUs {
		col, nbrIP, addrless := splitOSPF4Index(pdu.Name, oid.OSPFNbrTable)
		if col < 0 || nbrIP == "" { continue }
		k := rowKey{nbrIP, addrless}
		r := ensure(k)
		switch col {
		case 3: // ospfNbrRtrId
			r.routerID = ospfIPFromPDU(pdu)
		case 5: // ospfNbrPriority
			r.priority = client.PDUInt(pdu)
		case 6: // ospfNbrState
			r.state = client.PDUInt(pdu)
		case 7: // ospfNbrEvents
			r.events = int64(client.PDUUint64(pdu))
		}
	}

	results := make([]*model.OSPFNeighbour, 0, len(rows))
	for k, r := range rows {
		if r.state == 0 { continue }
		results = append(results, &model.OSPFNeighbour{
			DeviceID:    deviceID,
			NeighbourIP: k.ip,
			RouterID:    r.routerID,
			State:       ospfStateName(r.state),
			Priority:    r.priority,
			Events:      r.events,
			Area:        ifAreaMap[k.ip],
		})
	}
	return results, nil
}

// splitOSPF4Index parses col, dotted-IP, and addressLessIndex from an OSPF table PDU.
// Both ospfNbrTable and ospfIfTable use the same index structure:
//   col.a.b.c.d.addressLessIndex
func splitOSPF4Index(pduName, tableOID string) (col int, ip string, addrless int) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableOID, ".")
	if !strings.HasPrefix(full, base+".") {
		return -1, "", 0
	}
	parts := strings.Split(full[len(base)+1:], ".")
	if len(parts) < 6 {
		return -1, "", 0
	}
	c, _ := strconv.Atoi(parts[0])
	ip = strings.Join(parts[1:5], ".")
	al, _ := strconv.Atoi(parts[5])
	return c, ip, al
}

// ospfIPFromPDU extracts a dotted-decimal IP from an OSPF MIB PDU.
// gosnmp returns IpAddress as net.IP ([]byte of length 4).
func ospfIPFromPDU(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case []byte:
		if len(v) == 4 {
			return fmt.Sprintf("%d.%d.%d.%d", v[0], v[1], v[2], v[3])
		}
	case string:
		return strings.TrimSpace(v)
	}
	return ""
}

func ospfStateName(v int) string {
	switch v {
	case 1: return "down"
	case 2: return "attempt"
	case 3: return "init"
	case 4: return "two_way"
	case 5: return "exstart"
	case 6: return "exchange"
	case 7: return "loading"
	case 8: return "full"
	default: return "unknown"
	}
}
