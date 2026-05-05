import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchAlertRules, createAlertRule, updateAlertRule, deleteAlertRule } from '../api/alerts'
import type { AlertRule } from '../api/types'

const METRICS = [
  { value: 'cpu_util_pct',      label: 'CPU utilisation %',          hasThreshold: true,  conditions: ['gt', 'lt'],  unit: '%',    thresholdLabel: 'Threshold %',        simple: true },
  { value: 'mem_util_pct',      label: 'Memory utilisation %',       hasThreshold: true,  conditions: ['gt', 'lt'],  unit: '%',    thresholdLabel: 'Threshold %',        simple: true },
  { value: 'device_down',       label: 'Device unreachable',         hasThreshold: false, conditions: [],            unit: '',     thresholdLabel: '',                   simple: true },
  { value: 'interface_down',    label: 'Interface down (admin up)',   hasThreshold: false, conditions: [],            unit: '',     thresholdLabel: '',                   simple: true },
  { value: 'interface_flap',    label: 'Interface flapping',         hasThreshold: true,  conditions: [],            unit: 'changes', thresholdLabel: 'Changes in window', simple: true },
  { value: 'uptime',            label: 'Device rebooted (low uptime)', hasThreshold: true, conditions: ['lt'],       unit: 's',    thresholdLabel: 'Uptime below (s)',   simple: false },
  { value: 'temperature',       label: 'Temperature sensor high',    hasThreshold: true,  conditions: ['gt'],        unit: '°C',   thresholdLabel: 'Threshold °C',       simple: false },
  { value: 'interface_errors',  label: 'Interface errors',           hasThreshold: true,  conditions: ['gt'],        unit: '',     thresholdLabel: 'Error count',        simple: false },
  { value: 'custom_oid',        label: 'Custom OID',                 hasThreshold: true,  conditions: ['gt','lt','eq'], unit: '', thresholdLabel: 'Threshold value',   simple: false },
]

const COND_LABEL: Record<string, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' }

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major:    'bg-orange-100 text-orange-700',
  minor:    'bg-yellow-100 text-yellow-700',
  warning:  'bg-yellow-50 text-yellow-600',
  info:     'bg-blue-50 text-blue-600',
}

function SelectorSummary({ sel }: { sel: Record<string, unknown> | null }) {
  if (!sel || Object.keys(sel).length === 0) return <span className="text-slate-400">All devices</span>
  const parts = []
  if (Array.isArray(sel.device_ids) && sel.device_ids.length) parts.push(`${sel.device_ids.length} device(s)`)
  if (Array.isArray(sel.vendors) && sel.vendors.length) parts.push(`vendors: ${sel.vendors.join(', ')}`)
  if (Array.isArray(sel.tags) && sel.tags.length) parts.push(`tags: ${sel.tags.join(', ')}`)
  return <span className="text-slate-600">{parts.join(' · ') || 'All devices'}</span>
}

const DEFAULT_FORM = {
  name: '', description: '', metric: 'cpu_util_pct', condition: 'gt',
  threshold: '90', duration_seconds: '300', severity: 'warning',
  escalation_severity: '', escalation_seconds: '',
  stable_for_seconds: '0',
  notify_on_resolve: 'true',
  suppress_if_parent_down: 'false',
  renotify_seconds: '3600',
  custom_oid: '',
  scope: 'all',
  vendors: '', tags: '',
}

