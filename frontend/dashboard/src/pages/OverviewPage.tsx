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
  label, value, sub, colour, to,
}: {
  label: string
  value: number | string
  sub?: string
  colour: string
  to?: string
}) {
  const inner = (
    <div className={`bg-white rounded-xl border p-5 flex flex-col gap-1 transition-shadow ${to ? 'hover:shadow-md cursor-pointer' : ''} ${colour}`}>
      <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</span>
      <span className="text-3xl font-bold text-slate-800 tabular-nums">{value}</span>
      {sub && <span className="text-xs text-slate-400">{sub}</span>}
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
        <h1 className="text-base font-semibold text-slate-800">Overview</h1>
        <span className="text-xs text-slate-400">Refreshed {lastRefresh}</span>
      </div>

      {isLoading || !data ? (
        <div className="p-8 text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="p-6 space-y-6">

          {/* ── Stat cards ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total devices" value={data.devices.total}
              sub={`Last polled ${formatAge(data.last_polled_at)}`}
              colour="border-slate-200"
              to="/devices"
            />
            <StatCard
              label="Devices up" value={data.devices.up}
              colour={data.devices.up === data.devices.total && data.devices.total > 0
                ? 'border-green-200' : 'border-slate-200'}
            />
            <StatCard
              label="Devices down" value={data.devices.down + data.devices.unreachable}
              sub={data.devices.unreachable > 0 ? `${data.devices.unreachable} unreachable` : undefined}
              colour={data.devices.down + data.devices.unreachable > 0
                ? 'border-red-300' : 'border-slate-200'}
            />
            <StatCard
              label="Open alerts" value={data.alerts.open}
              sub={data.alerts.critical > 0 ? `${data.alerts.critical} critical` : undefined}
              colour={data.alerts.critical > 0 ? 'border-red-300'
                : data.alerts.open > 0 ? 'border-orange-200' : 'border-slate-200'}
            />
          </div>

          {/* ── Problem devices + Recent alerts ─────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Problem devices */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Problem devices</h2>
                <Link to="/devices" className="text-xs text-blue-600 hover:underline">All devices</Link>
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
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Open alerts</h2>
                <span className="text-xs text-slate-400">{data.alerts.open} total</span>
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
                    <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                      <SevBadge severity={a.severity} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-700 truncate">{a.title}</p>
                        <p className="text-xs text-slate-400">{formatAge(a.triggered_at)}</p>
                      </div>
                      {a.device_id && (
                        <Link to={`/devices/${a.device_id}`} className="text-xs text-blue-600 hover:underline shrink-0">Device</Link>
                      )}
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
    <div className="bg-white rounded-xl border border-slate-200 p-5">
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
