import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { fetchDevices } from '../api/devices'
import { fetchMaintenanceWindows } from '../api/maintenance'
import StatusBadge from '../components/StatusBadge'
import VendorBadge from '../components/VendorBadge'

function formatAge(iso: string | null) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 120) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

export default function DeviceList() {
  const navigate = useNavigate()

  const { data, isLoading, error } = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices({ limit: 200 }),
    refetchInterval: 30_000,
  })

  const { data: activeWindows = [] } = useQuery({
    queryKey: ['maintenance-active'],
    queryFn: () => fetchMaintenanceWindows({ active_only: true }),
    refetchInterval: 60_000,
  })
  const inMaintenance = new Set(
    activeWindows.flatMap(w =>
      (w.device_selector?.device_ids as string[] | undefined) ?? []
    )
  )

  if (isLoading) return <div className="p-8 text-slate-500">Loading devices…</div>
  if (error) return <div className="p-8 text-red-600">Failed to load devices.</div>

  const devices = data?.items ?? []

  return (
    <div>
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <h1 className="text-base font-semibold text-slate-800">Devices</h1>
        <span className="text-sm text-slate-400">{data?.total ?? 0} total</span>
      </div>

      <div className="p-6">
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-medium text-slate-600">Hostname</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">IP</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Vendor</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Type</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {devices.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400">No devices found.</td>
                </tr>
              )}
              {devices.map((d) => (
                <tr
                  key={d.id}
                  className="hover:bg-slate-50 cursor-pointer transition-colors"
                  onClick={() => navigate(`/devices/${d.id}`)}
                >
                  <td className="px-4 py-3">
                    <Link to={`/devices/${d.id}`} onClick={(e) => e.stopPropagation()}
                      className="font-medium text-blue-600 hover:underline">
                      {d.fqdn ?? d.hostname}
                    </Link>
                    {d.fqdn && d.fqdn !== d.hostname && (
                      <div className="text-xs text-slate-400 mt-0.5">{d.hostname}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 font-mono text-xs">{d.mgmt_ip}</td>
                  <td className="px-4 py-3"><VendorBadge vendor={d.vendor} /></td>
                  <td className="px-4 py-3 text-slate-500 capitalize">{d.device_type}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={d.status} />
                      {inMaintenance.has(d.id) && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                          Maintenance
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatAge(d.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
