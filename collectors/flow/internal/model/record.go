// Package model defines the core data structures for flow records.
package model

import (
	"net"
	"time"

	"github.com/google/uuid"
)

// NilUUID is a convenience zero-value UUID used when no device match is found.
var NilUUID = uuid.UUID{}

// FlowRecord holds a single decoded flow record ready for insertion into
// ClickHouse. Field names mirror the flow_records table columns.
type FlowRecord struct {
	// Device/collector metadata
	CollectorDeviceID uuid.UUID // collector_device_id
	CollectorIP       net.IP    // collector_ip  (IPv4, 4-byte form)
	ExporterIP        net.IP    // exporter_ip   (IPv4, 4-byte form)

	// Protocol identification
	FlowType string // "netflow_v5" | "netflow_v9" | "ipfix" | "sflow_v5"

	// Timing
	FlowStart  time.Time // flow_start
	FlowEnd    time.Time // flow_end
	ReceivedAt time.Time // received_at (set to time.Now() before insert)

	// Layer-3 addresses
	SrcIP    net.IP // src_ip  (IPv4)
	DstIP    net.IP // dst_ip  (IPv4)
	SrcIP6   net.IP // src_ip6 (IPv6)
	DstIP6   net.IP // dst_ip6 (IPv6)
	NextHop  net.IP // next_hop (IPv4)

	// Layer-4
	SrcPort    uint16
	DstPort    uint16
	IPProtocol uint8
	TCPFlags   uint8

	// Volume
	Bytes   uint64
	Packets uint64

	// Interface indices
	InputIfIndex  uint32
	OutputIfIndex uint32

	// Routing / BGP
	SrcASN       uint32
	DstASN       uint32
	SrcPrefixLen uint8
	DstPrefixLen uint8

	// QoS
	TOS  uint8
	DSCP uint8

	// Sampling
	SamplingRate uint32
}
