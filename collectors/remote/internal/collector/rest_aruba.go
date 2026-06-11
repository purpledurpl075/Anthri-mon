// Package collector — ArubaOS-CX REST state collector.
//
// ArubaRESTCollector polls ArubaOS-CX devices every 5 minutes via the
// native AOS-CX REST API and posts BGP session and OSPF neighbor state
// to the hub via POST /api/v1/collectors/bgp-sessions and
// POST /api/v1/collectors/ospf-neighbors.
//
// The hub upserts the data into the same bgp_sessions / ospf_neighbors
// tables used by SNMP, so the existing UI, alerting, and BGP event log
// all work without change.
//
// REST API must be enabled on the switch:
//
//	conf t
//	https-server vrf mgmt
//	end
//	wr mem
//
// Collection is controlled by the rest_collection_enabled flag per device.
// It is currently supported only for vendor == "aruba_cx".
package collector

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

const (
	arubaAPIVersion   = "v10.16"
	arubaCollectEvery = 5 * time.Minute
)

// ── ArubaRESTCollector ────────────────────────────────────────────────────────

// ArubaRESTCollector collects BGP and OSPF state from ArubaOS-CX devices
// via the native REST API and forwards results to the hub.
type ArubaRESTCollector struct {
	hubClient *hub.Client
	mu        sync.RWMutex
	devices   []hub.Device
	logger    zerolog.Logger
}

// NewArubaRESTCollector creates a new Aruba REST state collector.
func NewArubaRESTCollector(hubClient *hub.Client, logger zerolog.Logger) *ArubaRESTCollector {
	return &ArubaRESTCollector{
		hubClient: hubClient,
		logger:    logger.With().Str("subsystem", "aruba_rest").Logger(),
	}
}

// SetDevices replaces the current device list.
func (c *ArubaRESTCollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
}

// Run starts the periodic REST collection loop.
func (c *ArubaRESTCollector) Run(ctx context.Context) {
	ticker := time.NewTicker(arubaCollectEvery)
	defer ticker.Stop()

	c.collectAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.collectAll(ctx)
		}
	}
}

// collectAll runs collection for every REST-enabled ArubaOS-CX device.
func (c *ArubaRESTCollector) collectAll(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	for _, dev := range devices {
		if !dev.RestCollectionEnabled {
			continue
		}
		if dev.Vendor != "aruba_cx" {
			continue // REST collection currently only for ArubaOS-CX
		}
		if err := c.collectDevice(ctx, dev); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("aruba rest collection failed")
		}
	}
}

// collectDevice fetches BGP and OSPF state from one ArubaOS-CX device.
func (c *ArubaRESTCollector) collectDevice(ctx context.Context, dev hub.Device) error {
	// Aruba CX uses the same SSH username/password for REST basic auth.
	cred := dev.SSHCredential()
	if cred == nil {
		return fmt.Errorf("no credential available for %s", dev.Hostname)
	}
	username, _ := cred.Data["username"].(string)
	password, _ := cred.Data["password"].(string)

	ac := newArubaClient(dev.MgmtIP, username, password)
	if err := ac.login(ctx); err != nil {
		return fmt.Errorf("login: %w", err)
	}
	defer ac.logout(ctx)

	// ── BGP ───────────────────────────────────────────────────────────────────
	bgpSessions, bgpErr := ac.collectBGP(ctx, dev.ID)
	if bgpErr != nil {
		c.logger.Warn().Err(bgpErr).Str("device", dev.Hostname).Msg("bgp collection failed")
	} else if len(bgpSessions) > 0 {
		if err := c.hubClient.PostBGPSessions(ctx, bgpSessions); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("bgp post to hub failed")
		} else {
			c.logger.Info().
				Str("device", dev.Hostname).
				Int("sessions", len(bgpSessions)).
				Msg("bgp sessions posted")
		}
	}

	// ── OSPF ──────────────────────────────────────────────────────────────────
	ospfNbrs, ospfErr := ac.collectOSPF(ctx, dev.ID)
	if ospfErr != nil {
		c.logger.Warn().Err(ospfErr).Str("device", dev.Hostname).Msg("ospf collection failed")
	} else if len(ospfNbrs) > 0 {
		if err := c.hubClient.PostOSPFNeighbors(ctx, ospfNbrs); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("ospf post to hub failed")
		} else {
			c.logger.Info().
				Str("device", dev.Hostname).
				Int("neighbors", len(ospfNbrs)).
				Msg("ospf neighbors posted")
		}
	}

	// ── Routes ────────────────────────────────────────────────────────────────
	routes, routesErr := ac.collectRoutes(ctx, dev.ID)
	if routesErr != nil {
		c.logger.Warn().Err(routesErr).Str("device", dev.Hostname).Msg("routes collection failed")
	} else if len(routes) > 0 {
		if err := c.hubClient.PostRoutes(ctx, routes); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("routes post to hub failed")
		} else {
			c.logger.Info().
				Str("device", dev.Hostname).
				Int("routes", len(routes)).
				Msg("routes posted")
		}
	}

	return nil
}

