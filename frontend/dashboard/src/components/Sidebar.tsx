import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../api/client'

const fetchMe = () => api.get<{ username: string; role: string }>('/auth/me').then(r => r.data)
const fetchAlertCount = () =>
  api.get<{ total: number }>('/alerts', { params: { status: 'open', limit: 1 } }).then(r => r.data.total)

const nav = [
  {
    to: '/',
    label: 'Overview',
    end: true,
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    to: '/devices',
    label: 'Devices',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
      </svg>
    ),
  },
  {
    to: '/discover',
    label: 'Discover',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
      </svg>
    ),
  },
  {
    to: '/credentials',
    label: 'Credentials',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    ),
  },
]

const soon = [
  {
    label: 'Topology',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
        <path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" />
      </svg>
    ),
  },
]

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false })
  const { data: openAlerts } = useQuery({
    queryKey: ['alert-count'],
    queryFn: fetchAlertCount,
    refetchInterval: 30_000,
    retry: false,
  })

  function handleLogout() {
    localStorage.removeItem('token')
    navigate('/login')
  }

  return (
    <aside className="flex flex-col w-52 shrink-0 bg-slate-900 h-screen">
      {/* Brand */}
      <div className="px-5 py-5 border-b border-slate-700">
        <span className="text-white font-bold text-base tracking-tight">Anthrimon</span>
        <span className="ml-2 text-slate-500 text-xs">v0.1</span>
      </div>

      {/* Primary nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {nav.map(({ to, label, icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`
            }
          >
            {icon}
            {label}
          </NavLink>
        ))}

        {/* Alerts */}
        <NavLink to="/alerts"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`
          }
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span className="flex-1">Alerts</span>
          {!!openAlerts && openAlerts > 0 && (
            <span className="bg-red-500 text-white text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center leading-none">
              {openAlerts > 99 ? '99+' : openAlerts}
            </span>
          )}
        </NavLink>
        <NavLink to="/policies"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`
          }
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"/>
          </svg>
          Policies
        </NavLink>
        <NavLink to="/addresses"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`
          }
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M4 7h16M4 12h16M4 17h10"/>
          </svg>
          Addresses
        </NavLink>
        <NavLink to="/alert-rules"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`
          }
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4" />
          </svg>
          Alert Rules
        </NavLink>

        <NavLink to="/admin"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`
          }
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Administration
        </NavLink>

        <div className="pt-4 pb-1 px-3">
          <span className="text-xs font-medium text-slate-600 uppercase tracking-wider">Coming soon</span>
        </div>

        {soon.map(({ label, icon }) => (
          <div
            key={label}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-600 cursor-not-allowed select-none"
          >
            {icon}
            {label}
          </div>
        ))}
      </nav>

      {/* Account + sign out */}
      <div className="px-3 py-4 border-t border-slate-700 space-y-0.5">
        <NavLink
          to="/account"
          className={`flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors ${
            location.pathname === '/account'
              ? 'bg-slate-700 text-white'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
          <span className="truncate">{me?.username ?? 'Account'}</span>
        </NavLink>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out
        </button>
      </div>
    </aside>
  )
}
