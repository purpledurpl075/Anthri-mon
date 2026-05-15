// Package parser implements best-effort RFC 3164 and RFC 5424 syslog parsing.
// Parse never returns an error — if the message does not match either format
// it falls back to treating the entire input as the message body.
package parser

import (
	"bytes"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/purpledurpl075/anthri-mon/collectors/syslog/internal/model"
)

// utf8BOM is the UTF-8 byte-order mark that RFC 5424 allows before the MSG
// field.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// Parse parses a raw syslog line into a SyslogMessage. sourceIP is the remote
// address of the sender. The function never returns an error; on any parse
// failure it falls back to storing the full input in the Raw and Message fields
// with severity info (6).
func Parse(data []byte, sourceIP net.IP) model.SyslogMessage {
	raw := string(data)

	// A well-formed syslog message always starts with '<'.
	if len(data) < 3 || data[0] != '<' {
		return fallback(raw, sourceIP)
	}

	// Find the closing '>'.
	end := bytes.IndexByte(data[1:], '>')
	if end < 0 {
		return fallback(raw, sourceIP)
	}
	end++ // position relative to data[0]

	priStr := string(data[1:end])
	pri, err := strconv.Atoi(priStr)
	if err != nil || pri < 0 || pri > 191 {
		return fallback(raw, sourceIP)
	}

	facility := uint8(pri / 8)
	severity := uint8(pri % 8)

	rest := data[end+1:] // everything after the closing '>'

	// RFC 5424 detection: immediately after '>' must be "1 " (version = 1).
	if len(rest) >= 2 && rest[0] == '1' && rest[1] == ' ' {
		return parse5424(rest[2:], raw, sourceIP, facility, severity)
	}

	return parse3164(rest, raw, sourceIP, facility, severity)
}

// ---------------------------------------------------------------------------
// RFC 3164
// ---------------------------------------------------------------------------

// rfc3164Months maps short month names to month numbers for timestamp parsing.
var rfc3164Months = map[string]time.Month{
	"Jan": time.January, "Feb": time.February, "Mar": time.March,
	"Apr": time.April, "May": time.May, "Jun": time.June,
	"Jul": time.July, "Aug": time.August, "Sep": time.September,
	"Oct": time.October, "Nov": time.November, "Dec": time.December,
}

// parse3164 parses the portion of an RFC 3164 message after the PRI field.
// Format: TIMESTAMP HOSTNAME PROGRAM[PID]: MESSAGE
// TIMESTAMP: "Jan  2 15:04:05" or "Jan 02 15:04:05"
func parse3164(rest []byte, raw string, sourceIP net.IP, facility, severity uint8) model.SyslogMessage {
	msg := model.SyslogMessage{
		DeviceIP: normaliseIP(sourceIP),
		Facility: facility,
		Severity: severity,
		Ts:       time.Now().UTC(),
		Raw:      raw,
	}

	s := strings.TrimLeft(string(rest), " ")

	// Try to parse the timestamp: "Mmm DD HH:MM:SS " (16 chars minimum).
	// Allow for single or double-digit day (space-padded or zero-padded).
	ts, after, ok := parseRFC3164Timestamp(s)
	if ok {
		msg.Ts = ts
		s = strings.TrimLeft(after, " ")
	}

	// HOSTNAME — next word.
	hostname, s := nextWord(s)
	msg.Hostname = hostname

	// PROGRAM[PID]: — next token up to ':' or end.
	program, pid, s := parseProgramPID(s)
	msg.Program = program
	msg.PID = pid

	msg.Message = strings.TrimLeft(s, " ")
	return msg
}

// parseRFC3164Timestamp attempts to parse an RFC 3164 timestamp from the
// beginning of s. Returns the parsed time, the remaining string, and whether
// parsing succeeded.
func parseRFC3164Timestamp(s string) (time.Time, string, bool) {
	// Need at least "Jan  2 15:04:05 " = 16 chars.
	if len(s) < 15 {
		return time.Time{}, s, false
	}

	month, ok := rfc3164Months[s[0:3]]
	if !ok {
		return time.Time{}, s, false
	}
	if s[3] != ' ' {
		return time.Time{}, s, false
	}

	// Day: positions 4-5, space-padded or zero-padded.
	dayStr := strings.TrimLeft(s[4:6], " ")
	day, err := strconv.Atoi(dayStr)
	if err != nil {
		return time.Time{}, s, false
	}
	if s[6] != ' ' {
		return time.Time{}, s, false
	}

	// Time: positions 7-14 "HH:MM:SS"
	timeStr := s[7:15]
	parts := strings.Split(timeStr, ":")
	if len(parts) != 3 {
		return time.Time{}, s, false
	}
	hour, err1 := strconv.Atoi(parts[0])
	min, err2 := strconv.Atoi(parts[1])
	sec, err3 := strconv.Atoi(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return time.Time{}, s, false
	}

	now := time.Now().UTC()
	year := now.Year()

	// Handle December→January rollover: if the message month is December but
	// current month is January, the message was from last year.
	if month == time.December && now.Month() == time.January {
		year--
	}

	t := time.Date(year, month, day, hour, min, sec, 0, time.UTC)
	// Consume the timestamp + trailing space (15 chars + 1 space = 16).
	remaining := ""
	if len(s) > 15 {
		remaining = s[15:]
		if len(remaining) > 0 && remaining[0] == ' ' {
			remaining = remaining[1:]
		}
	}
	return t, remaining, true
}

