import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fetchPolicies, createPolicy, updatePolicy, deletePolicy, runPolicy,
  fetchComplianceResults, deployConfigMulti, previewDeployTargets,
  type CompliancePolicy, type ComplianceRule, type MultiDeployDeviceResult,
} from '../api/config'
import { fetchDevices } from '../api/devices'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { DEVICE_TYPE_COLOR, DeviceTypeIcon } from '../components/DeviceTypeIcon'

// ── Vendor-aware snippets ─────────────────────────────────────────────────────

const VENDOR_SNIPPETS: Record<string, { label: string; text: string }[]> = {
  arista: [
    { label: 'NTP server',      text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'logging host {{syslog_server}}' },
    { label: 'SSH timeout',     text: 'management ssh\n   idle-timeout 120' },
    { label: 'Banner',          text: 'banner login\nAuthorized access only.\nEOF' },
    { label: 'SNMP community',  text: 'snmp-server community {{community}} ro' },
    { label: 'DNS',             text: 'ip name-server {{dns_server}}' },
    { label: 'Domain name',     text: 'ip domain-name {{domain}}' },
  ],
  cisco_ios: [
    { label: 'NTP server',      text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'logging host {{syslog_server}}' },
    { label: 'SSH v2',          text: 'ip ssh version 2' },
    { label: 'Banner',          text: 'banner login #\nAuthorized access only.\n#' },
    { label: 'SNMP community',  text: 'snmp-server community {{community}} RO' },
    { label: 'DNS',             text: 'ip name-server {{dns_server}}' },
    { label: 'Domain name',     text: 'ip domain-name {{domain}}' },
    { label: 'Disable CDP',     text: 'no cdp run' },
  ],
  procurve: [
    { label: 'NTP server',      text: 'timesync ntp\nntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'logging {{syslog_server}}' },
    { label: 'Banner',          text: 'banner motd "Authorized access only"' },
    { label: 'SNMP community',  text: 'snmp-server community "{{community}}" operator' },
    { label: 'DNS',             text: 'ip dns server-address priority 1 {{dns_server}}' },
    { label: 'Timezone',        text: 'time timezone -300' },
  ],
  juniper: [
    { label: 'NTP server',      text: 'set system ntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'set system syslog host {{syslog_server}} any any' },
    { label: 'SSH',             text: 'set system services ssh' },
    { label: 'Banner',          text: 'set system login message "Authorized access only"' },
    { label: 'SNMP community',  text: 'set snmp community {{community}} authorization read-only' },
    { label: 'DNS',             text: 'set system name-server {{dns_server}}' },
  ],
  fortios: [
    { label: 'NTP server',      text: 'config system ntp\n  set ntpserver1 {{ntp_server}}\n  set status enable\nend' },
    { label: 'Syslog',          text: 'config log syslogd setting\n  set status enable\n  set server {{syslog_server}}\nend' },
    { label: 'DNS',             text: 'config system dns\n  set primary {{dns_server}}\nend' },
  ],
  generic: [
    { label: 'NTP server',      text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog server',   text: 'logging host {{syslog_server}}' },
    { label: 'Interface desc',  text: 'interface {{interface}}\n  description {{description}}' },
    { label: 'Disable iface',   text: 'interface {{interface}}\n  shutdown' },
    { label: 'SNMP community',  text: 'snmp-server community {{community}} ro' },
  ],
}

function getSnippets(vendors: string[]) {
  if (vendors.length === 1) {
    const v = vendors[0].toLowerCase()
    for (const [key, snips] of Object.entries(VENDOR_SNIPPETS)) {
      if (v.includes(key) || key.includes(v)) return snips
    }
  }
  return VENDOR_SNIPPETS.generic
}

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

type View = 'compliance' | 'policies' | 'deploy'

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
            {(['compliance', 'policies', 'deploy'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  view === v ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
                } ${v !== 'compliance' ? 'border-l border-slate-200' : ''}`}>
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

        {view === 'deploy' && <MultiDeployTab />}
      </div>
    </div>
  )
}

// ── Multi-device deploy tab ───────────────────────────────────────────────────

function MultiDeployTab() {
  const [scopeType, setScopeType]   = useState<'all' | 'vendor' | 'tag' | 'devices'>('all')
  const [scopeValue, setScopeValue] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [commands, setCommands]     = useState('')
  const [variables, setVariables]   = useState<{ key: string; value: string }[]>([
    { key: 'ntp_server',    value: '' },
    { key: 'syslog_server', value: '' },
  ])
  const [save, setSave]             = useState(true)
  const [result, setResult]         = useState<{ results: MultiDeployDeviceResult[]; succeeded: number; failed: number } | null>(null)
  const [deploying, setDeploying]   = useState(false)
  const [error, setError]           = useState<string | null>(null)

  // Fetch devices for preview and vendor detection
  const { data: devicesResp } = useQuery({ queryKey: ['devices-all'], queryFn: () => fetchDevices({ limit: 500 }) })
  const allDevices: any[] = (devicesResp as any)?.items ?? devicesResp ?? []

  // Compute targeted devices for preview
  const targetedDevices = useMemo(() => {
    if (scopeType === 'all') return allDevices
    if (scopeType === 'vendor') return allDevices.filter((d: any) => d.vendor?.toLowerCase().includes(scopeValue.toLowerCase()) && scopeValue)
    if (scopeType === 'tag') return allDevices.filter((d: any) => (d.tags || []).includes(scopeValue) && scopeValue)
    if (scopeType === 'devices') return allDevices.filter((d: any) => selectedIds.includes(d.id))
    return []
  }, [allDevices, scopeType, scopeValue, selectedIds])

  // Get unique vendors for smart snippets
  const vendors = useMemo(() => [...new Set(targetedDevices.map((d: any) => d.vendor).filter(Boolean))], [targetedDevices])
  const snippets = getSnippets(vendors as string[])

  const buildSelector = (): Record<string, unknown> | null => {
    if (scopeType === 'all') return null
    if (scopeType === 'vendor' && scopeValue) return { vendors: [scopeValue] }
    if (scopeType === 'tag'    && scopeValue) return { tags:    [scopeValue]  }
    if (scopeType === 'devices' && selectedIds.length) return { device_ids: selectedIds }
    return null
  }

  const varMap = Object.fromEntries(variables.filter(v => v.key && v.value).map(v => [v.key, v.value]))

  const handleDeploy = async () => {
    const lines = commands.split('\n').filter(l => l.trim())
    if (!lines.length) return
    if (!targetedDevices.length && scopeType !== 'all') { setError('No devices match the selector'); return }
    setDeploying(true); setResult(null); setError(null)
    try {
      const res = await deployConfigMulti({
        commands: lines,
        device_selector: buildSelector(),
        variables: varMap,
        save,
      })
      setResult(res)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? String(e))
    } finally {
      setDeploying(false)
    }
  }

  const inputCls = "border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="max-w-4xl space-y-5">
      {/* Warning */}
      <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
        <p className="text-xs text-amber-700">Commands are pushed directly to all matching devices. Test in a lab first. Vendor-specific config mode entry/exit is handled automatically.</p>
      </div>

      {/* Scope selector */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">Target devices</h3>
        <div className="flex gap-2 flex-wrap">
          {(['all','vendor','tag','devices'] as const).map(t => (
            <button key={t} onClick={() => { setScopeType(t); setScopeValue(''); setSelectedIds([]) }}
              className={`px-3 py-1.5 text-xs rounded-lg border capitalize transition-colors ${scopeType === t ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>
              {t === 'all' ? 'All devices' : `By ${t}`}
            </button>
          ))}
        </div>

        {scopeType === 'vendor' && (
          <div className="flex gap-2 flex-wrap">
            {[...new Set(allDevices.map((d: any) => d.vendor).filter(Boolean))].map(v => (
              <button key={v as string} onClick={() => setScopeValue(v as string)}
                className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${scopeValue === v ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>
                {v as string}
              </button>
            ))}
          </div>
        )}

        {scopeType === 'tag' && (
          <input value={scopeValue} onChange={e => setScopeValue(e.target.value)}
            placeholder="Enter tag name" className={`${inputCls} w-48`} />
        )}

        {scopeType === 'devices' && (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {allDevices.map((d: any) => (
              <label key={d.id} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 px-2 py-1 rounded">
                <input type="checkbox" checked={selectedIds.includes(d.id)}
                  onChange={e => setSelectedIds(ids => e.target.checked ? [...ids, d.id] : ids.filter(i => i !== d.id))}
                  className="rounded border-slate-300" />
                <span className="text-xs text-slate-700">{d.fqdn ?? d.hostname}</span>
                <span className="text-[10px] text-slate-400">{d.vendor}</span>
              </label>
            ))}
          </div>
        )}

        {/* Preview count */}
        <p className="text-xs text-slate-500">
          <span className="font-semibold text-slate-700">{targetedDevices.length}</span> device{targetedDevices.length !== 1 ? 's' : ''} targeted
          {vendors.length > 0 && <span className="ml-1 text-slate-400">· {vendors.join(', ')}</span>}
        </p>
      </div>

      {/* Template variables */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Template variables</h3>
            <p className="text-xs text-slate-400 mt-0.5">Use <code className="bg-slate-100 px-1 rounded">{'{{var}}'}</code> in commands. Built-ins: hostname, mgmt_ip, vendor, device_type</p>
          </div>
          <button onClick={() => setVariables(v => [...v, { key: '', value: '' }])}
            className="text-xs text-blue-600 hover:underline">+ Add</button>
        </div>
        <div className="space-y-2">
          {variables.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={v.key} onChange={e => setVariables(vs => vs.map((x,j) => j===i ? {...x,key:e.target.value} : x))}
                placeholder="variable_name" className={`${inputCls} w-36 font-mono`} />
              <span className="text-slate-400 text-xs">=</span>
              <input value={v.value} onChange={e => setVariables(vs => vs.map((x,j) => j===i ? {...x,value:e.target.value} : x))}
                placeholder="value" className={`${inputCls} flex-1`} />
              <button onClick={() => setVariables(vs => vs.filter((_,j) => j!==i))}
                className="text-slate-300 hover:text-red-400 transition-colors text-xs">✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* Command editor */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">
          Commands
          {vendors.length === 1 && <span className="ml-2 text-[10px] font-normal text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full capitalize">{vendors[0]} syntax</span>}
          {vendors.length > 1  && <span className="ml-2 text-[10px] font-normal text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">generic syntax (mixed vendors)</span>}
        </h3>

        <div className="flex flex-wrap gap-1.5">
          {snippets.map(s => (
            <button key={s.label} type="button"
              onClick={() => setCommands(c => c ? c + '\n' + s.text : s.text)}
              className="px-2 py-0.5 rounded-md text-[11px] border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
              + {s.label}
            </button>
          ))}
        </div>

        <textarea value={commands} onChange={e => setCommands(e.target.value)}
          spellCheck={false} rows={8}
          placeholder={'ntp server {{ntp_server}}\nlogging host {{syslog_server}}'}
          className="w-full border border-slate-200 rounded-xl px-4 py-3 font-mono text-xs bg-slate-950 text-green-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y leading-relaxed" />
      </div>

      {/* Deploy controls */}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} className="rounded border-slate-300 text-blue-600" />
          <span className="text-xs text-slate-600">Save to startup config</span>
        </label>
        <button onClick={handleDeploy} disabled={deploying || !commands.trim() || targetedDevices.length === 0}
          className="ml-auto flex items-center gap-1.5 px-5 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
          {deploying ? (
            <><span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />Deploying to {targetedDevices.length} device{targetedDevices.length !== 1 ? 's' : ''}…</>
          ) : (
            <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>Deploy to {targetedDevices.length} device{targetedDevices.length !== 1 ? 's' : ''}</>
          )}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">{error}</div>}

      {/* Results table */}
      {result && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-3">
            <h3 className="text-sm font-semibold text-slate-800">Deploy results</h3>
            <span className="text-xs text-green-600 font-medium">{result.succeeded} succeeded</span>
            {result.failed > 0 && <span className="text-xs text-red-500 font-medium">{result.failed} failed</span>}
          </div>
          <div className="divide-y divide-slate-50">
            {result.results.map((r, i) => (
              <details key={i} className="group">
                <summary className={`flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-slate-50 transition-colors list-none ${r.success ? '' : 'bg-red-50/40'}`}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${r.success ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-sm font-medium text-slate-700 flex-1">{r.hostname}</span>
                  {r.error && <span className="text-xs text-red-500 truncate max-w-xs">{r.error}</span>}
                  <svg className="w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                </summary>
                {(r.output || r.error) && (
                  <div className="px-5 pb-3">
                    <pre className="text-[11px] font-mono bg-slate-950 text-green-400 p-3 rounded-lg overflow-auto max-h-48 leading-relaxed whitespace-pre-wrap">
                      {r.error || r.output || '(no output)'}
                    </pre>
                  </div>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
