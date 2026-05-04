// Package vendor defines the VendorProfile data structure and helpers.
//
// Adding support for a new vendor requires only one new file in this package:
//
//  1. Declare a VendorProfile struct literal.
//  2. Call Register(&profile) in an init() function.
//
// No other files need to change. The auto-detection logic in registry.go
// handles everything else.
package vendor

// OIDSet describes a set of SNMP OIDs used to collect a specific metric class.
// Walk OIDs are passed to BulkWalkAll; Scalar OIDs are fetched with a single GET.
type OIDSet struct {
	Walk   []string // table/subtree OIDs — use BulkWalkAll
	Scalar []string // scalar OIDs — use a single GET
}

// Profile describes one vendor's SNMP characteristics.
// Only fill in the fields that differ from standard MIB behaviour.
// Nil OIDSet fields tell the poller to use the standard MIBs instead.
type Profile struct {
	// Human-readable vendor name for logging.
	Name string

	// PostgreSQL vendor_type enum value (e.g. "cisco_iosxr").
	// Must match a value in the vendor_type enum from 001_init.sql.
	// New vendors not yet in the DB enum should use "unknown" here until
	// the enum is extended with ALTER TYPE vendor_type ADD VALUE '...'.
	DBVendorType string

	// PostgreSQL device_type enum value inferred from the vendor profile.
	// One of: router, switch, firewall, load_balancer, wireless_controller, unknown.
	// Leave empty to keep the current value in the DB (no overwrite).
	DBDeviceType string

	// SysObjectID OID prefix(es) for this vendor.
	// Detection: if the device's sysObjectID starts with ANY of these prefixes,
	// this profile is a candidate match.
	// Use the most specific prefix possible to avoid false positives.
	SysObjectIDPrefixes []string

	// SysDescrPatterns are Go regexp strings applied to the sysDescr OID
	// value to disambiguate between vendors that share a sysObjectID prefix
	// (e.g. Cisco IOS vs IOS-XR vs NX-OS all share 1.3.6.1.4.1.9.).
	// If any pattern matches, this profile wins the tiebreak.
	SysDescrPatterns []string

	// Priority breaks ties when multiple profiles match the same device.
	// Higher number = higher priority. Defaults to 0.
	Priority int

	// Optional vendor-specific OID overrides. Nil = use standard MIBs.

	// CPUOIDS overrides hrProcessorLoad for CPU collection.
	CPUOIDs *OIDSet

	// MemoryOIDs overrides hrStorageTable for memory collection.
	MemoryOIDs *OIDSet

	// TempOIDs overrides ENTITY-SENSOR-MIB for temperature collection.
	TempOIDs *OIDSet
}