// parseProgramPID extracts the program name and optional PID from the front of
// s. Expected forms:
//   - "prog[123]: rest"
//   - "prog: rest"
//   - "prog rest"   (no colon — treat whole token as program, no PID)
func parseProgramPID(s string) (program, pid, rest string) {
	if s == "" {
		return "", "", ""
	}

	// Find end of the program+pid token (space or colon terminates).
	i := 0
	for i < len(s) && s[i] != ' ' && s[i] != ':' {
		i++
	}
	token := s[:i]
	after := s[i:]

	// Strip trailing colon from after.
	after = strings.TrimPrefix(after, ":")
	after = strings.TrimLeft(after, " ")

	// Check for brackets in token: "prog[pid]".
	if j := strings.IndexByte(token, '['); j >= 0 {
		program = token[:j]
		pidPart := token[j+1:]
		pidPart = strings.TrimSuffix(pidPart, "]")
		pid = pidPart
	} else {
		program = token
	}

	return program, pid, after
}

// ---------------------------------------------------------------------------
// RFC 5424
// ---------------------------------------------------------------------------

// parse5424 parses the portion of an RFC 5424 message after "<PRI>1 ".
// Format: TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
func parse5424(rest []byte, raw string, sourceIP net.IP, facility, severity uint8) model.SyslogMessage {
	msg := model.SyslogMessage{
		DeviceIP: normaliseIP(sourceIP),
		Facility: facility,
		Severity: severity,
		Ts:       time.Now().UTC(),
		Raw:      raw,
	}

	s := string(rest)

	// TIMESTAMP
	tsStr, s := nextField(s)
	if tsStr != "-" && tsStr != "" {
		if t, err := time.Parse(time.RFC3339Nano, tsStr); err == nil {
			msg.Ts = t.UTC()
		} else if t, err := time.Parse(time.RFC3339, tsStr); err == nil {
			msg.Ts = t.UTC()
		}
	}

	// HOSTNAME
	hostname, s := nextField(s)
	if hostname != "-" {
		msg.Hostname = hostname
	}

	// APP-NAME
	appName, s := nextField(s)
	if appName != "-" {
		msg.Program = appName
	}

	// PROCID
	procID, s := nextField(s)
	if procID != "-" {
		msg.PID = procID
	}

	// MSGID — skip
	_, s = nextField(s)

	// STRUCTURED-DATA — skip (may be "-" or "[...]")
	s = skipStructuredData(s)

	// MSG — optional BOM strip
	s = strings.TrimLeft(s, " ")
	if strings.HasPrefix(s, string(utf8BOM)) {
		s = s[len(utf8BOM):]
	} else if len(s) >= 3 {
		// Check raw BOM bytes in case the conversion lost them.
		b := []byte(s)
		if bytes.HasPrefix(b, utf8BOM) {
			// Re-decode without BOM.
			b = b[3:]
			if utf8.Valid(b) {
				s = string(b)
			}
		}
	}
	msg.Message = s

	return msg
}

// skipStructuredData advances past the structured-data field in an RFC 5424
// message. Structured data is either "-" or one or more "[...]" blocks.
func skipStructuredData(s string) string {
	s = strings.TrimLeft(s, " ")
	if strings.HasPrefix(s, "-") {
		return s[1:]
	}
	// Consume "[...]" blocks.
	for strings.HasPrefix(s, "[") {
		end := findSDEnd(s)
		if end < 0 {
			// Malformed — consume the rest.
			return ""
		}
		s = s[end+1:]
	}
	return s
}

// findSDEnd finds the index of the closing ']' for a structured-data element,
// accounting for escaped characters inside param values.
func findSDEnd(s string) int {
	if len(s) == 0 || s[0] != '[' {
		return -1
	}
	inValue := false
	for i := 1; i < len(s); i++ {
		switch s[i] {
		case '"':
			inValue = !inValue
		case '\\':
			if inValue {
				i++ // skip escaped character
			}
		case ']':
			if !inValue {
				return i
			}
		}
	}
	return -1
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// fallback returns a SyslogMessage with severity=info (6) treating the entire
// data as the message body.
func fallback(raw string, sourceIP net.IP) model.SyslogMessage {
	return model.SyslogMessage{
		DeviceIP: normaliseIP(sourceIP),
		Facility: 1, // user
		Severity: 6, // info
		Ts:       time.Now().UTC(),
		Message:  raw,
		Raw:      raw,
	}
}

// nextWord returns the first whitespace-delimited word from s and the
// remainder of the string after any leading whitespace.
func nextWord(s string) (word, rest string) {
	s = strings.TrimLeft(s, " \t")
	i := strings.IndexAny(s, " \t")
	if i < 0 {
		return s, ""
	}
	return s[:i], strings.TrimLeft(s[i:], " \t")
}

// nextField returns the first space-delimited token and the remainder. Unlike
// nextWord it does not strip leading whitespace before scanning (the RFC 5424
// fields are separated by exactly one space).
func nextField(s string) (field, rest string) {
	i := strings.IndexByte(s, ' ')
	if i < 0 {
		return s, ""
	}
	return s[:i], s[i+1:]
}

// normaliseIP converts a net.IP to its 4-byte IPv4 form where possible.
func normaliseIP(ip net.IP) net.IP {
	if ip == nil {
		return net.IPv4zero
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	return ip
}
