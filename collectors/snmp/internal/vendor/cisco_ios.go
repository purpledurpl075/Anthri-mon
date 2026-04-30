package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// Cisco IOS and IOS-XE share the same sysObjectID enterprise prefix.
// Disambiguated from IOS-XR and NX-OS via sysDescr pattern matching.
// IOS-XE is treated identically to IOS for collection purposes.
func init() {
	Register(&Profile{
		Name:         "Cisco IOS/IOS-XE",
		DBVendorType: "cisco_ios",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.9.1.",  // Cisco enterprise routers/switches
			"1.3.6.1.4.1.9.6.",  // Cisco Catalyst WS-C range
		},
		// Exclude IOS-XR and NX-OS which share 1.3.6.1.4.1.9.
		SysDescrPatterns: []string{
			`Cisco IOS Software`,
			`IOS-XE`,
			`Cisco Internetwork Operating System`,
		},
		Priority: 10,

		// Cisco PROCESS-MIB gives a more accurate 5-minute CPU average than
		// the standard hrProcessorLoad (which may reflect a 1-minute window
		// on some IOS versions).
		CPUOIDs: &OIDSet{
			Walk: []string{oid.CpmCPUTotal5minRev},
		},

		// Standard hrStorageTable works fine on IOS/IOS-XE.
		MemoryOIDs: nil,

		// CISCO-ENVMON-MIB temperature table — widely supported on Cisco hardware.
		TempOIDs: &OIDSet{
			Walk: []string{oid.CiscoEnvMonTempTable},
		},
	})
}
