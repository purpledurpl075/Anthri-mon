package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// Aruba-CX (ArubaOS-CX) switches support standard HOST-RESOURCES-MIB
// and ENTITY-SENSOR-MIB. OID prefix 47196 is the current Aruba Networks
// enterprise assignment; some older devices may appear under HP/Agilent (11).
func init() {
	Register(&Profile{
		Name:         "Aruba-CX",
		DBVendorType: "aruba_cx",
		DBDeviceType: "switch",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.47196.", // Aruba Networks (current)
			"1.3.6.1.4.1.11.",    // HP/Agilent legacy prefix used by some Aruba hardware
		},
		// Must require "ArubaOS-CX" explicitly — the HP enterprise prefix
		// 1.3.6.1.4.1.11 is shared with ProCurve/legacy ArubaOS, which is a
		// separate platform handled in procurve.go.
		SysDescrPatterns: []string{
			`ArubaOS-CX`,
		},
		Priority: 10,

		// sysUpTime resets whenever the AOS-CX SNMP agent process restarts,
		// which happens during config commits and watchdog cycles. Use
		// hrSystemUptime instead — it tracks actual OS uptime and is unaffected
		// by agent restarts.
		UptimeOID: oid.HrSystemUptime,

		CPUOIDs:    nil,
		MemoryOIDs: nil,
		TempOIDs:   nil,
	})
}
