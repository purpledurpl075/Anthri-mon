import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { fetchDevice, fetchDeviceHealth, fetchDeviceInterfaces } from '../api/devices'
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

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>()

  const { data: device, isLoading, isError } = useQuery({
    queryKey: ['device', id],
    queryFn: () => fetchDevice(id!),
    enabled: !!id,
  })

  const { data: health } = useQuery({
    queryKey: ['device-health', id],
    queryFn: () => fetchDeviceHealth(id!),
    enabled: !!id,
    refetchInterval: 60_000,
    retry: false,
  })

  const { data: interfaces, isLoading: ifaceLoading } = useQuery({
    queryKey: ['device-interfaces', id],
    queryFn: () => fetchDeviceInterfaces(id!),
    enabled: !!id,
    refetchInterval: 60_000,
  })

  if (isLoading || !device) return <div className="p-8 text-slate-500">Loading…</div>
  if (isError) return <div className="p-8 text-red-600">Failed to load device.</div>

  const upIfaces = interfaces?.filter((i) => i.oper_status === 'up').length ?? 0
  const totalIfaces = interfaces?.length ?? 0

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <nav className="flex items-center gap-2 text-sm">
          <Link to="/devices" className="text-blue-600 hover:underline">Devices</Link>
          <span className="text-slate-400">/</span>
          <span className="font-medium text-slate-800">{device.fqdn ?? device.hostname}</span>
        </nav>
        <StatusBadge status={device.status} />
      </div>

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

        {/* Interface table */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Interfaces</h3>
            <span className="text-xs text-slate-400">{totalIfaces} total</span>
          </div>
          {ifaceLoading ? (
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
