import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchSmtpSettings, saveSmtpSettings, testSmtpSettings } from '../api/admin'
import { fetchChannels, createChannel, updateChannel, deleteChannel, testChannel, type NotificationChannel } from '../api/channels'

// ── Shared form controls ───────────────────────────────────────────────────────

function FInput({ label, value, onChange, type = 'text', placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; hint?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}

function FToggle({ label, checked, onChange, hint }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string
}) {
  return (
    <div>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <div onClick={() => onChange(!checked)}
          className={`w-9 h-5 rounded-full transition-colors relative ${checked ? 'bg-blue-600' : 'bg-slate-300'}`}>
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
        </div>
        <span className="text-sm text-slate-700">{label}</span>
      </label>
      {hint && <p className="text-xs text-slate-400 mt-1 ml-11">{hint}</p>}
    </div>
  )
}

// ── SMTP Server tab ────────────────────────────────────────────────────────────

function SmtpTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['smtp-settings'], queryFn: fetchSmtpSettings })

  const [host, setHost]         = useState('')
  const [port, setPort]         = useState('587')
  const [user, setUser]         = useState('')
  const [password, setPassword] = useState('')
  const [fromAddr, setFromAddr] = useState('')
  const [ssl, setSsl]           = useState(false)
  const [loaded, setLoaded]     = useState(false)
  const [status, setStatus]     = useState<'idle' | 'saving' | 'saved' | 'error' | 'testing' | 'tested' | 'test-error'>('idle')
  const [errMsg, setErrMsg]     = useState('')

  if (data && !loaded) {
    setHost(data.host)
    setPort(String(data.port))
    setUser(data.user)
    setFromAddr(data.from_addr)
    setSsl(data.ssl)
    setLoaded(true)
  }

  const save = useMutation({
    mutationFn: () => saveSmtpSettings({
      host, port: Number(port), user,
      password: password || null,
      from_addr: fromAddr, ssl,
    }),
    onMutate: () => setStatus('saving'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['smtp-settings'] }); setStatus('saved'); setPassword('') },
    onError: (e: any) => { setStatus('error'); setErrMsg(e?.response?.data?.detail ?? 'Save failed') },
  })

  const test = useMutation({
    mutationFn: testSmtpSettings,
    onMutate: () => setStatus('testing'),
    onSuccess: () => setStatus('tested'),
    onError: (e: any) => { setStatus('test-error'); setErrMsg(e?.response?.data?.detail ?? 'Test failed') },
  })

  if (isLoading) return <div className="text-slate-400 text-sm p-6">Loading…</div>

  return (
    <div className="max-w-lg space-y-5 p-6">
      <p className="text-sm text-slate-500">
        Configure the outgoing SMTP server used for all email notifications. The password is encrypted with <code className="bg-slate-100 px-1 rounded text-xs">ANTHRIMON_ENCRYPTION_KEY</code> before storage.
      </p>

      <FInput label="Host" value={host} onChange={setHost} placeholder="smtp.gmail.com" />

      <div className="grid grid-cols-2 gap-4">
        <FInput label="Port" value={port} onChange={setPort} placeholder="587" />
        <FToggle label="Use SSL (port 465)" checked={ssl} onChange={setSsl}
          hint={ssl ? 'SMTP_SSL' : 'STARTTLS'} />
      </div>

      <FInput label="From address" value={fromAddr} onChange={setFromAddr} placeholder="anthrimon@yourdomain.com" />
      <FInput label="Username" value={user} onChange={setUser} placeholder="user@gmail.com" />
      <FInput label="Password" value={password} onChange={setPassword} type="password"
        hint={data?.password_set ? 'Password is set — leave blank to keep it unchanged' : 'No password stored yet'} />

      {(status === 'error' || status === 'test-error') && (
        <p className="text-xs text-red-600">{errMsg}</p>
      )}
      {status === 'saved'  && <p className="text-xs text-green-600">Settings saved.</p>}
      {status === 'tested' && <p className="text-xs text-green-600">Test email sent successfully.</p>}

      <div className="flex items-center gap-3 pt-1">
        <button onClick={() => save.mutate()}
          disabled={status === 'saving' || status === 'testing'}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => test.mutate()}
          disabled={!host || status === 'saving' || status === 'testing'}
          className="px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
          {status === 'testing' ? 'Sending…' : 'Send test email'}
        </button>
      </div>
    </div>
  )
}

// ── Notification Channels tab ──────────────────────────────────────────────────

const CHANNEL_TYPES = [
  { value: 'email',     label: 'Email',     available: true,  colour: 'bg-green-100 text-green-700' },
  { value: 'slack',     label: 'Slack',     available: false, colour: 'bg-purple-100 text-purple-700' },
  { value: 'webhook',   label: 'Webhook',   available: false, colour: 'bg-blue-100 text-blue-700' },
  { value: 'pagerduty', label: 'PagerDuty', available: false, colour: 'bg-red-100 text-red-700' },
  { value: 'teams',     label: 'Teams',     available: false, colour: 'bg-indigo-100 text-indigo-700' },
]

function typeMeta(type: string) {
  return CHANNEL_TYPES.find(t => t.value === type) ?? { label: type, colour: 'bg-slate-100 text-slate-600', available: false }
}

