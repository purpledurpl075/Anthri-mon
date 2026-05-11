import { useState, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchAlert, fetchAlertRule, acknowledgeAlert, resolveAlert } from '../api/alerts'
import { fetchDevice } from '../api/devices'
import api from '../api/client'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'

interface AlertComment { id: string; body: string; author: string; created_at: string }
const fetchComments = (id: string) => api.get<AlertComment[]>(`/alerts/${id}/comments`).then(r => r.data)
const postComment   = (id: string, body: string) => api.post<AlertComment>(`/alerts/${id}/comments`, { body }).then(r => r.data)

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626',
  major:    '#ea580c',
  minor:    '#d97706',
  warning:  '#ca8a04',
  info:     '#2563eb',
  resolved: '#16a34a',
}
const SEVERITY_BG: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major:    'bg-orange-100 text-orange-700',
  minor:    'bg-amber-100 text-amber-700',
  warning:  'bg-yellow-100 text-yellow-700',
  info:     'bg-blue-100 text-blue-700',
}
const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  major:    'bg-orange-100 text-orange-700 border-orange-200',
  minor:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  warning:  'bg-yellow-50 text-yellow-600 border-yellow-200',
  info:     'bg-blue-50 text-blue-600 border-blue-200',
}

const STATUS_STYLE: Record<string, string> = {
  open:         'text-red-600 bg-red-50 border-red-200',
  acknowledged: 'text-yellow-600 bg-yellow-50 border-yellow-200',
  resolved:     'text-green-600 bg-green-50 border-green-200',
  suppressed:   'text-slate-500 bg-slate-50 border-slate-200',
}

const METRIC_LABEL: Record<string, string> = {
  cpu_util_pct:     'CPU utilisation',
  mem_util_pct:     'Memory utilisation',
  device_down:      'Device reachability',
  interface_down:   'Interface status',
  interface_flap:   'Interface flapping',
  uptime:           'Device uptime',
  temperature:      'Temperature',
  interface_errors: 'Interface errors',
  custom_oid:       'Custom OID',
}

function fmt(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-2.5 border-b border-slate-100 last:border-0">
      <span className="text-xs font-medium text-slate-500 w-32 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-slate-800 flex-1">{children}</span>
    </div>
  )
}

