import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api/client'

interface Me {
  id: string
  username: string
  email: string
  full_name: string | null
  role: string
  tenant_id: string
}

const fetchMe = () => api.get<Me>('/auth/me').then(r => r.data)

const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Super admin',
  admin:      'Admin',
  operator:   'Operator',
  readonly:   'Read only',
}

export default function AccountPage() {
  const qc = useQueryClient()

  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: fetchMe })

  const [fullName, setFullName]         = useState('')
  const [email, setEmail]               = useState('')
  const [currentPw, setCurrentPw]       = useState('')
  const [newPw, setNewPw]               = useState('')
  const [confirmPw, setConfirmPw]       = useState('')
  const [profileMsg, setProfileMsg]     = useState<{ ok: boolean; text: string } | null>(null)
  const [pwMsg, setPwMsg]               = useState<{ ok: boolean; text: string } | null>(null)

  const profileMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/auth/me', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] })
      setProfileMsg({ ok: true, text: 'Profile updated.' })
    },
    onError: (e: any) => setProfileMsg({ ok: false, text: e?.response?.data?.detail ?? 'Update failed.' }),
  })

  const pwMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/auth/me', body),
    onSuccess: () => {
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setPwMsg({ ok: true, text: 'Password changed.' })
    },
    onError: (e: any) => setPwMsg({ ok: false, text: e?.response?.data?.detail ?? 'Change failed.' }),
  })

  if (isLoading || !me) return <div className="p-8 text-slate-500">Loading…</div>

  const saveProfile = () => {
    setProfileMsg(null)
    const body: Record<string, unknown> = {}
    if (fullName !== '') body.full_name = fullName
    if (email !== '')    body.email     = email
    if (Object.keys(body).length === 0) return
    profileMutation.mutate(body)
  }

  const changePassword = () => {
    setPwMsg(null)
    if (newPw !== confirmPw) { setPwMsg({ ok: false, text: 'New passwords do not match.' }); return }
    if (newPw.length < 8)    { setPwMsg({ ok: false, text: 'Password must be at least 8 characters.' }); return }
    pwMutation.mutate({ current_password: currentPw, new_password: newPw })
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <h1 className="text-base font-semibold text-slate-800">Account</h1>
      </div>

      <main className="p-6 max-w-xl space-y-6">

        {/* Profile info */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">Profile</h2>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-5">
            <dt className="text-slate-500">Username</dt>
            <dd className="font-mono text-slate-700">{me.username}</dd>
            <dt className="text-slate-500">Role</dt>
            <dd className="text-slate-700">{ROLE_LABEL[me.role] ?? me.role}</dd>
          </dl>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Full name</label>
              <input
                type="text"
                placeholder={me.full_name ?? 'Not set'}
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
              <input
                type="email"
                placeholder={me.email}
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={saveProfile}
              disabled={profileMutation.isPending || (!fullName && !email)}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {profileMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            {profileMsg && (
              <span className={`text-xs ${profileMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                {profileMsg.text}
              </span>
            )}
          </div>
        </div>

        {/* Password change */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">Change password</h2>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Current password</label>
              <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">New password</label>
              <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Confirm new password</label>
              <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={changePassword}
              disabled={pwMutation.isPending || !currentPw || !newPw || !confirmPw}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {pwMutation.isPending ? 'Changing…' : 'Change password'}
            </button>
            {pwMsg && (
              <span className={`text-xs ${pwMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                {pwMsg.text}
              </span>
            )}
          </div>
        </div>

      </main>
    </div>
  )
}
