// Package hub provides an authenticated HTTP client for the Anthrimon hub
// collector API.  All requests are sent through the WireGuard tunnel and
// require a Bearer API key obtained during bootstrap.
package hub

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ─── Domain types returned by GET /api/v1/collectors/config ──────────────────

// DeviceConfig is the full device list returned by the hub.
type DeviceConfig struct {
	CollectorID string   `json:"collector_id"`
	Devices     []Device `json:"devices"`
	GeneratedAt string   `json:"generated_at"`
}

// Device represents a single monitored device assigned to this collector.
type Device struct {
	ID               string       `json:"id"`
	Hostname         string       `json:"hostname"`
	MgmtIP           string       `json:"mgmt_ip"`
	Vendor           string       `json:"vendor"`
	DeviceType       string       `json:"device_type"`
	SNMPPort         int          `json:"snmp_port"`
	PollingIntervalS int          `json:"polling_interval_s"`
	Credentials      []Credential `json:"credentials"`
}

// Credential holds a single authentication credential for a device.
type Credential struct {
	Type     string         `json:"type"`
	Priority int            `json:"priority"`
	Data     map[string]any `json:"data"`
}

// ─── Client ──────────────────────────────────────────────────────────────────

// Client is an authenticated HTTP client for the hub collector API.
type Client struct {
	hubURL     string
	apiKey     string
	httpClient *http.Client
}

// NewClient builds a Client that trusts the given CA certificate (PEM file
// path).  If caCertPath is empty or the file is absent the system pool is used.
func NewClient(hubURL, apiKey, caCertPath string) *Client {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}

	if caCertPath != "" {
		if pem, err := os.ReadFile(caCertPath); err == nil {
			pool.AppendCertsFromPEM(pem)
		}
	}

	tlsCfg := &tls.Config{
		RootCAs:    pool,
		MinVersion: tls.VersionTLS12,
	}

	return &Client{
		hubURL: strings.TrimRight(hubURL, "/"),
		apiKey: apiKey,
		httpClient: &http.Client{
			Transport: &http.Transport{TLSClientConfig: tlsCfg},
			Timeout:   30 * time.Second,
		},
	}
}

// ─── API methods ─────────────────────────────────────────────────────────────

// Heartbeat sends a heartbeat to the hub.  stats is an arbitrary map of
// collector statistics that will be included in the payload.
func (c *Client) Heartbeat(ctx context.Context, version string, stats map[string]any) error {
	payload := map[string]any{
		"version": version,
		"stats":   stats,
	}
	return c.postJSON(ctx, "/api/v1/collectors/heartbeat", payload, nil)
}

// FetchConfig retrieves the current device list from the hub.
func (c *Client) FetchConfig(ctx context.Context) (*DeviceConfig, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/api/v1/collectors/config", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET /config: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read config response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /config: HTTP %d: %s", resp.StatusCode, string(data))
	}

	var cfg DeviceConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config response: %w", err)
	}
	return &cfg, nil
}

// PostMetrics forwards a Prometheus text exposition to the hub.
func (c *Client) PostMetrics(ctx context.Context, prometheusText string) error {
	req, err := c.newRequest(ctx, http.MethodPost, "/api/v1/collectors/metrics",
		strings.NewReader(prometheusText))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "text/plain; version=0.0.4")
	return c.doAndDiscard(req)
}

// PostFlows sends a batch of flow records to the hub.
func (c *Client) PostFlows(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/flows", records, nil)
}

// PostSyslog sends a batch of syslog records to the hub.
func (c *Client) PostSyslog(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/syslog", records, nil)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	url := c.hubURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, fmt.Errorf("build request %s %s: %w", method, url, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	return req, nil
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, out any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload for %s: %w", path, err)
	}

	req, err := c.newRequest(ctx, http.MethodPost, path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	defer resp.Body.Close()

	respData, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("POST %s: HTTP %d: %s", path, resp.StatusCode, string(respData))
	}

	if out != nil {
		return json.Unmarshal(respData, out)
	}
	return nil
}

func (c *Client) doAndDiscard(req *http.Request) error {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request %s %s: %w", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: HTTP %d: %s", req.Method, req.URL.Path, resp.StatusCode, string(data))
	}
	return nil
}
