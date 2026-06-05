// Hub-side SNMP trap receiver.  Listens on UDP :162 (configurable via
// ANTHRIMON_TRAP_ADDR), decodes SNMP v1/v2c/v3 packets, then POSTs each trap
// to the hub API in exactly the same JSON format produced by the remote
// collector's anthrimon-traphandler exec handler.
//
// SNMPv3 credentials are fetched from the hub API on startup and refreshed
// every 30 seconds so new devices/credentials take effect without a restart.
//
// Configuration (environment variables):
//
//	ANTHRIMON_TRAP_HUB_URL   Hub base URL          (default "http://127.0.0.1:8001")
//	ANTHRIMON_TRAP_API_KEY   Collector API key      (required)
//	ANTHRIMON_TRAP_ADDR      UDP listen address     (default ":162")
package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

const version = "0.1.3"

const defaultCACertPath = "/etc/anthrimon/tls/ca.crt"

// ── OID classification (identical to trap-handler) ────────────────────────────

var _standardTraps = map[string]trapMeta{
	"1.3.6.1.6.3.1.1.5.1": {Name: "coldStart", Severity: "warning"},
	"1.3.6.1.6.3.1.1.5.2": {Name: "warmStart", Severity: "info"},
	"1.3.6.1.6.3.1.1.5.3": {Name: "linkDown", Severity: "critical"},
	"1.3.6.1.6.3.1.1.5.4": {Name: "linkUp", Severity: "info"},
	"1.3.6.1.6.3.1.1.5.5": {Name: "authenticationFailure", Severity: "warning"},
	"1.3.6.1.6.3.1.1.5.6": {Name: "egpNeighborLoss", Severity: "warning"},
}

