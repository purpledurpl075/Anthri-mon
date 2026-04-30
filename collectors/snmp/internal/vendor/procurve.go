package vendor

// HP ProCurve and legacy ArubaOS switching platform.
// This covers the older HP ProCurve switch line (J-series, E-series) and the
// Aruba-branded versions sold post-HPE acquisition (Aruba 2530, 2540, 2930,
// etc.) that run ProVision/ProCurve firmware — NOT ArubaOS-CX, which is a
// separate platform handled in aruba_cx.go.
//
// Key firmware families:
//   K.xx  — oldest ProCurve (5300/3400/2600 series); hrProcessorLoad unreliable
//   YA/YB — mid-gen (2900/2600v2); standard MIBs generally work
//   WA/WB — current ProCurve/Aruba-branded (2530/2930/5400R); full standard MIB support
//
// All three share the HP enterprise OID prefix 1.3.6.1.4.1.11.
func init() {
	Register(&Profile{
		Name:         "HP ProCurve / Aruba (legacy)",
		DBVendorType: "procurve",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.11.2.3.7.", // HP ProCurve switch-specific sub-tree
			"1.3.6.1.4.1.11.",       // HP/Agilent enterprise fallback
		},
		// Match ProCurve and the Aruba-branded variants that do NOT run CX.
		// "ArubaOS-CX" is intentionally excluded — that goes to aruba_cx.go.
		SysDescrPatterns: []string{
			`ProCurve`,
			`HP Switch`,
			`HP OfficeConnect`,
			`Aruba \d`,         // "Aruba 2530", "Aruba 2930F", etc.
			`HP J\d`,           // "HP J9088A" style sysDescr on older models
		},
		// Lower priority than aruba_cx so the CX profile wins when both
		// OID prefix and "Aruba" text match (belt-and-suspenders safety).
		Priority: 5,

		// Standard hrProcessorLoad works on YA firmware and later.
		// K-firmware devices return 0 — those will show CPU as unavailable
		// rather than wrong. Vendor-specific OID can be added here when
		// K-firmware lab testing confirms the exact OID path.
		CPUOIDs: nil,

		// hrStorageTable works on all supported firmware versions.
		MemoryOIDs: nil,

		// Newer ProCurve/Aruba switches support ENTITY-SENSOR-MIB for temperature.
		// Older models (pre-YA) may not expose temperature at all.
		TempOIDs: nil,
	})
}
