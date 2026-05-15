import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fetchFlowSummary, fetchTopTalkers, fetchTopPorts, fetchProtocolBreakdown,
  fetchTopDevices, fetchFlowTimeseries, searchFlows, fetchIpDetail,
} from '../api/flow'
import { fetchDevices } from '../api/devices'
import TimeSeriesChart from '../components/TimeSeriesChart'
import { DEVICE_TYPE_COLOR, DeviceTypeIcon } from '../components/DeviceTypeIcon'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`
  if (b >= 1e9)  return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3)  return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}
function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(n)
}
function fmtTs(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const PROTO_COLOR: Record<string, string> = {
  TCP: '#3b82f6', UDP: '#f59e0b', ICMP: '#10b981', OSPF: '#8b5cf6',
  GRE: '#ec4899', ESP: '#ef4444', SCTP: '#06b6d4',
}
const protoColor = (name: string) => PROTO_COLOR[name] ?? '#94a3b8'

const PORT_NAMES: Record<number, string> = {
  20: 'FTP-data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  80: 'HTTP', 110: 'POP3', 143: 'IMAP', 179: 'BGP', 443: 'HTTPS', 465: 'SMTPS',
  514: 'Syslog', 587: 'SMTP', 993: 'IMAPS', 995: 'POP3S', 1194: 'OpenVPN',
  1433: 'MSSQL', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC',
  6379: 'Redis', 8080: 'HTTP-alt', 8443: 'HTTPS-alt',
}

const TIME_WINDOWS = [
  { label: '15m', minutes: 15 },
  { label: '1h',  minutes: 60 },
  { label: '6h',  minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '7d',  minutes: 10080 },
]

// ── Filter state ──────────────────────────────────────────────────────────────

interface Filters {
  srcIp?:    string
  dstIp?:    string
  protocol?: number
  dstPort?:  number
}

function FilterChips({ filters, onRemove }: { filters: Filters; onRemove: (k: keyof Filters) => void }) {
  const chips: { key: keyof Filters; label: string }[] = []
  if (filters.srcIp)    chips.push({ key: 'srcIp',    label: `src: ${filters.srcIp}` })
  if (filters.dstIp)    chips.push({ key: 'dstIp',    label: `dst: ${filters.dstIp}` })
  if (filters.protocol != null) chips.push({ key: 'protocol', label: `proto: ${filters.protocol}` })
  if (filters.dstPort != null)  chips.push({ key: 'dstPort',  label: `port: ${filters.dstPort}` })
  if (chips.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {chips.map(c => (
        <span key={c.key} className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700 font-mono">
          {c.label}
          <button onClick={() => onRemove(c.key)} className="text-blue-400 hover:text-blue-700 ml-0.5 leading-none">×</button>
        </span>
      ))}
    </div>
  )
}

// ── Clickable value helpers ───────────────────────────────────────────────────

function ClickableIP({ ip, role, onFilter, onDetail }: {
  ip: string; role: 'src' | 'dst'
  onFilter: (role: 'src' | 'dst', ip: string) => void
  onDetail: (ip: string) => void
}) {
  return (
    <span className="group/ip inline-flex items-center gap-0.5">
      <button
        onClick={() => onDetail(ip)}
        className="font-mono text-xs font-medium text-slate-700 hover:text-blue-600 hover:underline transition-colors"
        title="View IP details"
      >
        {ip}
      </button>
      <button
        onClick={() => onFilter(role, ip)}
        className="opacity-0 group-hover/ip:opacity-100 transition-opacity text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 hover:bg-blue-100 hover:text-blue-600 ml-0.5"
        title={`Filter by ${role} IP`}
      >
        {role}
      </button>
    </span>
  )
}

function ClickableProto({ name, proto, onFilter }: { name: string; proto: number; onFilter: (p: number) => void }) {
  return (
    <button
      onClick={() => onFilter(proto)}
      className="text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors hover:opacity-80"
      style={{ backgroundColor: `${protoColor(name)}18`, color: protoColor(name) }}
      title="Filter by protocol"
    >
      {name}
    </button>
  )
}

function ClickablePort({ port, onFilter }: { port: number; proto?: string; onFilter: (p: number) => void }) {
  return (
    <button
      onClick={() => onFilter(port)}
      className="font-mono text-xs font-bold text-slate-700 hover:text-blue-600 hover:underline transition-colors"
      title="Filter by port"
    >
      {port}
    </button>
  )
}

// ── IP detail panel ───────────────────────────────────────────────────────────

function IpDetailPanel({ ip, minutes, deviceId, onClose, onFilter }: {
  ip: string; minutes: number; deviceId: string
  onClose: () => void
  onFilter: (role: 'src' | 'dst', ip: string) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['flow-ip-detail', ip, minutes, deviceId],
    queryFn:  () => fetchIpDetail(ip, minutes, deviceId || undefined),
  })

  const maxPeerBytes = Math.max(...(data?.top_peers ?? []).map(p => p.bytes_sent + p.bytes_received), 1)
  const maxPortBytes = Math.max(...(data?.top_ports ?? []).map(p => p.bytes_total), 1)

  const tsSeries = useMemo(() => [
    { name: 'Out', color: '#f59e0b', data: (data?.timeseries ?? []).map(p => [p.ts_ms, p.bytes_out] as [number, number]) },
    { name: 'In',  color: '#6366f1', data: (data?.timeseries ?? []).map(p => [p.ts_ms, p.bytes_in]  as [number, number]) },
  ], [data])

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="w-full max-w-md bg-white shadow-2xl flex flex-col overflow-hidden border-l border-slate-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-0.5">IP Detail</p>
            <h2 className="text-base font-bold text-slate-800 font-mono">{ip}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onFilter('src', ip)} className="px-2.5 py-1 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-lg hover:bg-amber-100 transition-colors">as src</button>
            <button onClick={() => onFilter('dst', ip)} className="px-2.5 py-1 text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors">as dst</button>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-6 text-center text-sm text-slate-400">Loading…</div>
          ) : !data ? null : (
            <>
              {/* In/Out totals */}
              <div className="px-5 py-4 grid grid-cols-2 gap-3 border-b border-slate-100">
                <div className="bg-indigo-50 rounded-xl px-4 py-3">
                  <p className="text-[10px] text-indigo-400 font-medium uppercase tracking-wide">Sent (as src)</p>
                  <p className="text-xl font-bold text-indigo-700 tabular-nums mt-1">{fmtBytes(data.bytes_as_src)}</p>
                  <p className="text-xs text-indigo-400 mt-0.5">{fmtNum(data.pkts_as_src)} pkts</p>
                </div>
                <div className="bg-amber-50 rounded-xl px-4 py-3">
                  <p className="text-[10px] text-amber-500 font-medium uppercase tracking-wide">Received (as dst)</p>
                  <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmtBytes(data.bytes_as_dst)}</p>
                  <p className="text-xs text-amber-400 mt-0.5">{fmtNum(data.pkts_as_dst)} pkts</p>
                </div>
              </div>

              {/* Time series */}
              {tsSeries[0].data.length >= 2 && (
                <div className="px-5 py-4 border-b border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-3">Traffic over time</p>
                  <TimeSeriesChart series={tsSeries} height={100} yFmt={v => fmtBytes(v) + '/s'} />
                </div>
              )}

              {/* Top peers */}
              {data.top_peers.length > 0 && (
                <div className="px-5 py-4 border-b border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-3">Top peers</p>
                  <div className="space-y-2">
                    {data.top_peers.map(p => (
                      <div key={p.peer_ip} className="flex items-center gap-2">
                        <button
                          onClick={() => onFilter('dst', p.peer_ip)}
                          className="font-mono text-xs text-slate-700 hover:text-blue-600 hover:underline w-32 shrink-0 text-left truncate"
                        >
                          {p.peer_ip}
                        </button>
                        <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full bg-indigo-400" style={{ width: `${((p.bytes_sent + p.bytes_received) / maxPeerBytes) * 100}%` }} />
                        </div>
                        <span className="text-xs text-slate-500 tabular-nums w-14 text-right shrink-0">{fmtBytes(p.bytes_sent + p.bytes_received)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Top ports */}
              {data.top_ports.length > 0 && (
                <div className="px-5 py-4">
                  <p className="text-xs font-semibold text-slate-500 mb-3">Top destination ports</p>
                  <div className="space-y-2">
                    {data.top_ports.map(p => (
                      <div key={`${p.dst_port}-${p.protocol}`} className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-700 w-10 shrink-0">{p.dst_port}</span>
                        <span className="text-[10px] text-slate-400 w-16 shrink-0">{PORT_NAMES[p.dst_port] ?? p.protocol_name}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${(p.bytes_total / maxPortBytes) * 100}%`, backgroundColor: protoColor(p.protocol_name) }} />
                        </div>
                        <span className="text-xs text-slate-500 tabular-nums w-14 text-right shrink-0">{fmtBytes(p.bytes_total)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ minutes, deviceId, filters }: { minutes: number; deviceId: string; filters: Filters }) {
  const { data, isLoading } = useQuery({
    queryKey:        ['flow-summary', minutes, deviceId, filters],
    queryFn:         () => fetchFlowSummary(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })
  const cards = [
    { name: 'Total bytes',    value: data ? fmtBytes(data.bytes_total)    : '—', accent: '#6366f1' },
    { name: 'Packets',        value: data ? fmtNum(data.packets_total)    : '—', accent: '#0891b2' },
    { name: 'Flows',          value: data ? fmtNum(data.flows_total)      : '—', accent: '#10b981' },
    { name: 'Unique src IPs', value: data ? fmtNum(data.unique_src_ips)   : '—', accent: '#f59e0b' },
    { name: 'Unique dst IPs', value: data ? fmtNum(data.unique_dst_ips)   : '—', accent: '#ef4444' },
    { name: 'Exporters',      value: data ? String(data.active_exporters) : '—', accent: '#8b5cf6' },
  ]
  return (
    <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map(c => (
        <div key={c.name} className="relative bg-white rounded-xl border border-slate-200 px-4 py-3 overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{ backgroundColor: c.accent }} />
          <p className="text-xs text-slate-400 mb-1">{c.name}</p>
          <p className="text-xl font-bold text-slate-800 tabular-nums">
            {isLoading ? <span className="text-slate-300">…</span> : c.value}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── Time series ───────────────────────────────────────────────────────────────

function FlowTimeSeries({ minutes, deviceId, filters }: { minutes: number; deviceId: string; filters: Filters }) {
  const { data = [] } = useQuery({
    queryKey:        ['flow-timeseries', minutes, deviceId, filters.srcIp, filters.dstIp],
    queryFn:         () => fetchFlowTimeseries(minutes, deviceId || undefined, filters.srcIp, filters.dstIp),
    refetchInterval: 30_000,
  })
  const series = [{ name: 'Bytes/s', color: '#6366f1', data: data.map(p => [p.ts_ms, p.bytes_total / 60] as [number, number]) }]
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Traffic volume</h2>
        <span className="text-[10px] text-slate-400">bytes/s avg per minute</span>
      </div>
      <div className="px-5 py-4">
        <TimeSeriesChart series={series} height={140} yFmt={v => fmtBytes(v) + '/s'} empty="No flow data yet" />
      </div>
    </div>
  )
}

// ── Top talkers ───────────────────────────────────────────────────────────────

function TopTalkersTable({ minutes, deviceId, filters, onFilter, onDetail }: {
  minutes: number; deviceId: string; filters: Filters
  onFilter: (role: 'src' | 'dst', ip: string) => void
  onDetail: (ip: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  // local no-op for protocol filter inside table rows — page-level handler owns it
  const setFilterProtoLocal = (_p: number) => {}

  const { data = [], isLoading } = useQuery({
    queryKey:        ['flow-top-talkers', minutes, deviceId, filters],
    queryFn:         () => fetchTopTalkers(minutes, 20, deviceId || undefined, filters.protocol),
    refetchInterval: 30_000,
  })

  const filtered = data.filter(r => {
    if (filters.srcIp  && r.src_ip !== filters.srcIp)  return false
    if (filters.dstIp  && r.dst_ip !== filters.dstIp)  return false
    return true
  })

  const maxBytes = Math.max(...filtered.map(r => r.bytes_total), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Top talkers</h2>
        <span className="text-[10px] text-slate-400">{filtered.length} pairs</span>
      </div>
      {isLoading ? (
        <div className="px-5 py-8 text-center text-xs text-slate-400">Loading…</div>
      ) : filtered.length === 0 ? <EmptyFlow /> : (
        <div className="divide-y divide-slate-50">
          {filtered.map((r, i) => {
            const key = `${r.src_ip}-${r.dst_ip}-${r.protocol}`
            const isOpen = expanded === key
            return (
              <div key={i}>
                <div className="px-5 py-2.5 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-2">
                    {/* Expand toggle */}
                    <button
                      onClick={() => setExpanded(isOpen ? null : key)}
                      className="text-slate-300 hover:text-slate-500 transition-colors shrink-0"
                      title="Expand conversation"
                    >
                      <svg className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <ClickableIP ip={r.src_ip} role="src" onFilter={onFilter} onDetail={onDetail} />
                        <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14m-4-4 4 4-4 4"/></svg>
                        <ClickableIP ip={r.dst_ip} role="dst" onFilter={onFilter} onDetail={onDetail} />
                        <ClickableProto name={r.protocol_name} proto={r.protocol} onFilter={setFilterProtoLocal} />
                        <span className="ml-auto text-xs font-bold text-slate-700 tabular-nums shrink-0">{fmtBytes(r.bytes_total)}</span>
                      </div>
                      <div className="mt-1 h-1 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full bg-indigo-400" style={{ width: `${(r.bytes_total / maxBytes) * 100}%` }} />
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-[11px] text-slate-400">
                        <span>{fmtNum(r.packets_total)} pkts</span>
                        <span>{fmtNum(r.flow_count)} flows</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Inline conversation time series */}
                {isOpen && (
                  <ConversationTimeSeries
                    srcIp={r.src_ip} dstIp={r.dst_ip}
                    minutes={minutes} deviceId={deviceId}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ConversationTimeSeries({ srcIp, dstIp, minutes, deviceId }: {
  srcIp: string; dstIp: string; minutes: number; deviceId: string
}) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['flow-conv-ts', srcIp, dstIp, minutes, deviceId],
    queryFn:  () => fetchFlowTimeseries(minutes, deviceId || undefined, srcIp, dstIp),
  })
  const series = [{ name: 'Bytes/s', color: '#6366f1', data: data.map(p => [p.ts_ms, p.bytes_total / 60] as [number, number]) }]
  return (
    <div className="px-8 pb-3 bg-slate-50 border-t border-slate-100">
      <p className="text-[10px] text-slate-400 pt-2 pb-1 font-medium uppercase tracking-wide">
        {srcIp} → {dstIp}
      </p>
      {isLoading ? (
        <div className="text-xs text-slate-400 py-2">Loading…</div>
      ) : (
        <TimeSeriesChart series={series} height={80} yFmt={v => fmtBytes(v) + '/s'} empty="No data for this conversation" />
      )}
    </div>
  )
}

// ── Protocol breakdown ────────────────────────────────────────────────────────

function ProtocolBreakdown({ minutes, deviceId, filters, onFilterProto }: {
  minutes: number; deviceId: string; filters: Filters
  onFilterProto: (p: number) => void
}) {
  const { data = [] } = useQuery({
    queryKey:        ['flow-protocols', minutes, deviceId],
    queryFn:         () => fetchProtocolBreakdown(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })
  const byProto = useMemo(() => {
    const m: Record<string, { name: string; proto: number; bytes: number }> = {}
    for (const p of data) {
      const key = String(p.protocol)
      if (!m[key]) m[key] = { name: p.protocol_name, proto: p.protocol, bytes: 0 }
      m[key].bytes += p.bytes_total
    }
    return Object.values(m).sort((a, b) => b.bytes - a.bytes).slice(0, 12)
  }, [data])
  const maxBytes = Math.max(...byProto.map(p => p.bytes), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Protocol breakdown</h2>
      </div>
      {byProto.length === 0 ? <EmptyFlow /> : (
        <div className="px-5 py-3 space-y-2.5">
          {byProto.map(p => (
            <div key={p.proto} className="flex items-center gap-3">
              <button
                onClick={() => onFilterProto(p.proto)}
                className={`text-xs font-medium w-14 shrink-0 text-left transition-colors hover:underline ${filters.protocol === p.proto ? 'text-blue-600 font-bold' : 'text-slate-600'}`}
              >
                {p.name}
              </button>
              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full transition-all cursor-pointer" onClick={() => onFilterProto(p.proto)} style={{ width: `${(p.bytes / maxBytes) * 100}%`, backgroundColor: protoColor(p.name) }} />
              </div>
              <span className="text-xs font-bold text-slate-600 tabular-nums w-16 text-right shrink-0">{fmtBytes(p.bytes)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Top ports ─────────────────────────────────────────────────────────────────

function TopPortsTable({ minutes, deviceId, filters, onFilterPort }: {
  minutes: number; deviceId: string; filters: Filters
  onFilterPort: (p: number) => void
}) {
  const { data = [], isLoading } = useQuery({
    queryKey:        ['flow-top-ports', minutes, deviceId],
    queryFn:         () => fetchTopPorts(minutes, 15, deviceId || undefined),
    refetchInterval: 30_000,
  })
  const maxBytes = Math.max(...data.map(r => r.bytes_total), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Top destination ports</h2>
      </div>
      {isLoading ? <div className="px-5 py-8 text-center text-xs text-slate-400">Loading…</div>
        : data.length === 0 ? <EmptyFlow /> : (
        <div className="divide-y divide-slate-50">
          {data.map((r, i) => (
            <div key={i} className={`px-5 py-2.5 hover:bg-slate-50 transition-colors flex items-center gap-3 ${filters.dstPort === r.dst_port ? 'bg-blue-50' : ''}`}>
              <div className="w-12 text-right shrink-0">
                <ClickablePort port={r.dst_port} proto={r.protocol_name} onFilter={onFilterPort} />
              </div>
              <div className="w-20 shrink-0 text-[10px] text-slate-400">{PORT_NAMES[r.dst_port] ?? r.protocol_name}</div>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden cursor-pointer" onClick={() => onFilterPort(r.dst_port)}>
                <div className="h-full rounded-full transition-all" style={{ width: `${(r.bytes_total / maxBytes) * 100}%`, backgroundColor: protoColor(r.protocol_name) }} />
              </div>
              <span className="text-xs font-bold text-slate-600 tabular-nums w-16 text-right shrink-0">{fmtBytes(r.bytes_total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Top devices ───────────────────────────────────────────────────────────────

function TopDevicesPanel({ minutes, onSelectDevice }: { minutes: number; onSelectDevice: (id: string) => void }) {
  const { data = [] } = useQuery({
    queryKey:        ['flow-top-devices', minutes],
    queryFn:         () => fetchTopDevices(minutes),
    refetchInterval: 30_000,
  })
  const maxBytes = Math.max(...data.map(d => d.bytes_total), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Top devices by flow</h2>
      </div>
      {data.length === 0 ? <EmptyFlow /> : (
        <div className="divide-y divide-slate-50">
          {data.map(d => (
            <div key={d.device_id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors group">
              <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[d.device_type] ?? '#475569' }}>
                <DeviceTypeIcon type={d.device_type} size={14} />
              </span>
              <button onClick={() => onSelectDevice(d.device_id)} className="text-sm font-medium text-slate-700 truncate group-hover:text-blue-600 transition-colors w-32 shrink-0 text-left" title="Filter to this device">
                {d.device_name}
              </button>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${(d.bytes_total / maxBytes) * 100}%` }} />
              </div>
              <span className="text-xs font-bold text-slate-600 tabular-nums w-16 text-right shrink-0">{fmtBytes(d.bytes_total)}</span>
              <Link to={`/devices/${d.device_id}`} className="shrink-0 text-slate-300 hover:text-blue-500 transition-colors" title="Go to device">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Flow search ───────────────────────────────────────────────────────────────

function FlowSearch({ deviceId, filters }: { deviceId: string; filters: Filters }) {
  const [open, setOpen] = useState(false)
  const [srcIp,   setSrcIp]   = useState(filters.srcIp   ?? '')
  const [dstIp,   setDstIp]   = useState(filters.dstIp   ?? '')
  const [proto,   setProto]   = useState(filters.protocol != null ? String(filters.protocol) : '')
  const [dstPort, setDstPort] = useState(filters.dstPort  != null ? String(filters.dstPort)  : '')
  const [minutes, setMinutes] = useState('10')
  const [submitted, setSubmitted] = useState(false)

  const params = {
    device_id: deviceId || undefined,
    src_ip:    srcIp    || undefined,
    dst_ip:    dstIp    || undefined,
    protocol:  proto    ? Number(proto)   : undefined,
    dst_port:  dstPort  ? Number(dstPort) : undefined,
    minutes:   Number(minutes),
    limit:     200,
  }

  const { data = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['flow-search', params],
    queryFn:  () => searchFlows(params),
    enabled:  submitted,
  })

  const inputCls = "border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 w-full bg-white"

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-slate-50 transition-colors">
        <h2 className="text-sm font-semibold text-slate-800">Flow search</h2>
        <svg className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {open && (
        <>
          <div className="px-5 py-4 border-t border-slate-100 grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Src IP</label>
              <input value={srcIp} onChange={e => setSrcIp(e.target.value)} placeholder="1.2.3.4" className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Dst IP</label>
              <input value={dstIp} onChange={e => setDstIp(e.target.value)} placeholder="5.6.7.8" className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Protocol</label>
              <select value={proto} onChange={e => setProto(e.target.value)} className={inputCls}>
                <option value="">Any</option>
                <option value="6">TCP (6)</option>
                <option value="17">UDP (17)</option>
                <option value="1">ICMP (1)</option>
                <option value="89">OSPF (89)</option>
                <option value="47">GRE (47)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Dst port</label>
              <input value={dstPort} onChange={e => setDstPort(e.target.value)} placeholder="443" className={inputCls} type="number" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Window</label>
              <select value={minutes} onChange={e => setMinutes(e.target.value)} className={inputCls}>
                <option value="5">Last 5m</option>
                <option value="10">Last 10m</option>
                <option value="30">Last 30m</option>
                <option value="60">Last 1h</option>
                <option value="360">Last 6h</option>
              </select>
            </div>
          </div>
          <div className="px-5 pb-4 flex items-center gap-3">
            <button onClick={() => { setSubmitted(true); refetch() }} className="px-4 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg hover:bg-slate-700 transition-colors">
              {isFetching ? 'Searching…' : 'Search'}
            </button>
            {submitted && <span className="text-xs text-slate-400">{data.length} records</span>}
          </div>
          {submitted && data.length > 0 && (
            <div className="border-t border-slate-100 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    {['Time','Src','Dst','Proto','Bytes','Pkts','Type'].map(h => (
                      <th key={h} className={`px-4 py-2 font-medium text-slate-500 ${h === 'Bytes' || h === 'Pkts' ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {data.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-2 font-mono text-slate-400 whitespace-nowrap">{fmtTs(r.flow_start_ms)}</td>
                      <td className="px-4 py-2 font-mono text-slate-700 whitespace-nowrap">
                        {r.src_ip}{r.src_port > 0 && <span className="text-slate-400">:{r.src_port}</span>}
                      </td>
                      <td className="px-4 py-2 font-mono text-slate-700 whitespace-nowrap">
                        {r.dst_ip}{r.dst_port > 0 && <span className="text-slate-400">:{r.dst_port}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ backgroundColor: `${protoColor(r.protocol_name)}18`, color: protoColor(r.protocol_name) }}>
                          {r.protocol_name}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-600 whitespace-nowrap">{fmtBytes(r.bytes)}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-500 whitespace-nowrap">{fmtNum(r.packets)}</td>
                      <td className="px-4 py-2 text-slate-400">{r.flow_type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {submitted && !isLoading && data.length === 0 && (
            <div className="px-5 py-6 text-center text-xs text-slate-400 border-t border-slate-100">No flows matched</div>
          )}
        </>
      )}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyFlow() {
  return (
    <div className="px-5 py-8 text-center">
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-slate-100 mb-3">
        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path d="M3 7h4l2 4h10l-2-9H9L7 7M3 7l2 10h14l2-4"/></svg>
      </div>
      <p className="text-sm text-slate-400">No flow data</p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FlowPage() {
  const [deviceId,   setDeviceId]   = useState('')
  const [windowMins, setWindowMins] = useState(60)
  const [filters,    setFilters]    = useState<Filters>({})
  const [detailIp,   setDetailIp]   = useState<string | null>(null)

  const { data: devicesResp } = useQuery({
    queryKey: ['devices-list'],
    queryFn:  () => fetchDevices({ limit: 500 }),
  })
  const devices: any[] = (devicesResp as any)?.items ?? devicesResp ?? []

  const setFilter = (role: 'src' | 'dst', ip: string) => {
    if (!ip) return
    setFilters(f => role === 'src' ? { ...f, srcIp: ip } : { ...f, dstIp: ip })
  }
  const setFilterProto = (p: number) => setFilters(f => ({ ...f, protocol: f.protocol === p ? undefined : p }))
  const setFilterPort  = (p: number) => setFilters(f => ({ ...f, dstPort:  f.dstPort  === p ? undefined : p }))
  const removeFilter   = (k: keyof Filters) => setFilters(f => { const n = { ...f }; delete n[k]; return n })
  const clearFilters   = () => setFilters({})

  const hasFilters = Object.keys(filters).some(k => filters[k as keyof Filters] != null)

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-slate-800">Flow</h1>
            <p className="text-xs text-slate-400 mt-0.5">NetFlow · sFlow · IPFIX</p>
          </div>

          <select value={deviceId} onChange={e => setDeviceId(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-600">
            <option value="">All devices</option>
            {devices.map((d: any) => <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>)}
          </select>

          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {TIME_WINDOWS.map(w => (
              <button key={w.minutes} onClick={() => setWindowMins(w.minutes)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${windowMins === w.minutes ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'} ${w.minutes !== 15 ? 'border-l border-slate-200' : ''}`}>
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {/* Active filter chips */}
        {hasFilters && (
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <FilterChips filters={filters} onRemove={removeFilter} />
            <button onClick={clearFilters} className="text-[10px] text-slate-400 hover:text-slate-600 underline">Clear all</button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-6 space-y-4">
        <SummaryCards minutes={windowMins} deviceId={deviceId} filters={filters} />
        <FlowTimeSeries minutes={windowMins} deviceId={deviceId} filters={filters} />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3">
            <TopTalkersTable
              minutes={windowMins} deviceId={deviceId} filters={filters}
              onFilter={setFilter} onDetail={setDetailIp}
            />
          </div>
          <div className="lg:col-span-2">
            <ProtocolBreakdown
              minutes={windowMins} deviceId={deviceId} filters={filters}
              onFilterProto={setFilterProto}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TopPortsTable
            minutes={windowMins} deviceId={deviceId} filters={filters}
            onFilterPort={setFilterPort}
          />
          <TopDevicesPanel minutes={windowMins} onSelectDevice={setDeviceId} />
        </div>

        <FlowSearch deviceId={deviceId} filters={filters} />
      </div>

      {/* IP detail slide-out */}
      {detailIp && (
        <IpDetailPanel
          ip={detailIp} minutes={windowMins} deviceId={deviceId}
          onClose={() => setDetailIp(null)}
          onFilter={(role, ip) => { setFilter(role, ip); setDetailIp(null) }}
        />
      )}
    </div>
  )
}
