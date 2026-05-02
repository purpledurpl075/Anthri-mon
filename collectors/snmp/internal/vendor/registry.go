package vendor

import (
	"regexp"
	"strings"
	"sync"
)

var (
	mu       sync.RWMutex
	profiles []*Profile
)

// Register adds a vendor profile to the global registry.
// Called from each vendor file's init() function.
// Panics on duplicate DBVendorType to catch copy-paste errors at startup.
func Register(p *Profile) {
	mu.Lock()
	defer mu.Unlock()
	for _, existing := range profiles {
		if existing.DBVendorType == p.DBVendorType && p.DBVendorType != "unknown" {
			panic("vendor: duplicate DBVendorType registered: " + p.DBVendorType)
		}
	}
	profiles = append(profiles, p)
}

// Detect returns the best-matching Profile for the given sysObjectID and
// sysDescr values. Returns nil if no profile matches (callers should treat
// the device as vendor "unknown").
//
// Matching rules (evaluated in order):
//  1. Collect all profiles whose SysObjectIDPrefixes match the sysObjectID.
//  2. If any of those have SysDescrPatterns, keep only the ones that match
//     sysDescr (if none match, fall back to all prefix-matched profiles).
//  3. Among remaining candidates, return the one with the highest Priority.
//  4. Ties in Priority are broken by longest matching OID prefix (most specific).
func Detect(sysObjectID, sysDescr string) *Profile {
	mu.RLock()
	defer mu.RUnlock()

	// Normalise: gosnmp may return the OID with or without a leading dot.
	oid := strings.TrimPrefix(sysObjectID, ".")

	type candidate struct {
		profile    *Profile
		prefixLen  int
		descrMatch bool
	}

	var candidates []candidate
	for _, p := range profiles {
		matched, prefLen := matchesOIDPrefix(oid, p.SysObjectIDPrefixes)
		if !matched {
			continue
		}
		dm := matchesSysDescr(sysDescr, p.SysDescrPatterns)
		candidates = append(candidates, candidate{
			profile:    p,
			prefixLen:  prefLen,
			descrMatch: dm,
		})
	}

	if len(candidates) == 0 {
		return nil
	}

	// Narrow to sysDescr-matched candidates if any.
	var descrMatched []candidate
	for _, c := range candidates {
		if c.descrMatch {
			descrMatched = append(descrMatched, c)
		}
	}
	if len(descrMatched) > 0 {
		candidates = descrMatched
	}

	// Pick best: highest Priority, then longest OID prefix.
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.profile.Priority > best.profile.Priority {
			best = c
		} else if c.profile.Priority == best.profile.Priority && c.prefixLen > best.prefixLen {
			best = c
		}
	}
	return best.profile
}

// All returns a snapshot of all registered profiles (used for diagnostics).
func All() []*Profile {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]*Profile, len(profiles))
	copy(out, profiles)
	return out
}

// ── internal helpers ─────────────────────────────────────────────────────────

func matchesOIDPrefix(oid string, prefixes []string) (matched bool, longestLen int) {
	for _, prefix := range prefixes {
		p := strings.TrimPrefix(prefix, ".")
		p = strings.TrimSuffix(p, ".")
		// Must match prefix exactly OR as a proper sub-tree (next char is ".")
		if oid == p || strings.HasPrefix(oid, p+".") {
			if len(p) > longestLen {
				longestLen = len(p)
				matched = true
			}
		}
	}
	return
}

func matchesSysDescr(sysDescr string, patterns []string) bool {
	if len(patterns) == 0 {
		return false
	}
	for _, pat := range patterns {
		re, err := regexp.Compile("(?i)" + pat)
		if err != nil {
			continue
		}
		if re.MatchString(sysDescr) {
			return true
		}
	}
	return false
}
