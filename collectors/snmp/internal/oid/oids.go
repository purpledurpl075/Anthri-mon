// Package oid centralises every OID used across all pollers.
// Adding support for a new MIB means adding constants here — no OID strings
// scattered elsewhere in the codebase.
package oid

// ── System MIB (RFC 1213 / SNMPv2-MIB) ──────────────────────────────────────

const (
	SysDescr    = "1.3.6.1.2.1.1.1.0"
	SysObjectID = "1.3.6.1.2.1.1.2.0"
	SysUpTime   = "1.3.6.1.2.1.1.3.0"
	SysContact  = "1.3.6.1.2.1.1.4.0"
	SysName     = "1.3.6.1.2.1.1.5.0"
	SysLocation = "1.3.6.1.2.1.1.6.0"
)

// ── IF-MIB: ifTable (RFC 2863) ───────────────────────────────────────────────
// Subtree root for BulkWalk.

const IfTable = "1.3.6.1.2.1.2.2.1"

// Individual ifTable column subtrees (walk to get all rows).
const (
	IfDescr       = "1.3.6.1.2.1.2.2.1.2"
	IfType        = "1.3.6.1.2.1.2.2.1.3"
	IfMtu         = "1.3.6.1.2.1.2.2.1.4"
	IfSpeed       = "1.3.6.1.2.1.2.2.1.5"
	IfPhysAddr    = "1.3.6.1.2.1.2.2.1.6"
	IfAdminStatus = "1.3.6.1.2.1.2.2.1.7"
	IfOperStatus  = "1.3.6.1.2.1.2.2.1.8"
	IfLastChange  = "1.3.6.1.2.1.2.2.1.9"
	IfInOctets    = "1.3.6.1.2.1.2.2.1.10"
	IfInUcastPkts = "1.3.6.1.2.1.2.2.1.11"
	IfInDiscards  = "1.3.6.1.2.1.2.2.1.13"
	IfInErrors    = "1.3.6.1.2.1.2.2.1.14"
	IfOutOctets   = "1.3.6.1.2.1.2.2.1.16"
	IfOutUcastPkts = "1.3.6.1.2.1.2.2.1.17"
	IfOutDiscards = "1.3.6.1.2.1.2.2.1.19"
	IfOutErrors   = "1.3.6.1.2.1.2.2.1.20"
)

// ── IF-MIB: ifXTable (RFC 2863) ─────────────────────────────────────────────
// 64-bit HC counters — always prefer these over 32-bit ifTable counters.

const IfXTable = "1.3.6.1.2.1.31.1.1.1"

const (
	IfName          = "1.3.6.1.2.1.31.1.1.1.1"
	IfHCInOctets    = "1.3.6.1.2.1.31.1.1.1.6"
	IfHCInUcastPkts = "1.3.6.1.2.1.31.1.1.1.7"
	IfHCOutOctets   = "1.3.6.1.2.1.31.1.1.1.10"
	IfHCOutUcastPkts = "1.3.6.1.2.1.31.1.1.1.11"
	IfHighSpeed     = "1.3.6.1.2.1.31.1.1.1.15" // Mbps; multiply × 1e6 for bps
	IfAlias         = "1.3.6.1.2.1.31.1.1.1.18"
)

// ── HOST-RESOURCES-MIB (RFC 2790) ───────────────────────────────────────────

const (
	// CPU: walk returns one row per processor, value 0–100 (%)
	HrProcessorTable = "1.3.6.1.2.1.25.3.3.1"
	HrProcessorLoad  = "1.3.6.1.2.1.25.3.3.1.2"

	// Storage table
	HrStorageTable            = "1.3.6.1.2.1.25.2.3.1"
	HrStorageType             = "1.3.6.1.2.1.25.2.3.1.2"
	HrStorageDescr            = "1.3.6.1.2.1.25.2.3.1.3"
	HrStorageAllocationUnits  = "1.3.6.1.2.1.25.2.3.1.4"
	HrStorageSize             = "1.3.6.1.2.1.25.2.3.1.5"
	HrStorageUsed             = "1.3.6.1.2.1.25.2.3.1.6"

	// Storage type OID values (hrStorageType column returns one of these)
	HrStorageTypeRam          = "1.3.6.1.2.1.25.2.1.2"
	HrStorageTypeVirtualMemory = "1.3.6.1.2.1.25.2.1.3"
	HrStorageTypeFlash        = "1.3.6.1.2.1.25.2.1.7"
)

