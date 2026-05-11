import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchOverview, fetchTopBandwidth, type TopInterface, type TopDevice } from '../api/overview'
import StatusBadge from '../components/StatusBadge'
import VendorBadge from '../components/VendorBadge'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatAge(iso: string | null) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 120)   return `${secs}s ago`
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function fmtBps(bps: number): string {
  if (bps >= 1e9)  return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6)  return `${(bps / 1e6).toFixed(1)} Mbps`
  if (bps >= 1e3)  return `${(bps / 1e3).toFixed(0)} Kbps`
  return `${bps.toFixed(0)} bps`
}

const SEV_ORDER = ['critical', 'major', 'minor', 'warning', 'info'] as const
const SEV_COLOR: Record<string, string> = {
  critical: '#dc2626', major: '#ea580c', minor: '#d97706',
  warning: '#2563eb', info: '#64748b',
}
const SEV_BG: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  major:    'bg-orange-100 text-orange-700 border-orange-200',
  minor:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  warning:  'bg-blue-100 text-blue-700 border-blue-200',
  info:     'bg-slate-100 text-slate-600 border-slate-200',
}

function utilColor(pct: number | null): string {
  if (pct === null) return '#94a3b8'
  if (pct < 30)  return '#16a34a'
  if (pct < 60)  return '#0891b2'
  if (pct < 80)  return '#d97706'
  if (pct < 95)  return '#ea580c'
  return '#dc2626'
}

// ── Icons ─────────────────────────────────────────────────────────────────────
// Filled/solid style icons — much more visual weight than outlines

const Icons = {
  Servers: () => (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path d="M4 3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4zm0 8a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2H4zM14 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
    </svg>
  ),
  XCircle: () => (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd"/>
    </svg>
  ),
  Link: () => (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path fillRule="evenodd" d="M12.586 4.586a2 2 0 1 1 2.828 2.828l-3 3a2 2 0 0 1-2.828 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l3-3a3.5 3.5 0 0 0-4.95-4.95l-1.5 1.5a.75.75 0 0 0 1.06 1.06l1.5-1.5zm-5 5a2 2 0 0 1 2.828 0 .75.75 0 1 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-3 3a3.5 3.5 0 0 0 4.95 4.95l1.5-1.5a.75.75 0 0 0-1.06-1.06l-1.5 1.5a2 2 0 0 1-2.828-2.828l3-3z" clipRule="evenodd"/>
    </svg>
  ),
  Bell: () => (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path fillRule="evenodd" d="M10 2a6 6 0 0 0-6 6c0 1.887-.454 3.665-1.257 5.234a.75.75 0 0 0 .515 1.076 32.94 32.94 0 0 0 3.256.508 3.5 3.5 0 0 0 6.972 0 32.933 32.933 0 0 0 3.256-.508.75.75 0 0 0 .515-1.076A11.448 11.448 0 0 1 16 8a6 6 0 0 0-6-6zm0 15.5a2 2 0 0 1-1.95-1.557 33.54 33.54 0 0 0 3.9 0A2 2 0 0 1 10 17.5z" clipRule="evenodd"/>
    </svg>
  ),
  Signal: () => (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
      <path d="M16.364 3.636a.75.75 0 0 1 0 1.06 9 9 0 0 1 0 12.728.75.75 0 0 1-1.06-1.06 7.5 7.5 0 0 0 0-10.607.75.75 0 0 1 0-1.06zM4.697 4.697a.75.75 0 0 1 1.06 0 7.5 7.5 0 0 1 0 10.607.75.75 0 0 1-1.061-1.061 6 6 0 0 0 0-8.485.75.75 0 0 1 0-1.061zm9.193 2.121a.75.75 0 0 1 0 1.06 4.5 4.5 0 0 1 0 6.364.75.75 0 1 1-1.06-1.06 3 3 0 0 0 0-4.243.75.75 0 0 1 0-1.061.75.75 0 0 1 1.06 0zM7.172 7.879a.75.75 0 0 1 1.06 1.06 3 3 0 0 0 0 4.243.75.75 0 1 1-1.06 1.06 4.5 4.5 0 0 1 0-6.363zM10 9a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
    </svg>
  ),
  ChevronRight: () => (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
      <path fillRule="evenodd" d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L9.19 8 6.22 5.03a.75.75 0 0 1 0-1.06z"/>
    </svg>
  ),
  ArrowUp: () => (
    <svg viewBox="0 0 12 12" fill="currentColor" className="w-2.5 h-2.5">
      <path d="M6 2.5L10 7H2L6 2.5z"/>
    </svg>
  ),
  ArrowDown: () => (
    <svg viewBox="0 0 12 12" fill="currentColor" className="w-2.5 h-2.5">
      <path d="M6 9.5L2 5H10L6 9.5z"/>
    </svg>
  ),
}