var _enterpriseTraps = []enterpriseTrap{
	// ── BGP (RFC 4273, 1.3.6.1.2.1.15) ──────────────────────────────────────
	{Prefix: "1.3.6.1.2.1.15.7.2", Name: "bgp.backwardTransition", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.15.7.1", Name: "bgp.established",        Severity: "info"},

	// ── OSPF (RFC 4750, 1.3.6.1.2.1.14) ─────────────────────────────────────
	{Prefix: "1.3.6.1.2.1.14.16.2.7",  Name: "ospf.authFailure",             Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.14.16.2.8",  Name: "ospf.virtAuthFailure",         Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.14.16.2.15", Name: "ospf.lsdbOverflow",            Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.14.16.2.16", Name: "ospf.lsdbApproachingOverflow", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.3",  Name: "ospf.nbrStateChange",          Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.4",  Name: "ospf.virtNbrStateChange",      Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.1",  Name: "ospf.ifStateChange",           Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.2",  Name: "ospf.virtIfStateChange",       Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.",        Name: "ospf.trap",                     Severity: "warning"},

	// ── IS-IS (RFC 4444, 1.3.6.1.2.1.138) ───────────────────────────────────
	{Prefix: "1.3.6.1.2.1.138.0.5", Name: "isis.databaseOverload", Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.138.0.7", Name: "isis.corruptedLSP",     Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.138.0.1", Name: "isis.adjacencyChange",  Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.138.",    Name: "isis.trap",              Severity: "warning"},

	// ── MPLS LSR (RFC 3813, 1.3.6.1.2.1.131) ────────────────────────────────
	{Prefix: "1.3.6.1.2.1.131.0.2", Name: "mpls.xcDown", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.131.0.1", Name: "mpls.xcUp",   Severity: "info"},
	{Prefix: "1.3.6.1.2.1.131.",    Name: "mpls.trap",    Severity: "info"},

	// ── STP / BRIDGE-MIB (RFC 1493, 1.3.6.1.2.1.17) ────────────────────────
	{Prefix: "1.3.6.1.2.1.17.0.2", Name: "stp.topologyChange", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.17.0.1", Name: "stp.newRoot",        Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.17.",    Name: "stp.trap",            Severity: "info"},

	// ── LLDP (IEEE 802.1AB, 1.0.8802.1.1.2) ────────────────────────────────
	{Prefix: "1.0.8802.1.1.2.0.0.1", Name: "lldp.remTablesChange", Severity: "info"},
	{Prefix: "1.0.8802.1.1.2.",      Name: "lldp.trap",             Severity: "info"},

	// ── VRRP (RFC 2787, 1.3.6.1.2.1.68) ────────────────────────────────────
	{Prefix: "1.3.6.1.2.1.68.0.2", Name: "vrrp.authFailure", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.68.0.1", Name: "vrrp.newMaster",   Severity: "info"},
	{Prefix: "1.3.6.1.2.1.68.",    Name: "vrrp.trap",         Severity: "info"},

	// ── Arista ───────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.30065.3.9",  Name: "arista.bgpPeerStateChange", Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.30065.3.10", Name: "arista.linkStateChange",    Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.30065.",     Name: "arista.trap",                Severity: "info"},

	// ── Aruba CX ─────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.47196.4.1.1.3.20", Name: "aruba_cx.linkStateChange", Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.47196.",           Name: "aruba_cx.trap",             Severity: "info"},

	// ── HP / ProCurve ────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.11.2.14.12.1", Name: "hp.linkChange", Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.11.2.",        Name: "hp.trap",        Severity: "info"},

	// ── Cisco ────────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.9.9.187.", Name: "cisco.bgpBackwardTransition", Severity: "critical"},
	{Prefix: "1.3.6.1.4.1.9.9.43.",  Name: "cisco.configChange",          Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.9.9.13.",  Name: "cisco.envMonAlert",           Severity: "critical"},
	{Prefix: "1.3.6.1.4.1.9.",       Name: "cisco.trap",                   Severity: "info"},

	// ── Juniper ──────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.2636.", Name: "juniper.trap", Severity: "info"},
}

type trapMeta struct {
	Name     string
	Severity string
}

type enterpriseTrap struct {
	Prefix   string
	Name     string
	Severity string
}

func resolveTrapType(oid string) trapMeta {
	if m, ok := _standardTraps[oid]; ok {
		return m
	}
	best := trapMeta{Name: "unknown", Severity: "info"}
	bestLen := 0
	for _, et := range _enterpriseTraps {
		if strings.HasPrefix(oid, et.Prefix) && len(et.Prefix) > bestLen {
			best = trapMeta{Name: et.Name, Severity: et.Severity}
			bestLen = len(et.Prefix)
		}
	}
	return best
}

// ── SNMP packet decoding ──────────────────────────────────────────────────────

const (
	oidSysUpTime = "1.3.6.1.2.1.1.3.0"
	oidTrapOID   = "1.3.6.1.6.3.1.1.4.1.0"
)

// v1TrapOID converts a v1 generic/specific trap to the equivalent v2c OID,
// matching the normalisation snmptrapd performs before calling an exec handler.
func v1TrapOID(pkt *gosnmp.SnmpPacket) string {
	if pkt.GenericTrap >= 0 && pkt.GenericTrap <= 5 {
		return fmt.Sprintf("1.3.6.1.6.3.1.1.5.%d", pkt.GenericTrap+1)
	}
	// Enterprise-specific (genericTrap == 6)
	ent := strings.TrimPrefix(pkt.Enterprise, ".")
	return fmt.Sprintf("%s.0.%d", ent, pkt.SpecificTrap)
}

// pduTypeName returns the type label matching snmptrapd's exec output format so
// the varbind objects are identical to those produced by the trap-handler.
func pduTypeName(t gosnmp.Asn1BER) string {
	switch t {
	case gosnmp.OctetString:
		return "STRING"
	case gosnmp.ObjectIdentifier:
		return "OID"
	case gosnmp.Integer:
		return "INTEGER"
	case gosnmp.TimeTicks:
		return "Timeticks"
	case gosnmp.IPAddress:
		return "IpAddress"
	case gosnmp.Gauge32:
		return "Gauge32"
	case gosnmp.Counter32:
		return "Counter32"
	case gosnmp.Counter64:
		return "Counter64"
	case gosnmp.Opaque:
		return "Opaque"
	case gosnmp.BitString:
		return "Bits"
	default:
		return "STRING"
	}
}

// pduValueStr converts a PDU value to a plain string.
func pduValueStr(pdu gosnmp.SnmpPDU) string {
	switch pdu.Type {
	case gosnmp.OctetString:
		if b, ok := pdu.Value.([]byte); ok {
			return string(b)
		}
	case gosnmp.ObjectIdentifier:
		if s, ok := pdu.Value.(string); ok {
			return strings.TrimPrefix(s, ".")
		}
	case gosnmp.TimeTicks:
		return fmt.Sprintf("%d", pdu.Value)
	case gosnmp.IPAddress:
		if s, ok := pdu.Value.(string); ok {
			return s
		}
	case gosnmp.Opaque:
		if b, ok := pdu.Value.([]byte); ok {
			return fmt.Sprintf("%x", b)
		}
	}
	return fmt.Sprintf("%v", pdu.Value)
}

// decodeTrap extracts the normalised trap OID, SNMP version string, and
// varbind list from a received packet.  v1 traps are normalised to v2c
// format (same as snmptrapd does) so downstream classification is uniform.
func decodeTrap(pkt *gosnmp.SnmpPacket) (trapOID, snmpVer string, varbinds []map[string]any) {
	switch pkt.Version {
	case gosnmp.Version1:
		snmpVer = "v1"
		trapOID = v1TrapOID(pkt)
		for _, v := range pkt.Variables {
			oid := strings.TrimPrefix(v.Name, ".")
			varbinds = append(varbinds, map[string]any{
				"oid":   oid,
				"type":  pduTypeName(v.Type),
				"value": pduValueStr(v),
			})
		}

	default: // v2c, v3
		if pkt.Version == gosnmp.Version3 {
			snmpVer = "v3"
		} else {
			snmpVer = "v2c"
		}
		for _, v := range pkt.Variables {
			oid := strings.TrimPrefix(v.Name, ".")
			switch oid {
			case oidSysUpTime:
				continue
			case oidTrapOID:
				if s, ok := v.Value.(string); ok {
					trapOID = strings.TrimPrefix(s, ".")
				}
				continue
			}
			varbinds = append(varbinds, map[string]any{
				"oid":   oid,
				"type":  pduTypeName(v.Type),
				"value": pduValueStr(v),
			})
		}
	}

	if varbinds == nil {
		varbinds = []map[string]any{}
	}
	return
}

// ── SNMPv3 credential management ─────────────────────────────────────────────

type v3User struct {
	Username  string `json:"username"`
	AuthProto string `json:"auth_proto"`
	AuthKey   string `json:"auth_key"`
	PrivProto string `json:"priv_proto"`
	PrivKey   string `json:"priv_key"`
}

// noopLogger satisfies gosnmp.Logger without emitting output (used for the
// security parameters table internal logging only).
type noopLogger struct{}

func (noopLogger) Print(v ...interface{})                 {}
func (noopLogger) Printf(format string, v ...interface{}) {}

// zlogAdapter routes gosnmp's internal log output (auth errors, decrypt
// failures, etc.) through zerolog so they appear in the journal.
type zlogAdapter struct{}

func (zlogAdapter) Print(v ...interface{}) {
	log.Debug().Msg(fmt.Sprint(v...))
}
func (zlogAdapter) Printf(format string, v ...interface{}) {
	log.Debug().Msgf(format, v...)
}

func mapAuthProto(s string) gosnmp.SnmpV3AuthProtocol {
	switch strings.ToUpper(s) {
	case "MD5":
		return gosnmp.MD5
	case "SHA", "SHA-128":
		return gosnmp.SHA
	case "SHA-224":
		return gosnmp.SHA224
	case "SHA-256":
		return gosnmp.SHA256
	case "SHA-384":
		return gosnmp.SHA384
	case "SHA-512":
		return gosnmp.SHA512
	default:
		return gosnmp.SHA256
	}
}

func mapPrivProto(s string) gosnmp.SnmpV3PrivProtocol {
	switch strings.ToUpper(s) {
	case "DES":
		return gosnmp.DES
	case "AES", "AES-128":
		return gosnmp.AES
	case "AES-192":
		return gosnmp.AES192
	case "AES-192C":
		return gosnmp.AES192C
	case "AES-256":
		return gosnmp.AES256
	case "AES-256C":
		return gosnmp.AES256C
	default:
		return gosnmp.AES
	}
}

// populateV3Table adds or updates users in the security parameters table.
// The table is reused across refreshes — entries are overwritten in place,
// so new credentials take effect immediately without a restart.
func populateV3Table(table *gosnmp.SnmpV3SecurityParametersTable, users []v3User) {
	for _, u := range users {
		sp := &gosnmp.UsmSecurityParameters{
			UserName:                 u.Username,
			AuthenticationProtocol:  mapAuthProto(u.AuthProto),
			AuthenticationPassphrase: u.AuthKey,
			PrivacyProtocol:         mapPrivProto(u.PrivProto),
			PrivacyPassphrase:       u.PrivKey,
		}
		if err := table.Add(u.Username, sp); err != nil {
			log.Warn().Str("user", u.Username).Err(err).Msg("v3 table: failed to add user")
		}
	}
}

// ── HTTP poster ───────────────────────────────────────────────────────────────

func tlsTransport() *http.Transport {
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	if pem, err := os.ReadFile(defaultCACertPath); err == nil {
		pool.AppendCertsFromPEM(pem)
	}
	return &http.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:    pool,
			MinVersion: tls.VersionTLS12,
		},
	}
}

type poster struct {
	hubURL string
	apiKey string
	client *http.Client
}

func newPoster(hubURL, apiKey string) *poster {
	return &poster{
		hubURL: strings.TrimRight(hubURL, "/"),
		apiKey: apiKey,
		client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: tlsTransport(),
		},
	}
}

func (p *poster) post(event map[string]any) error {
	payload, err := json.Marshal(map[string]any{"events": []any{event}})
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, p.hubURL+"/api/v1/collectors/traps", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("hub returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func (p *poster) fetchV3Users() ([]v3User, error) {
	req, err := http.NewRequest(http.MethodGet, p.hubURL+"/api/v1/collectors/trap-users", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hub returned HTTP %d", resp.StatusCode)
	}
	var body struct {
		Users []v3User `json:"users"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return body.Users, nil
}

// ── Config ────────────────────────────────────────────────────────────────────

type config struct {
	hubURL     string
	apiKey     string
	listenAddr string
}

func loadConfig() (config, error) {
	cfg := config{
		hubURL:     getenv("ANTHRIMON_TRAP_HUB_URL", "http://127.0.0.1:8001"),
		apiKey:     os.Getenv("ANTHRIMON_TRAP_API_KEY"),
		listenAddr: getenv("ANTHRIMON_TRAP_ADDR", ":162"),
	}
	if cfg.apiKey == "" {
		return config{}, fmt.Errorf("ANTHRIMON_TRAP_API_KEY is not set")
	}
	return cfg, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})
	log.Info().Str("version", version).Msg("anthrimon-trap-receiver starting")

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal().Err(err).Msg("config error")
	}

	p := newPoster(cfg.hubURL, cfg.apiKey)

	// Build the v3 security table and load credentials on startup.
	v3Table := gosnmp.NewSnmpV3SecurityParametersTable(gosnmp.NewLogger(noopLogger{}))
	users, err := p.fetchV3Users()
	if err != nil {
		log.Warn().Err(err).Msg("could not load v3 credentials on startup — v3 traps will fail until next refresh")
	} else {
		populateV3Table(v3Table, users)
		log.Info().Int("users", len(users)).Msg("v3 credentials loaded")
	}

	tl := gosnmp.NewTrapListener()
	tl.Params = gosnmp.Default
	tl.Params.Logger = gosnmp.NewLogger(zlogAdapter{})
	tl.Params.TrapSecurityParametersTable = v3Table

	tl.OnNewTrap = func(pkt *gosnmp.SnmpPacket, addr *net.UDPAddr) {
		sourceIP := addr.IP.String()
		trapOID, snmpVer, varbinds := decodeTrap(pkt)

		if trapOID == "" {
			log.Warn().Str("src", sourceIP).Msg("trap received with no OID — dropping")
			return
		}

		meta := resolveTrapType(trapOID)

		event := map[string]any{
			"source_ip":    sourceIP,
			"device_id":    "",
			"trap_type":    meta.Name,
			"oid":          trapOID,
			"severity":     meta.Severity,
			"varbinds":     varbinds,
			"snmp_version": snmpVer,
			"received_at":  time.Now().UTC().Format(time.RFC3339Nano),
		}

		if err := p.post(event); err != nil {
			log.Error().Err(err).Str("src", sourceIP).Str("oid", trapOID).Msg("failed to post trap")
		} else {
			log.Info().
				Str("src", sourceIP).
				Str("oid", trapOID).
				Str("type", meta.Name).
				Str("severity", meta.Severity).
				Str("snmp_ver", snmpVer).
				Int("varbinds", len(varbinds)).
				Msg("trap ingested")
		}
	}

	// Refresh v3 credentials every 30 seconds so new devices take effect
	// without a service restart.  We reuse the same table — Add overwrites
	// existing entries and the table's internal RWMutex keeps it thread-safe.
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			updated, err := p.fetchV3Users()
			if err != nil {
				log.Warn().Err(err).Msg("v3 credential refresh failed")
				continue
			}
			populateV3Table(v3Table, updated)
			log.Debug().Int("users", len(updated)).Msg("v3 credentials refreshed")
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		log.Info().Msg("shutting down")
		tl.Close()
	}()

	log.Info().Str("addr", cfg.listenAddr).Str("hub", cfg.hubURL).Msg("listening for SNMP traps")
	if err := tl.Listen(cfg.listenAddr); err != nil {
		log.Fatal().Err(err).Msg("listener error")
	}
}