export default function AlertDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: alert, isLoading, isError } = useQuery({
    queryKey: ['alert', id],
    queryFn: () => fetchAlert(id!),
    enabled: !!id,
  })

  const { data: device } = useQuery({
    queryKey: ['device', alert?.device_id],
    queryFn: () => fetchDevice(alert!.device_id!),
    enabled: !!alert?.device_id,
  })

  const { data: rule } = useQuery({
    queryKey: ['alert-rule', alert?.rule_id],
    queryFn:  () => fetchAlertRule(alert!.rule_id!),
    enabled:  !!alert?.rule_id,
  })

  const ackMut = useMutation({
    mutationFn: () => acknowledgeAlert(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert', id] }),
  })
  const resolveMut = useMutation({
    mutationFn: () => resolveAlert(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert', id] })
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['alert-count'] })
    },
  })

  if (isLoading) return <div className="p-8 text-slate-400 text-sm">Loading…</div>
  if (isError || !alert) return <div className="p-8 text-red-600 text-sm">Alert not found.</div>

  const ctx = alert.context ?? {}
  const metric = ctx.metric as string | undefined
  const value = ctx.value as number | undefined
  const threshold = ctx.threshold as number | undefined
  const condition = ctx.condition as string | undefined
  const isPct = metric === 'cpu_util_pct' || metric === 'mem_util_pct'

  const sevColor   = alert.status === 'resolved'
    ? SEVERITY_COLOR.resolved
    : (SEVERITY_COLOR[alert.severity] ?? '#475569')
  const statusLabel: Record<string, string> = {
    open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved', suppressed: 'Suppressed',
  }

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Breadcrumb */}
      <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center justify-between">
        <nav className="flex items-center gap-1.5 text-xs text-slate-400">
          <Link to="/alerts" className="hover:text-blue-600 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
            Alerts
          </Link>
          <span>/</span>
          <span className="text-slate-600 font-medium truncate max-w-xs">{alert.title}</span>
        </nav>
        <div className="flex items-center gap-2">
          {alert.status === 'open' && (
            <button onClick={() => ackMut.mutate()} disabled={ackMut.isPending}
              className="px-3 py-1.5 text-xs font-medium text-amber-700 border border-amber-300 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors">
              {ackMut.isPending ? 'Acknowledging…' : 'Acknowledge'}
            </button>
          )}
          {(alert.status === 'open' || alert.status === 'acknowledged') && (
            <button onClick={() => resolveMut.mutate()} disabled={resolveMut.isPending}
              className="px-3 py-1.5 text-xs font-medium text-green-700 border border-green-300 bg-green-50 rounded-lg hover:bg-green-100 disabled:opacity-50 transition-colors">
              {resolveMut.isPending ? 'Resolving…' : 'Resolve'}
            </button>
          )}
        </div>
      </div>

      {/* Hero */}
      <div className="bg-white border-b border-slate-200" style={{ borderLeft: `4px solid ${sevColor}` }}>
        <div className="px-6 py-5">
          {/* Badges row */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide ${SEVERITY_BG[alert.severity] ?? 'bg-slate-100 text-slate-500'}`}>
              {alert.severity}
            </span>
            <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase tracking-wide"
              style={{ backgroundColor: `${sevColor}18`, color: sevColor }}>
              {statusLabel[alert.status] ?? alert.status}
            </span>
            {metric && (
              <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 uppercase tracking-wide">
                {METRIC_LABEL[metric] ?? metric}
              </span>
            )}
          </div>

          {/* Title */}
          <h1 className="text-xl font-bold text-slate-900 mb-1">{alert.title}</h1>
          {alert.message && <p className="text-sm text-slate-500 mb-4">{alert.message}</p>}

          {/* Value / threshold */}
          {value !== undefined && (
            <div className="flex flex-wrap gap-3 mt-3">
              <div className="bg-slate-50 rounded-xl px-5 py-3 border border-slate-100">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Value</p>
                <p className="text-2xl font-bold" style={{ color: sevColor }}>
                  {value}{isPct ? '%' : ''}
                </p>
              </div>
              {threshold !== undefined && (
                <div className="bg-slate-50 rounded-xl px-5 py-3 border border-slate-100">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Threshold</p>
                  <p className="text-2xl font-bold text-slate-700">
                    {condition === 'gt' ? '>' : condition === 'lt' ? '<' : ''} {threshold}{isPct ? '%' : ''}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Timeline strip */}
        <div className="flex flex-col sm:flex-row border-t border-slate-100">
          {[
            { label: 'Triggered',     ts: alert.triggered_at,   color: '#dc2626' },
            { label: 'Acknowledged',  ts: alert.acknowledged_at, color: '#d97706' },
            { label: 'Resolved',      ts: alert.resolved_at,     color: '#16a34a' },
          ].filter(e => e.ts).map(({ label, ts, color }, i, arr) => (
            <div key={label} className={`px-4 py-2.5 flex-1 ${i < arr.length - 1 ? 'border-b sm:border-b-0 sm:border-r border-slate-100' : ''}`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
              </div>
              <span className="text-xs text-slate-700">{fmt(ts)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Detail cards */}
      <div className="p-3 md:p-6 grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">

        {/* Device */}
        {device && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Device</h2>
              <Link to={`/devices/${device.id}`}
                className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                Open device
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </Link>
            </div>
            <div className="px-5 py-1">
              <Row label="Hostname">
                <span className="font-medium text-slate-800">{device.fqdn ?? device.hostname}</span>
              </Row>
              <Row label="IP"><span className="font-mono">{device.mgmt_ip}</span></Row>
              {device.vendor && <Row label="Vendor">{device.vendor}</Row>}
              {device.device_type && (
                <Row label="Type">
                  <span className="flex items-center gap-1.5" style={{ color: DEVICE_TYPE_COLOR[device.device_type] ?? '#64748b' }}>
                    <DeviceTypeIcon type={device.device_type} size={13} />
                    <span className="text-slate-700">{DEVICE_TYPE_LABEL[device.device_type] ?? device.device_type}</span>
                  </span>
                </Row>
              )}
              <Row label="Status">
                <span className="flex items-center gap-1.5 text-xs font-medium"
                  style={{ color: device.status === 'up' ? '#16a34a' : '#dc2626' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: device.status === 'up' ? '#16a34a' : '#dc2626' }} />
                  {device.status}
                </span>
              </Row>
            </div>
          </div>
        )}

        {/* Rule */}
        {alert.rule_id && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Alert Rule</h2>
              <Link to="/alert-rules" className="text-xs text-blue-600 hover:underline">View rules</Link>
            </div>
            <div className="px-5 py-1">
              <Row label="Name">
                <span className="font-medium text-slate-800">
                  {rule?.name ?? <span className="font-mono text-[10px] text-slate-400">{alert.rule_id}</span>}
                </span>
              </Row>
              {rule?.metric && (
                <Row label="Metric"><span className="font-mono text-xs">{METRIC_LABEL[rule.metric] ?? rule.metric}</span></Row>
              )}
              {rule?.threshold != null && (
                <Row label="Threshold">
                  <span className="font-semibold">{rule.threshold}{rule.metric?.includes('pct') ? '%' : ''}</span>
                </Row>
              )}
              {rule?.severity && (
                <Row label="Severity">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${SEVERITY_BG[rule.severity] ?? ''}`}>
                    {rule.severity}
                  </span>
                </Row>
              )}
            </div>
          </div>
        )}

        {/* Extra context */}
        {Object.keys(ctx).some(k => !['metric','value','threshold','condition'].includes(k)) && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Context</h2>
            </div>
            <div className="px-5 py-1">
              {Object.entries(ctx)
                .filter(([k]) => !['metric','value','threshold','condition'].includes(k))
                .map(([k, v]) => (
                  <Row key={k} label={k}>
                    <span className="font-mono text-[10px] text-slate-600">{String(v)}</span>
                  </Row>
                ))}
              <Row label="Alert ID"><span className="font-mono text-[10px] text-slate-400">{alert.id}</span></Row>
            </div>
          </div>
        )}

        {/* Comments — full width */}
        <div className="lg:col-span-2">
          <CommentThread alertId={alert.id} />
        </div>
      </div>
    </div>
  )
}

