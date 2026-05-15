// Package state manages the persisted bootstrap state for the remote collector.
// The state file records the WireGuard keys and hub assignment so that the
// collector can reconnect across restarts without re-bootstrapping.
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// State is the persisted bootstrap state written to disk as JSON.
type State struct {
	CollectorID   string `json:"collector_id"`
	APIKey        string `json:"api_key"`
	WGPrivateKey  string `json:"wg_private_key"`
	WGPublicKey   string `json:"wg_public_key"`
	WGAssignedIP  string `json:"wg_assigned_ip"`  // e.g. "10.100.0.2"
	WGHubPubkey   string `json:"wg_hub_pubkey"`
	WGHubEndpoint string `json:"wg_hub_endpoint"` // e.g. "1.2.3.4:51820"
}

// Load reads and deserialises the state file at path.
// Returns (nil, nil) when the file does not exist — callers interpret this as
// "bootstrap required".
func Load(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read state file %q: %w", path, err)
	}

	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse state file %q: %w", path, err)
	}
	return &s, nil
}

// Save serialises the state to the file at path, creating any intermediate
// directories with mode 0700.  The file itself is written with mode 0600 to
// protect the WireGuard private key.
func (s *State) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	// Write to a temp file then rename for atomicity.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("write state tmp file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename state file: %w", err)
	}
	return nil
}
