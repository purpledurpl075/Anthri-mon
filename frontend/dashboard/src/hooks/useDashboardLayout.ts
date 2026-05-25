import { useState } from 'react'

// ── Widget registry ───────────────────────────────────────────────────────────

export interface WidgetDef {
  id: string
  label: string
  description: string
  defaultW: number  // columns (1–12)
  defaultH: number  // rows (each ~120px)
  minW?: number
  minH?: number
}

export const WIDGET_DEFS: WidgetDef[] = [
  { id: 'stat_cards',           label: 'Stat cards',            description: 'Device counts, alert totals, poll health',  defaultW: 12, defaultH: 2, minH: 2 },
  { id: 'alert_severity',       label: 'Alert severity',        description: 'Open alerts by severity',                    defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'device_types',         label: 'Device types',          description: 'Device count by type',                       defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'top_bandwidth',        label: 'Top bandwidth',         description: 'Busiest interfaces and devices',             defaultW: 12, defaultH: 4, minH: 3 },
  { id: 'problem_devices',      label: 'Problem devices',       description: 'Down or unreachable devices',                defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'open_alerts',          label: 'Open alerts',           description: 'Highest-severity open alerts',               defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'top_alerting_devices', label: 'Top alerting devices',  description: 'Devices with the most open alerts',          defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'recently_resolved',    label: 'Recently resolved',     description: 'Alerts resolved in the last hour',           defaultW: 12, defaultH: 3, minH: 2 },
  { id: 'bgp_summary',          label: 'BGP summary',           description: 'BGP session health across all devices',       defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'interface_health',     label: 'Interface health',      description: 'Up / Down / Admin-down breakdown',            defaultW: 4,  defaultH: 3, minH: 2 },
  { id: 'top_cpu',              label: 'Top CPU',               description: 'Top 5 devices by current CPU%',              defaultW: 4,  defaultH: 3, minH: 2 },
  { id: 'top_memory',           label: 'Top memory',            description: 'Top 5 devices by current memory%',           defaultW: 4,  defaultH: 3, minH: 2 },
  { id: 'routing_health',       label: 'Routing health',        description: 'BGP and OSPF session summary',               defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'config_changes',       label: 'Config changes',        description: 'Devices with config changes in last 24 h',   defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'collector_status',     label: 'Collector status',      description: 'Remote collector health',                    defaultW: 4,  defaultH: 2, minH: 2 },
  { id: 'syslog_activity',      label: 'Syslog activity',       description: 'Syslog message counts by severity',          defaultW: 4,  defaultH: 2, minH: 2 },
  { id: 'alert_timeline',       label: 'Alert timeline',        description: 'Hourly alert count over last 24 h',          defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'syslog_feed',          label: 'Syslog live feed',      description: 'Last 10 critical/emergency messages',         defaultW: 6,  defaultH: 4, minH: 3 },
  { id: 'syslog_heatmap',       label: 'Syslog heatmap',        description: 'Message intensity by hour × day (7 days)',   defaultW: 8,  defaultH: 3, minH: 2 },
  { id: 'bgp_prefix_totals',    label: 'BGP prefix totals',     description: 'Total prefixes received and advertised',     defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'bgp_flap_log',         label: 'BGP flap log',          description: 'Recent BGP state transitions',               defaultW: 6,  defaultH: 4, minH: 3 },
  { id: 'ospf_areas',           label: 'OSPF areas',            description: 'Neighbor counts per OSPF area',              defaultW: 4,  defaultH: 3, minH: 2 },
]

// ── Persisted layout ──────────────────────────────────────────────────────────

export interface WidgetConfig {
  id: string
  visible: boolean
  // react-grid-layout item
  x: number
  y: number
  w: number
  h: number
}

// Storage key — bump the version suffix whenever the default layout changes so
// existing users see the fresh default instead of the old stored one.
const STORAGE_KEY = 'anthrimon-dashboard-rgl-v2'

// Widgets shown out of the box, with explicit positions.
// Everything not in this list starts hidden; the user adds it via "Customize".
const DEFAULT_VISIBLE_LAYOUT: Omit<WidgetConfig, 'visible'>[] = [
  // Row 0: summary stat strip (full width)
  { id: 'stat_cards',      x: 0, y:  0, w: 12, h: 2 },
  // Row 2: problem state side-by-side
  { id: 'problem_devices', x: 0, y:  2, w:  6, h: 3 },
  { id: 'open_alerts',     x: 6, y:  2, w:  6, h: 3 },
  // Row 5: severity breakdown + interface health
  { id: 'alert_severity',  x: 0, y:  5, w:  6, h: 3 },
  { id: 'interface_health',x: 6, y:  5, w:  6, h: 3 },
  // Row 8: bandwidth table (full width)
  { id: 'top_bandwidth',   x: 0, y:  8, w: 12, h: 4 },
]

const DEFAULT_VISIBLE_IDS = new Set(DEFAULT_VISIBLE_LAYOUT.map(w => w.id))

function buildDefaultLayout(): WidgetConfig[] {
  // Start with the hand-placed visible widgets.
  const configs: WidgetConfig[] = DEFAULT_VISIBLE_LAYOUT.map(w => ({ ...w, visible: true }))

  // Append every other widget as hidden (x/y/w/h are irrelevant until shown).
  for (const def of WIDGET_DEFS) {
    if (!DEFAULT_VISIBLE_IDS.has(def.id)) {
      configs.push({ id: def.id, visible: false, x: 0, y: 0, w: def.defaultW, h: def.defaultH })
    }
  }
  return configs
}

function loadLayout(): WidgetConfig[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as WidgetConfig[]
      const knownIds = new Set(WIDGET_DEFS.map(d => d.id))
      const result = parsed.filter(w => knownIds.has(w.id))
      // New widgets added after the user saved their layout start hidden so
      // they don't unexpectedly appear on an existing dashboard.
      for (const def of WIDGET_DEFS) {
        if (!result.find(w => w.id === def.id)) {
          result.push({ id: def.id, visible: false, x: 0, y: 0, w: def.defaultW, h: def.defaultH })
        }
      }
      return result
    }
  } catch {}
  return buildDefaultLayout()
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboardLayout() {
  const [layout, setLayout] = useState<WidgetConfig[]>(loadLayout)

  const persist = (next: WidgetConfig[]) => {
    setLayout(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {}
  }

  const updateFromRGL = (rglLayout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => {
    persist(layout.map(w => {
      const item = rglLayout.find(l => l.i === w.id)
      return item ? { ...w, x: item.x, y: item.y, w: item.w, h: item.h } : w
    }))
  }

  const setVisible = (id: string, visible: boolean) => {
    const def = WIDGET_DEFS.find(d => d.id === id)
    // When showing a previously hidden widget, place it at the bottom of the
    // current visible grid so it doesn't overlap anything.
    const bottomY = visible
      ? layout.filter(w => w.visible).reduce((m, w) => Math.max(m, w.y + w.h), 0)
      : 0
    persist(layout.map(w =>
      w.id === id
        ? { ...w, visible, ...(visible && def ? { x: 0, y: bottomY, w: def.defaultW, h: def.defaultH } : {}) }
        : w,
    ))
  }

  const reset = () => persist(buildDefaultLayout())

  return { layout, updateFromRGL, setVisible, reset }
}
