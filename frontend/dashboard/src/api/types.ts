export interface DeviceListItem {
  id: string
  hostname: string
  mgmt_ip: string
  vendor: string
  device_type: string
  platform: string | null
  status: string
  last_seen: string | null
  is_active: boolean
  tags: string[]
}

export interface PaginatedResponse<T> {
  total: number
  limit: number
  offset: number
  items: T[]
}

export interface Device {
  id: string
  hostname: string
  fqdn: string | null
  mgmt_ip: string
  vendor: string
  device_type: string
  platform: string | null
  os_version: string | null
  serial_number: string | null
  sys_description: string | null
  collection_method: string
  snmp_version: string
  snmp_port: number
  polling_interval_s: number
  status: string
  last_seen: string | null
  last_polled: string | null
  is_active: boolean
  tags: string[]
  notes: string | null
}

export interface Interface {
  id: string
  device_id: string
  if_index: number
  name: string
  description: string | null
  if_type: string | null
  speed_bps: number | null
  mtu: number | null
  mac_address: string | null
  admin_status: string
  oper_status: string
  last_change: string | null
  updated_at: string
}

export interface HealthData {
  device_id: string
  collected_at: string
  cpu_util_pct: number | null
  mem_used_bytes: number | null
  mem_total_bytes: number | null
  mem_util_pct: number | null
  uptime_seconds: number | null
  temperatures: Array<{ sensor: string; celsius: number; ok: boolean }>
}
