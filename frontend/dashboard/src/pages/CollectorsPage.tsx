import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchCollectors, createCollector, deleteCollector, regenerateToken,
  type RemoteCollector,
} from '../api/collectors'
import { useRole, hasRole } from '../hooks/useCurrentUser'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAge(iso: string | null) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400)return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const STATUS_DOT: Record<string, string> = {
  online:  'bg-green-500',
  offline: 'bg-slate-400',
  pending: 'bg-amber-400 animate-pulse',
  revoked: 'bg-red-400',
}
const STATUS_TEXT: Record<string, string> = {
  online:  'text-green-700 bg-green-100',
  offline: 'text-slate-600 bg-slate-100',
  pending: 'text-amber-700 bg-amber-100',
  revoked: 'text-red-700 bg-red-100',
}

// ── Token display modal (shown once after create/regenerate) ──────────────────

function TokenModal({ collector, ca_cert, onClose }: {
  collector: RemoteCollector
  ca_cert:   string | null
  onClose:   () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const envBlock = [
    `ANTHRIMON_HUB=https://${window.location.hostname}`,
    `ANTHRIMON_TOKEN=${collector.registration_token}`,
  ].join('\n')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-800">Collector created — <span className="text-slate-600">{collector.name}</span></h2>
              <p className="text-xs text-slate-400 mt-0.5">Save the registration token now. It will not be shown again.</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Warning */}
          <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
            <p className="text-xs text-amber-700">The registration token is a one-time secret. Copy it before closing this dialog — it cannot be retrieved afterwards. If lost, regenerate it from the collector list.</p>
          </div>

          {/* Registration token */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Registration token (24h, single-use)</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-slate-950 text-green-400 text-xs font-mono px-3 py-2.5 rounded-lg overflow-auto whitespace-nowrap">
                {collector.registration_token}
              </code>
              <button onClick={() => copy(collector.registration_token!, 'token')}
                className="shrink-0 px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                {copied === 'token' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Env block */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Collector environment variables</label>
            <div className="flex items-start gap-2">
              <pre className="flex-1 bg-slate-950 text-green-400 text-xs font-mono px-3 py-2.5 rounded-lg leading-relaxed">{envBlock}</pre>
              <button onClick={() => copy(envBlock, 'env')}
                className="shrink-0 px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                {copied === 'env' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* CA cert */}
          {ca_cert && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Hub CA certificate (save as <code className="bg-slate-100 px-1 rounded text-[10px]">anthrimon-ca.crt</code> on the collector)</label>
              <div className="flex items-start gap-2">
                <pre className="flex-1 bg-slate-950 text-green-400 text-[10px] font-mono px-3 py-2.5 rounded-lg leading-relaxed max-h-32 overflow-auto">{ca_cert}</pre>
                <button onClick={() => copy(ca_cert, 'cert')}
                  className="shrink-0 px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  {copied === 'cert' ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Quick start */}
          <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-2">
            <p className="text-xs font-semibold text-slate-600">Quick start on the remote server</p>
            <pre className="text-[11px] font-mono text-slate-700 leading-relaxed whitespace-pre-wrap">{[
              `# 1. Install collector binary`,
              `curl -fsSL https://${window.location.hostname}/downloads/anthrimon-collector -o /usr/local/bin/anthrimon-collector`,
              `chmod +x /usr/local/bin/anthrimon-collector`,
              ``,
              `# 2. Save the CA cert`,
              `# (paste the CA cert above into /etc/anthrimon/ca.crt)`,
              ``,
              `# 3. Run with environment variables`,
              `ANTHRIMON_HUB=https://${window.location.hostname} \\`,
              `ANTHRIMON_TOKEN=<token> \\`,
              `ANTHRIMON_CA=/etc/anthrimon/ca.crt \\`,
              `anthrimon-collector`,
            ].join('\n')}</pre>
          </div>
        </div>

        <div className="px-6 pb-5 flex justify-end">
          <button onClick={onClose}
            className="px-5 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors">
            I've saved the token
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Collector row ─────────────────────────────────────────────────────────────

function CollectorRow({ collector, canEdit, onToken }: {
  collector: RemoteCollector
  canEdit:   boolean
  onToken:   (c: RemoteCollector, ca: string) => void
}) {
  const qc = useQueryClient()
  const [confirmDel, setConfirmDel] = useState(false)

  const deleteMut = useMutation({
    mutationFn: () => deleteCollector(collector.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['collectors'] }),
  })

  const tokenMut = useMutation({
    mutationFn: () => regenerateToken(collector.id),
    onSuccess:  (data) => onToken(
      { ...collector, registration_token: data.registration_token },
      data.ca_cert
    ),
  })

  return (
    <tr className="hover:bg-slate-50 transition-colors">
      {/* Status */}
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[collector.status] ?? STATUS_DOT.offline}`} />
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize ${STATUS_TEXT[collector.status] ?? STATUS_TEXT.offline}`}>
            {collector.status}
          </span>
        </div>
      </td>

      {/* Name + hostname */}
      <td className="px-4 py-3.5">
        <div className="text-sm font-medium text-slate-800">{collector.name}</div>
        {collector.hostname && (
          <div className="text-xs text-slate-400 font-mono mt-0.5">{collector.hostname}</div>
        )}
      </td>

      {/* WireGuard IP */}
      <td className="px-4 py-3.5">
        {collector.wg_ip
          ? <code className="text-xs font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{collector.wg_ip}</code>
          : <span className="text-xs text-slate-300">not bootstrapped</span>}
      </td>

      {/* Capabilities */}
      <td className="px-4 py-3.5">
        <div className="flex gap-1 flex-wrap">
          {(collector.capabilities ?? []).map(c => (
            <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium capitalize">{c}</span>
          ))}
        </div>
      </td>

      {/* Last seen */}
      <td className="px-4 py-3.5 text-xs text-slate-500">
        {collector.last_seen ? formatAge(collector.last_seen) : '—'}
      </td>

      {/* Version */}
      <td className="px-4 py-3.5 text-xs text-slate-400 font-mono">
        {collector.version ?? '—'}
      </td>

      {/* Actions */}
      <td className="px-4 py-3.5 text-right">
        {canEdit && collector.is_active && (
          <div className="flex items-center justify-end gap-1">
            <button onClick={() => tokenMut.mutate()} disabled={tokenMut.isPending} title="Regenerate registration token"
              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"/></svg>
            </button>
            {confirmDel ? (
              <>
                <button onClick={() => deleteMut.mutate()} className="text-xs text-red-600 hover:underline font-medium px-1">Revoke</button>
                <button onClick={() => setConfirmDel(false)} className="text-xs text-slate-400 hover:underline px-1">Cancel</button>
              </>
            ) : (
              <button onClick={() => setConfirmDel(true)} title="Revoke collector"
                className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18.364 5.636 5.636 18.364m0-12.728 12.728 12.728"/></svg>
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CollectorsPage() {
  const qc      = useQueryClient()
  const role    = useRole()
  const canEdit = hasRole(role, 'admin')

  const [showCreate,   setShowCreate]   = useState(false)
  const [newName,      setNewName]      = useState('')
  const [tokenData,    setTokenData]    = useState<{ collector: RemoteCollector; ca: string } | null>(null)

  const { data: collectors = [], isLoading } = useQuery({
    queryKey:        ['collectors'],
    queryFn:         fetchCollectors,
    refetchInterval: 15_000,
  })

  const createMut = useMutation({
    mutationFn: () => createCollector({ name: newName.trim() }),
    onSuccess:  (c) => {
      qc.invalidateQueries({ queryKey: ['collectors'] })
      setShowCreate(false)
      setNewName('')
      setTokenData({ collector: c, ca: c.ca_cert ?? '' })
    },
  })

  const online  = collectors.filter(c => c.status === 'online').length
  const offline = collectors.filter(c => c.status === 'offline').length
  const pending = collectors.filter(c => c.status === 'pending').length

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Remote Collectors</h1>
          <p className="text-xs text-slate-400 mt-0.5">WireGuard-tunnelled polling agents at remote sites</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Status summary */}
          {collectors.length > 0 && (
            <div className="hidden sm:flex items-center gap-3 text-xs text-slate-500">
              {online  > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />{online} online</span>}
              {offline > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-slate-400" />{offline} offline</span>}
              {pending > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />{pending} pending</span>}
            </div>
          )}
          {canEdit && (
            <button onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
              New collector
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">

        {/* Empty state */}
        {!isLoading && collectors.length === 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-100 mb-4">
              <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-700">No remote collectors yet</p>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
              Create a collector to deploy a polling agent at a remote site.
              It connects back to this hub over a WireGuard tunnel.
            </p>
            {canEdit && (
              <button onClick={() => setShowCreate(true)}
                className="mt-4 px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors">
                Create first collector
              </button>
            )}
          </div>
        )}

        {/* Collector table */}
        {collectors.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {['Status', 'Name', 'WireGuard IP', 'Capabilities', 'Last seen', 'Version', ''].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {collectors.map(c => (
                  <CollectorRow
                    key={c.id}
                    collector={c}
                    canEdit={canEdit}
                    onToken={(col, ca) => setTokenData({ collector: col, ca })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* WireGuard info card */}
        <div className="mt-5 bg-slate-50 rounded-2xl border border-slate-200 p-5 flex items-start gap-4">
          <div className="w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700">WireGuard overlay: 10.100.0.0/24</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Hub is <code className="bg-slate-200 px-1 rounded text-[10px]">10.100.0.1</code>.
              Collectors are assigned <code className="bg-slate-200 px-1 rounded text-[10px]">10.100.0.2–51</code> automatically at bootstrap.
              Ensure UDP 51820 is open inbound on this server.
            </p>
          </div>
        </div>

      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">New remote collector</h2>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Collector name *</label>
                <input
                  autoFocus
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && newName.trim() && createMut.mutate()}
                  placeholder="e.g. branch-london"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <p className="text-xs text-slate-400">
                A registration token will be generated. You'll have 24 hours to bootstrap the collector.
              </p>
            </div>
            <div className="px-6 pb-5 flex justify-end gap-2">
              <button onClick={() => { setShowCreate(false); setNewName('') }}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
              <button onClick={() => createMut.mutate()} disabled={createMut.isPending || !newName.trim()}
                className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
                {createMut.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Token display modal */}
      {tokenData && (
        <TokenModal
          collector={tokenData.collector}
          ca_cert={tokenData.ca}
          onClose={() => setTokenData(null)}
        />
      )}
    </div>
  )
}