// ── Mini sparkline ────────────────────────────────────────────────────────────

function MiniSparkline({ inSeries, outSeries, w = 96, h = 32 }: {
  inSeries: [number, number][]
  outSeries: [number, number][]
  w?: number
  h?: number
}) {
  const all = [...inSeries, ...outSeries]
  if (all.length < 2) {
    return <div style={{ width: w, height: h }} className="flex items-center justify-center text-[9px] text-slate-300">no data</div>
  }

  const maxV  = Math.max(...all.map(([, v]) => v), 1)
  const allT  = all.map(([t]) => t)
  const minT  = Math.min(...allT)
  const maxT  = Math.max(...allT)
  const rangeT = maxT - minT || 1

  const sx = (t: number) => ((t - minT) / rangeT) * w
  const sy = (v: number) => h - 1 - (v / maxV) * (h - 3)

  const pts = (s: [number, number][]) => s.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const area = (s: [number, number][]) => {
    if (s.length < 2) return ''
    const p = s.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' L ')
    return `M ${sx(s[0][0])},${h} L ${p} L ${sx(s.at(-1)![0])},${h} Z`
  }

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      {inSeries.length >= 2 && (
        <>
          <path d={area(inSeries)} fill="#0891b2" fillOpacity={0.15} />
          <polyline points={pts(inSeries)} fill="none" stroke="#0891b2" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {outSeries.length >= 2 && (
        <>
          <path d={area(outSeries)} fill="#f59e0b" fillOpacity={0.15} />
          <polyline points={pts(outSeries)} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, accentColor, icon, to, footer,
}: {
  label: string
  value: number | string
  sub?: string
  accentColor: string
  icon: React.ReactNode
  to?: string
  footer?: React.ReactNode
}) {
  const inner = (
    <div
      className={`relative bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col h-full transition-all duration-150 ${to ? 'hover:shadow-md hover:-translate-y-px cursor-pointer' : ''}`}
    >
      {/* Colored left accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl" style={{ backgroundColor: accentColor }} />

      <div className="pl-5 pr-4 pt-4 pb-3 flex flex-col gap-3 flex-1">
        <div className="flex items-start justify-between">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${accentColor}18` }}
          >
            <span style={{ color: accentColor }}>{icon}</span>
          </div>
          {sub && (
            <span
              className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
              style={{ backgroundColor: `${accentColor}15`, color: accentColor }}
            >
              {sub}
            </span>
          )}
        </div>
        <div className="flex-1">
          <div className="text-2xl md:text-3xl font-bold text-slate-800 tabular-nums leading-none">{value}</div>
          <p className="text-xs text-slate-400 mt-1 font-medium">{label}</p>
        </div>
        {footer && <div className="border-t border-slate-100 pt-2.5">{footer}</div>}
      </div>
    </div>
  )
  return to ? <Link to={to} className="block h-full">{inner}</Link> : inner
}

// ── Alert severity bar ─────────────────────────────────────────────────────────

function AlertSeverityBar({ bySeverity, total }: { bySeverity: Record<string, number>; total: number }) {
  const segments = SEV_ORDER.map(s => ({ sev: s, n: bySeverity[s] ?? 0 })).filter(s => s.n > 0)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-800">Alert severity</h2>
        <span className="text-xs text-slate-400">{total} open</span>
      </div>
      {total === 0 ? (
        <div className="flex flex-col items-center py-4 gap-2">
          <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
          </div>
          <p className="text-sm text-slate-400">No open alerts</p>
        </div>
      ) : (
        <>
          <div className="flex h-2.5 rounded-full overflow-hidden gap-px mb-4">
            {segments.map(s => (
              <div key={s.sev} style={{ width: `${(s.n / total) * 100}%`, backgroundColor: SEV_COLOR[s.sev] }} title={`${s.sev}: ${s.n}`} className="transition-all" />
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {SEV_ORDER.map(sev => {
              const n = bySeverity[sev] ?? 0
              return (
                <Link key={sev} to={`/alerts?severity=${sev}`}
                  className={`rounded-xl px-3 py-2.5 flex flex-col gap-0.5 border transition-all hover:scale-[1.02] ${n === 0 ? 'opacity-30 pointer-events-none' : ''}`}
                  style={{ borderColor: `${SEV_COLOR[sev]}30`, backgroundColor: `${SEV_COLOR[sev]}08` }}>
                  <span className="text-xl font-bold tabular-nums" style={{ color: SEV_COLOR[sev] }}>{n}</span>
                  <span className="text-[10px] capitalize text-slate-500">{sev}</span>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Device type breakdown ─────────────────────────────────────────────────────

function DeviceTypeGrid({ byType }: { byType: Record<string, number> }) {
  const TYPE_ORDER = ['router', 'switch', 'firewall', 'access_point', 'wireless_controller', 'load_balancer', 'unknown']
  const entries = [
    ...TYPE_ORDER.filter(t => byType[t] > 0).map(t => ({ type: t, n: byType[t] })),
    ...Object.entries(byType).filter(([t, n]) => n > 0 && !TYPE_ORDER.includes(t)).map(([t, n]) => ({ type: t, n })),
  ]

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-4">Device types</h2>
      <div className="grid grid-cols-2 gap-2">
        {entries.map(({ type, n }) => {
          const color = DEVICE_TYPE_COLOR[type] ?? '#475569'
          return (
            <Link key={type} to={`/devices?type=${type}`}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all hover:shadow-sm hover:scale-[1.02]"
              style={{ borderColor: `${color}25`, backgroundColor: `${color}08` }}>
              <span style={{ color }}><DeviceTypeIcon type={type} size={16} /></span>
              <div className="min-w-0">
                <span className="text-lg font-bold text-slate-800 tabular-nums block leading-tight">{n}</span>
                <span className="text-[10px] text-slate-500 capitalize truncate block">
                  {DEVICE_TYPE_LABEL[type] ?? type.replace('_', ' ')}
                </span>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

// ── Top bandwidth ─────────────────────────────────────────────────────────────

function TopBandwidthSection() {
  const [tab, setTab] = useState<'interfaces' | 'devices'>('interfaces')

  const { data, isLoading } = useQuery({
    queryKey:        ['top-bandwidth'],
    queryFn:         () => fetchTopBandwidth(8),
    staleTime:       25_000,
    refetchInterval: 30_000,
  })

  const maxBps = Math.max(
    ...(data?.top_interfaces ?? []).map(i => i.current_in_bps + i.current_out_bps),
    1,
  )
  const maxDevBps = Math.max(...(data?.top_devices ?? []).map(d => d.total_bps), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-800">Top bandwidth</h2>
          <span className="text-[10px] text-slate-400 font-medium">30 min</span>
        </div>
        <div className="flex rounded-lg overflow-hidden border border-slate-200">
          {(['interfaces', 'devices'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs font-medium transition-colors capitalize ${
                tab === t ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
              } ${t === 'devices' ? 'border-l border-slate-200' : ''}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="px-5 py-8 text-center text-xs text-slate-400">Loading…</div>
      ) : tab === 'interfaces' ? (
        data?.top_interfaces.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-slate-400">No bandwidth data yet — metrics appear after the first poll cycle.</div>
        ) : (
          <div className="divide-y divide-slate-50">
            {data!.top_interfaces.map(iface => {
              const combined = iface.current_in_bps + iface.current_out_bps
              const barPct   = (combined / maxBps) * 100
              const uc       = utilColor(iface.util_pct)

              return (
                <div key={iface.iface_id} className="px-5 py-3 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-3">
                    {/* Left: device info */}
                    <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[iface.device_type] ?? '#475569' }}>
                      <DeviceTypeIcon type={iface.device_type} size={15} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 flex-wrap">
                        <Link to={`/devices/${iface.device_id}`}
                          className="text-sm font-semibold text-slate-800 hover:text-blue-600 transition-colors truncate">
                          {iface.device_name}
                        </Link>
                        <span className="text-slate-300 text-xs shrink-0">/</span>
                        <Link to={`/devices/${iface.device_id}/interfaces/${iface.iface_id}`}
                          className="text-xs font-mono text-slate-500 hover:text-blue-600 transition-colors truncate">
                          {iface.iface_name}
                        </Link>
                        {iface.util_pct !== null && (
                          <span className="ml-auto text-xs font-bold shrink-0" style={{ color: uc }}>
                            {iface.util_pct.toFixed(1)}%
                          </span>
                        )}
                      </div>

                      {/* Utilisation bar */}
                      <div className="mt-1.5 mb-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${barPct}%`, backgroundColor: uc }} />
                      </div>

                      {/* In / Out numbers */}
                      <div className="flex items-center gap-3 text-[11px]">
                        <span className="flex items-center gap-1 text-cyan-600 font-medium">
                          <Icons.ArrowDown />
                          {fmtBps(iface.current_in_bps)}
                        </span>
                        <span className="flex items-center gap-1 text-amber-500 font-medium">
                          <Icons.ArrowUp />
                          {fmtBps(iface.current_out_bps)}
                        </span>
                        {iface.speed_bps && (
                          <span className="text-slate-300 ml-auto">
                            of {fmtBps(iface.speed_bps)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Right: sparkline */}
                    <div className="shrink-0 hidden sm:block">
                      <MiniSparkline
                        inSeries={iface.in_series as [number, number][]}
                        outSeries={iface.out_series as [number, number][]}
                        w={96} h={34}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        /* Devices tab */
        data?.top_devices.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-slate-400">No bandwidth data yet.</div>
        ) : (
          <div className="divide-y divide-slate-50">
            {data!.top_devices.map(dev => {
              const barPct = (dev.total_bps / maxDevBps) * 100
              return (
                <Link key={dev.device_id} to={`/devices/${dev.device_id}`}
                  className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors group">
                  <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[dev.device_type] ?? '#475569' }}>
                    <DeviceTypeIcon type={dev.device_type} size={15} />
                  </span>
                  <span className="w-40 text-sm font-semibold text-slate-800 truncate group-hover:text-blue-600 transition-colors shrink-0">
                    {dev.device_name}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-cyan-500 transition-all" style={{ width: `${barPct}%` }} />
                  </div>
                  <span className="text-sm font-bold text-slate-700 tabular-nums shrink-0 w-24 text-right">
                    {fmtBps(dev.total_bps)}
                  </span>
                </Link>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}

// ── Top alerting devices ───────────────────────────────────────────────────────

function TopAlertingDevices({ devices, maxCount }: {
  devices: { device_id: string; hostname: string; device_type: string; count: number }[]
  maxCount: number
}) {
  if (devices.length === 0) return null
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-800">Top alerting devices</h2>
        <Link to="/alerts" className="text-xs text-blue-600 hover:underline">View all</Link>
      </div>
      <div className="space-y-2.5">
        {devices.map(d => (
          <Link key={d.device_id} to={`/devices/${d.device_id}`}
            className="flex items-center gap-3 group">
            <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[d.device_type] ?? '#475569' }}>
              <DeviceTypeIcon type={d.device_type} size={14} />
            </span>
            <span className="w-32 text-xs font-medium text-slate-700 truncate group-hover:text-blue-600 transition-colors shrink-0">
              {d.hostname}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full bg-red-500 transition-all" style={{ width: `${(d.count / maxCount) * 100}%` }} />
            </div>
            <span className="text-xs font-bold text-slate-700 tabular-nums shrink-0 w-6 text-right">{d.count}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey:        ['overview'],
    queryFn:         fetchOverview,
    refetchInterval: 30_000,
  })

  const lastRefresh = dataUpdatedAt ? formatAge(new Date(dataUpdatedAt).toISOString()) : '—'
  const pollPct = data
    ? data.poll_health.total_active > 0
      ? Math.round((data.poll_health.polled_recently / data.poll_health.total_active) * 100)
      : 100
    : null

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Overview</h1>
          <p className="text-xs text-slate-400 mt-0.5">Refreshed {lastRefresh}</p>
        </div>
        {data && (
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400">
            <span className={`w-1.5 h-1.5 rounded-full ${
              (pollPct ?? 0) >= 90 ? 'bg-green-500' : (pollPct ?? 0) >= 60 ? 'bg-amber-500' : 'bg-red-500'
            }`} />
            {data.poll_health.polled_recently}/{data.poll_health.total_active} devices polled
          </div>
        )}
      </div>

      {isLoading || !data ? (
        <div className="p-8 text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 md:p-6 space-y-4 md:space-y-5">

          {/* ── Stat cards ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
            <StatCard
              label="Total devices" value={data.devices.total}
              sub={data.last_polled_at ? `polled ${formatAge(data.last_polled_at)}` : undefined}
              accentColor="#6366f1" to="/devices"
              icon={<Icons.Servers />}
              footer={
                <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
                  {([
                    { v: data.devices.up,         c: '#16a34a' },
                    { v: data.devices.unreachable, c: '#f97316' },
                    { v: data.devices.down,        c: '#dc2626' },
                    { v: data.devices.unknown,     c: '#e2e8f0' },
                  ] as const).filter(s => s.v > 0).map((s, i) => (
                    <div key={i} style={{ width: `${(s.v / data.devices.total) * 100}%`, backgroundColor: s.c }} />
                  ))}
                </div>
              }
            />

            <StatCard
              label="Devices down" value={data.devices.down + data.devices.unreachable}
              sub={data.devices.unreachable > 0 ? `${data.devices.unreachable} unreachable` : undefined}
              accentColor={data.devices.down + data.devices.unreachable > 0 ? '#dc2626' : '#94a3b8'}
              to="/devices?status=down" icon={<Icons.XCircle />}
            />

            <StatCard
              label="Interfaces down" value={data.interfaces_down}
              accentColor={data.interfaces_down > 0 ? '#f97316' : '#94a3b8'}
              icon={<Icons.Link />}
            />

            <StatCard
              label="Open alerts" value={data.alerts.open}
              sub={data.alerts.critical > 0 ? `${data.alerts.critical} critical` : data.alerts.major > 0 ? `${data.alerts.major} major` : undefined}
              accentColor={data.alerts.critical > 0 ? '#dc2626' : data.alerts.open > 0 ? '#f97316' : '#16a34a'}
              to="/alerts" icon={<Icons.Bell />}
            />

            <StatCard
              label="Poll health" value={`${pollPct ?? 0}%`}
              sub={`${data.poll_health.polled_recently}/${data.poll_health.total_active} devices`}
              accentColor={(pollPct ?? 0) >= 90 ? '#16a34a' : (pollPct ?? 0) >= 60 ? '#d97706' : '#dc2626'}
              icon={<Icons.Signal />}
              footer={
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{
                      width: `${pollPct ?? 0}%`,
                      backgroundColor: (pollPct ?? 0) >= 90 ? '#16a34a' : (pollPct ?? 0) >= 60 ? '#d97706' : '#dc2626',
                    }}
                  />
                </div>
              }
            />
          </div>

          {/* ── Alert severity + Device types ─────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
            <div className="lg:col-span-2">
              <AlertSeverityBar bySeverity={data.alerts.by_severity} total={data.alerts.open} />
            </div>
            <DeviceTypeGrid byType={data.devices.by_type} />
          </div>

          {/* ── Top bandwidth ─────────────────────────────────────────────── */}
          <TopBandwidthSection />

          {/* ── Problem devices + Open alerts ─────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Problem devices</h2>
                <Link to="/devices" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                  All <Icons.ChevronRight />
                </Link>
              </div>
              {data.problem_devices.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-100 mb-2">
                    <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
                  </div>
                  <p className="text-sm text-slate-400">All devices reachable</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-50">
                  {data.problem_devices.map(d => (
                    <li key={d.id}>
                      <Link to={`/devices/${d.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors">
                        <span style={{ color: DEVICE_TYPE_COLOR[d.device_type] ?? '#475569' }} className="shrink-0">
                          <DeviceTypeIcon type={d.device_type} size={15} />
                        </span>
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

            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Open alerts</h2>
                <Link to="/alerts" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                  {data.alerts.open > 0 ? `${data.alerts.open} total` : 'View all'} <Icons.ChevronRight />
                </Link>
              </div>
              {data.recent_alerts.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-100 mb-2">
                    <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
                  </div>
                  <p className="text-sm text-slate-400">No open alerts</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-50">
                  {data.recent_alerts.map(a => (
                    <li key={a.id}>
                      <Link to={`/alerts/${a.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors group">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium shrink-0 ${SEV_BG[a.severity] ?? SEV_BG.info}`}>
                          {a.severity}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-slate-700 truncate group-hover:text-blue-600 transition-colors">{a.title}</p>
                          <p className="text-xs text-slate-400">{formatAge(a.triggered_at)}</p>
                        </div>
                        <span className="text-slate-300 group-hover:text-blue-400 shrink-0 transition-colors"><Icons.ChevronRight /></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── Top alerting devices ──────────────────────────────────────── */}
          {data.top_alerting_devices.length > 0 && (
            <TopAlertingDevices
              devices={data.top_alerting_devices}
              maxCount={data.top_alerting_devices[0]?.count ?? 1}
            />
          )}

        </div>
      )}
    </div>
  )
}
