// Package poller implements the per-device SNMP polling logic.
package poller

import (
	"time"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/vendor"
)

// PollSysInfo fetches the RFC 1213 system group scalars from the device and
// runs vendor auto-detection using the returned sysObjectID and sysDescr.
// This is always the first poll on any device — results drive which OIDs are
// used for subsequent interface and health polls.
func PollSysInfo(s *client.Session, deviceID uuid.UUID) (*model.DeviceInfo, error) {
	scalarOIDs := []string{
		oid.SysDescr,
		oid.SysObjectID,
		oid.SysUpTime,
		oid.SysContact,
		oid.SysName,
		oid.SysLocation,
	}

	pdus, err := s.Get(scalarOIDs)
	if err != nil {
		return nil, err
	}

	info := &model.DeviceInfo{
		DeviceID: deviceID,
		PollTime: time.Now().UTC(),
	}

	for _, pdu := range pdus {
		switch {
		case endsWith(pdu.Name, oid.SysDescr):
			info.SysDescr = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysObjectID):
			info.SysObjectID = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysUpTime):
			info.SysUpTimeTicks = uint32(client.PDUUint64(pdu))
		case endsWith(pdu.Name, oid.SysContact):
			info.SysContact = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysName):
			info.SysName = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysLocation):
			info.SysLocation = client.PDUString(pdu)
		}
	}

	// Auto-detect vendor from the received OID and sysDescr.
	if p := vendor.Detect(info.SysObjectID, info.SysDescr); p != nil {
		info.VendorName = p.Name
		info.DBVendorType = p.DBVendorType
		info.DBDeviceType = p.DBDeviceType
	} else {
		info.VendorName = "unknown"
		info.DBVendorType = "unknown"
	}

	return info, nil
}

// PollSysUpTime fetches only the sysUpTime scalar (1.3.6.1.2.1.1.3.0).
// Used on interface poll ticks where only the uptime counter is needed for
// ifLastChange calculations — avoids a full 6-OID PollSysInfo round-trip.
func PollSysUpTime(s *client.Session) (uint32, error) {
	pdus, err := s.Get([]string{oid.SysUpTime})
	if err != nil {
		return 0, err
	}
	if len(pdus) == 0 {
		return 0, nil
	}
	return uint32(client.PDUUint64(pdus[0])), nil
}

// endsWith is a loose OID suffix match that handles leading dots from gosnmp.
func endsWith(pduName, oidSuffix string) bool {
	// gosnmp returns names like ".1.3.6.1.2.1.1.1.0"
	// oidSuffix may or may not have a leading dot — strip both and compare suffix.
	name := trimDot(pduName)
	suffix := trimDot(oidSuffix)
	return name == suffix
}

func trimDot(s string) string {
	if len(s) > 0 && s[0] == '.' {
		return s[1:]
	}
	return s
}
