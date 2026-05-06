import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { fetchDevice, fetchDeviceHealth, fetchDeviceInterfaces, deleteDevice, patchDevice, setAlertExclusions, fetchDeviceCredentials, linkDeviceCredential, unlinkDeviceCredential, runSnmpDiag, fetchDeviceNeighbours } from '../api/devices'
import { fetchCredentials } from '../api/credentials'
import { fetchMaintenanceWindows, createMaintenanceWindow, deleteMaintenanceWindow, type MaintenanceWindow } from '../api/maintenance'
import StatusBadge from '../components/StatusBadge'
import VendorBadge from '../components/VendorBadge'

function formatUptime(secs: number | string | null) {
  if (!secs) return '—'
  const s = Number(secs)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

function formatSpeed(bps: number | string | null) {
  if (!bps) return '—'
  const n = Number(bps)
  if (n >= 1_000_000_000) return `${n / 1_000_000_000}G`
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  if (n >= 1_000) return `${n / 1_000}K`
  return `${n}`
}

function formatBytes(bytes: number | string | null) {
  if (!bytes) return '—'
  const gb = Number(bytes) / 1_073_741_824
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = Number(bytes) / 1_048_576
  return `${mb.toFixed(0)} MB`
}

function MemBar({ used, total }: { used: number | string | null; total: number | string | null }) {
  if (!used || !total) return <span className="text-slate-400 text-sm">—</span>
  const pct = Math.round((Number(used) / Number(total)) * 100)
  const colour = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{formatBytes(used)} / {formatBytes(total)}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function GearIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{title}</p>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

function Input({ value, onChange, type = 'text' }: { value: string | number; onChange: (v: string) => void; type?: string }) {
  return (
    <input
      type={type} value={value} onChange={e => onChange(e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 px-4 py-3">
      <p className="text-xs font-medium text-slate-400">{title}</p>
      <p className="text-xs text-slate-300 mt-0.5">{description}</p>
    </div>
  )
}

// ── Neighbours ────────────────────────────────────────────────────────────────

function nodeColor(caps: string[]): string {
  if (caps.includes('router'))          return '#2563eb'  // blue
  if (caps.includes('bridge') || caps.includes('switch')) return '#16a34a' // green
  if (caps.includes('wlanAccessPoint')) return '#7c3aed'  // purple
  if (caps.includes('telephone'))       return '#ea580c'  // orange
  return '#475569' // slate
}

interface TopoNode {
  key:   string
  label: string
  ip:    string | null
  caps:  string[]
  localPort:  string
  remotePort: string | null
  protocol: 'lldp' | 'cdp'
}

function NeighbourMap({ deviceName, nodes }: { deviceName: string; nodes: TopoNode[] }) {
  const [hovered, setHovered] = useState<string | null>(null)
  const W = 760, H = 400
  const cx = W / 2, cy = H / 2
  const radius = Math.min(160, 60 + nodes.length * 14)

  const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-400 text-sm">
        No neighbour data yet — waiting for a poll cycle.
      </div>
    )
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 400 }}>
      {/* Edges */}
      {nodes.map((n, i) => {
        const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2
        const nx = cx + radius * Math.cos(angle)
        const ny = cy + radius * Math.sin(angle)
        const isHov = hovered === n.key
        const mx = (cx + nx) / 2, my = (cy + ny) / 2
        return (
          <g key={n.key + '-edge'}>
            <line x1={cx} y1={cy} x2={nx} y2={ny}
              stroke={isHov ? '#94a3b8' : '#e2e8f0'} strokeWidth={isHov ? 2 : 1.5} />
            {/* port labels */}
            <text x={cx + (nx - cx) * 0.25} y={cy + (ny - cy) * 0.25 - 4}
              fontSize={9} fill="#94a3b8" textAnchor="middle">{n.localPort}</text>
            {n.remotePort && (
              <text x={cx + (nx - cx) * 0.78} y={cy + (ny - cy) * 0.78 - 4}
                fontSize={9} fill="#94a3b8" textAnchor="middle">{trunc(n.remotePort, 10)}</text>
            )}
            {/* mgmt IP near neighbour */}
            {isHov && n.ip && (
              <text x={nx} y={ny + 28} fontSize={9} fill="#64748b" textAnchor="middle">{n.ip}</text>
            )}
          </g>
        )
      })}

      {/* Neighbour nodes */}
      {nodes.map((n, i) => {
        const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2
        const nx = cx + radius * Math.cos(angle)
        const ny = cy + radius * Math.sin(angle)
        const color = nodeColor(n.caps)
        const isHov = hovered === n.key
        return (
          <g key={n.key} style={{ cursor: 'default' }}
            onMouseEnter={() => setHovered(n.key)}
            onMouseLeave={() => setHovered(null)}>
            <circle cx={nx} cy={ny} r={isHov ? 22 : 18}
              fill="white" stroke={color} strokeWidth={isHov ? 3 : 2} />
            {/* capability icon letter */}
            <text x={nx} y={ny + 4} fontSize={10} fontWeight="600"
              fill={color} textAnchor="middle">
              {n.caps.includes('router') ? 'R' : n.caps.includes('bridge') || n.caps.includes('switch') ? 'SW' : n.caps.includes('wlanAccessPoint') ? 'AP' : '?'}
            </text>
            {/* label */}
            <text x={nx} y={ny + 32} fontSize={10} fill="#334155" textAnchor="middle" fontWeight="500">
              {trunc(n.label, 14)}
            </text>
            {/* protocol badge */}
            <text x={nx} y={ny + 43} fontSize={8} fill="#94a3b8" textAnchor="middle">
              {n.protocol.toUpperCase()}
            </text>
          </g>
        )
      })}

      {/* Centre device */}
      <circle cx={cx} cy={cy} r={28} fill="#1e293b" stroke="#334155" strokeWidth={2} />
      <text x={cx} y={cy + 4} fontSize={10} fontWeight="700" fill="white" textAnchor="middle">
        {trunc(deviceName, 12)}
      </text>
    </svg>
  )
}

