// snmpdiag is a one-shot diagnostic tool that walks a given OID subtree
// and prints every PDU returned. Used to verify vendor MIB support.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

func main() {
	target := flag.String("target", "", "Device IP")
	user := flag.String("user", "", "SNMPv3 username")
	auth := flag.String("auth", "SHA", "Auth protocol (SHA, SHA256, MD5)")
	authpw := flag.String("authpw", "", "Auth password")
	priv := flag.String("priv", "AES", "Priv protocol (AES, DES)")
	privpw := flag.String("privpw", "", "Priv password")
	oid := flag.String("oid", "1.3.6.1.2.1.1", "OID subtree to walk")
	flag.Parse()

	if *target == "" || *user == "" {
		fmt.Fprintln(os.Stderr, "usage: snmpdiag -target IP -user USER -authpw PASS -privpw PASS -oid OID")
		os.Exit(1)
	}

	g := &gosnmp.GoSNMP{
		Target:         *target,
		Port:           161,
		Version:        gosnmp.Version3,
		Timeout:        5 * time.Second,
		Retries:        2,
		MaxRepetitions: 25,
		SecurityModel:  gosnmp.UserSecurityModel,
		MsgFlags:       gosnmp.AuthPriv,
		SecurityParameters: &gosnmp.UsmSecurityParameters{
			UserName:                 *user,
			AuthenticationProtocol:  mapAuth(*auth),
			AuthenticationPassphrase: *authpw,
			PrivacyProtocol:         mapPriv(*priv),
			PrivacyPassphrase:       *privpw,
		},
	}

	if err := g.Connect(); err != nil {
		fmt.Fprintf(os.Stderr, "connect failed: %v\n", err)
		os.Exit(1)
	}
	defer g.Conn.Close()

	fmt.Printf("Walking %s on %s ...\n\n", *oid, *target)
	count := 0
	err := g.BulkWalk(*oid, func(pdu gosnmp.SnmpPDU) error {
		fmt.Printf("  %-45s  type=%-12s  value=%v\n",
			pdu.Name, typeName(pdu.Type), pdu.Value)
		count++
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "walk error: %v\n", err)
	}
	fmt.Printf("\n%d PDUs returned\n", count)
}

func mapAuth(s string) gosnmp.SnmpV3AuthProtocol {
	switch strings.ToUpper(s) {
	case "MD5":
		return gosnmp.MD5
	case "SHA256":
		return gosnmp.SHA256
	case "SHA224":
		return gosnmp.SHA224
	default:
		return gosnmp.SHA
	}
}

func mapPriv(s string) gosnmp.SnmpV3PrivProtocol {
	switch strings.ToUpper(s) {
	case "DES":
		return gosnmp.DES
	case "AES192":
		return gosnmp.AES192
	case "AES256":
		return gosnmp.AES256
	default:
		return gosnmp.AES
	}
}

func typeName(t gosnmp.Asn1BER) string {
	switch t {
	case gosnmp.Integer:
		return "Integer"
	case gosnmp.OctetString:
		return "OctetString"
	case gosnmp.ObjectIdentifier:
		return "OID"
	case gosnmp.Counter32:
		return "Counter32"
	case gosnmp.Gauge32:
		return "Gauge32"
	case gosnmp.TimeTicks:
		return "TimeTicks"
	case gosnmp.Counter64:
		return "Counter64"
	case gosnmp.NoSuchObject:
		return "NoSuchObject"
	case gosnmp.NoSuchInstance:
		return "NoSuchInstance"
	default:
		return fmt.Sprintf("type(%d)", t)
	}
}
