import { useState } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../api/client'

const fetchMe = () => api.get<{ username: string; role: string }>('/auth/me').then(r => r.data)
const fetchAlertCount = () =>
  api.get<{ total: number }>('/alerts', { params: { status: 'open', limit: 1 } }).then(r => r.data.total)

// ── Icons ──────────────────────────────────────────────────────────────────

const I = {
  grid:       <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  monitor:    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
  topology:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>,
  list:       <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg>,
  search:     <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  bell:       <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  rules:      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4"/></svg>,
  policies:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"/></svg>,
  key:        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  settings:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  user:       <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>,
  logout:     <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  chevron:    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>,
}

// ── Nav link ───────────────────────────────────────────────────────────────

function Item({ to, label, icon, end, badge }: {
  to: string; label: string; icon: React.ReactNode; end?: boolean; badge?: number
}) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) =>
        `group flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-all ${
          isActive
            ? 'bg-white/10 text-white'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span className={`shrink-0 transition-colors ${isActive ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-300'}`}>
            {icon}
          </span>
          <span className="flex-1 truncate">{label}</span>
          {badge != null && badge > 0 && (
            <span className="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center leading-none">
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

// ── Collapsible section ────────────────────────────────────────────────────

function Section({ label, defaultOpen = true, children }: {
  label: string; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 group">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest group-hover:text-slate-400 transition-colors">
          {label}
        </span>
        <span className={`text-slate-600 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}>
          {I.chevron}
        </span>
      </button>
      <div className={`overflow-hidden transition-all duration-200 ${open ? 'opacity-100' : 'max-h-0 opacity-0'}`}
        style={{ maxHeight: open ? '500px' : '0' }}>
        <div className="space-y-0.5 pb-2">
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const navigate  = useNavigate()
  const location  = useLocation()

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false })
  const { data: openAlerts } = useQuery({
    queryKey: ['alert-count'],
    queryFn: fetchAlertCount,
    refetchInterval: 30_000,
    retry: false,
  })

  return (
    <aside className="flex flex-col w-52 shrink-0 bg-slate-900 h-screen border-r border-slate-800">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-sm leading-none tracking-tight">Anthrimon</div>
            <div className="text-slate-500 text-[10px] mt-0.5">v0.1</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 space-y-3 overflow-y-auto">
        {/* Overview — standalone */}
        <Item to="/" label="Overview" icon={I.grid} end />

        <div className="border-t border-slate-800 pt-3 space-y-3">
          <Section label="Network">
            <Item to="/devices"  label="Devices"  icon={I.monitor} />
            <Item to="/topology" label="Topology" icon={I.topology} />
            <Item to="/addresses" label="Addresses" icon={I.list} />
            <Item to="/discover" label="Discover"  icon={I.search} />
          </Section>

          <Section label="Monitoring">
            <Item to="/alerts"      label="Alerts"      icon={I.bell}     badge={openAlerts} />
            <Item to="/alert-rules" label="Alert Rules"  icon={I.rules} />
            <Item to="/policies"    label="Policies"     icon={I.policies} />
          </Section>

          <Section label="Configuration">
            <Item to="/credentials" label="Credentials"    icon={I.key} />
            <Item to="/admin"       label="Administration" icon={I.settings} />
          </Section>
        </div>
      </nav>

      {/* Account */}
      <div className="px-3 py-3 border-t border-slate-800 space-y-0.5">
        <NavLink to="/account"
          className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-all ${
            location.pathname === '/account'
              ? 'bg-white/10 text-white'
              : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
          }`}
        >
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
            location.pathname === '/account' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'
          }`}>
            {(me?.username ?? 'U').slice(0, 2).toUpperCase()}
          </span>
          <div className="flex-1 min-w-0">
            <div className="truncate text-xs font-medium leading-none mb-0.5">{me?.username ?? 'Account'}</div>
            {me?.role && <div className="text-[10px] text-slate-500 capitalize leading-none">{me.role}</div>}
          </div>
        </NavLink>
        <button
          onClick={() => { localStorage.removeItem('token'); navigate('/login') }}
          className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-all"
        >
          {I.logout}
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  )
}