// ── ArubaOS-CX HTTP client ────────────────────────────────────────────────────

type arubaClient struct {
	host     string
	username string
	password string
	cookies  []*http.Cookie
	http     *http.Client
}

func newArubaClient(host, username, password string) *arubaClient {
	return &arubaClient{
		host:     host,
		username: username,
		password: password,
		http: &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					InsecureSkipVerify: true, //nolint:gosec — enterprise self-signed certs
				},
			},
		},
	}
}

func (a *arubaClient) baseURL() string {
	return fmt.Sprintf("https://%s/rest/%s", a.host, arubaAPIVersion)
}

func (a *arubaClient) login(ctx context.Context) error {
	form := url.Values{
		"username": {a.username},
		"password": {a.password},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		a.baseURL()+"/login", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.ReadAll(resp.Body) //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("login returned HTTP %d", resp.StatusCode)
	}
	a.cookies = resp.Cookies()
	return nil
}

func (a *arubaClient) logout(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL()+"/logout", nil)
	if err != nil {
		return
	}
	for _, ck := range a.cookies {
		req.AddCookie(ck)
	}
	resp, err := a.http.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// get performs a GET request against the AOS-CX REST API and returns the
// parsed JSON body.  Returns an empty map on 404.
func (a *arubaClient) get(ctx context.Context, path string, params url.Values) (any, error) {
	rawURL := a.baseURL() + path
	if len(params) > 0 {
		rawURL += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for _, ck := range a.cookies {
		req.AddCookie(ck)
	}

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return map[string]any{}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s returned HTTP %d", path, resp.StatusCode)
	}

	var result any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return result, nil
}

// ── State normalisers ─────────────────────────────────────────────────────────

func normBGPState(raw string) string {
	switch strings.ToLower(raw) {
	case "established":
		return "established"
	case "active":
		return "active"
	case "idle":
		return "idle"
	case "connect":
		return "connect"
	case "opensent":
		return "opensent"
	case "openconfirm", "openconfirmed":
		return "openconfirm"
	}
	return "unknown"
}

func normOSPFState(raw string) string {
	switch strings.ToLower(raw) {
	case "full":
		return "full"
	case "two_way", "2-way":
		return "two_way"
	case "init":
		return "init"
	case "exstart":
		return "exstart"
	case "exchange":
		return "exchange"
	case "loading":
		return "loading"
	case "down":
		return "down"
	case "attempt":
		return "attempt"
	}
	return "unknown"
}

// ── BGP collection ────────────────────────────────────────────────────────────

