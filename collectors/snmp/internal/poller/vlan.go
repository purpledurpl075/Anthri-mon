package poller

import (
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
	"github.com/rs/zerolog/log"
)

// PollVLANs walks the Q-BRIDGE-MIB tables and returns per-VLAN metadata and
// per-interface VLAN membership records.
//
// ifByIndex maps ifIndex → interface name and is used only for internal
// resolution; the writer resolves IfIndex to interface_id independently.
//
// All walk failures are treated as non-fatal: an empty slice + nil error is
// returned so the poll cycle can continue.
func PollVLANs(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.VLANResult, []*model.InterfaceVLANResult, error) {
	// ── 1. Walk dot1qVlanStaticName → vlan_id → name ──────────────────────────
	namePDUs, err := s.BulkWalkAll(oid.Dot1qVlanStaticName)
	if err != nil || len(namePDUs) == 0 {
		if err != nil {
			log.Warn().Err(err).Msg("vlan: dot1qVlanStaticName walk failed")
		}
		return nil, nil, nil
	}

	vlanNames := make(map[int]string) // vlanID → name
	base := strings.TrimPrefix(oid.Dot1qVlanStaticName, ".")
	for _, pdu := range namePDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, base+".") {
			continue
		}
		suffix := full[len(base)+1:]
		vlanID, err := strconv.Atoi(suffix)
		if err != nil {
			continue
		}
		vlanNames[vlanID] = client.PDUString(pdu)
	}

	vlans := make([]*model.VLANResult, 0, len(vlanNames))
	for id, name := range vlanNames {
		vlans = append(vlans, &model.VLANResult{
			DeviceID: deviceID,
			VlanID:   id,
			Name:     name,
		})
	}

	// ── 2. Build bridge port → ifIndex mapping (dot1dBasePortTable col 2) ─────
	bridgePortToIfIdx := buildBridgePortMap(s)

	// ── 3. Walk dot1qVlanCurrentEgressPorts ───────────────────────────────────
	egressPDUs, err := s.BulkWalkAll(oid.Dot1qVlanCurrentEgressPorts)
	if err != nil || len(egressPDUs) == 0 {
		if err != nil {
			log.Warn().Err(err).Msg("vlan: dot1qVlanCurrentEgressPorts walk failed")
		}
		// Return VLANs we have but no interface membership.
		return vlans, nil, nil
	}
	egressBitmaps := make(map[int][]byte) // vlanID → bitmap
	for _, pdu := range egressPDUs {
		vlanID, ok := parseVlanCurrentIndex(pdu.Name, oid.Dot1qVlanCurrentEgressPorts)
		if !ok {
			continue
		}
		if b, ok := pdu.Value.([]byte); ok {
			egressBitmaps[vlanID] = b
		}
	}

	// ── 4. Walk dot1qVlanCurrentUntaggedPorts ─────────────────────────────────
	untagPDUs, err := s.BulkWalkAll(oid.Dot1qVlanCurrentUntaggedPorts)
	if err != nil {
		log.Warn().Err(err).Msg("vlan: dot1qVlanCurrentUntaggedPorts walk failed (non-fatal)")
	}
	untagBitmaps := make(map[int][]byte) // vlanID → bitmap
	for _, pdu := range untagPDUs {
		vlanID, ok := parseVlanCurrentIndex(pdu.Name, oid.Dot1qVlanCurrentUntaggedPorts)
		if !ok {
			continue
		}
		if b, ok := pdu.Value.([]byte); ok {
			untagBitmaps[vlanID] = b
		}
	}

	// ── 5. Build InterfaceVLANResults from egress bitmaps ─────────────────────
	var ifvlans []*model.InterfaceVLANResult
	for vlanID, egress := range egressBitmaps {
		untag := untagBitmaps[vlanID]
		for portNum := 1; portNum <= len(egress)*8; portNum++ {
			if !bitmapBitSet(egress, portNum) {
				continue
			}
			ifIdx, ok := bridgePortToIfIdx[portNum]
			if !ok {
				continue
			}
			tagged := !bitmapBitSet(untag, portNum)
			ifvlans = append(ifvlans, &model.InterfaceVLANResult{
				DeviceID: deviceID,
				IfIndex:  ifIdx,
				VlanID:   vlanID,
				Tagged:   tagged,
			})
		}
	}

	return vlans, ifvlans, nil
}

// buildBridgePortMap walks dot1dBasePortTable and returns a map of
// bridge port number → ifIndex.  Errors are swallowed — callers get an empty map.
func buildBridgePortMap(s *client.Session) map[int]int {
	portPDUs, err := s.BulkWalkAll(oid.MACPortTable)
	m := make(map[int]int)
	if err != nil {
		log.Warn().Err(err).Msg("vlan: dot1dBasePortTable walk failed")
		return m
	}
	for _, pdu := range portPDUs {
		col, portNum := splitBridgePortIndex(pdu.Name)
		if col == 2 && portNum > 0 { // dot1dBasePortIfIndex
			m[portNum] = client.PDUInt(pdu)
		}
	}
	return m
}

// parseVlanCurrentIndex extracts the VlanIndex from a dot1qVlanCurrent* PDU name.
// The OID suffix after the table base is: col.TimeMark.VlanIndex
// We skip TimeMark and return VlanIndex.
func parseVlanCurrentIndex(pduName, tableBase string) (vlanID int, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableBase, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, false
	}
	// suffix = "timeMark.vlanID"
	suffix := full[len(base)+1:]
	dot := strings.LastIndex(suffix, ".")
	if dot < 0 {
		return 0, false
	}
	id, err := strconv.Atoi(suffix[dot+1:])
	if err != nil {
		return 0, false
	}
	return id, true
}

// bitmapBitSet reports whether bridge port portNum (1-indexed, MSB-first) is
// set in the given octet-string bitmap.
func bitmapBitSet(bitmap []byte, portNum int) bool {
	if len(bitmap) == 0 || portNum < 1 {
		return false
	}
	idx := (portNum - 1) / 8
	bit := 7 - (portNum-1)%8
	if idx >= len(bitmap) {
		return false
	}
	return (bitmap[idx]>>uint(bit))&1 == 1
}
