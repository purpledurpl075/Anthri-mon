import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fetchPolicies, createPolicy, updatePolicy, deletePolicy, runPolicy,
  fetchComplianceResults,
  type CompliancePolicy, type ComplianceRule,
} from '../api/config'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { DEVICE_TYPE_COLOR, DeviceTypeIcon } from '../components/DeviceTypeIcon'

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEV_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major:    'bg-orange-100 text-orange-700',
  minor:    'bg-yellow-100 text-yellow-700',
  warning:  'bg-yellow-50 text-yellow-600',
  info:     'bg-blue-50 text-blue-600',
}

const STATUS_STYLE: Record<string, string> = {
  pass:  'bg-green-100 text-green-700',
  fail:  'bg-red-100 text-red-700',
  error: 'bg-slate-100 text-slate-500',
}

function formatAge(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

// ── Compliance result row ─────────────────────────────────────────────────────

function ResultRow({ result }: { result: ReturnType<typeof useQuery<any>>['data'] extends any[] ? ReturnType<typeof useQuery<any>>['data'][number] : never }) {
  const [open, setOpen] = useState(false)
  const fails = (result.findings as ComplianceRule[]).filter((f: any) => f.status === 'fail')

  return (
    <div className={`border-b border-slate-50 last:border-0 ${result.status === 'fail' ? 'bg-red-50/30' : ''}`}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize shrink-0 ${STATUS_STYLE[result.status] ?? STATUS_STYLE.error}`}>
          {result.status}
        </span>
        <Link to={`/devices/${result.device_id}`} onClick={e => e.stopPropagation()}
          className="text-sm font-medium text-slate-700 hover:text-blue-600 transition-colors w-36 truncate shrink-0">
          {result.device_name}
        </Link>
        <span className="text-xs text-slate-600 flex-1 truncate">{result.policy_name}</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded capitalize shrink-0 ${SEV_STYLE[result.severity] ?? SEV_STYLE.warning}`}>
          {result.severity}
        </span>
        {result.status === 'fail' && (
          <span className="text-[10px] text-red-500 shrink-0">{fails.length} failing</span>
        )}
        <span className="text-xs text-slate-400 shrink-0">{formatAge(result.checked_at)}</span>
        <svg className={`w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-1.5">
          {(result.findings as any[]).map((f: any, i: number) => (
            <div key={i} className={`flex items-start gap-2.5 px-3 py-2 rounded-lg text-xs ${
              f.status === 'pass' ? 'bg-green-50' : f.status === 'fail' ? 'bg-red-50' : 'bg-slate-50'
            }`}>
              <span className={`shrink-0 font-semibold ${f.status === 'pass' ? 'text-green-600' : f.status === 'fail' ? 'text-red-600' : 'text-slate-500'}`}>
                {f.status === 'pass' ? '✓' : f.status === 'fail' ? '✗' : '!'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-slate-700">{f.description}</p>
                {f.matched_text && <p className="font-mono text-[10px] text-slate-500 mt-0.5 truncate">{f.matched_text}</p>}
                {f.error && <p className="text-red-500 mt-0.5">{f.error}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Policy form ───────────────────────────────────────────────────────────────

const RULE_TYPES = [
  { value: 'regex_present',  label: 'Must match (regex)' },
  { value: 'regex_absent',   label: 'Must not match (regex)' },
  { value: 'contains',       label: 'Must contain (literal)' },
  { value: 'not_contains',   label: 'Must not contain (literal)' },
]

const EXAMPLE_RULES: { label: string; rule: ComplianceRule }[] = [
  { label: 'NTP configured',        rule: { type: 'regex_present', pattern: 'ntp server', description: 'NTP server must be configured' } },
  { label: 'Password encryption',   rule: { type: 'regex_absent', pattern: 'no service password-encryption', description: 'Password encryption must be enabled' } },
  { label: 'SSH enabled',           rule: { type: 'regex_present', pattern: 'ip ssh version 2|management ssh', description: 'SSH v2 must be enabled' } },
  { label: 'Telnet disabled',       rule: { type: 'regex_absent', pattern: 'transport input telnet', description: 'Telnet must not be allowed' } },
  { label: 'Banner set',            rule: { type: 'regex_present', pattern: 'banner (login|motd)', description: 'Login banner must be configured' } },
  { label: 'Logging configured',    rule: { type: 'regex_present', pattern: 'logging host|logging server', description: 'Remote syslog must be configured' } },
  { label: 'Spanning tree',         rule: { type: 'regex_present', pattern: 'spanning-tree mode', description: 'STP mode must be explicitly set' } },
]

interface PolicyFormProps {
  initial?: Partial<CompliancePolicy>
  onSave: (data: Partial<CompliancePolicy>) => void
  onCancel: () => void
  saving: boolean
}

function PolicyForm({ initial, onSave, onCancel, saving }: PolicyFormProps) {
  const [name,        setName]        = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [severity,    setSeverity]    = useState(initial?.severity ?? 'warning')
  const [rules,       setRules]       = useState<ComplianceRule[]>(initial?.rules ?? [])

  const addRule = () => setRules(r => [...r, { type: 'regex_present', pattern: '', description: '' }])
  const removeRule = (i: number) => setRules(r => r.filter((_, j) => j !== i))
  const updateRule = (i: number, field: keyof ComplianceRule, value: string) =>
    setRules(r => r.map((rule, j) => j === i ? { ...rule, [field]: value } : rule))

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Policy name *</label>
          <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="NTP Compliance" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Severity</label>
          <select value={severity} onChange={e => setSeverity(e.target.value)} className={inputCls}>
            {['critical','major','minor','warning','info'].map(s => <option key={s} value={s} className="capitalize">{s}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} placeholder="Optional description" />
      </div>

      {/* Quick-add examples */}
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-2">Quick add rule</label>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLE_RULES.map(ex => (
            <button key={ex.label} type="button" onClick={() => setRules(r => [...r, { ...ex.rule }])}
              className="px-2 py-0.5 rounded-md text-[11px] border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
              + {ex.label}
            </button>
          ))}
        </div>
      </div>

      {/* Rules */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-slate-600">Rules ({rules.length})</label>
          <button onClick={addRule} className="text-xs text-blue-600 hover:underline">+ Add rule</button>
        </div>
        <div className="space-y-2">
          {rules.map((rule, i) => (
            <div key={i} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
              <div className="flex items-center gap-2">
                <select value={rule.type} onChange={e => updateRule(i, 'type', e.target.value)}
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 flex-1">
                  {RULE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <button onClick={() => removeRule(i)} className="text-slate-300 hover:text-red-500 transition-colors shrink-0">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M6 18 18 6M6 6l12 12"/></svg>
                </button>
              </div>
              <input value={rule.pattern} onChange={e => updateRule(i, 'pattern', e.target.value)}
                placeholder="Pattern / text to match"
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <input value={rule.description ?? ''} onChange={e => updateRule(i, 'description', e.target.value)}
                placeholder="Description (shown in compliance report)"
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          ))}
          {rules.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-4 border border-dashed border-slate-200 rounded-lg">
              No rules yet — add one above or use a quick-add example
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
        <button onClick={() => onSave({ name, description: description || undefined, severity, rules, is_enabled: true })}
          disabled={saving || !name}
          className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type View = 'compliance' | 'policies'

export default function ConfigPage() {
  const qc = useQueryClient()
  const role    = useRole()
  const canEdit = hasRole(role, 'admin')
  const [view,        setView]        = useState<View>('compliance')
  const [showForm,    setShowForm]    = useState(false)
  const [editPolicy,  setEditPolicy]  = useState<CompliancePolicy | null>(null)
  const [confirmDel,  setConfirmDel]  = useState<string | null>(null)
  const [runResult,   setRunResult]   = useState<Record<string, number> | null>(null)

  const { data: results = [], isLoading: resultsLoading } = useQuery({
    queryKey: ['compliance-results'],
    queryFn:  () => fetchComplianceResults(),
    refetchInterval: 60_000,
  })

  const { data: policies = [], isLoading: policiesLoading } = useQuery({
    queryKey: ['compliance-policies'],
    queryFn:  fetchPolicies,
  })

  const createMut = useMutation({
    mutationFn: createPolicy,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['compliance-policies'] }); setShowForm(false) },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CompliancePolicy> }) => updatePolicy(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['compliance-policies'] }); setEditPolicy(null) },
  })

  const deleteMut = useMutation({
    mutationFn: deletePolicy,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['compliance-policies'] }); setConfirmDel(null) },
  })

  const runMut = useMutation({
    mutationFn: runPolicy,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['compliance-results'] })
      setRunResult(data)
      setTimeout(() => setRunResult(null), 5000)
    },
  })

  const failCount = results.filter(r => r.status === 'fail').length
  const passCount = results.filter(r => r.status === 'pass').length

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Config Management</h1>
          <p className="text-xs text-slate-400 mt-0.5">Backup, diff, and compliance</p>
        </div>
        <div className="flex items-center gap-3">
          {runResult && (
            <div className="text-xs text-slate-600 bg-slate-100 px-3 py-1 rounded-lg">
              Ran: {runResult.pass ?? 0} pass · {runResult.fail ?? 0} fail · {runResult.skip ?? 0} skip
            </div>
          )}
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {(['compliance', 'policies'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  view === v ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
                } ${v === 'policies' ? 'border-l border-slate-200' : ''}`}>
                {v}
                {v === 'compliance' && failCount > 0 && (
                  <span className="ml-1.5 bg-red-500 text-white text-[9px] font-bold rounded-full px-1.5">{failCount}</span>
                )}
              </button>
            ))}
          </div>
          {canEdit && view === 'policies' && (
            <button onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
              New policy
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">

        {view === 'compliance' ? (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              {[
                { label: 'Failing',  value: failCount, accent: failCount > 0 ? '#dc2626' : '#94a3b8' },
                { label: 'Passing',  value: passCount, accent: '#16a34a' },
                { label: 'Policies', value: policies.length, accent: '#6366f1' },
                { label: 'Devices checked', value: new Set(results.map(r => r.device_id)).size, accent: '#0891b2' },
              ].map(c => (
                <div key={c.label} className="relative bg-white rounded-xl border border-slate-200 px-4 py-3 overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{ backgroundColor: c.accent }} />
                  <p className="text-xs text-slate-400 mb-1">{c.label}</p>
                  <p className="text-2xl font-bold text-slate-800">{c.value}</p>
                </div>
              ))}
            </div>

            {/* Results table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Compliance results</h2>
                <span className="text-xs text-slate-400">{results.length} checks</span>
              </div>
              {resultsLoading ? (
                <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>
              ) : results.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <p className="text-sm text-slate-400">No compliance results yet</p>
                  <p className="text-xs text-slate-300 mt-1">Create a policy and run it, or wait for the hourly collection cycle</p>
                </div>
              ) : (
                <div>
                  {results.map(r => <ResultRow key={r.id} result={r as any} />)}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Create form */}
            {showForm && (
              <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-5">
                <h3 className="text-sm font-semibold text-slate-800 mb-4">New compliance policy</h3>
                <PolicyForm
                  onSave={data => createMut.mutate(data)}
                  onCancel={() => setShowForm(false)}
                  saving={createMut.isPending}
                />
              </div>
            )}

            {/* Edit form */}
            {editPolicy && (
              <div className="bg-white rounded-2xl border border-blue-200 p-6 mb-5">
                <h3 className="text-sm font-semibold text-slate-800 mb-4">Edit — {editPolicy.name}</h3>
                <PolicyForm
                  initial={editPolicy}
                  onSave={data => updateMut.mutate({ id: editPolicy.id, data })}
                  onCancel={() => setEditPolicy(null)}
                  saving={updateMut.isPending}
                />
              </div>
            )}

            {/* Policy list */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-800">Policies ({policies.length})</h2>
              </div>
              {policiesLoading ? (
                <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>
              ) : policies.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <p className="text-sm text-slate-400">No policies yet</p>
                  {canEdit && (
                    <button onClick={() => setShowForm(true)} className="mt-2 text-sm text-blue-600 hover:underline">
                      Create your first policy
                    </button>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-slate-50">
                  {policies.map(p => (
                    <div key={p.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-800">{p.name}</span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded capitalize ${SEV_STYLE[p.severity] ?? SEV_STYLE.warning}`}>{p.severity}</span>
                          {!p.is_enabled && <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">disabled</span>}
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">{p.rules.length} rule{p.rules.length !== 1 ? 's' : ''}{p.description ? ` · ${p.description}` : ''}</p>
                      </div>
                      {canEdit && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => runMut.mutate(p.id)} disabled={runMut.isPending}
                            className="px-2.5 py-1 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
                            {runMut.isPending ? 'Running…' : 'Run'}
                          </button>
                          <button onClick={() => setEditPolicy(p)}
                            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          {confirmDel === p.id ? (
                            <>
                              <button onClick={() => deleteMut.mutate(p.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                              <button onClick={() => setConfirmDel(null)} className="text-xs text-slate-400 hover:underline ml-1">Cancel</button>
                            </>
                          ) : (
                            <button onClick={() => setConfirmDel(p.id)}
                              className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"/></svg>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
