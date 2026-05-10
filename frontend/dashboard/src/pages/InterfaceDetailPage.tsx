import React, { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../api/client'
import { fetchDevice } from '../api/devices'
import StatusBadge from '../components/StatusBadge'
import type { Interface } from '../api/types'

// ── Types ──────────────────────────────────────────────────────────────────

interface IfaceMetrics {
  if_name:      string
  speed_bps:    number | null
  in_bps:       [number, number][]
  out_bps:      [number, number][]
  in_errors:    [number, number][]
  out_errors:   [number, number][]
  in_discards:  [number, number][]
  out_discards: [number, number][]
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtBps(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gbps`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mbps`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} Kbps`
  return `${v.toFixed(0)} bps`
}

function fmtBpsShort(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}G`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${v.toFixed(0)}`
}

function fmtRateShort(v: number): string {
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K/s`
  if (v >= 1)   return `${v.toFixed(1)}/s`
  return `${(v * 1000).toFixed(0)}m/s`
}

function fmtSpeed(bps: number | null): string {
  if (!bps) return '—'
  if (bps >= 1e9) return `${bps / 1e9} Gbps`
  if (bps >= 1e6) return `${bps / 1e6} Mbps`
  return `${bps} bps`
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const step = Math.pow(10, exp)
  for (const mult of [1, 2, 5, 10]) {
    if (mult * step >= v) return mult * step
  }
  return 10 * step
}

// ── Chart ──────────────────────────────────────────────────────────────────

const M = { top: 10, right: 16, bottom: 28, left: 56 }

interface Series {
  name:  string
  color: string
  data:  [number, number][]
}

function TimeSeriesChart({
  series,
  height = 180,
  yFmt = fmtBpsShort,
  empty = 'No data',
}: {
  series:  Series[]
  height?: number
  yFmt?:   (v: number) => string
  empty?:  string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [w, setW]       = useState(700)
  const [hoverI, setHI] = useState<number | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(e => setW(e[0].contentRect.width))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const allPts = series.flatMap(s => s.data)
  if (allPts.length === 0) {
    return (
      <div ref={containerRef} style={{ height }} className="flex items-center justify-center text-slate-300 text-sm">
        {empty}
      </div>
    )
  }

  const maxV   = niceMax(Math.max(...allPts.map(([, v]) => v), 1))
  const minT   = Math.min(...allPts.map(([t]) => t))
  const maxT   = Math.max(...allPts.map(([t]) => t))
  const rangeT = maxT - minT || 1
  const iW     = w - M.left - M.right
  const iH     = height - M.top - M.bottom

  const sx = (t: number) => M.left + ((t - minT) / rangeT) * iW
  const sy = (v: number) => M.top + iH - Math.max(0, Math.min(1, v / maxV)) * iH

  const yTicks  = [0.25, 0.5, 0.75, 1.0].map(f => maxV * f)
  const xTicks  = 5
  const refData = series.find(s => s.data.length > 0)?.data ?? []

  const linePts = (data: [number, number][]) =>
    data.length < 2 ? '' : data.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' ')

  const areaPath = (data: [number, number][]) => {
    if (data.length < 2) return ''
    const line = data.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' L ')
    return `M ${sx(data[0][0])},${sy(0)} L ${line} L ${sx(data.at(-1)![0])},${sy(0)} Z`
  }

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx   = e.clientX - rect.left - M.left
    if (mx < 0 || mx > iW) { setHI(null); return }
    const t    = minT + (mx / iW) * rangeT
    let ni = 0, minD = Infinity
    refData.forEach(([pt], idx) => {
      const d = Math.abs(pt - t)
      if (d < minD) { minD = d; ni = idx }
    })
    setHI(ni)
  }

  const hoverT = hoverI != null ? (refData[hoverI]?.[0] ?? null) : null
  const hoverX = hoverT != null ? sx(hoverT) : null

  return (
    <div ref={containerRef} className="w-full relative select-none">
      <svg
        width={w} height={height}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHI(null)}
        style={{ cursor: 'crosshair' }}
      >
        {/* Y grid + labels */}
        {yTicks.map(v => (
          <g key={v}>
            <line x1={M.left} x2={w - M.right} y1={sy(v)} y2={sy(v)} stroke="#f1f5f9" strokeWidth={1} />
            <text x={M.left - 6} y={sy(v)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#94a3b8">
              {yFmt(v)}
            </text>
          </g>
        ))}
        {/* Baseline */}
        <line x1={M.left} x2={w - M.right} y1={sy(0)} y2={sy(0)} stroke="#e2e8f0" strokeWidth={1} />

        {/* X time labels */}
        {Array.from({ length: xTicks }, (_, i) => {
          const frac  = i / (xTicks - 1)
          const t     = minT + frac * rangeT
          const secsAgo = maxT - t
          const label = i === xTicks - 1 ? 'now'
            : secsAgo >= 3600 ? `${Math.round(secsAgo / 3600)}h`
            : `${Math.round(secsAgo / 60)}m`
          return (
            <text key={i} x={sx(t)} y={height - 6} textAnchor="middle" fontSize={10} fill="#94a3b8">
              {label}
            </text>
          )
        })}

        {/* Series */}
        {series.map(s => s.data.length >= 2 && (
          <g key={s.name}>
            <path d={areaPath(s.data)} fill={s.color} fillOpacity={0.12} />
            <polyline points={linePts(s.data)} fill="none" stroke={s.color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        ))}

        {/* Hover crosshair + dots */}
        {hoverX != null && <>
          <line x1={hoverX} x2={hoverX} y1={M.top} y2={height - M.bottom} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="4 2" />
          {series.map(s => {
            const pt = s.data[hoverI!]
            return pt ? <circle key={s.name} cx={sx(pt[0])} cy={sy(pt[1])} r={3.5} fill={s.color} stroke="white" strokeWidth={1.5} /> : null
          })}
        </>}
      </svg>

      {/* Hover tooltip */}
      {hoverI != null && hoverX != null && (
        <div
          className="absolute bg-slate-800 text-white text-[11px] rounded-lg px-2.5 py-2 shadow-xl pointer-events-none z-10 whitespace-nowrap"
          style={{
            top:  M.top,
            left: hoverX + (hoverX > w * 0.65 ? -(200) : 12),
          }}
        >
          {series.map(s => {
            const pt = s.data[hoverI!]
            return pt ? (
              <div key={s.name} className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                <span className="text-slate-300 w-16">{s.name}</span>
                <span className="font-semibold font-mono">{yFmt(pt[1])}</span>
              </div>
            ) : null
          })}
        </div>
      )}
    </div>
  )
}

