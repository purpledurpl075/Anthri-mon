package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// Cisco NX-OS (Nexus switches) uses the enterprise prefix 1.3.6.1.4.1.9.12
// and its sysDescr always contains "NX-OS".
func init() {
	Register(&Profile{
		Name:         "Cisco NX-OS",
		DBVendorType: "cisco_nxos",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.9.12.", // Nexus platform OID space
			"1.3.6.1.4.1.9.1.",  // Some NX-OS devices use the generic Cisco prefix
		},
		SysDescrPatterns: []string{
			`NX-OS`,
			`Nexus`,
		},
		Priority: 20,

		// NX-OS supports CISCO-PROCESS-MIB on most versions.
		CPUOIDs: &OIDSet{
			Walk: []string{oid.CpmCPUTotal5minRev},
		},

		MemoryOIDs: nil, // hrStorageTable works on NX-OS

		// NX-OS exposes temperature via ENTITY-SENSOR-MIB.
		TempOIDs: nil,
	})
}
