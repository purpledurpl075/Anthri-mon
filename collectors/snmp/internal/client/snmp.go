// Package client wraps gosnmp with connection lifecycle management, v2c/v3
// support, and exponential backoff reconnection. All callers use Session — the
// underlying gosnmp handle is never exposed directly.
package client

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/rs/zerolog"
)

// Session holds an open SNMP connection to a single device.
type Session struct {
	DeviceID string
	Target   string
	g        *gosnmp.GoSNMP
	log      zerolog.Logger
}

// NewSession builds a gosnmp handle for the given device and credentials but
// does not connect. Call Connect before making any queries.
func NewSession(
	dev model.DeviceRow,
	cred interface{}, // *model.SNMPV2cCredential or *model.SNMPV3Credential
	timeout time.Duration,
	retries int,
	maxOids int,
	maxReps uint32,
	log zerolog.Logger,
) (*Session, error) {
	g := &gosnmp.GoSNMP{
		Target:         dev.MgmtIP,
		Port:           uint16(dev.SNMPPort),
		Timeout:        timeout,
		Retries:        retries,
		MaxOids:        maxOids,
		MaxRepetitions: maxReps,
	}

	switch c := cred.(type) {
	case *model.SNMPV2cCredential:
		g.Version = gosnmp.Version2c
		g.Community = c.Community

	case *model.SNMPV3Credential:
		g.Version = gosnmp.Version3
		g.SecurityModel = gosnmp.UserSecurityModel

		params := &gosnmp.UsmSecurityParameters{
			UserName: c.Username,
		}

		// Map auth protocol string to gosnmp constant.
		authProto, err := mapAuthProtocol(c.AuthProtocol)
		if err != nil {
			return nil, err
		}
		privProto, err := mapPrivProtocol(c.PrivProtocol)
		if err != nil {
			return nil, err
		}

		params.AuthenticationProtocol = authProto
		params.PrivacyProtocol = privProto

		switch {
		case c.AuthKey != "" && c.PrivKey != "":
			g.MsgFlags = gosnmp.AuthPriv
			params.AuthenticationPassphrase = c.AuthKey
			params.PrivacyPassphrase = c.PrivKey
		case c.AuthKey != "":
			g.MsgFlags = gosnmp.AuthNoPriv
			params.AuthenticationPassphrase = c.AuthKey
		default:
			g.MsgFlags = gosnmp.NoAuthNoPriv
		}

		g.SecurityParameters = params

	default:
		return nil, fmt.Errorf("unsupported credential type %T", cred)
	}

	return &Session{
		DeviceID: dev.ID.String(),
		Target:   dev.MgmtIP,
		g:        g,
		log:      log.With().Str("device_id", dev.ID.String()).Str("target", dev.MgmtIP).Logger(),
	}, nil
}

// Connect opens the UDP socket and for SNMPv3 performs the engine-ID
// discovery handshake. Safe to call multiple times — closes any existing
// connection first.
func (s *Session) Connect() error {
	if s.g.Conn != nil {
		s.g.Conn.Close() //nolint:errcheck
	}
	if err := s.g.Connect(); err != nil {
		return fmt.Errorf("snmp connect to %s: %w", s.Target, err)
	}
	return nil
}

// Close cleanly shuts down the underlying UDP connection.
func (s *Session) Close() {
	if s.g.Conn != nil {
		s.g.Conn.Close() //nolint:errcheck
	}
}

// Get performs a synchronous SNMP GET for the given OIDs. Returns one PDU per OID.
// Handles NO_SUCH_OBJECT and NO_SUCH_INSTANCE silently (zero-value PDU returned).
func (s *Session) Get(oids []string) ([]gosnmp.SnmpPDU, error) {
	result, err := s.g.Get(oids)
	if err != nil {
		return nil, fmt.Errorf("snmp get %v on %s: %w", oids, s.Target, err)
	}
	return result.Variables, nil
}

// BulkWalkAll performs a GETBULK walk of the subtree rooted at rootOID and
// returns all PDUs found. Returns an empty slice (not an error) when the
// subtree is empty or the OID is not implemented.
func (s *Session) BulkWalkAll(rootOID string) ([]gosnmp.SnmpPDU, error) {
	pdus, err := s.g.BulkWalkAll(rootOID)
	if err != nil {
		// gosnmp returns an error when the agent says "no such object".
		// Treat as an empty result rather than a hard failure.
		if isNoSuchObject(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("snmp bulkwalk %s on %s: %w", rootOID, s.Target, err)
	}
	return pdus, nil
}

// ── PDU value helpers ────────────────────────────────────────────────────────

// PDUString returns the string value of a PDU, handling OctetString bytes and
// plain string types transparently.
func PDUString(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case string:
		return strings.TrimSpace(v)
	case []byte:
		return strings.TrimSpace(string(v))
	}
	return ""
}