// ── Info card ──────────────────────────────────────────────────────────────

function InfoCard({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="bg-slate-50 rounded-xl px-4 py-3">
      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-sm font-medium text-slate-800 ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

const RANGES = [
  { label: '1h',  hours: 1  },
  { label: '6h',  hours: 6  },
  { label: '24h', hours: 24 },
]

export default function InterfaceDetailPage() {
  const { id: deviceId, ifaceId } = useParams<{ id: string; ifaceId: string }>()
  const navigate  = useNavigate()
  const [hours, setHours] = useState(1)

  const { data: device } = useQuery({
    queryKey: ['device', deviceId],
    queryFn:  () => fetchDevice(deviceId!),
    enabled:  !!deviceId,
  })

  const { data: iface, isLoading: ifaceLoading } = useQuery<Interface>({
    queryKey: ['interface', ifaceId],
    queryFn:  () => api.get<Interface>(`/interfaces/${ifaceId}`).then(r => r.data),
    enabled:  !!ifaceId,
  })

  const { data: metrics, isLoading: metricsLoading } = useQuery<IfaceMetrics>({
    queryKey:        ['iface-metrics', ifaceId, hours],
    queryFn:         () => api.get<IfaceMetrics>(`/interfaces/${ifaceId}/utilisation`, { params: { hours } }).then(r => r.data),
    enabled:         !!ifaceId,
    staleTime:       30_000,
    refetchInterval: 60_000,
  })

  if (ifaceLoading) {
    return <div className="flex items-center justify-center h-full text-slate-400 text-sm">Loading…</div>
  }
  if (!iface) {
    return <div className="flex items-center justify-center h-full text-slate-400 text-sm">Interface not found</div>
  }

  const speed      = metrics?.speed_bps ?? iface.speed_bps
  const inLast     = metrics?.in_bps?.at(-1)?.[1]  ?? null
  const outLast    = metrics?.out_bps?.at(-1)?.[1]  ?? null
  const inPct      = speed && inLast  != null ? inLast  / speed * 100 : null
  const outPct     = speed && outLast != null ? outLast / speed * 100 : null
  const inErrLast  = metrics?.in_errors?.at(-1)?.[1]  ?? null
  const outErrLast = metrics?.out_errors?.at(-1)?.[1]  ?? null
  const inDiscLast = metrics?.in_discards?.at(-1)?.[1] ?? null
  const outDiscLast = metrics?.out_discards?.at(-1)?.[1] ?? null

  const hostname   = device?.fqdn ?? device?.hostname ?? deviceId
  const ipAddresses: string[] = Array.isArray(iface.ip_addresses)
    ? iface.ip_addresses.map((a: any) => (typeof a === 'string' ? a : a?.address ?? String(a)))
    : []

  const adminUp = iface.admin_status === 'up'
  const operUp  = iface.oper_status  === 'up'

  return (
    <div className="flex flex-col min-h-full bg-slate-50">

      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-xs text-slate-400 mb-3">
          <button onClick={() => navigate(`/devices/${deviceId}`)} className="hover:text-slate-600 transition-colors">
            {hostname}
          </button>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
          <button onClick={() => navigate(`/devices/${deviceId}`)} className="hover:text-slate-600 transition-colors">
            Interfaces
          </button>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
          <span className="text-slate-600 font-medium">{iface.name}</span>
        </nav>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl font-bold text-slate-900 font-mono">{iface.name}</h1>
              <StatusBadge status={iface.admin_status} />
              {iface.admin_status !== iface.oper_status && <StatusBadge status={iface.oper_status} />}
            </div>
            {iface.description && (
              <p className="text-sm text-slate-500">{iface.description}</p>
            )}
            {!adminUp && (
              <p className="text-xs text-amber-600 mt-0.5">Interface is administratively down</p>
            )}
            {adminUp && !operUp && (
              <p className="text-xs text-red-500 mt-0.5">Interface is down — link may be disconnected</p>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-2xl font-bold text-slate-800">{fmtSpeed(speed)}</div>
            <div className="text-xs text-slate-400 mt-0.5">{iface.if_type ?? 'Unknown type'}</div>
          </div>
        </div>
      </div>

      {/* Info cards */}
      <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <InfoCard label="Speed"    value={fmtSpeed(iface.speed_bps)} />
        <InfoCard label="MTU"      value={iface.mtu ?? '—'} />
        <InfoCard label="Index"    value={iface.if_index} />
        <InfoCard label="MAC"      value={iface.mac_address ?? '—'} mono />
        <InfoCard label="Last change" value={fmtAge(iface.last_change)} />
        <InfoCard
          label="IP addresses"
          value={ipAddresses.length > 0
            ? <div className="space-y-0.5">{ipAddresses.map(a => <div key={a} className="font-mono text-xs">{a}</div>)}</div>
            : '—'
          }
        />
      </div>

      {/* Metrics */}
      <div className="px-6 pb-6 space-y-5 flex-1">

        {/* Time range selector */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Interface metrics</h2>
          <div className="flex rounded-lg overflow-hidden border border-slate-200 bg-white">
            {RANGES.map(r => (
              <button
                key={r.hours}
                onClick={() => setHours(r.hours)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  hours === r.hours
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-500 hover:bg-slate-50'
                } ${r.hours !== 1 ? 'border-l border-slate-200' : ''}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Bandwidth */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Bandwidth</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">Traffic rate over the last {RANGES.find(r => r.hours === hours)?.label}</p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded bg-cyan-500 inline-block" />In
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded bg-amber-400 inline-block" />Out
              </span>
            </div>
          </div>

          <div className="px-4 pt-3 pb-1">
            {metricsLoading ? (
              <div className="flex items-center justify-center h-44 text-slate-300 text-sm">Loading…</div>
            ) : (
              <TimeSeriesChart
                height={180}
                yFmt={fmtBpsShort}
                series={[
                  { name: 'In',  color: '#0891b2', data: (metrics?.in_bps  ?? []) as [number, number][] },
                  { name: 'Out', color: '#f59e0b', data: (metrics?.out_bps ?? []) as [number, number][] },
                ]}
              />
            )}
          </div>

          {/* Current stats */}
          <div className="grid grid-cols-2 divide-x divide-slate-100 border-t border-slate-100">
            {[
              { label: 'In',  val: inLast,  pct: inPct,  color: '#0891b2' },
              { label: 'Out', val: outLast, pct: outPct, color: '#f59e0b' },
            ].map(({ label, val, pct, color }) => (
              <div key={label} className="px-5 py-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
                </div>
                <div className="text-lg font-bold text-slate-800">
                  {val != null ? fmtBps(val) : <span className="text-slate-300 text-sm">No data</span>}
                </div>
                {pct != null && (
                  <div className="mt-1.5">
                    <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                      <span>Utilisation</span>
                      <span>{pct.toFixed(2)}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(pct, 100)}%`,
                          backgroundColor: pct > 90 ? '#dc2626' : pct > 70 ? '#f59e0b' : color,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Errors & Discards */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Errors & Discards</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">Rate per second over the last {RANGES.find(r => r.hours === hours)?.label}</p>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap justify-end">
              {[
                { label: 'In errors',   color: '#dc2626' },
                { label: 'Out errors',  color: '#f97316' },
                { label: 'In discards', color: '#7c3aed' },
                { label: 'Out discards',color: '#0891b2' },
              ].map(({ label, color }) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 rounded inline-block" style={{ backgroundColor: color }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          <div className="px-4 pt-3 pb-1">
            {metricsLoading ? (
              <div className="flex items-center justify-center h-32 text-slate-300 text-sm">Loading…</div>
            ) : (
              <TimeSeriesChart
                height={140}
                yFmt={fmtRateShort}
                empty="No errors or discards recorded"
                series={[
                  { name: 'In errors',    color: '#dc2626', data: (metrics?.in_errors    ?? []) as [number, number][] },
                  { name: 'Out errors',   color: '#f97316', data: (metrics?.out_errors   ?? []) as [number, number][] },
                  { name: 'In discards',  color: '#7c3aed', data: (metrics?.in_discards  ?? []) as [number, number][] },
                  { name: 'Out discards', color: '#0891b2', data: (metrics?.out_discards ?? []) as [number, number][] },
                ]}
              />
            )}
          </div>

          {/* Current error stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-slate-100 border-t border-slate-100 text-center">
            {[
              { label: 'In errors',    val: inErrLast,  color: '#dc2626' },
              { label: 'Out errors',   val: outErrLast, color: '#f97316' },
              { label: 'In discards',  val: inDiscLast, color: '#7c3aed' },
              { label: 'Out discards', val: outDiscLast,color: '#0891b2' },
            ].map(({ label, val, color }) => (
              <div key={label} className="px-3 py-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-wide mb-1" style={{ color }}>{label}</div>
                <div className={`text-sm font-bold ${val ? 'text-slate-800' : 'text-slate-300'}`}>
                  {val != null ? (val === 0 ? '0' : fmtRateShort(val)) : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
