import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api/client'

interface AlertPolicy {
  id: string
  name: string
  description: string | null
  is_enabled: boolean
  is_builtin: boolean
  device_selector: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

const fetchPolicies = () => api.get<AlertPolicy[]>('/alert-policies').then(r => r.data)

const SCOPE_OPTIONS = [
  { value: 'all',     label: 'All devices' },
  { value: 'vendors', label: 'Specific vendors' },
  { value: 'tags',    label: 'Specific tags' },
]

const VENDOR_OPTIONS = [
  'arista', 'aruba_cx', 'procurve', 'cisco_ios', 'cisco_iosxe',
  'cisco_iosxr', 'cisco_nxos', 'juniper', 'fortios',
]

const TEMPLATE_THRESHOLDS: Record<string, Record<string, number>> = {
  'Standard Switch':  { cpu_util_pct: 85, mem_util_pct: 90 },
  'Core Router':      { cpu_util_pct: 75, mem_util_pct: 85 },
  'Firewall':         { cpu_util_pct: 90, mem_util_pct: 90 },
}

function ApplyModal({ policy, onClose }: { policy: AlertPolicy; onClose: () => void }) {
  const qc = useQueryClient()
  const [scope, setScope] = useState('all')
  const [vendors, setVendors] = useState<string[]>([])
  const [tags, setTags] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [ruleCount, setRuleCount] = useState(0)

  const defaultThresholds = TEMPLATE_THRESHOLDS[policy.name] ?? {}
  const [cpuThreshold, setCpuThreshold] = useState(String(defaultThresholds.cpu_util_pct ?? ''))
  const [memThreshold, setMemThreshold] = useState(String(defaultThresholds.mem_util_pct ?? ''))
  const hasThresholds = Object.keys(defaultThresholds).length > 0

  const buildSelector = () => {
    if (scope === 'all') return null
    if (scope === 'vendors' && vendors.length) return { vendors }
    if (scope === 'tags') {
      const t = tags.split(',').map(x => x.trim()).filter(Boolean)
      if (t.length) return { tags: t }
    }
    return null
  }

  const buildThresholdOverrides = () => {
    const overrides: Record<string, number> = {}
    if (cpuThreshold) overrides['cpu_util_pct'] = Number(cpuThreshold)
    if (memThreshold) overrides['mem_util_pct'] = Number(memThreshold)
    return Object.keys(overrides).length ? overrides : undefined
  }

  const apply = useMutation({
    mutationFn: () => api.post(`/alert-policies/${policy.id}/apply`, {
      device_selector: buildSelector(),
      threshold_overrides: buildThresholdOverrides(),
    }),
    onSuccess: (res: any) => {
      setRuleCount(res.data.length)
      setSuccess(true)
      qc.invalidateQueries({ queryKey: ['alert-rules'] })
    },
    onError: (e: any) => setError(e?.response?.data?.detail ?? 'Apply failed'),
  })

  const toggleVendor = (v: string) =>
    setVendors(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])

  if (success) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
          </div>
          <h3 className="text-base font-semibold text-slate-800 mb-1">Policy applied</h3>
          <p className="text-sm text-slate-500 mb-6">
            Created {ruleCount} alert rule{ruleCount !== 1 ? 's' : ''} from <strong>{policy.name}</strong>.
            You can view and edit them in Alert Rules.
          </p>
          <button onClick={onClose}
            className="px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Apply — {policy.name}</h2>
            {policy.description && <p className="text-xs text-slate-400 mt-0.5">{policy.description}</p>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <p className="text-xs font-medium text-slate-600 mb-2">Apply to</p>
            <div className="space-y-1.5">
              {SCOPE_OPTIONS.map(o => (
                <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input type="radio" value={o.value} checked={scope === o.value}
                    onChange={() => setScope(o.value)} className="text-blue-600" />
                  {o.label}
                </label>
              ))}
            </div>
          </div>

          {scope === 'vendors' && (
            <div>
              <p className="text-xs font-medium text-slate-600 mb-2">Select vendors</p>
              <div className="flex flex-wrap gap-2">
                {VENDOR_OPTIONS.map(v => (
                  <button key={v} onClick={() => toggleVendor(v)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      vendors.includes(v)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'
                    }`}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}

          {scope === 'tags' && (
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Tags <span className="text-slate-400 font-normal">(comma-separated)</span></p>
              <input value={tags} onChange={e => setTags(e.target.value)}
                placeholder="core, edge, datacenter"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          )}

          {/* Threshold customisation */}
          {hasThresholds && (
            <div className="border-t border-slate-100 pt-4">
              <p className="text-xs font-medium text-slate-600 mb-2">Thresholds <span className="text-slate-400 font-normal">(leave blank to use defaults)</span></p>
              <div className="grid grid-cols-2 gap-3">
                {defaultThresholds.cpu_util_pct !== undefined && (
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">CPU % (default {defaultThresholds.cpu_util_pct})</label>
                    <input type="number" value={cpuThreshold} onChange={e => setCpuThreshold(e.target.value)}
                      placeholder={String(defaultThresholds.cpu_util_pct)}
                      className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                )}
                {defaultThresholds.mem_util_pct !== undefined && (
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Memory % (default {defaultThresholds.mem_util_pct})</label>
                    <input type="number" value={memThreshold} onChange={e => setMemThreshold(e.target.value)}
                      placeholder={String(defaultThresholds.mem_util_pct)}
                      className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button
            onClick={() => apply.mutate()}
            disabled={apply.isPending || (scope === 'vendors' && vendors.length === 0)}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {apply.isPending ? 'Applying…' : 'Apply policy'}
          </button>
        </div>
      </div>
    </div>
  )
}

const POLICY_ICON: Record<string, string> = {
  'Standard Switch':          '🔀',
  'Core Router':              '🌐',
  'Firewall':                 '🔥',
  'Interface Flap Detection': '⚡',
}

export default function PoliciesPage() {
  const { data: policies = [] } = useQuery({ queryKey: ['alert-policies'], queryFn: fetchPolicies })
  const [applying, setApplying] = useState<AlertPolicy | null>(null)

  const builtin = policies.filter(p => p.is_builtin)
  const custom  = policies.filter(p => !p.is_builtin)

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <h1 className="text-base font-semibold text-slate-800">Alert Policies</h1>
        <p className="text-xs text-slate-400 mt-0.5">Apply a policy to create best-practice alert rules for your devices instantly.</p>
      </div>

      <main className="p-6 space-y-8 max-w-4xl">

        {/* Built-in templates */}
        <div>
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Built-in templates</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {builtin.map(p => (
              <div key={p.id} className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{POLICY_ICON[p.name] ?? '📋'}</span>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">{p.name}</h3>
                      {p.description && <p className="text-xs text-slate-400 mt-0.5">{p.description}</p>}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setApplying(p)}
                  className="mt-auto w-full py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
                >
                  Apply →
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Custom policies */}
        {custom.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Custom policies</h2>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              {custom.map(p => (
                <div key={p.id} className="flex items-center justify-between px-5 py-4 border-b border-slate-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{p.name}</p>
                    {p.description && <p className="text-xs text-slate-400">{p.description}</p>}
                  </div>
                  <button onClick={() => setApplying(p)}
                    className="text-sm text-blue-600 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50 transition-colors">
                    Apply
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>

      {applying && <ApplyModal policy={applying} onClose={() => setApplying(null)} />}
    </div>
  )
}