function RuleModal({ editing, onClose }: { editing: AlertRule | null; onClose: () => void }) {
  const qc = useQueryClient()
  const meta = (m: string) => METRICS.find(x => x.value === m) ?? METRICS[0]

  const init = editing ? {
    name: editing.name,
    description: editing.description ?? '',
    metric: editing.metric,
    condition: editing.condition || 'gt',
    threshold: String(editing.threshold ?? ''),
    duration_seconds: String(editing.duration_seconds),
    severity: editing.severity,
    escalation_severity: editing.escalation_severity ?? '',
    escalation_seconds: String(editing.escalation_seconds ?? ''),
    stable_for_seconds: String(editing.stable_for_seconds ?? '0'),
    notify_on_resolve: String(editing.notify_on_resolve ?? true),
    suppress_if_parent_down: String(editing.suppress_if_parent_down ?? false),
    renotify_seconds: String(editing.renotify_seconds ?? 3600),
    custom_oid: editing.custom_oid ?? '',
    scope: !editing.device_selector || Object.keys(editing.device_selector).length === 0
      ? 'all'
      : (editing.device_selector.device_ids ? 'device' : editing.device_selector.vendors ? 'vendors' : editing.device_selector.tags ? 'tags' : 'all'),
    vendors: (editing.device_selector?.vendors as string[] ?? []).join(', '),
    tags: (editing.device_selector?.tags as string[] ?? []).join(', '),
  } : DEFAULT_FORM

  const [f, setF] = useState(init)
  const [advanced, setAdvanced] = useState(!!editing)
  const [error, setError] = useState('')

  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }))

  const buildSelector = () => {
    if (f.scope === 'all') return null
    if (f.scope === 'vendors') {
      const vendors = f.vendors.split(',').map(v => v.trim()).filter(Boolean)
      return vendors.length ? { vendors } : null
    }
    if (f.scope === 'tags') {
      const tags = f.tags.split(',').map(t => t.trim()).filter(Boolean)
      return tags.length ? { tags } : null
    }
    return null
  }

  const save = useMutation({
    mutationFn: () => {
      const m = meta(f.metric)
      const body: Record<string, unknown> = {
        name: f.name,
        description: f.description || null,
        metric: f.metric,
        condition: m.conditions[0] ?? f.condition,
        threshold: m.hasThreshold ? Number(f.threshold) : null,
        custom_oid: f.metric === 'custom_oid' ? (f.custom_oid || null) : null,
        duration_seconds: Number(f.duration_seconds),
        severity: f.severity,
        escalation_severity: f.escalation_severity || null,
        escalation_seconds: f.escalation_seconds ? Number(f.escalation_seconds) : null,
        stable_for_seconds: Number(f.stable_for_seconds) || 0,
        notify_on_resolve: f.notify_on_resolve === 'true',
        suppress_if_parent_down: f.suppress_if_parent_down === 'true',
        renotify_seconds: Number(f.renotify_seconds) || 3600,
        device_selector: buildSelector(),
      }
      return editing
        ? updateAlertRule(editing.id, body)
        : createAlertRule(body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] })
      onClose()
    },
    onError: (e: any) => setError(e?.response?.data?.detail ?? 'Save failed'),
  })

  const m = meta(f.metric)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">{editing ? 'Edit rule' : 'New alert rule'}</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setAdvanced(a => !a)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                advanced ? 'bg-slate-700 text-white border-slate-700' : 'text-slate-500 border-slate-200 hover:border-slate-400'
              }`}
            >
              {advanced ? 'Advanced' : 'Simple'}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Rule name <span className="text-red-500">*</span></label>
            <input value={f.name} onChange={e => set('name', e.target.value)}
              placeholder="High CPU — core switches"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          {/* Metric */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Metric</label>
            <select value={f.metric} onChange={e => set('metric', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {METRICS.filter(m => advanced || m.simple).map(m =>
                <option key={m.value} value={m.value}>{m.label}</option>
              )}
            </select>
          </div>

          {/* Custom OID input */}
          {f.metric === 'custom_oid' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                OID <span className="text-slate-400 font-normal">e.g. 1.3.6.1.2.1.1.3.0</span>
              </label>
              <input value={f.custom_oid} onChange={e => set('custom_oid', e.target.value)}
                placeholder="1.3.6.1.4.1.9.9.109.1.1.1.1.3.1"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          )}

          {/* Threshold + condition */}
          {m.hasThreshold && (
            <div className="grid grid-cols-2 gap-3">
              {m.conditions.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Condition</label>
                  <select value={f.condition} onChange={e => set('condition', e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {m.conditions.map(c => <option key={c} value={c}>{COND_LABEL[c] ?? c}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Threshold {f.metric === 'interface_flap' ? '(state changes)' : '(%)'}
                </label>
                <input type="number" value={f.threshold} onChange={e => set('threshold', e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          )}

          {/* Duration */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {f.metric === 'interface_flap' ? 'Detection window (s)' : 'Sustained duration (s)'}
              <span className="text-slate-400 font-normal ml-1">— 0 fires immediately</span>
            </label>
            <input type="number" value={f.duration_seconds} onChange={e => set('duration_seconds', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          {/* Severity */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Severity</label>
            <select value={f.severity} onChange={e => set('severity', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {['critical', 'major', 'minor', 'warning', 'info'].map(s =>
                <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>

          {/* Device scope — always visible */}
          <div className="border-t border-slate-100 pt-4">
            <label className="block text-xs font-medium text-slate-600 mb-2">Applies to</label>
            <div className="space-y-1.5">
              {[['all','All devices'],['vendors','Specific vendors'],['tags','Specific tags']].map(([val,lbl]) => (
                <label key={val} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input type="radio" value={val} checked={f.scope === val} onChange={() => set('scope', val)} className="text-blue-600" />
                  {lbl}
                </label>
              ))}
            </div>
            {f.scope === 'vendors' && (
              <input value={f.vendors} onChange={e => set('vendors', e.target.value)} placeholder="arista, cisco_ios, procurve"
                className="mt-2 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            )}
            {f.scope === 'tags' && (
              <input value={f.tags} onChange={e => set('tags', e.target.value)} placeholder="core, edge, datacenter"
                className="mt-2 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            )}
          </div>

          {/* Advanced fields */}
          {advanced && <>
            <div className="border-t border-slate-100 pt-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Escalation</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Escalate to</label>
                  <select value={f.escalation_severity} onChange={e => set('escalation_severity', e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">No escalation</option>
                    {['critical','major','minor','warning'].map(s =>
                      <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">After (s)</label>
                  <input type="number" value={f.escalation_seconds} onChange={e => set('escalation_seconds', e.target.value)}
                    placeholder="e.g. 600" disabled={!f.escalation_severity}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40" />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Stable for (s) <span className="text-slate-400 font-normal">— wait this long after condition clears before resolving</span>
              </label>
              <input type="number" value={f.stable_for_seconds} onChange={e => set('stable_for_seconds', e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Re-notify after (s) <span className="text-slate-400 font-normal">— 0 = never</span></label>
              <input type="number" value={f.renotify_seconds ?? '3600'} onChange={e => set('renotify_seconds', e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={f.notify_on_resolve === 'true' || f.notify_on_resolve === true as any}
                  onChange={e => set('notify_on_resolve', String(e.target.checked))}
                  className="rounded border-slate-300 text-blue-600" />
                Notify when alert auto-resolves
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={f.suppress_if_parent_down === 'true' || f.suppress_if_parent_down === true as any}
                  onChange={e => set('suppress_if_parent_down', String(e.target.checked))}
                  className="rounded border-slate-300 text-blue-600" />
                Suppress if parent device is unreachable
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Description <span className="text-slate-400 font-normal">(shown in alert)</span></label>
              <textarea value={f.description} onChange={e => set('description', e.target.value)} rows={2}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </>}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!f.name || save.isPending}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {save.isPending ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AlertRulesPage() {
  const qc = useQueryClient()
  const [modal, setModal] = useState<AlertRule | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data } = useQuery({ queryKey: ['alert-rules'], queryFn: fetchAlertRules })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateAlertRule(id, { is_enabled: enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteAlertRule,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-rules'] }); setConfirmDelete(null) },
  })

  const rules = data?.items ?? []

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <h1 className="text-base font-semibold text-slate-800">Alert Rules</h1>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          New rule
        </button>
      </div>

      <main className="p-6">
        {rules.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
            <p className="text-slate-400 text-sm mb-3">No alert rules yet.</p>
            <button onClick={() => setModal('new')} className="text-sm text-blue-600 hover:underline">Create your first rule</button>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Rule</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Metric</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Severity</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Scope</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Enabled</th>
                  <th className="px-4 py-3 w-32"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((r: AlertRule) => {
                  const m = METRICS.find(x => x.value === r.metric)
                  return (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{r.name}</div>
                        {r.description && <div className="text-xs text-slate-400">{r.description}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{m?.label ?? r.metric}</div>
                        {r.threshold != null && (
                          <div className="text-xs text-slate-400">
                            {COND_LABEL[r.condition] ?? r.condition} {r.threshold}{r.metric.includes('pct') ? '%' : ''}
                            {r.duration_seconds > 0 && ` for ${r.duration_seconds}s`}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${SEVERITY_STYLE[r.severity] ?? 'bg-slate-100 text-slate-600'}`}>
                          {r.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs"><SelectorSummary sel={r.device_selector} /></td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => toggleMutation.mutate({ id: r.id, enabled: !r.is_enabled })}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${r.is_enabled ? 'bg-blue-600' : 'bg-slate-200'}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${r.is_enabled ? 'translate-x-4' : 'translate-x-1'}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right space-x-3">
                        <button onClick={() => setModal(r)} className="text-xs text-blue-600 hover:underline">Edit</button>
                        {confirmDelete === r.id ? (
                          <>
                            <button onClick={() => deleteMutation.mutate(r.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                            <button onClick={() => setConfirmDelete(null)} className="text-xs text-slate-400 hover:underline">Cancel</button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmDelete(r.id)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {modal && <RuleModal editing={modal === 'new' ? null : modal} onClose={() => setModal(null)} />}
    </div>
  )
}
