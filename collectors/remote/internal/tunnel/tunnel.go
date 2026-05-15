// Package tunnel manages the wg0 WireGuard interface used by the remote
// collector to reach the Anthrimon hub.  It shells out to wireguard-tools
// (`wg`) and iproute2 (`ip`) which must be installed on the host.
package tunnel

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"strings"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/state"
)

const wgInterface = "wg0"

// Setup brings up the wg0 interface using the credentials in st.
// It is idempotent — if the interface already exists the `ip link add` step is
// silently ignored.
func Setup(st *state.State) error {
	// 1. Create the interface (ignore EEXIST).
	_ = runCmd("ip", "link", "add", wgInterface, "type", "wireguard")

	// 2. Write private key to a temp file with mode 0600.
	tmpPath, err := writeTempPrivKey(st.WGPrivateKey)
	if err != nil {
		return fmt.Errorf("write wg private key: %w", err)
	}
	defer os.Remove(tmpPath)

	if err := runCmd("wg", "set", wgInterface, "private-key", tmpPath); err != nil {
		return fmt.Errorf("wg set private-key: %w", err)
	}

	// 3. Configure the hub peer.
	if err := runCmd("wg", "set", wgInterface,
		"peer", st.WGHubPubkey,
		"allowed-ips", "0.0.0.0/0",
		"endpoint", st.WGHubEndpoint,
		"persistent-keepalive", "25",
	); err != nil {
		return fmt.Errorf("wg set peer: %w", err)
	}

	// 4. Assign the WireGuard IP (ignore EEXIST).
	_ = runCmd("ip", "addr", "add", st.WGAssignedIP+"/32", "dev", wgInterface)

	// 5. Bring the interface up.
	if err := runCmd("ip", "link", "set", wgInterface, "up"); err != nil {
		return fmt.Errorf("ip link set %s up: %w", wgInterface, err)
	}

	// 6. Add host route to the hub through the tunnel (ignore EEXIST).
	_ = runCmd("ip", "route", "add", "10.100.0.1/32", "dev", wgInterface)

	return nil
}

// Teardown removes the wg0 interface.
func Teardown() error {
	if err := runCmd("ip", "link", "del", wgInterface); err != nil {
		return fmt.Errorf("ip link del %s: %w", wgInterface, err)
	}
	return nil
}

// IsUp returns true when wg0 exists and is in the UP state.
func IsUp() bool {
	out, err := exec.Command("ip", "link", "show", wgInterface).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "UP")
}

// writeTempPrivKey writes privKey to a temporary file with mode 0600 and
// returns the path.  The caller is responsible for deleting the file.
func writeTempPrivKey(privKey string) (string, error) {
	name := fmt.Sprintf("/tmp/wg-priv-%08x", rand.Uint32())
	if err := os.WriteFile(name, []byte(privKey+"\n"), 0600); err != nil {
		return "", err
	}
	return name, nil
}

// runCmd executes a command and returns a combined-output error on failure.
func runCmd(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w — %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
