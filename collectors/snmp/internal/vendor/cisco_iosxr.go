package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// Cisco IOS-XR uses the same enterprise OID prefix as IOS but its sysDescr
// always contains "IOS XR". It also supports ENTITY-SENSOR-MIB for temperature
// and CISCO-PROCESS-MIB for CPU (both standard for modern Cisco platforms).
func init() {
	Register(&Profile{
		Name:         "Cisco IOS-XR",
		DBVendorType: "cisco_iosxr",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.9.1.",
		},
		SysDescrPatterns: []string{
			`IOS XR`,
			`IOS-XR`,
		},
		// Higher priority than cisco_ios so IOS-XR wins the tiebreak when
		// both patterns could theoretically match.
		Priority: 20,

		CPUOIDs: &OIDSet{
			Walk: []string{oid.CpmCPUTotal5minRev},
		},

		// hrStorageTable is unreliable on IOS-XR for physical RAM; the Cisco
		// PROCESS-MIB doesn't expose memory either. Standard hrStorageTable
		// returns what it can — acceptable for Phase 1.
		MemoryOIDs: nil,

		// IOS-XR supports ENTITY-SENSOR-MIB (standard) on all modern versions.
		// The poller's default temperature path handles this.
		TempOIDs: nil,
	})
}