function NeighboursSection({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const [view, setView] = useState<'list' | 'map'>('list')

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['neighbours', deviceId],
    queryFn: () => fetchDeviceNeighbours(deviceId),
    staleTime: 60_000,
  })

  const lldp = data?.lldp ?? []
  const cdp  = data?.cdp  ?? []
  const total = lldp.length + cdp.length

  // Merged node list for the map — deduplicate by remote name
  const topoNodes: TopoNode[] = [
    ...lldp.map(n => ({
      key:        n.remote_system_name || n.remote_chassis_id || n.local_port,
      label:      n.remote_system_name || n.remote_chassis_id || '?',
      ip:         n.remote_mgmt_ip,
      caps:       n.capabilities,
      localPort:  n.local_port,
      remotePort: n.remote_port,
      protocol:   'lldp' as const,
    })),
    ...cdp
      .filter(n => !lldp.some(l => l.remote_system_name === n.remote_device))
      .map(n => ({
        key:        n.remote_device || n.local_port,
        label:      n.remote_device || '?',
        ip:         n.remote_mgmt_ip,
        caps:       n.capabilities,
        localPort:  n.local_port,
        remotePort: n.remote_port,
        protocol:   'cdp' as const,
      })),
  ]

  if (isLoading) return <p className="text-xs text-slate-400 p-4">Loading…</p>

  return (
    <div>
      {/* Sub-tab bar */}
      <div className="flex items-center justify-between border-b border-slate-100 px-1 mb-3">
        <div className="flex">
          {(['list', 'map'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors capitalize ${
                view === v ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>
              {v === 'list' ? `List${total ? ` (${total})` : ''}` : 'Map'}
            </button>
          ))}
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="text-xs text-blue-600 hover:underline disabled:opacity-50 pr-1">
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {view === 'list' && (
        <div className="space-y-3">
          {total === 0 && <p className="text-xs text-slate-400">No neighbours discovered yet.</p>}

          {lldp.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">LLDP</p>
              <div className="space-y-1.5">
                {lldp.map((n, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-500 shrink-0">{n.local_port}</span>
                      <span className="text-slate-300">→</span>
                      <span className="font-medium text-slate-700 truncate">{n.remote_system_name || n.remote_chassis_id || '—'}</span>
                      {n.remote_port && <span className="font-mono text-slate-400 shrink-0">{n.remote_port}</span>}
                    </div>
                    {(n.remote_mgmt_ip || n.capabilities.length > 0) && (
                      <div className="mt-1 flex flex-wrap gap-2 text-slate-400">
                        {n.remote_mgmt_ip && <span>{n.remote_mgmt_ip}</span>}
                        {n.capabilities.map(c => (
                          <span key={c} className="px-1 bg-slate-100 rounded text-slate-500">{c}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {cdp.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">CDP</p>
              <div className="space-y-1.5">
                {cdp.map((n, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-500 shrink-0">{n.local_port}</span>
                      <span className="text-slate-300">→</span>
                      <span className="font-medium text-slate-700 truncate">{n.remote_device || '—'}</span>
                      {n.remote_port && <span className="font-mono text-slate-400 shrink-0">{n.remote_port}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-slate-400">
                      {n.remote_mgmt_ip && <span>{n.remote_mgmt_ip}</span>}
                      {n.platform && <span className="italic">{n.platform}</span>}
                      {n.duplex && <span>{n.duplex} duplex</span>}
                      {n.native_vlan != null && n.native_vlan > 0 && <span>vlan {n.native_vlan}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {view === 'map' && (
        <NeighbourMap deviceName={deviceName} nodes={topoNodes} />
      )}
    </div>
  )
}

// ── Credential assignment ─────────────────────────────────────────────────────

const CRED_TYPE_LABEL: Record<string, string> = {
  snmp_v2c: 'SNMP v2c', snmp_v3: 'SNMP v3', ssh: 'SSH',
  gnmi_tls: 'gNMI TLS', api_token: 'API Token', netconf: 'NETCONF',
}

function CredentialSection({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState('')
  const [priority, setPriority]     = useState('0')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [errMsg, setErrMsg]         = useState('')

  const { data: assigned = [], isLoading } = useQuery({
    queryKey: ['device-creds', deviceId],
    queryFn: () => fetchDeviceCredentials(deviceId),
  })
  const { data: all = [] } = useQuery({
    queryKey: ['credentials-all'],
    queryFn: () => fetchCredentials(true),
  })

  const unassignedIds = new Set(assigned.map(a => a.credential_id))
  const available = all.filter(c => !unassignedIds.has(c.id))

  const linkMut = useMutation({
    mutationFn: () => linkDeviceCredential(deviceId, selectedId, Number(priority)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['device-creds', deviceId] }); setSelectedId(''); setErrMsg('') },
    onError: (e: any) => setErrMsg(e?.response?.data?.detail ?? 'Failed to assign'),
  })

  const unlinkMut = useMutation({
    mutationFn: (credId: string) => unlinkDeviceCredential(deviceId, credId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['device-creds', deviceId] }); setConfirmDel(null) },
  })

  if (isLoading) return <p className="text-xs text-slate-400">Loading…</p>

  return (
    <div className="space-y-2">
      {assigned.length === 0 && <p className="text-xs text-slate-400">No credentials assigned.</p>}
      {assigned.map(a => (
        <div key={a.credential_id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs">
          <div>
            <span className="font-medium text-slate-700">{a.name}</span>
            <span className="ml-2 text-slate-400">{CRED_TYPE_LABEL[a.type] ?? a.type}</span>
            <span className="ml-2 text-slate-300">priority {a.priority}</span>
          </div>
          {confirmDel === a.credential_id ? (
            <div className="flex items-center gap-2">
              <button onClick={() => unlinkMut.mutate(a.credential_id)} className="text-red-600 hover:underline">Remove</button>
              <button onClick={() => setConfirmDel(null)} className="text-slate-400 hover:underline">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDel(a.credential_id)} className="text-slate-400 hover:text-red-500">✕</button>
          )}
        </div>
      ))}

      {available.length > 0 && (
        <div className="flex gap-2 pt-1">
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
            className="flex-1 border border-slate-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">Assign credential…</option>
            {available.map(c => <option key={c.id} value={c.id}>{c.name} ({CRED_TYPE_LABEL[c.type] ?? c.type})</option>)}
          </select>
          <input type="number" value={priority} onChange={e => setPriority(e.target.value)}
            placeholder="Pri" className="w-14 border border-slate-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button onClick={() => linkMut.mutate()} disabled={!selectedId || linkMut.isPending}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            Assign
          </button>
        </div>
      )}
      {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
    </div>
  )
}

// ── SNMP diagnostic ────────────────────────────────────────────────────────────

function SnmpDiagSection({ deviceId }: { deviceId: string }) {
  const [result, setResult]   = useState<Awaited<ReturnType<typeof runSnmpDiag>> | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState('')

  async function run() {
    setRunning(true); setResult(null); setError('')
    try {
      const r = await runSnmpDiag(deviceId)
      setResult(r)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Request failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-3">
      <button onClick={run} disabled={running}
        className="w-full border border-slate-300 text-slate-600 text-sm rounded-lg py-2 hover:bg-slate-50 disabled:opacity-50 transition-colors">
        {running ? 'Running…' : 'Run SNMP diagnostic'}
      </button>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {result && (
        <div className={`rounded-lg border p-3 text-xs space-y-2 ${result.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          <div className="flex items-center justify-between">
            <span className={`font-semibold ${result.success ? 'text-green-700' : 'text-red-700'}`}>
              {result.success ? 'Reachable' : 'Failed'}
            </span>
            <span className="text-slate-400">
              {result.credential_name} · {CRED_TYPE_LABEL[result.credential_type] ?? result.credential_type}
              {result.response_ms != null && ` · ${result.response_ms}ms`}
            </span>
          </div>
          {result.error && <p className="text-red-600">{result.error}</p>}
          {result.results.map(r => (
            <div key={r.oid} className="flex gap-3">
              <span className="text-slate-500 w-24 shrink-0">{r.oid}</span>
              <span className="text-slate-700 break-all">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Maintenance windows ────────────────────────────────────────────────────────

function MaintenanceBadge({ deviceId }: { deviceId: string }) {
  const { data: windows = [] } = useQuery({
    queryKey: ['maintenance', deviceId],
    queryFn: () => fetchMaintenanceWindows({ device_id: deviceId }),
  })
  if (!windows.some(w => w.is_active)) return null
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      In maintenance
    </span>
  )
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function MaintenanceSection({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
  const [showForm, setShowForm]     = useState(false)
  const [name, setName]             = useState('')
  const [startsAt, setStartsAt]     = useState('')
  const [endsAt, setEndsAt]         = useState('')
  const [isRecurring, setIsRecurring] = useState(false)
  const [cron, setCron]             = useState('0 2 * * 6')
  const [errMsg, setErrMsg]         = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const { data: windows = [], isLoading } = useQuery({
    queryKey: ['maintenance', deviceId],
    queryFn: () => fetchMaintenanceWindows({ device_id: deviceId }),
  })

  const createMut = useMutation({
    mutationFn: () => createMaintenanceWindow({
      name,
      device_selector: { device_ids: [deviceId] },
      starts_at: new Date(startsAt).toISOString(),
      ends_at: new Date(endsAt).toISOString(),
      is_recurring: isRecurring,
      recurrence_cron: isRecurring ? cron : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance', deviceId] })
      setShowForm(false); setName(''); setStartsAt(''); setEndsAt(''); setErrMsg('')
    },
    onError: (e: any) => setErrMsg(e?.response?.data?.detail ?? 'Failed to create window'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMaintenanceWindow(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maintenance', deviceId] }); setConfirmDel(null) },
  })

  if (isLoading) return <p className="text-xs text-slate-400">Loading…</p>

  return (
    <div className="space-y-3">
      {windows.length === 0 && !showForm && (
        <p className="text-xs text-slate-400">No maintenance windows scheduled.</p>
      )}

      {windows.map(w => (
        <div key={w.id} className={`rounded-lg border px-3 py-2 text-xs space-y-0.5 ${w.is_active ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-700">{w.name}</span>
            <div className="flex items-center gap-2">
              {w.is_active && (
                <span className="px-1.5 py-0.5 bg-amber-200 text-amber-800 rounded text-xs font-medium">Active</span>
              )}
              {w.is_recurring && (
                <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">Recurring</span>
              )}
              {confirmDel === w.id ? (
                <>
                  <button onClick={() => deleteMut.mutate(w.id)} className="text-red-600 hover:underline">Confirm</button>
                  <button onClick={() => setConfirmDel(null)} className="text-slate-400 hover:underline">Cancel</button>
                </>
              ) : (
                <button onClick={() => setConfirmDel(w.id)} className="text-slate-400 hover:text-red-600">Delete</button>
              )}
            </div>
          </div>
          {w.is_recurring
            ? <p className="text-slate-400">Cron: <code>{w.recurrence_cron}</code> · duration {Math.round((new Date(w.ends_at).getTime() - new Date(w.starts_at).getTime()) / 60000)} min</p>
            : <p className="text-slate-400">{fmt(w.starts_at)} → {fmt(w.ends_at)}</p>
          }
        </div>
      ))}

      {showForm ? (
        <div className="rounded-lg border border-slate-200 p-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Scheduled maintenance"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Start</label>
              <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">End</label>
              <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
            <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)}
              className="rounded border-slate-300 text-blue-600" />
            Recurring
          </label>
          {isRecurring && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Cron expression</label>
              <input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 2 * * 6"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-slate-400 mt-1">Standard 5-field cron. Start/end define the duration per occurrence.</p>
            </div>
          )}
          {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
          <div className="flex gap-2">
            <button onClick={() => createMut.mutate()} disabled={!name || !startsAt || !endsAt || createMut.isPending}
              className="flex-1 bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {createMut.isPending ? 'Saving…' : 'Schedule'}
            </button>
            <button onClick={() => { setShowForm(false); setErrMsg('') }}
              className="flex-1 text-sm text-slate-500 border border-slate-200 rounded-lg py-2 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)}
          className="w-full mt-1 border border-slate-300 text-slate-600 text-sm rounded-lg py-2 hover:bg-slate-50 transition-colors">
          + Schedule downtime
        </button>
      )}
    </div>
  )
}

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tab, setTab] = useState<'interfaces' | 'neighbours'>('interfaces')

  const deleteMutation = useMutation({
    mutationFn: () => deleteDevice(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      navigate('/devices')
    },
  })

  const { data: device, isLoading, isError } = useQuery({
    queryKey: ['device', id],
    queryFn: () => fetchDevice(id!),
    enabled: !!id,
  })

  const { data: health } = useQuery({
    queryKey: ['device-health', id],
    queryFn: () => fetchDeviceHealth(id!),
    enabled: !!id,
    refetchInterval: 15_000,
    retry: false,
  })

  const { data: interfaces, isLoading: ifaceLoading } = useQuery({
    queryKey: ['device-interfaces', id],
    queryFn: () => fetchDeviceInterfaces(id!),
    enabled: !!id,
    refetchInterval: 15_000,
  })

  // SNMP form state — initialised from device once loaded
  const [snmpVersion, setSnmpVersion] = useState('')
  const [snmpPort, setSnmpPort] = useState('')
  const [pollingInterval, setPollingInterval] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState('')
  const [ignoredMetrics, setIgnoredMetrics] = useState<string[]>([])
  const [ignoredIfaces, setIgnoredIfaces] = useState<string[]>([])
  const [overrideMetric, setOverrideMetric] = useState('cpu_util_pct')
  const [overrideThreshold, setOverrideThreshold] = useState('')
  const [overrideSeverity, setOverrideSeverity] = useState('warning')
  const [overrideMsg, setOverrideMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const exclusionMutation = useMutation({
    mutationFn: () => setAlertExclusions(id!, ignoredMetrics, ignoredIfaces),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['device', id] }),
  })

  const overrideMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      import('../api/client').then(m => m.default.post('/alert-rules', body)),
    onSuccess: () => {
      setOverrideThreshold('')
      setOverrideMsg({ ok: true, text: 'Override rule created.' })
    },
    onError: () => setOverrideMsg({ ok: false, text: 'Failed to create override.' }),
  })

  const patchMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => patchDevice(id!, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['device', id] }),
  })

  if (isLoading || !device) return <div className="p-8 text-slate-500">Loading…</div>
  if (isError) return <div className="p-8 text-red-600">Failed to load device.</div>

  const upIfaces = interfaces?.filter((i) => i.oper_status === 'up').length ?? 0
  const totalIfaces = interfaces?.length ?? 0

  const openSettings = () => {
    setSnmpVersion(device.snmp_version)
    setSnmpPort(String(device.snmp_port))
    setPollingInterval(String(device.polling_interval_s))
    setTagInput('')
    setTagError('')
    const excl = (device as any).alert_exclusions ?? { metrics: [], interface_ids: [] }
    setIgnoredMetrics(excl.metrics ?? [])
    setIgnoredIfaces(excl.interface_ids ?? [])
    setConfirmDelete(false)
    setSettingsOpen(true)
  }

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase().replace(/\s+/g, '-')
    if (!tag) return
    const current: string[] = device.tags ?? []
    if (current.includes(tag)) { setTagError('Tag already exists'); return }
    setTagError('')
    patchMutation.mutate({ tags: [...current, tag] }, {
      onSuccess: () => { setTagInput(''); queryClient.invalidateQueries({ queryKey: ['device', id] }) },
    })
  }

  const removeTag = (tag: string) => {
    const current: string[] = device.tags ?? []
    patchMutation.mutate({ tags: current.filter(t => t !== tag) })
  }

  const saveSnmp = () => patchMutation.mutate({
    snmp_version: snmpVersion,
    snmp_port: Number(snmpPort),
    polling_interval_s: Number(pollingInterval),
  })

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <nav className="flex items-center gap-2 text-sm">
          <Link to="/devices" className="text-blue-600 hover:underline">Devices</Link>
          <span className="text-slate-400">/</span>
          <span className="font-medium text-slate-800">{device.fqdn ?? device.hostname}</span>
        </nav>
        <div className="flex items-center gap-3">
          <StatusBadge status={device.status} />
          <MaintenanceBadge deviceId={id!} />
          <button
            onClick={openSettings}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            title="Device settings"
          >
            <GearIcon />
          </button>
        </div>
      </div>

      {/* Settings drawer */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 bg-black/20 z-30" onClick={() => setSettingsOpen(false)} />
          <div className="fixed top-0 right-0 h-full w-80 bg-white shadow-xl z-40 flex flex-col">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-700">
                <GearIcon />
                <span className="text-sm font-semibold">Device settings</span>
              </div>
              <button onClick={() => setSettingsOpen(false)} className="text-slate-400 hover:text-slate-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">

              <Section title="SNMP">
                <Field label="Version">
                  <Select value={snmpVersion} onChange={setSnmpVersion} options={[
                    { value: 'v2c', label: 'v2c' },
                    { value: 'v3',  label: 'v3' },
                    { value: 'v1',  label: 'v1' },
                  ]} />
                </Field>
                <Field label="Port">
                  <Input value={snmpPort} onChange={setSnmpPort} type="number" />
                </Field>
                <Field label="Polling interval (s)">
                  <Input value={pollingInterval} onChange={setPollingInterval} type="number" />
                </Field>
                <button
                  onClick={saveSnmp}
                  disabled={patchMutation.isPending}
                  className="w-full mt-1 bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {patchMutation.isPending ? 'Saving…' : 'Save SNMP settings'}
                </button>
                {patchMutation.isSuccess && <p className="text-xs text-green-600 mt-1">Saved.</p>}
                {patchMutation.isError && <p className="text-xs text-red-600 mt-1">Save failed.</p>}
              </Section>

              <Section title="Tags">
                <div className="flex flex-wrap gap-1.5 mb-2 min-h-[24px]">
                  {(device.tags ?? []).length === 0 && (
                    <span className="text-xs text-slate-400">No tags</span>
                  )}
                  {(device.tags ?? []).map((tag: string) => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs">
                      {tag}
                      <button onClick={() => removeTag(tag)} className="text-slate-400 hover:text-red-500 leading-none">×</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={tagInput}
                    onChange={e => { setTagInput(e.target.value); setTagError('') }}
                    onKeyDown={e => e.key === 'Enter' && addTag()}
                    placeholder="core, edge, uplink…"
                    className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button onClick={addTag} disabled={!tagInput.trim()}
                    className="px-3 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 disabled:opacity-40">
                    Add
                  </button>
                </div>
                {tagError && <p className="text-xs text-red-500 mt-1">{tagError}</p>}
                <p className="text-xs text-slate-400 mt-1">Tags are used by alert policies to target specific devices.</p>
              </Section>

              <Section title="Alert ignores">
                <p className="text-xs text-slate-400 mb-2">Silence specific alert types for this device. Interface-specific ignores only affect interface down alerts.</p>

                {/* Metric ignores */}
                <p className="text-xs font-medium text-slate-500 mb-1.5">Ignore metrics</p>
                <div className="space-y-1 mb-3">
                  {['cpu_util_pct','mem_util_pct','device_down','temperature','uptime'].map(metric => (
                    <label key={metric} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input type="checkbox"
                        checked={ignoredMetrics.includes(metric)}
                        onChange={e => setIgnoredMetrics(prev =>
                          e.target.checked ? [...prev, metric] : prev.filter(m => m !== metric)
                        )}
                        className="rounded border-slate-300 text-blue-600" />
                      {metric.replace(/_/g, ' ')}
                    </label>
                  ))}
                </div>

                {/* Interface-specific ignores */}
                <p className="text-xs font-medium text-slate-500 mb-1.5">Ignore specific interfaces (interface down alerts)</p>
                <div className="space-y-1 mb-3 max-h-32 overflow-y-auto">
                  {(interfaces ?? []).filter(i => i.admin_status === 'up').map(iface => (
                    <label key={iface.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input type="checkbox"
                        checked={ignoredIfaces.includes(iface.id)}
                        onChange={e => setIgnoredIfaces(prev =>
                          e.target.checked ? [...prev, iface.id] : prev.filter(i => i !== iface.id)
                        )}
                        className="rounded border-slate-300 text-blue-600" />
                      <span className="font-mono">{iface.name}</span>
                      {iface.description && <span className="text-slate-400 truncate">{iface.description}</span>}
                    </label>
                  ))}
                  {(interfaces ?? []).filter(i => i.admin_status === 'up').length === 0 && (
                    <p className="text-xs text-slate-400">No admin-up interfaces loaded</p>
                  )}
                </div>

                <button
                  onClick={() => exclusionMutation.mutate()}
                  disabled={exclusionMutation.isPending}
                  className="w-full bg-slate-700 text-white text-sm rounded-lg py-2 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {exclusionMutation.isPending ? 'Saving…' : 'Save ignores'}
                </button>
                {exclusionMutation.isSuccess && <p className="text-xs text-green-600 mt-1">Saved.</p>}
              </Section>

              <Section title="Alert overrides">
                <p className="text-xs text-slate-400 mb-2">
                  Override global alert thresholds for this device specifically.
                  Device-level rules take priority over policy rules.
                </p>
                <Field label="Metric">
                  <Select value={overrideMetric} onChange={setOverrideMetric} options={[
                    { value: 'cpu_util_pct', label: 'CPU %' },
                    { value: 'mem_util_pct', label: 'Memory %' },
                    { value: 'device_down',  label: 'Device down' },
                    { value: 'interface_down', label: 'Interface down' },
                  ]} />
                </Field>
                {(overrideMetric === 'cpu_util_pct' || overrideMetric === 'mem_util_pct') && (
                  <Field label="Threshold (%)">
                    <Input value={overrideThreshold} onChange={setOverrideThreshold} type="number" />
                  </Field>
                )}
                <Field label="Severity">
                  <Select value={overrideSeverity} onChange={setOverrideSeverity} options={[
                    { value: 'critical', label: 'Critical' },
                    { value: 'major',    label: 'Major' },
                    { value: 'warning',  label: 'Warning' },
                    { value: 'info',     label: 'Info' },
                  ]} />
                </Field>
                <button
                  onClick={() => {
                    setOverrideMsg(null)
                    const hasThreshold = overrideMetric === 'cpu_util_pct' || overrideMetric === 'mem_util_pct'
                    overrideMutation.mutate({
                      name: `${device.fqdn ?? device.hostname} — ${overrideMetric} override`,
                      metric: overrideMetric,
                      condition: 'gt',
                      threshold: hasThreshold ? Number(overrideThreshold) : null,
                      duration_seconds: 0,
                      severity: overrideSeverity,
                      device_selector: { device_ids: [id] },
                    })
                  }}
                  disabled={overrideMutation.isPending || ((overrideMetric === 'cpu_util_pct' || overrideMetric === 'mem_util_pct') && !overrideThreshold)}
                  className="w-full mt-1 bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {overrideMutation.isPending ? 'Creating…' : 'Create override rule'}
                </button>
                {overrideMsg && (
                  <p className={`text-xs mt-1 ${overrideMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                    {overrideMsg.text}
                  </p>
                )}
              </Section>

              <Section title="Credentials">
                <CredentialSection deviceId={id!} />
              </Section>

              <Section title="SNMP Diagnostic">
                <SnmpDiagSection deviceId={id!} />
              </Section>

              <Section title="Alerting">
                <PlaceholderSection title="Alert thresholds" description="Per-device CPU, memory and interface alert rules — coming soon" />
              </Section>

              <Section title="Maintenance">
                <MaintenanceSection deviceId={id!} />
              </Section>

              <Section title="Danger zone">
                {confirmDelete ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
                    <p className="text-xs text-red-700 font-medium">Remove {device.fqdn ?? device.hostname}?</p>
                    <p className="text-xs text-red-500">This will delete all interfaces, health data and alerts for this device.</p>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => deleteMutation.mutate()}
                        disabled={deleteMutation.isPending}
                        className="flex-1 bg-red-600 text-white text-xs rounded-lg py-1.5 hover:bg-red-700 disabled:opacity-50"
                      >
                        {deleteMutation.isPending ? 'Removing…' : 'Confirm remove'}
                      </button>
                      <button onClick={() => setConfirmDelete(false)} className="flex-1 text-xs text-slate-500 border border-slate-200 rounded-lg py-1.5 hover:bg-slate-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="w-full text-sm text-red-600 border border-red-200 rounded-lg py-2 hover:bg-red-50 transition-colors"
                  >
                    Remove device
                  </button>
                )}
              </Section>
            </div>
          </div>
        </>
      )}


      <main className="p-6 space-y-6">
        {/* Device info + health cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Device info card */}
          <div className="md:col-span-2 bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-base font-semibold text-slate-800 mb-3">
              {device.fqdn ?? device.hostname}
              {device.fqdn && device.fqdn !== device.hostname && (
                <span className="ml-2 text-xs font-normal text-slate-400">({device.hostname})</span>
              )}
            </h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">IP</dt>
              <dd className="font-mono text-slate-700">{device.mgmt_ip}</dd>
              <dt className="text-slate-500">Vendor</dt>
              <dd><VendorBadge vendor={device.vendor} /></dd>
              <dt className="text-slate-500">Platform</dt>
              <dd className="text-slate-700">{device.platform ?? '—'}</dd>
              <dt className="text-slate-500">OS version</dt>
              <dd className="text-slate-700">{device.os_version ?? '—'}</dd>
              <dt className="text-slate-500">SNMP</dt>
              <dd className="text-slate-700">{device.snmp_version?.toUpperCase() ?? '—'} :{device.snmp_port}</dd>
              <dt className="text-slate-500">Interfaces</dt>
              <dd className="text-slate-700">{upIfaces} up / {totalIfaces} total</dd>
              {(device.tags ?? []).length > 0 && (
                <>
                  <dt className="text-slate-500">Tags</dt>
                  <dd className="flex flex-wrap gap-1">
                    {(device.tags ?? []).map((tag: string) => (
                      <span key={tag} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-xs">{tag}</span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>

          {/* CPU card */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">CPU</span>
            {health?.cpu_util_pct != null ? (
              <>
                <span className="text-3xl font-bold text-slate-800">
                  {Number(health.cpu_util_pct).toFixed(1)}%
                </span>
                <div className="mt-3 h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${Number(health.cpu_util_pct) > 90 ? 'bg-red-500' : Number(health.cpu_util_pct) > 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(Number(health.cpu_util_pct), 100)}%` }}
                  />
                </div>
              </>
            ) : (
              <span className="text-2xl text-slate-400">—</span>
            )}
          </div>

          {/* Memory + Uptime card */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
            <div>
              <span className="text-xs font-medium text-slate-500 uppercase tracking-wide block mb-2">Memory</span>
              <MemBar used={health?.mem_used_bytes ?? null} total={health?.mem_total_bytes ?? null} />
            </div>
            <div>
              <span className="text-xs font-medium text-slate-500 uppercase tracking-wide block mb-1">Uptime</span>
              <span className="text-sm font-medium text-slate-700">{formatUptime(health?.uptime_seconds ?? null)}</span>
            </div>
          </div>
        </div>

        {/* Tabbed panel: Interfaces / Neighbours */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="border-b border-slate-100 px-5 flex items-center justify-between">
            <nav className="flex gap-1 -mb-px">
              {(['interfaces', 'neighbours'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors capitalize ${
                    tab === t
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}>
                  {t === 'interfaces' ? `Interfaces${totalIfaces ? ` (${totalIfaces})` : ''}` : 'Neighbours'}
                </button>
              ))}
            </nav>
          </div>

          {tab === 'interfaces' && (
            ifaceLoading ? (
              <div className="p-6 text-slate-400 text-sm">Loading interfaces…</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Name</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Description</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Type</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Speed</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Admin</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Oper</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">MAC</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {(interfaces ?? []).map((iface) => (
                      <tr key={iface.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2 font-medium text-slate-700">{iface.name}</td>
                        <td className="px-4 py-2 text-slate-500 max-w-[200px] truncate">{iface.description ?? '—'}</td>
                        <td className="px-4 py-2 text-slate-500 text-xs">{iface.if_type ?? '—'}</td>
                        <td className="px-4 py-2 text-slate-600">{formatSpeed(iface.speed_bps)}</td>
                        <td className="px-4 py-2"><StatusBadge status={iface.admin_status} /></td>
                        <td className="px-4 py-2"><StatusBadge status={iface.oper_status} /></td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-400">{iface.mac_address ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {tab === 'neighbours' && (
            <div className="p-5">
              <NeighboursSection deviceId={id!} deviceName={device?.fqdn ?? device?.hostname ?? ''} />
            </div>
          )}
        </div>

        {/* Temperature sensors (shown only if data exists) */}
        {health && health.temperatures.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-800">Temperature Sensors</h3>
            </div>
            <div className="p-4 flex flex-wrap gap-3">
              {health.temperatures.map((t, i) => (
                <div key={i} className={`rounded-lg border px-4 py-3 text-sm ${t.ok ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                  <div className="font-medium text-slate-700">{t.sensor}</div>
                  <div className={`text-lg font-bold ${t.ok ? 'text-green-700' : 'text-red-700'}`}>{t.celsius}°C</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
