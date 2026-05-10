package poller

import (
	"strings"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
	"github.com/rs/zerolog/log"
)

// PollSTPPorts walks dot1dStpPortState and dot1dStpPortRole and returns one
// STPPortResult per bridge port that has a known STP state.
//
// ifByIndex maps ifIndex → interface name; it is accepted for signature
// consistency but the writer resolves IfIndex independently.
//
// If the device does not support STP (empty walk), an empty slice + nil error
// is returned so the poll cycle can continue.
func PollSTPPorts(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.STPPortResult, error) {
	// ── 1. Walk dot1dStpPortState ──────────────────────────────────────────────
	statePDUs, err := s.BulkWalkAll(oid.Dot1dStpPortState)
	if err != nil || len(statePDUs) == 0 {
		if err != nil {
			log.Warn().Err(err).Msg("stp: dot1dStpPortState walk failed")
		}
		return nil, nil
	}

	type portRow struct {
		state int
		role  int
	}
	rows := make(map[int]*portRow)
	ensure := func(port int) *portRow {
		if r, ok := rows[port]; ok {
			return r
		}
		r := &portRow{}
		rows[port] = r
		return r
	}

	stateBase := strings.TrimPrefix(oid.Dot1dStpPortState, ".")
	for _, pdu := range statePDUs {
		port := parseStpPortIndex(pdu.Name, stateBase)
		if port < 0 {
			continue
		}
		ensure(port).state = client.PDUInt(pdu)
	}

	// ── 2. Walk dot1dStpPortRole ───────────────────────────────────────────────
	rolePDUs, err := s.BulkWalkAll(oid.Dot1dStpPortRole)
	if err != nil {
		log.Warn().Err(err).Msg("stp: dot1dStpPortRole walk failed (non-fatal)")
	}
	roleBase := strings.TrimPrefix(oid.Dot1dStpPortRole, ".")
	for _, pdu := range rolePDUs {
		port := parseStpPortIndex(pdu.Name, roleBase)
		if port < 0 {
			continue
		}
		ensure(port).role = client.PDUInt(pdu)
	}

	// ── 3. Build bridge port → ifIndex map ────────────────────────────────────
	bridgePortToIfIdx := buildBridgePortMap(s)

	// ── 4. Assemble results ────────────────────────────────────────────────────
	results := make([]*model.STPPortResult, 0, len(rows))
	for portNum, r := range rows {
		if r.state == 0 {
			continue // no state returned for this port
		}
		ifIdx, ok := bridgePortToIfIdx[portNum]
		if !ok {
			if len(bridgePortToIfIdx) > 0 {
				continue // map exists but port not in it — skip
			}
			ifIdx = portNum // no bridge map → assume portNum == ifIndex (Arista EOS)
		}
		results = append(results, &model.STPPortResult{
			DeviceID: deviceID,
			IfIndex:  ifIdx,
			State:    stpStateName(r.state),
			Role:     stpRoleName(r.role),
		})
	}
	return results, nil
}

// parseStpPortIndex returns the bridge port number from a dot1dStpPort* PDU name.
// The OID suffix after the column base is simply the port number.
func parseStpPortIndex(pduName, columnBase string) int {
	full := strings.TrimPrefix(pduName, ".")
	if !strings.HasPrefix(full, columnBase+".") {
		return -1
	}
	suffix := full[len(columnBase)+1:]
	// suffix should be a plain integer (the bridge port number)
	n := 0
	for _, c := range suffix {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return -1
	}
	return n
}

func stpStateName(v int) string {
	switch v {
	case 1:
		return "disabled"
	case 2:
		return "blocking"
	case 3:
		return "listening"
	case 4:
		return "learning"
	case 5:
		return "forwarding"
	default:
		return "disabled"
	}
}

func stpRoleName(v int) string {
	switch v {
	case 1:
		return "root"
	case 2:
		return "designated"
	case 3:
		return "alternate"
	case 4:
		return "backup"
	default:
		return "unknown"
	}
}
