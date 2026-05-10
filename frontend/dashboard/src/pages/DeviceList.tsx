import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchDevices } from '../api/devices'
import { fetchMaintenanceWindows } from '../api/maintenance'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'
import VendorBadge from '../components/VendorBadge'
import type { DeviceListItem } from '../api/types'

// ── Helpers ────────────────────────────────────────────────────────────────

function formatAge(iso: string | null) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 120)   return `${secs}s ago`
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const STATUS_COLOR: Record<string, string> = {
  up:          '#16a34a',
  down:        '#dc2626',
  unreachable: '#f97316',
  unknown:     '#94a3b8',
}
const STATUS_BORDER: Record<string, string> = {
  up:          'border-green-400',
  down:        'border-red-400',
  unreachable: 'border-orange-400',
  unknown:     'border-slate-300',
}
const STATUS_LABEL: Record<string, string> = {
  up: 'Up', down: 'Down', unreachable: 'Unreachable', unknown: 'Unknown',
}

// ── Stat card ──────────────────────────────────────────────────────────────

function StatPill({ label, count, color, active, onClick }: {
  label: string; count: number; color: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
        active
          ? 'border-transparent text-white'
          : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
      }`}
      style={active ? { backgroundColor: color, borderColor: color } : {}}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: active ? 'rgba(255,255,255,0.7)' : color }} />
      <span>{count}</span>
      <span className={active ? 'text-white/80' : 'text-slate-400'}>{label}</span>
    </button>
  )
}

// ── Device card ────────────────────────────────────────────────────────────

function DeviceCard({ device, inMaintenance }: { device: DeviceListItem; inMaintenance: boolean }) {
  const navigate = useNavigate()
  const color   = DEVICE_TYPE_COLOR[device.device_type] ?? '#475569'
  const sc      = STATUS_COLOR[device.status]  ?? '#94a3b8'
  const border  = STATUS_BORDER[device.status] ?? 'border-slate-200'

  return (
    <div
      onClick={() => navigate(`/devices/${device.id}`)}
      className={`group relative bg-white border-l-4 ${border} rounded-xl border border-l-[4px] border-slate-200 px-5 py-4 cursor-pointer hover:shadow-md hover:-translate-y-px transition-all duration-150 flex items-center gap-4`}
      style={{ borderLeftColor: sc }}
    >
      {/* Icon */}
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <span style={{ color }}><DeviceTypeIcon type={device.device_type} size={20} /></span>
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-semibold text-slate-800 truncate">
            {device.fqdn ?? device.hostname}
          </span>
          {device.fqdn && device.fqdn !== device.hostname && (
            <span className="text-xs text-slate-400 truncate hidden sm:block">{device.hostname}</span>
          )}
          {inMaintenance && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Maintenance
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="font-mono">{device.mgmt_ip}</span>
          <span className="text-slate-300">·</span>
          <span style={{ color }} className="font-medium">
            {DEVICE_TYPE_LABEL[device.device_type] ?? device.device_type}
          </span>
          <span className="text-slate-300 hidden sm:block">·</span>
          <span className="hidden sm:block">{formatAge(device.last_seen)}</span>
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-4 shrink-0">
        <div className="hidden md:block">
          <VendorBadge vendor={device.vendor} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: sc }} />
          <span className="text-xs font-medium" style={{ color: sc }}>
            {STATUS_LABEL[device.status] ?? device.status}
          </span>
        </div>
        <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'up' | 'down' | 'unreachable' | 'unknown'

export default function DeviceList() {
  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const { data, isLoading, error } = useQuery({
    queryKey: ['devices'],
    queryFn:  () => fetchDevices({ limit: 500 }),
    refetchInterval: 30_000,
  })

  const { data: activeWindows = [] } = useQuery({
    queryKey: ['maintenance-active'],
    queryFn:  () => fetchMaintenanceWindows({ active_only: true }),
    refetchInterval: 60_000,
  })

  const inMaintenance = new Set<string>(
    activeWindows.flatMap(w =>
      (w.device_selector?.device_ids as string[] | undefined) ?? []
    )
  )

  const devices = data?.items ?? []

  const counts = useMemo(() => ({
    all:         devices.length,
    up:          devices.filter(d => d.status === 'up').length,
    down:        devices.filter(d => d.status === 'down').length,
    unreachable: devices.filter(d => d.status === 'unreachable').length,
    unknown:     devices.filter(d => d.status === 'unknown').length,
  }), [devices])

  const filtered = useMemo(() => {
    return devices.filter(d => {
      if (statusFilter !== 'all' && d.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          (d.fqdn ?? d.hostname).toLowerCase().includes(q) ||
          d.mgmt_ip.includes(q) ||
          (d.vendor ?? '').toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [devices, statusFilter, search])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-slate-400 text-sm">Loading devices…</div>
      </div>
    )
  }
  if (error) {
    return <div className="p-8 text-red-600 text-sm">Failed to load devices.</div>
  }

  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-900">

      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Devices</h1>
          <p className="text-xs text-slate-400 mt-0.5">{data?.total ?? 0} in inventory</p>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4 max-w-5xl">

        {/* Stats + search row */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Status filter pills */}
          <div className="flex items-center gap-2 flex-wrap">
            <StatPill label="All"         count={counts.all}         color="#475569" active={statusFilter === 'all'}         onClick={() => setStatusFilter('all')} />
            <StatPill label="Up"          count={counts.up}          color="#16a34a" active={statusFilter === 'up'}          onClick={() => setStatusFilter('up')} />
            {counts.down > 0 && (
              <StatPill label="Down"      count={counts.down}        color="#dc2626" active={statusFilter === 'down'}        onClick={() => setStatusFilter('down')} />
            )}
            {counts.unreachable > 0 && (
              <StatPill label="Unreachable" count={counts.unreachable} color="#f97316" active={statusFilter === 'unreachable'} onClick={() => setStatusFilter('unreachable')} />
            )}
            {counts.unknown > 0 && (
              <StatPill label="Unknown"   count={counts.unknown}     color="#94a3b8" active={statusFilter === 'unknown'}     onClick={() => setStatusFilter('unknown')} />
            )}
          </div>

          <div className="flex-1" />

          {/* Search */}
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search hostname, IP, vendor…"
              className="pl-9 pr-4 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
            />
          </div>
        </div>

        {/* Device cards */}
        {filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 py-16 text-center">
            <p className="text-slate-400 text-sm">
              {search ? `No devices match "${search}"` : 'No devices found.'}
            </p>
            {search && (
              <button onClick={() => setSearch('')} className="mt-2 text-xs text-blue-600 hover:underline">
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(d => (
              <DeviceCard key={d.id} device={d} inMaintenance={inMaintenance.has(d.id)} />
            ))}
          </div>
        )}

      </div>
    </div>
  )
}