function TypeBadge({ type }: { type: string }) {
  const m = typeMeta(type)
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.colour}`}>{m.label}</span>
}

function channelSummary(ch: NotificationChannel): string {
  if (ch.type === 'email') {
    const to: string[] = (ch.config.to as string[]) ?? []
    return to.length ? to.join(', ') : 'No recipients'
  }
  return ''
}

function ChannelModal({ editing, onClose }: { editing: NotificationChannel | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName]           = useState(editing?.name ?? '')
  const [type, setType]           = useState(editing?.type ?? 'email')
  const [recipients, setRecipients] = useState(
    editing?.type === 'email' ? ((editing.config.to as string[]) ?? []).join('\n') : ''
  )
  const [enabled, setEnabled]     = useState(editing?.is_enabled ?? true)
  const [errMsg, setErrMsg]       = useState('')

  const save = useMutation({
    mutationFn: () => {
      const config = type === 'email'
        ? { to: recipients.split('\n').map(s => s.trim()).filter(Boolean) }
        : {}
      return editing
        ? updateChannel(editing.id, { name, config, is_enabled: enabled })
        : createChannel({ name, type, config, is_enabled: enabled })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channels'] }); onClose() },
    onError: (e: any) => setErrMsg(e?.response?.data?.detail ?? 'Save failed'),
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">{editing ? 'Edit channel' : 'New channel'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <FInput label="Name" value={name} onChange={setName} placeholder="ops-email" />

          {!editing ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <div className="grid grid-cols-2 gap-2">
                {CHANNEL_TYPES.map(t => (
                  <button key={t.value} onClick={() => t.available && setType(t.value)} disabled={!t.available}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                      type === t.value ? 'border-blue-500 bg-blue-50 text-blue-700' :
                      t.available ? 'border-slate-200 hover:border-slate-300 text-slate-700' :
                      'border-slate-100 text-slate-300 cursor-not-allowed'
                    }`}>
                    <span className={`inline-block w-2 h-2 rounded-full ${t.available ? 'bg-current' : 'bg-slate-200'}`} />
                    {t.label}
                    {!t.available && <span className="ml-auto text-xs text-slate-300">soon</span>}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <TypeBadge type={editing.type} />
            </div>
          )}

          {(editing?.type ?? type) === 'email' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Recipients</label>
              <textarea value={recipients} onChange={e => setRecipients(e.target.value)} rows={3}
                placeholder={"admin@example.com\nops@example.com"}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono" />
              <p className="text-xs text-slate-400 mt-1">One address per line</p>
            </div>
          )}

          <FToggle label="Enabled" checked={enabled} onChange={setEnabled} />
          {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!name || save.isPending}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ChannelsTab() {
  const qc = useQueryClient()
  const [modal, setModal]             = useState<'new' | NotificationChannel | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [testStatus, setTestStatus]   = useState<Record<string, 'idle' | 'testing' | 'ok' | 'err'>>({})

  const { data: channels = [], isLoading } = useQuery({
    queryKey: ['channels'],
    queryFn: fetchChannels,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteChannel(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channels'] }); setConfirmDelete(null) },
  })

  async function handleTest(id: string) {
    setTestStatus(s => ({ ...s, [id]: 'testing' }))
    try {
      await testChannel(id)
      setTestStatus(s => ({ ...s, [id]: 'ok' }))
    } catch {
      setTestStatus(s => ({ ...s, [id]: 'err' }))
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Channels receive alert notifications. Assign them to alert rules.</p>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          Add channel
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : channels.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <p className="text-slate-400 text-sm mb-3">No notification channels yet.</p>
          <button onClick={() => setModal('new')} className="text-sm text-blue-600 hover:underline">Add your first channel</button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-medium text-slate-600">Name</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Type</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Recipients / config</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="px-4 py-3 w-48"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {channels.map(ch => (
                <tr key={ch.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{ch.name}</td>
                  <td className="px-4 py-3"><TypeBadge type={ch.type} /></td>
                  <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate">{channelSummary(ch)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ch.is_enabled ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                      {ch.is_enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    {ch.type === 'email' && (
                      <button onClick={() => handleTest(ch.id)}
                        disabled={testStatus[ch.id] === 'testing'}
                        className={`text-xs ${testStatus[ch.id] === 'ok' ? 'text-green-600' : testStatus[ch.id] === 'err' ? 'text-red-500' : 'text-slate-400 hover:text-blue-600'}`}>
                        {testStatus[ch.id] === 'testing' ? 'Sending…' : testStatus[ch.id] === 'ok' ? 'Sent!' : testStatus[ch.id] === 'err' ? 'Failed' : 'Test'}
                      </button>
                    )}
                    <button onClick={() => setModal(ch)} className="text-xs text-blue-600 hover:underline">Edit</button>
                    {confirmDelete === ch.id ? (
                      <>
                        <button onClick={() => deleteMut.mutate(ch.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                        <button onClick={() => setConfirmDelete(null)} className="text-xs text-slate-400 hover:underline">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmDelete(ch.id)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && <ChannelModal editing={modal === 'new' ? null : modal} onClose={() => setModal(null)} />}
    </div>
  )
}

// ── Admin page ─────────────────────────────────────────────────────────────────

type Tab = 'smtp' | 'channels'

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('smtp')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'smtp',     label: 'SMTP Server' },
    { id: 'channels', label: 'Notification Channels' },
  ]

  return (
    <div>
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <h1 className="text-base font-semibold text-slate-800">Administration</h1>
      </div>

      <div className="bg-white border-b border-slate-200 px-6">
        <nav className="flex gap-1 -mb-px">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'smtp'     && <SmtpTab />}
      {tab === 'channels' && <ChannelsTab />}
    </div>
  )
}
