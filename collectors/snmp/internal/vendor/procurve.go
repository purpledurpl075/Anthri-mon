package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// HP ProCurve and legacy ArubaOS switching platform.
// This covers the older HP ProCurve switch line (J-series, E-series) and the
// Aruba-branded versions sold post-HPE acquisition (Aruba 2530, 2540, 2930,
// etc.) that run ProVision/ProCurve firmware — NOT ArubaOS-CX, which is a
// separate platform handled in aruba_cx.go.
//
// Key firmware families:
//   K.xx  — oldest ProCurve (5300/3400/2600 series)
//   YA/YB — mid-gen (2900/2600v2)
//   WA/WB — current ProCurve/Aruba-branded (2530/2930/5400R)
//
// hrProcessorLoad returns 0 on all ProVision/ProCurve firmware.
// CPU is exposed via HP-ICF-CHASSIS-MIB hpicfChassisCpuUtil scalar instead.
// Memory is exposed via HP-ICF MIB table, not hrStorageTable.
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
			`Aruba \d`,  // "Aruba 2530", "Aruba 2930F", etc.
			`HP J\d`,    // "HP J9088A" style sysDescr on older models
		},
		// Lower priority than aruba_cx so the CX profile wins when both
		// OID prefix and "Aruba" text match (belt-and-suspenders safety).
		Priority: 5,

		// hpicfChassisCpuUtil scalar — 1-minute CPU % average.
		CPUOIDs: &OIDSet{
			Scalar: []string{oid.HpicfChassisCpuUtil},
		},

		// HP-ICF memory table entry: col 3 = allocated bytes, col 4 = free bytes.
		// Walk the entry-level OID so splitTableOID resolves col.idx correctly.
		MemoryOIDs: &OIDSet{
			Walk: []string{oid.HpicfMemEntry},
		},

		// ENTITY-SENSOR-MIB temperature works on WA/WB firmware.
		// Older firmware may return empty — that is handled gracefully.
		TempOIDs: nil,
	})
}
