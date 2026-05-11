import api from './client'

export interface OverviewData {
  devices: {
    total: number
    up: number
    down: number
    unreachable: number
    unknown: number
    by_type: Record<string, number>
  }
  alerts: {
    open: number
    critical: number
    major: number
    by_severity: Record<string, number>
  }
  interfaces_down: number
  poll_health: {
    polled_recently: number
    total_active: number
  }
  last_polled_at: string | null
  problem_devices: {
    id: string
    hostname: string
    mgmt_ip: string
    vendor: string
    device_type: string
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
  top_alerting_devices: {
    device_id: string
    hostname: string
    device_type: string
    count: number
  }[]
  generated_at: string
}

export interface TopInterface {
  device_id: string
  device_name: string
  device_type: string
  iface_id: string
  iface_name: string
  speed_bps: number | null
  current_in_bps: number
  current_out_bps: number
  util_pct: number | null
  in_series: [number, number][]
  out_series: [number, number][]
}

export interface TopDevice {
  device_id: string
  device_name: string
  device_type: string
  total_bps: number
}

export interface TopBandwidthData {
  top_interfaces: TopInterface[]
  top_devices: TopDevice[]
}

export const fetchOverview = () =>
  api.get<OverviewData>('/overview').then(r => r.data)

export const fetchTopBandwidth = (limit = 8) =>
  api.get<TopBandwidthData>('/overview/top-bandwidth', { params: { limit } }).then(r => r.data)