// PDUUint64 returns the unsigned 64-bit integer value of a PDU.
// Works for Counter32, Counter64, Gauge32, TimeTicks, Integer.
func PDUUint64(pdu gosnmp.SnmpPDU) uint64 {
	switch v := pdu.Value.(type) {
	case uint64:
		return v
	case uint:
		return uint64(v)
	case int:
		if v < 0 {
			return 0
		}
		return uint64(v)
	}
	return 0
}

// PDUInt returns the signed integer value of a PDU.
func PDUInt(pdu gosnmp.SnmpPDU) int {
	switch v := pdu.Value.(type) {
	case int:
		return v
	case uint:
		return int(v)
	case uint64:
		return int(v)
	}
	return 0
}

// PDUMACAddress converts a 6-byte OctetString PDU to "aa:bb:cc:dd:ee:ff".
// Returns "" for any other length (loopbacks, virtual interfaces, etc.).
func PDUMACAddress(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if !ok || len(b) != 6 {
		return ""
	}
	return fmt.Sprintf("%s:%s:%s:%s:%s:%s",
		hex.EncodeToString(b[0:1]),
		hex.EncodeToString(b[1:2]),
		hex.EncodeToString(b[2:3]),
		hex.EncodeToString(b[3:4]),
		hex.EncodeToString(b[4:5]),
		hex.EncodeToString(b[5:6]),
	)
}

// OIDIndex extracts the row index from a fully-qualified PDU name given the
// column OID prefix. E.g. for prefix "1.3.6.1.2.1.2.2.1.2" and pdu name
// ".1.3.6.1.2.1.2.2.1.2.3", it returns "3".
func OIDIndex(pduName, columnOID string) string {
	// PDU names from gosnmp have a leading dot.
	full := strings.TrimPrefix(pduName, ".")
	prefix := strings.TrimPrefix(columnOID, ".")
	if !strings.HasPrefix(full, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(full, prefix)
	return strings.TrimPrefix(rest, ".")
}

// ── Credential unmarshal helpers ─────────────────────────────────────────────

// UnmarshalV2c decodes raw JSON bytes into an SNMPV2cCredential.
func UnmarshalV2c(data []byte) (*model.SNMPV2cCredential, error) {
	var c model.SNMPV2cCredential
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("unmarshal snmp_v2c credential: %w", err)
	}
	if c.Community == "" {
		return nil, fmt.Errorf("snmp_v2c credential missing community string")
	}
	return &c, nil
}

// UnmarshalV3 decodes raw JSON bytes into an SNMPV3Credential.
func UnmarshalV3(data []byte) (*model.SNMPV3Credential, error) {
	var c model.SNMPV3Credential
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("unmarshal snmp_v3 credential: %w", err)
	}
	if c.Username == "" {
		return nil, fmt.Errorf("snmp_v3 credential missing username")
	}
	return &c, nil
}

// ── Exponential backoff ──────────────────────────────────────────────────────

// Backoff implements truncated exponential backoff for reconnection loops.
type Backoff struct {
	attempt int
	maxSecs float64
}

// NewBackoff returns a backoff starting at 1 s and capping at maxSecs.
func NewBackoff(maxSecs float64) *Backoff {
	return &Backoff{maxSecs: maxSecs}
}

// Next returns the delay for the current attempt and advances the counter.
func (b *Backoff) Next() time.Duration {
	secs := math.Min(math.Pow(2, float64(b.attempt)), b.maxSecs)
	b.attempt++
	return time.Duration(secs) * time.Second
}

// Reset resets the attempt counter (call after a successful connection).
func (b *Backoff) Reset() {
	b.attempt = 0
}

// SleepOrCancel waits for d or returns early if ctx is cancelled.
// Returns true if the context was cancelled.
func SleepOrCancel(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return true
	case <-time.After(d):
		return false
	}
}

// ── Internal helpers ─────────────────────────────────────────────────────────

func mapAuthProtocol(s string) (gosnmp.SnmpV3AuthProtocol, error) {
	switch strings.ToUpper(s) {
	case "", "NONE":
		return gosnmp.NoAuth, nil
	case "MD5":
		return gosnmp.MD5, nil
	case "SHA", "SHA1":
		return gosnmp.SHA, nil
	case "SHA224":
		return gosnmp.SHA224, nil
	case "SHA256":
		return gosnmp.SHA256, nil
	case "SHA384":
		return gosnmp.SHA384, nil
	case "SHA512":
		return gosnmp.SHA512, nil
	default:
		return gosnmp.NoAuth, fmt.Errorf("unknown auth protocol %q", s)
	}
}

func mapPrivProtocol(s string) (gosnmp.SnmpV3PrivProtocol, error) {
	switch strings.ToUpper(s) {
	case "", "NONE":
		return gosnmp.NoPriv, nil
	case "DES":
		return gosnmp.DES, nil
	case "AES", "AES128":
		return gosnmp.AES, nil
	case "AES192":
		return gosnmp.AES192, nil
	case "AES256":
		return gosnmp.AES256, nil
	default:
		return gosnmp.NoPriv, fmt.Errorf("unknown priv protocol %q", s)
	}
}

func isNoSuchObject(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "no such") || strings.Contains(msg, "nosuchobject")
}
