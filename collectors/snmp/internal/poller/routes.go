package poller

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollRouteTable walks ipCidrRouteTable (RFC 2096) and returns connected,
// static and OSPF routes. BGP and IS-IS entries are skipped for now.
func PollRouteTable(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.RouteEntry, error) {
	pdus, err := s.BulkWalkAll(oid.IPCidrRouteTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	// Key = "dest/mask/tos/nexthop" string formed from OID index.
	type rowKey struct{ dest, mask, nexthop string }
	type row struct {
		ifIndex  int
		proto    int
		routeType int
		metric   int
	}
	rows := make(map[rowKey]*row)
	ensure := func(k rowKey) *row {
		if r, ok := rows[k]; ok { return r }
		r := &row{}; rows[k] = r; return r
	}

	for _, pdu := range pdus {
		col, dest, mask, nexthop, ok := splitCidrRouteIndex(pdu.Name)
		if !ok { continue }
		k := rowKey{dest, mask, nexthop}
		r := ensure(k)
		switch col {
		case 5: r.ifIndex   = client.PDUInt(pdu)
		case 6: r.routeType = client.PDUInt(pdu)
		case 7: r.proto     = client.PDUInt(pdu)
		case 11: r.metric   = client.PDUInt(pdu)
		}
	}

	results := make([]*model.RouteEntry, 0, len(rows))
	for k, r := range rows {
		proto := cidrProtoName(r.proto)
		if proto == "" {
			continue // skip BGP, IS-IS, etc.
		}
		if r.routeType == 2 {
			continue // reject/null route
		}

		prefixLen := maskToPrefixLen(k.mask)
		dest := fmt.Sprintf("%s/%d", k.dest, prefixLen)

		nextHop := k.nexthop
		if nextHop == "0.0.0.0" || proto == "connected" {
			nextHop = ""
		}

		ifName := ifByIndex[r.ifIndex]

		results = append(results, &model.RouteEntry{
			DeviceID:      deviceID,
			Destination:   dest,
			NextHop:       nextHop,
			Protocol:      proto,
			Metric:        r.metric,
			InterfaceName: ifName,
		})
	}
	return results, nil
}

// splitCidrRouteIndex parses the ipCidrRouteTable OID index.
// Suffix format after table base: col.a.b.c.d.ma.mb.mc.md.tos.na.nb.nc.nd
func splitCidrRouteIndex(pduName string) (col int, dest, mask, nexthop string, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oid.IPCidrRouteTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, "", "", "", false
	}
	parts := strings.Split(full[len(base)+1:], ".")
	// col(0) + dest(1-4) + mask(5-8) + tos(9) + nexthop(10-13) = 14 parts minimum
	if len(parts) < 14 {
		return 0, "", "", "", false
	}
	c, err := strconv.Atoi(parts[0])
	if err != nil { return 0, "", "", "", false }

	dest   = strings.Join(parts[1:5],   ".")
	mask   = strings.Join(parts[5:9],   ".")
	nexthop= strings.Join(parts[10:14], ".")
	return c, dest, mask, nexthop, true
}

// cidrProtoName maps ipCidrProto integer to our protocol string.
// Returns "" for protocols we skip (BGP, IS-IS, etc.).
func cidrProtoName(v int) string {
	switch v {
	case 2: return "connected" // local
	case 3: return "static"    // netmgmt
	case 9: return "ospf"
	case 1: return "other"
	default: return "" // skip BGP(13), ISIS(14), IGRP(7), EIGRP(11), RIP(8), etc.
	}
}
