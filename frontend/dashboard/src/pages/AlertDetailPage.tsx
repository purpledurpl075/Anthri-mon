import { useState, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchAlert, acknowledgeAlert, resolveAlert } from '../api/alerts'
import { fetchDevice } from '../api/devices'
import api from '../api/client'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'

interface AlertComment { id: string; body: string; author: string; created_at: string }
const fetchComments = (id: string) => api.get<AlertComment[]>(`/alerts/${id}/comments`).then(r => r.data)
const postComment   = (id: string, body: string) => api.post<AlertComment>(`/alerts/${id}/comments`, { body }).then(r => r.data)

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

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <nav className="flex items-center gap-2 text-xs text-slate-400 mb-3">
          <Link to="/alerts" className="hover:text-blue-600">Alerts</Link>
          <span>/</span>
          <span className="text-slate-600 truncate max-w-xs">{alert.title}</span>
        </nav>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold text-slate-800 mb-2">{alert.title}</h1>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2.5 py-1 rounded border text-xs font-semibold capitalize ${SEVERITY_STYLE[alert.severity] ?? ''}`}>
                {alert.severity}
              </span>
              <span className={`inline-flex items-center px-2.5 py-1 rounded border text-xs font-medium capitalize ${STATUS_STYLE[alert.status] ?? ''}`}>
                {alert.status}
              </span>
              {metric && (
                <span className="text-xs text-slate-400 bg-slate-100 px-2 py-1 rounded">
                  {METRIC_LABEL[metric] ?? metric}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {alert.status === 'open' && (
              <button onClick={() => ackMut.mutate()} disabled={ackMut.isPending}
                className="px-3 py-1.5 text-xs font-medium text-yellow-700 border border-yellow-300 rounded-lg hover:bg-yellow-50 disabled:opacity-50 transition-colors">
                {ackMut.isPending ? 'Acknowledging…' : 'Acknowledge'}
              </button>
            )}
            {(alert.status === 'open' || alert.status === 'acknowledged') && (
              <button onClick={() => resolveMut.mutate()} disabled={resolveMut.isPending}
                className="px-3 py-1.5 text-xs font-medium text-green-700 border border-green-300 rounded-lg hover:bg-green-50 disabled:opacity-50 transition-colors">
                {resolveMut.isPending ? 'Resolving…' : 'Resolve'}
              </button>
            )}
            <button onClick={() => navigate(-1)}
              className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
              Back
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
        {/* Alert details */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Alert details</h2>
          <div>
            {alert.message && <Row label="Description">{alert.message}</Row>}
            <Row label="Alert ID"><span className="font-mono text-[10px]">{alert.id}</span></Row>
            {value !== undefined && (
              <Row label="Value">
                <span className="font-semibold">{value}{isPct ? '%' : ''}</span>
                {threshold !== undefined && (
                  <span className="text-slate-400 ml-2">
                    threshold: {condition} {threshold}{isPct ? '%' : ''}
                  </span>
                )}
              </Row>
            )}
            {Object.entries(ctx)
              .filter(([k]) => !['metric','value','threshold','condition'].includes(k))
              .map(([k, v]) => (
                <Row key={k} label={k}>
                  <span className="font-mono text-[10px]">{String(v)}</span>
                </Row>
              ))
            }
          </div>
        </div>

        {/* Timeline */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Timeline</h2>
          <div className="space-y-3">
            {[
              { label: 'Triggered',     ts: alert.triggered_at,    color: 'bg-red-500' },
              { label: 'Acknowledged',  ts: alert.acknowledged_at,  color: 'bg-yellow-500' },
              { label: 'Resolved',      ts: alert.resolved_at,      color: 'bg-green-500' },
            ].map(({ label, ts, color }) => ts && (
              <div key={label} className="flex items-start gap-3">
                <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${color}`} />
                <div>
                  <p className="text-xs font-medium text-slate-700">{label}</p>
                  <p className="text-[10px] text-slate-400">{fmt(ts)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Device */}
        {device && (
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Device</h2>
            <div>
              <Row label="Hostname">
                <Link to={`/devices/${device.id}`} className="text-blue-600 hover:underline font-medium">
                  {device.fqdn ?? device.hostname}
                </Link>
              </Row>
              <Row label="IP address"><span className="font-mono">{device.mgmt_ip}</span></Row>
              <Row label="Vendor">{device.vendor ?? '—'}</Row>
              <Row label="Type">
              {device.device_type ? (
                <span className="flex items-center gap-1.5"
                  style={{ color: DEVICE_TYPE_COLOR[device.device_type] ?? '#64748b' }}>
                  <DeviceTypeIcon type={device.device_type} size={14} />
                  <span className="text-slate-700">{DEVICE_TYPE_LABEL[device.device_type] ?? device.device_type}</span>
                </span>
              ) : '—'}
            </Row>
              <Row label="Status">
                <span className={`inline-flex items-center gap-1 text-xs font-medium capitalize ${
                  device.status === 'up' ? 'text-green-600' : 'text-red-600'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${device.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`}/>
                  {device.status}
                </span>
              </Row>
            </div>
          </div>
        )}

        {/* Rule */}
        {alert.rule_id && (
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Rule</h2>
            <Row label="Rule ID">
              <Link to={`/alert-rules`} className="text-blue-600 hover:underline font-mono text-[10px]">
                {alert.rule_id}
              </Link>
            </Row>
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
