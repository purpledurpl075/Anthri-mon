import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchOverview } from '../api/overview'
import StatusBadge from '../components/StatusBadge'
import VendorBadge from '../components/VendorBadge'

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatAge(iso: string | null) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 120)   return `${secs}s ago`
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const SEV_COLOUR: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  major:    'bg-orange-100 text-orange-700 border-orange-200',
  minor:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  warning:  'bg-blue-100 text-blue-700 border-blue-200',
  info:     'bg-slate-100 text-slate-600 border-slate-200',
}

function SevBadge({ severity }: { severity: string }) {
  const cls = SEV_COLOUR[severity] ?? SEV_COLOUR.info
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium ${cls}`}>
      {severity}
    </span>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, accentColor, icon, to,
}: {
  label: string
  value: number | string
  sub?: string
  accentColor: string
  icon: React.ReactNode
  to?: string
}) {
  const inner = (
    <div className={`bg-white rounded-2xl border border-slate-200 p-5 flex flex-col gap-3 transition-all duration-150 ${to ? 'hover:shadow-md hover:-translate-y-px cursor-pointer' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${accentColor}18` }}>
          <span style={{ color: accentColor }}>{icon}</span>
        </div>
        {sub && (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
            style={{ backgroundColor: `${accentColor}15`, color: accentColor }}>
            {sub}
          </span>
        )}
      </div>
      <div>
        <span className="text-3xl font-bold text-slate-800 tabular-nums">{value}</span>
        <p className="text-xs text-slate-400 mt-0.5">{label}</p>
      </div>
    </div>
  )
  return to ? <Link to={to}>{inner}</Link> : inner
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['overview'],
    queryFn: fetchOverview,
    refetchInterval: 30_000,
  })

  const lastRefresh = dataUpdatedAt ? formatAge(new Date(dataUpdatedAt).toISOString()) : '—'

  return (
    <div>
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Overview</h1>
          <p className="text-xs text-slate-400 mt-0.5">Refreshed {lastRefresh}</p>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="p-8 text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="p-6 space-y-6">

          {/* ── Stat cards ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total devices" value={data.devices.total}
              sub={data.last_polled_at ? `polled ${formatAge(data.last_polled_at)}` : undefined}
              accentColor="#6366f1"
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>}
              to="/devices"
            />
            <StatCard
              label="Devices up" value={data.devices.up}
              accentColor="#16a34a"
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>}
            />
            <StatCard
              label="Devices down" value={data.devices.down + data.devices.unreachable}
              sub={data.devices.unreachable > 0 ? `${data.devices.unreachable} unreachable` : undefined}
              accentColor={data.devices.down + data.devices.unreachable > 0 ? '#dc2626' : '#94a3b8'}
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>}
            />
            <StatCard
              label="Open alerts" value={data.alerts.open}
              sub={data.alerts.critical > 0 ? `${data.alerts.critical} critical` : undefined}
              accentColor={data.alerts.critical > 0 ? '#dc2626' : data.alerts.open > 0 ? '#f97316' : '#16a34a'}
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>}
              to="/alerts"
            />
          </div>

          {/* ── Problem devices + Recent alerts ─────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Problem devices */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Problem devices</h2>
                <Link to="/devices" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                  All devices
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </Link>
              </div>
              {data.problem_devices.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-100 mb-2">
                    <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path d="M20 6 9 17l-5-5"/>
                    </svg>
                  </div>
                  <p className="text-sm text-slate-400">All devices reachable</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-50">
                  {data.problem_devices.map(d => (
                    <li key={d.id}>
                      <Link to={`/devices/${d.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-800 truncate">{d.hostname}</span>
                            <VendorBadge vendor={d.vendor} />
                          </div>
                          <span className="text-xs text-slate-400 font-mono">{d.mgmt_ip}</span>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <StatusBadge status={d.status} />
                          <span className="text-xs text-slate-400">{formatAge(d.last_seen)}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Recent alerts */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Open alerts</h2>
                <Link to="/alerts" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                  {data.alerts.open} total
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </Link>
              </div>
              {data.recent_alerts.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-100 mb-2">
                    <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path d="M20 6 9 17l-5-5"/>
                    </svg>
                  </div>
                  <p className="text-sm text-slate-400">No open alerts</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-50">
                  {data.recent_alerts.map(a => (
                    <li key={a.id}>
                      <Link
                        to={`/alerts/${a.id}`}
                        className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors group"
                      >
                        <SevBadge severity={a.severity} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-slate-700 truncate group-hover:text-blue-600 transition-colors">{a.title}</p>
                          <p className="text-xs text-slate-400">{formatAge(a.triggered_at)}</p>
                        </div>
                        <svg className="w-3.5 h-3.5 text-slate-300 group-hover:text-blue-400 shrink-0 transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path d="M5 12h14M12 5l7 7-7 7" />
                        </svg>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

          </div>

          {/* ── Devices by vendor (simple breakdown) ────────────────────── */}
          {data.devices.total > 0 && (
            <DeviceStatusBar devices={data.devices} />
          )}

        </div>
      )}
    </div>
  )
}

function DeviceStatusBar({ devices }: { devices: { total: number; up: number; down: number; unreachable: number; unknown: number } }) {
  const segments = [
    { label: 'Up',          value: devices.up,          colour: 'bg-green-500' },
    { label: 'Down',        value: devices.down,         colour: 'bg-red-500' },
    { label: 'Unreachable', value: devices.unreachable,  colour: 'bg-orange-400' },
    { label: 'Unknown',     value: devices.unknown,      colour: 'bg-slate-300' },
  ].filter(s => s.value > 0)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-4">Device status breakdown</h2>
      <div className="flex h-3 rounded-full overflow-hidden gap-px">
        {segments.map(s => (
          <div
            key={s.label}
            className={`${s.colour} transition-all`}
            style={{ width: `${(s.value / devices.total) * 100}%` }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-4 mt-3">
        {segments.map(s => (
          <div key={s.label} className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded-full ${s.colour}`} />
            <span className="text-xs text-slate-600">{s.label} <span className="font-medium text-slate-800">{s.value}</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}