// ── ENTITY-MIB (RFC 2737) ────────────────────────────────────────────────────

const (
	EntPhysicalDescr = "1.3.6.1.2.1.47.1.1.1.1.2" // populated on Arista/most vendors
	EntPhysicalName  = "1.3.6.1.2.1.47.1.1.1.1.7" // often empty on Arista EOS
)

// ── ENTITY-SENSOR-MIB (RFC 3433) ─────────────────────────────────────────────
// Walk entPhySensorType to find temperature sensors (type == 8 = celsius).
// Then read corresponding entPhySensorValue rows by matching index.

const (
	EntPhySensorType      = "1.3.6.1.2.1.99.1.1.1.1"
	EntPhySensorScale     = "1.3.6.1.2.1.99.1.1.1.2" // SensorDataScale enum (units=9)
	EntPhySensorPrecision = "1.3.6.1.2.1.99.1.1.1.3" // decimal places 0–9
	EntPhySensorValue     = "1.3.6.1.2.1.99.1.1.1.4"

	EntSensorTypeCelsius  = 8 // entPhySensorType value indicating temperature
	EntSensorScaleUnits   = 9 // entPhySensorScale: units (10^0); most common for temp
)

// ── Cisco: CISCO-PROCESS-MIB ─────────────────────────────────────────────────

const (
	// 5-minute CPU average per processor (walk returns one row per CPU).
	// Preferred over hrProcessorLoad for IOS/IOS-XE/IOS-XR — more accurate.
	CpmCPUTotal5minRev = "1.3.6.1.4.1.9.9.109.1.1.1.1.8"
)

// ── Cisco: CISCO-ENVMON-MIB ──────────────────────────────────────────────────

const (
	CiscoEnvMonTempTable = "1.3.6.1.4.1.9.9.13.1.3.1"
	CiscoEnvMonTempDescr = "1.3.6.1.4.1.9.9.13.1.3.1.2"
	CiscoEnvMonTempValue = "1.3.6.1.4.1.9.9.13.1.3.1.3"
	// State: 1=normal, 2=warning, 3=critical, 4=shutdown, 5=notPresent
	CiscoEnvMonTempState = "1.3.6.1.4.1.9.9.13.1.3.1.6"
)

// ── Juniper: JUNIPER-MIB (jnxOperating table) ────────────────────────────────
// jnxOperating covers chassis components: FPCs, SCBs, REs, fans, etc.

const (
	JnxOperatingTable  = "1.3.6.1.4.1.2636.3.1.13.1"
	JnxOperatingDescr  = "1.3.6.1.4.1.2636.3.1.13.1.5"
	JnxOperatingTemp   = "1.3.6.1.4.1.2636.3.1.13.1.7"
	JnxOperatingCPU    = "1.3.6.1.4.1.2636.3.1.13.1.8"
	JnxOperatingMemory = "1.3.6.1.4.1.2636.3.1.13.1.11"
)

// ── HP ProCurve / Aruba (legacy): HP-ICF-CHASSIS-MIB ─────────────────────────

const (
	// hpicfChassisCpuUtil: 1-minute CPU utilisation % scalar.
	// Present on ProCurve/Aruba switches running YA/WA/WB firmware.
	// hrProcessorLoad returns 0 on these devices — use this instead.
	HpicfChassisCpuUtil = "1.3.6.1.4.1.11.2.14.11.5.1.7.1.4.0"

	// hpicfMemEntry: walk from the entry-level OID so splitTableOID sees col.idx.
	// Column 3 (hpicfMemAllocated) = bytes allocated, column 4 (hpicfMemFree) = bytes free.
	// The parent table OID is 1.3.6.1.4.1.11.2.14.11.5.1.1.2; .1 is the entry object.
	HpicfMemEntry = "1.3.6.1.4.1.11.2.14.11.5.1.1.2.1"
)

// ── FortiGate: FORTINET-FORTIGATE-MIB ────────────────────────────────────────

