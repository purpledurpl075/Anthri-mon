import api from './client'

export interface Credential {
  id: string
  name: string
  type: string
}

export interface DiscoveredDevice {
  ip: string
  hostname: string
  vendor: string
  sys_descr: string
  sys_object_id: string
  already_in_db: boolean
  device_id: string | null
}

export interface SweepJob {
  job_id: string
  status: 'pending' | 'running' | 'done' | 'error'
  cidr: string
  total: number
  scanned: number
  found: DiscoveredDevice[]
  error: string | null
  started_at: string
  finished_at: string | null
}

export const fetchCredentials = () =>
  api.get<Credential[]>('/credentials').then(r => r.data)
// Note: fetchCredentials here fetches SNMP-only (no ?all=true) for the sweep dropdown

export const startSweep = (cidr: string, credential_id: string, timeout_s = 3) =>
  api.post<SweepJob>('/discovery/sweep', { cidr, credential_id, timeout_s }).then(r => r.data)

export const getSweepJob = (job_id: string) =>
  api.get<SweepJob>(`/discovery/sweep/${job_id}`).then(r => r.data)