func (a *arubaClient) collectBGP(ctx context.Context, deviceID string) ([]map[string]any, error) {
	vrfsRaw, err := a.get(ctx, "/system/vrfs", nil)
	if err != nil {
		return nil, fmt.Errorf("get vrfs: %w", err)
	}
	vrfs, ok := vrfsRaw.(map[string]any)
	if !ok || len(vrfs) == 0 {
		return nil, nil
	}

	var sessions []map[string]any

	for vrfName := range vrfs {
		routersRaw, err := a.get(ctx, "/system/vrfs/"+vrfName+"/bgp_routers", nil)
		if err != nil {
			continue
		}
		routers, ok := routersRaw.(map[string]any)
		if !ok {
			continue
		}

		for asnStr := range routers {
			var localASN int
			fmt.Sscanf(asnStr, "%d", &localASN)

			nbrsRaw, err := a.get(ctx,
				"/system/vrfs/"+vrfName+"/bgp_routers/"+asnStr+"/bgp_neighbors",
				url.Values{"depth": {"2"}},
			)
			if err != nil {
				continue
			}
			nbrs, ok := nbrsRaw.(map[string]any)
			if !ok {
				continue
			}

			for peerIP, dataRaw := range nbrs {
				data, ok := dataRaw.(map[string]any)
				if !ok {
					continue
				}
				status, _ := data["status"].(map[string]any)
				stats, _ := data["statistics"].(map[string]any)
				if status == nil {
					status = map[string]any{}
				}
				if stats == nil {
					stats = map[string]any{}
				}

				stateRaw, _ := status["bgp_peer_state"].(string)

				// Prefix statistics live under status.prefix_statistics.<afi-safi>.{received,sent}
				prefixesRx := 0
				prefixesTx := 0
				if pfxStats, ok := status["prefix_statistics"].(map[string]any); ok {
					for _, afiRaw := range pfxStats {
						if afi, ok := afiRaw.(map[string]any); ok {
							prefixesRx += jsonInt(afi["received"])
							prefixesTx += jsonInt(afi["sent"])
						}
					}
				}

				sessions = append(sessions, map[string]any{
					"device_id":            deviceID,
					"vrf":                  vrfName,
					"peer_ip":              peerIP,
					"peer_asn":             data["remote_as"],
					"local_asn":            localASN,
					"description":          data["description"],
					"state":                normBGPState(stateRaw),
					"uptime_s":             jsonInt(stats["bgp_peer_uptime"]),
					"flap_count":           jsonInt(stats["bgp_peer_established_count"]),
					"in_updates":           jsonInt(stats["bgp_peer_update_in_count"]),
					"out_updates":          jsonInt(stats["bgp_peer_update_out_count"]),
					"prefixes_received":    prefixesRx,
					"prefixes_advertised":  prefixesTx,
				})
			}
		}
	}

	return sessions, nil
}

// ── OSPF collection ───────────────────────────────────────────────────────────