const (
	// Scalar system stats
	FgSysCpuUsage    = "1.3.6.1.4.1.12356.101.4.1.3.0"
	FgSysMemUsage    = "1.3.6.1.4.1.12356.101.4.1.4.0"  // % used
	FgSysMemCapacity = "1.3.6.1.4.1.12356.101.4.1.5.0"  // total KB

	// Hardware sensor table (temperature, fan, etc.)
	FgHwSensorTable     = "1.3.6.1.4.1.12356.101.4.4.2.1"
	FgHwSensorEntName   = "1.3.6.1.4.1.12356.101.4.4.2.1.2"
	FgHwSensorEntValue  = "1.3.6.1.4.1.12356.101.4.4.2.1.3"
	FgHwSensorEntAlarmStatus = "1.3.6.1.4.1.12356.101.4.4.2.1.4"
)

// ── IP-MIB: ARP table (RFC 1213 / RFC 4293) ──────────────────────────────────
// ipNetToMediaTable — maps IP addresses to MAC addresses per interface.
// Indexed by (ifIndex, ipAddress-as-4-octets).
const ARPTable = "1.3.6.1.2.1.4.22.1"

// ── BRIDGE-MIB (RFC 4188) ────────────────────────────────────────────────────
// dot1dTpFdbTable — MAC forwarding database: MAC → bridge port.
// Indexed by MAC address as 6 decimal octets.
const MACFdbTable = "1.3.6.1.2.1.17.4.3.1"

// dot1dBasePortTable — maps bridge port number → ifIndex.
// Indexed by bridge port number.
const MACPortTable = "1.3.6.1.2.1.17.1.4.1"

// ── LLDP-MIB (IEEE 802.1AB) ──────────────────────────────────────────────────
// Two OID namespaces exist: IEEE (1.0.8802) used by most enterprise gear,
// and IETF (1.3.6.1.2.1.111) used by some Linux/open-source agents.
// The poller tries the IEEE namespace first, then falls back to IETF.

const (
	// lldpRemTable: one row per discovered neighbour per local port.
	// Indexed by (lldpRemTimeMark, lldpRemLocalPortNum, lldpRemIndex).
	LLDPRemTableIEEE = "1.0.8802.1.1.2.1.4.1.1"
	LLDPRemTableIETF = "1.3.6.1.2.1.111.1.4.1.1"

	// lldpLocPortTable: maps lldpRemLocalPortNum → local port description (ifName).
	// Indexed by lldpLocPortNum (same integer as lldpRemLocalPortNum).
	LLDPLocPortIEEE = "1.0.8802.1.1.2.1.3.7.1"
	LLDPLocPortIETF = "1.3.6.1.2.1.111.1.3.7.1"

	// lldpRemManAddrTable: management addresses for each neighbour.
	// The IPv4 address is encoded in the OID index itself.
	// Indexed by (timeMark, portNum, remIndex, addrSubtype, addr...).
	LLDPRemManAddrIEEE = "1.0.8802.1.1.2.1.4.2.1"
	LLDPRemManAddrIETF = "1.3.6.1.2.1.111.1.4.2.1"
)

// ── CISCO-CDP-MIB ─────────────────────────────────────────────────────────────
// CDP is Cisco-proprietary; present on IOS, IOS-XE, IOS-XR, NX-OS.
// cdpCacheTable is indexed by (cdpCacheIfIndex, cdpCacheDeviceIndex).

const (
	CDPCacheTable = "1.3.6.1.4.1.9.9.23.1.2.1.1"
)

// ── IANA ifType values (most common) ─────────────────────────────────────────

var IfTypeNames = map[int]string{
	1:   "other",
	6:   "ethernetCsmacd",
	24:  "softwareLoopback",
	53:  "propVirtual",
	131: "tunnel",
	135: "l2vlan",
	136: "l3ipvlan",
	161: "ieee8023adLag",
	166: "mpls",
	188: "atmVciEndPt",
}

// IfTypeName returns the IANA name for an ifType integer, or "other" if unrecognised.
func IfTypeName(t int) string {
	if name, ok := IfTypeNames[t]; ok {
		return name
	}
	return "other"
}
