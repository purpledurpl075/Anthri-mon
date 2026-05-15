// Package model defines the core data structures for syslog messages.
package model

import (
	"net"
	"time"

	"github.com/google/uuid"
)

// SyslogMessage holds a single parsed syslog message ready for insertion into
// ClickHouse. Field names mirror the syslog_messages table columns.
type SyslogMessage struct {
	DeviceID   uuid.UUID // device_id     (UUID; uuid.Nil when device not found)
	DeviceIP   net.IP    // device_ip     (IPv4, 4-byte form)
	Facility   uint8     // facility      (0-23)
	Severity   uint8     // severity      (0-7)
	Ts         time.Time // ts            (DateTime64(3,'UTC') — message timestamp)
	Hostname   string    // hostname      (LowCardinality(String))
	Program    string    // program       (LowCardinality(String))
	PID        string    // pid           (String)
	Message    string    // message       (String)
	Raw        string    // raw           (String — original line)
	ReceivedAt time.Time // received_at   (DateTime — set just before insert)
}

// facilityNames maps facility numbers to their canonical names.
var facilityNames = [24]string{
	"kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news",
	"uucp", "cron", "authpriv", "ftp", "ntp", "security", "console",
	"solaris-cron",
	"local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7",
}

// severityNames maps severity numbers to their canonical names.
var severityNames = [8]string{
	"emergency", "alert", "critical", "error", "warning", "notice", "info", "debug",
}

// FacilityName returns the canonical name for facility f, or "unknown" if f > 23.
func FacilityName(f uint8) string {
	if int(f) < len(facilityNames) {
		return facilityNames[f]
	}
	return "unknown"
}

// SeverityName returns the canonical name for severity s, or "unknown" if s > 7.
func SeverityName(s uint8) string {
	if int(s) < len(severityNames) {
		return severityNames[s]
	}
	return "unknown"
}
