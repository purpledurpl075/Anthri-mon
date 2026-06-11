import api from './client'

export interface L3Hop {
  device_id: string
  device_name: string
  mgmt_ip: string
  egress_if: string | null
  next_hop: string | null
  route_prefix: string | null
  route_protocol: string | null
  ecmp_count: number | null
}

export interface L2Hop {
  device_id: string
  device_name: string
  mgmt_ip: string
  ingress_port: string | null
  egress_port: string | null
  vlan: number | null
}

export interface TraceResult {
  src_ip: string
  dst_ip: string
  src_mac: string | null
  dst_mac: string | null
  src_located: boolean
  src_device: string | null
  l3_hops: L3Hop[]
  l2_hops: L2Hop[]
  dst_device: string | null
  dst_found: boolean
  incomplete: boolean
  incomplete_reason: string | null
  dead_end_device: string | null
  dead_end_device_id: string | null
  error: string | null
}

export const runPathTrace = (src_ip: string, dst_ip: string) =>
  api.post<TraceResult>('/path-trace', { src_ip, dst_ip }).then(r => r.data)
