import api from './client'

export interface RemoteCollector {
  id:            string
  name:          string
  hostname:      string | null
  site_id:       string | null
  status:        'pending' | 'online' | 'offline' | 'revoked'
  wg_ip:         string | null
  wg_public_key: string | null
  ip_address:    string | null
  version:       string | null
  capabilities:  string[]
  last_seen:     string | null
  registered_at: string | null
  is_active:     boolean
  created_at:    string
  // Only present immediately after creation / token regeneration
  registration_token?: string
  ca_cert?:            string
}

export interface CollectorCreate { name: string; site_id?: string }

export const fetchCollectors    = () =>
  api.get<RemoteCollector[]>('/collectors').then(r => r.data)

export const createCollector    = (body: CollectorCreate) =>
  api.post<RemoteCollector>('/collectors', body).then(r => r.data)

export const fetchCollector     = (id: string) =>
  api.get<RemoteCollector>(`/collectors/${id}`).then(r => r.data)

export const deleteCollector    = (id: string) =>
  api.delete(`/collectors/${id}`)

export const regenerateToken    = (id: string) =>
  api.post<{ registration_token: string; ca_cert: string; expires_at: string }>(
    `/collectors/${id}/token`
  ).then(r => r.data)
