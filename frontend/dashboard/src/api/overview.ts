import api from './client'

export interface OverviewData {
  devices: {
    total: number
    up: number
    down: number
    unreachable: number
    unknown: number
  }
  alerts: {
    open: number
    critical: number
    major: number
    by_severity: Record<string, number>
  }
  last_polled_at: string | null
  problem_devices: {
    id: string
    hostname: string
    mgmt_ip: string
    vendor: string
    status: string
    last_seen: string | null
  }[]
  recent_alerts: {
    id: string
    title: string
    severity: string
    triggered_at: string | null
    device_id: string | null
  }[]
  generated_at: string
}

export const fetchOverview = () =>
  api.get<OverviewData>('/overview').then(r => r.data)
