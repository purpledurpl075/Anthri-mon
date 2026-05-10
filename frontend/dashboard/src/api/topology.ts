import api from './client'

export interface TopologyNode {
  id: string
  hostname: string
  mgmt_ip: string
  vendor: string
  device_type: string
  status: string
  connected: boolean
}

export interface TopologyEdge {
  id: string
  source: string
  target: string
  source_port: string | null
  target_port: string | null
  source_iface_id: string | null
  source_speed_bps: number | null
  source_if_index: number | null
  protocol: 'lldp' | 'cdp'
}

export interface TopologyResponse {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

export interface LinkUtilisation {
  if_name: string
  speed_bps: number | null
  in_bps: [number, number][]
  out_bps: [number, number][]
}

export const fetchTopology = () =>
  api.get<TopologyResponse>('/topology').then(r => r.data)

export const fetchLinkUtil = (ifaceId: string) =>
  api.get<LinkUtilisation>(`/interfaces/${ifaceId}/utilisation`).then(r => r.data)
