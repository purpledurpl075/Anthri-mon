import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { fetchDevice, fetchDeviceHealth, fetchDeviceInterfaces, deleteDevice, patchDevice } from '../api/devices'
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

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

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
    setConfirmDelete(false)
    setSettingsOpen(true)
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

              <Section title="Credentials">
                <PlaceholderSection title="Credential management" description="Assign or swap credentials for this device — coming soon" />
              </Section>

              <Section title="Alerting">
                <PlaceholderSection title="Alert thresholds" description="Per-device CPU, memory and interface alert rules — coming soon" />
              </Section>

              <Section title="Maintenance">
                <PlaceholderSection title="Maintenance windows" description="Schedule downtime to suppress alerts — coming soon" />
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