function CommentThread({ alertId }: { alertId: string }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { data: comments = [] } = useQuery({
    queryKey: ['alert-comments', alertId],
    queryFn: () => fetchComments(alertId),
    refetchInterval: 30_000,
  })

  const addMut = useMutation({
    mutationFn: () => postComment(alertId, text.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-comments', alertId] })
      setText('')
      textareaRef.current?.focus()
    },
  })

  function timeAgo(iso: string) {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return new Date(iso).toLocaleDateString()
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-4">Comments</h2>

      {/* Thread */}
      {comments.length === 0 ? (
        <p className="text-xs text-slate-400 mb-4">No comments yet — add one below.</p>
      ) : (
        <div className="space-y-4 mb-5">
          {comments.map(c => (
            <div key={c.id} className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center shrink-0 text-[10px] font-bold text-slate-600 uppercase">
                {c.author.slice(0, 2)}
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-xs font-semibold text-slate-700">{c.author}</span>
                  <span className="text-[10px] text-slate-400">{timeAgo(c.created_at)}</span>
                </div>
                <p className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Compose */}
      <div className="flex gap-3 items-start">
        <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center shrink-0 text-[10px] font-bold text-blue-700">
          You
        </div>
        <div className="flex-1 space-y-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault()
                addMut.mutate()
              }
            }}
            placeholder="Add a comment — describe the problem, actions taken, or resolution… (Ctrl+Enter to submit)"
            rows={3}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
          <div className="flex justify-end">
            <button
              onClick={() => addMut.mutate()}
              disabled={!text.trim() || addMut.isPending}
              className="px-4 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {addMut.isPending ? 'Posting…' : 'Comment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
