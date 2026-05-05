import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchAlerts, acknowledgeAlert, resolveAlert } from '../api/alerts'
import type { Alert } from '../api/types'

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  major:    'bg-orange-100 text-orange-700 border-orange-200',
  minor:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  warning:  'bg-yellow-50 text-yellow-600 border-yellow-200',
  info:     'bg-blue-50 text-blue-600 border-blue-200',
}

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  major:    'bg-orange-500',
  minor:    'bg-yellow-500',
  warning:  'bg-yellow-400',
  info:     'bg-blue-400',
}

const STATUS_STYLE: Record<string, string> = {
  open:         'text-red-600 bg-red-50',
  acknowledged: 'text-yellow-600 bg-yellow-50',
  resolved:     'text-green-600 bg-green-50',
}

function timeAgo(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60)  return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

export default function AlertsPage() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('open')
  const [severityFilter, setSeverityFilter] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  const effectiveStatus = showHistory ? (statusFilter === 'open' ? '' : statusFilter) : statusFilter

  const { data } = useQuery({
    queryKey: ['alerts', effectiveStatus, severityFilter],
    queryFn: () => fetchAlerts({
      status: effectiveStatus || undefined,
      severity: severityFilter || undefined,
      limit: 200,
    }),
    refetchInterval: showHistory ? 60_000 : 15_000,
  })

  const ackMutation = useMutation({
    mutationFn: acknowledgeAlert,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  })
  const resolveMutation = useMutation({
    mutationFn: resolveAlert,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['alert-count'] })
    },
  })

  const alerts = data?.items ?? []

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-slate-800">Alerts</h1>
          {data && (
            <span className="text-xs text-slate-400">{data.total} total</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowHistory(h => !h); if (!showHistory) setStatusFilter('') }}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              showHistory
                ? 'bg-slate-700 text-white border-slate-700'
                : 'text-slate-500 border-slate-200 hover:border-slate-400'
            }`}
          >
            {showHistory ? 'History on' : 'History'}
          </button>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {showHistory ? (
              <>
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="resolved">Resolved</option>
                <option value="suppressed">Suppressed</option>
              </>
            ) : (
              <>
                <option value="open">Open</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="suppressed">Suppressed</option>
              </>
            )}
          </select>
          <select
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      <main className="p-6">
        {alerts.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-slate-500 text-sm">No alerts{statusFilter ? ` with status "${statusFilter}"` : ''}.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" >
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left px-4 py-3 font-medium text-slate-600 w-6"></th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Alert</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Severity</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Triggered</th>
                  <th className="px-4 py-3 w-36"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {alerts.map((a: Alert) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className={`w-2 h-2 rounded-full ${SEVERITY_DOT[a.severity] ?? 'bg-slate-300'}`} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{a.title}</div>
                      {a.message && <div className="text-xs text-slate-400 mt-0.5">{a.message}</div>}
                      {a.context?.value != null && (
                        <div className="text-xs text-slate-400 mt-0.5">
                          Current: {String(a.context.value)}{a.context?.metric === 'cpu_util_pct' || a.context?.metric === 'mem_util_pct' ? '%' : ''}
                          {a.context?.threshold != null && ` · Threshold: ${a.context.threshold}${a.context?.metric === 'cpu_util_pct' || a.context?.metric === 'mem_util_pct' ? '%' : ''}`}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium capitalize ${SEVERITY_STYLE[a.severity] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                        {a.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_STYLE[a.status] ?? 'text-slate-500 bg-slate-50'}`}>
                        {a.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{timeAgo(a.triggered_at)}</td>
                    <td className="px-4 py-3 text-right space-x-2">
                      {a.status === 'open' && (
                        <button
                          onClick={() => ackMutation.mutate(a.id)}
                          disabled={ackMutation.isPending}
                          className="text-xs text-yellow-600 border border-yellow-200 rounded px-2 py-1 hover:bg-yellow-50 disabled:opacity-50"
                        >
                          Ack
                        </button>
                      )}
                      {(a.status === 'open' || a.status === 'acknowledged') && (
                        <button
                          onClick={() => resolveMutation.mutate(a.id)}
                          disabled={resolveMutation.isPending}
                          className="text-xs text-green-600 border border-green-200 rounded px-2 py-1 hover:bg-green-50 disabled:opacity-50"
                        >
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
