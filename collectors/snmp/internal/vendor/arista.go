package vendor

// Arista EOS supports standard HOST-RESOURCES-MIB (CPU, memory) and
// ENTITY-SENSOR-MIB (temperature) on all tested versions. No vendor-specific
// OID overrides are required for Phase 1.
func init() {
	Register(&Profile{
		Name:         "Arista EOS",
		DBVendorType: "arista",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.30065.", // Arista Networks enterprise OID
		},
		Priority: 10,

		// All nil → poller uses standard hrProcessorLoad, hrStorageTable,
		// and ENTITY-SENSOR-MIB paths.
		CPUOIDs:    nil,
		MemoryOIDs: nil,
		TempOIDs:   nil,
	})
}