func (a *arubaClient) collectOSPF(ctx context.Context, deviceID string) ([]map[string]any, error) {
	vrfsRaw, err := a.get(ctx, "/system/vrfs", nil)
	if err != nil {
		return nil, fmt.Errorf("get vrfs: %w", err)
	}
	vrfs, ok := vrfsRaw.(map[string]any)
	if !ok || len(vrfs) == 0 {
		return nil, nil
	}

	var neighbors []map[string]any

	for vrfName := range vrfs {
		routersRaw, err := a.get(ctx, "/system/vrfs/"+vrfName+"/ospf_routers", nil)
		if err != nil {
			continue
		}
		routers, ok := routersRaw.(map[string]any)
		if !ok {
			continue
		}

		for tag := range routers {
			areasRaw, err := a.get(ctx,
				"/system/vrfs/"+vrfName+"/ospf_routers/"+tag+"/areas", nil)
			if err != nil {
				continue
			}
			areas, ok := areasRaw.(map[string]any)
			if !ok {
				continue
			}

			for areaID := range areas {
				ifacesRaw, err := a.get(ctx,
					"/system/vrfs/"+vrfName+"/ospf_routers/"+tag+
						"/areas/"+areaID+"/ospf_interfaces", nil)
				if err != nil {
					continue
				}
				ifaces, ok := ifacesRaw.(map[string]any)
				if !ok {
					continue
				}

				for ifaceName := range ifaces {
					// URL-encode the interface name (e.g. "1/1/1" → "1%2F1%2F1").
					ifaceEnc := url.PathEscape(ifaceName)

					nbrsRaw, err := a.get(ctx,
						"/system/vrfs/"+vrfName+"/ospf_routers/"+tag+
							"/areas/"+areaID+"/ospf_interfaces/"+ifaceEnc+"/ospf_neighbors",
						url.Values{"depth": {"2"}},
					)
					if err != nil {
						continue
					}
					nbrs, ok := nbrsRaw.(map[string]any)
					if !ok {
						continue
					}

					for routerIDKey, nbrRaw := range nbrs {
						nbr, ok := nbrRaw.(map[string]any)
						if !ok {
							continue
						}

						neighborID, _ := nbr["nbr_router_id"].(string)
						if neighborID == "" {
							neighborID = routerIDKey
						}
						neighborIP, _ := nbr["nbr_if_addr"].(string)
						if neighborIP == "" {
							neighborIP = routerIDKey
						}
						stateRaw, _ := nbr["nfsm_state"].(string)

						neighbors = append(neighbors, map[string]any{
							"device_id":      deviceID,
							"vrf":            vrfName,
							"router_id":      neighborID,
							"neighbor_ip":    neighborIP,
							"interface_name": ifaceName,
							"area":           areaID,
							"state":          normOSPFState(stateRaw),
						})
					}
				}
			}
		}
	}

	return neighbors, nil
}

// ── Routes ────────────────────────────────────────────────────────────────────

// collectRoutes fetches the RIB for the "default" VRF via the AOS-CX Route
// table (/system/vrfs/default/routes?depth=2) and returns route_entries-shaped
// records, one per nexthop so ECMP routes are preserved under
// route_entries' UNIQUE(device_id, destination, next_hop) constraint.
//
// Only the default VRF is collected — route_entries has no VRF column, and
// other VRFs (e.g. "mgmt") are not reachable from the default VRF without an
// explicit route leak, so mixing them in would let path-trace hop through
// routes that don't actually carry default-VRF traffic.
func (a *arubaClient) collectRoutes(ctx context.Context, deviceID string) ([]map[string]any, error) {
	routesRaw, err := a.get(ctx, "/system/vrfs/default/routes", url.Values{"depth": {"2"}})
	if err != nil {
		return nil, fmt.Errorf("get routes: %w", err)
	}
	routeMap, ok := routesRaw.(map[string]any)
	if !ok {
		return nil, nil
	}

	var routes []map[string]any

	for _, routeRaw := range routeMap {
		route, ok := routeRaw.(map[string]any)
		if !ok {
			continue
		}
		prefix, _ := route["prefix"].(string)
		if prefix == "" {
			continue
		}
		fromRaw, _ := route["from"].(string)
		proto := normArubaRouteOwner(fromRaw)

		nexthops := a.arubaRouteNexthops(ctx, route["nexthops"])
		if len(nexthops) == 0 && proto == "static" {
			// Static routes not yet selected into the FIB carry their
			// configured nexthop(s) under static_nexthops instead of
			// nexthops.
			nexthops = a.arubaRouteNexthops(ctx, route["static_nexthops"])
		}

		if len(nexthops) == 0 {
			// Connected routes (no next-hop IP, just an egress port) and
			// "nullroute"/blackhole statics both land here with an empty
			// next_hop. This is also the safety net for any nexthops shape
			// arubaRouteNexthops doesn't recognise, so a route is never
			// silently dropped from route_entries.
			routes = append(routes, map[string]any{
				"device_id":      deviceID,
				"destination":    prefix,
				"next_hop":       "",
				"protocol":       proto,
				"metric":         0,
				"interface_name": "",
			})
			continue
		}

		for _, nh := range nexthops {
			routes = append(routes, map[string]any{
				"device_id":      deviceID,
				"destination":    prefix,
				"next_hop":       nh.ip,
				"protocol":       proto,
				"metric":         nh.metric,
				"interface_name": nh.iface,
			})
		}
	}

	return routes, nil
}

// arubaNexthopEntry holds the route_entries-relevant fields of a single
// AOS-CX Route_Nexthop.
type arubaNexthopEntry struct {
	ip     string
	iface  string
	metric int
}

// arubaRouteNexthops normalises a Route's "nexthops" (or "static_nexthops")
// reference set into a flat list of next-hop entries.
//
// At depth=2, AOS-CX REST is expected to expand each nexthop reference into
// its full Route_Nexthop object — but for routes with a non-empty nexthop
// set (connected interfaces, OSPF/BGP-learned routes, default routes) the
// reference set has been observed coming back as {key: "<URI>"} or
// ["<URI>", ...] instead, with the objects left unexpanded. Both shapes are
// handled here, following any unexpanded URI with one extra GET so the real
// next-hop IP/interface is still captured instead of the route disappearing.
func (a *arubaClient) arubaRouteNexthops(ctx context.Context, raw any) []arubaNexthopEntry {
	var refs []any
	switch v := raw.(type) {
	case map[string]any:
		for _, nh := range v {
			refs = append(refs, nh)
		}
	case []any:
		refs = v
	default:
		return nil
	}

	var out []arubaNexthopEntry
	for _, nhRaw := range refs {
		switch nh := nhRaw.(type) {
		case map[string]any:
			out = append(out, parseArubaNexthop(nh))
		case string:
			obj, err := a.get(ctx, arubaRefPath(nh), url.Values{"depth": {"2"}})
			if err != nil {
				continue
			}
			if m, ok := obj.(map[string]any); ok && len(m) > 0 {
				out = append(out, parseArubaNexthop(m))
			}
		}
	}
	return out
}

// parseArubaNexthop extracts route_entries fields from an expanded
// Route_Nexthop object.
func parseArubaNexthop(nh map[string]any) arubaNexthopEntry {
	ip, _ := nh["ip_address"].(string)
	return arubaNexthopEntry{
		ip:     ip,
		iface:  arubaPortName(nh["port"]),
		metric: jsonInt(nh["distance"]),
	}
}

// arubaRefPath strips the "/rest/<version>" prefix from an absolute AOS-CX
// REST resource URI so it can be re-used with arubaClient.get, which
// prepends the base URL itself.
func arubaRefPath(uri string) string {
	prefix := "/rest/" + arubaAPIVersion
	if rest, ok := strings.CutPrefix(uri, prefix); ok {
		return rest
	}
	return uri
}

// arubaPortName extracts the port/interface name from a Route_Nexthop's
// "port" reference field, which AOS-CX REST returns as either a bare string
// or a {"<name>": "/rest/.../system/ports/<name>"} reference object.
func arubaPortName(v any) string {
	switch p := v.(type) {
	case string:
		return p
	case map[string]any:
		for _, refRaw := range p {
			ref, ok := refRaw.(string)
			if !ok {
				continue
			}
			i := strings.LastIndex(ref, "/")
			if i < 0 {
				continue
			}
			if name, err := url.PathUnescape(ref[i+1:]); err == nil {
				return name
			}
			return ref[i+1:]
		}
	}
	return ""
}

// normArubaRouteOwner maps AOS-CX Route.from values to the same protocol
// vocabulary used by SNMP/eAPI (cidrProtoName/normEOSRouteType).
func normArubaRouteOwner(raw string) string {
	lower := strings.ToLower(raw)
	switch {
	case lower == "connected":
		return "connected"
	case lower == "static":
		return "static"
	case strings.Contains(lower, "bgp"):
		return "bgp"
	case strings.HasPrefix(lower, "ospf"):
		return "ospf"
	case strings.HasPrefix(lower, "isis"):
		return "isis"
	case lower == "rip":
		return "rip"
	default:
		return "other"
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

// jsonInt converts a JSON-decoded numeric value (float64 from encoding/json)
// to int, returning 0 on failure.
func jsonInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return 0
}
