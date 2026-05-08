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
  protocol: 'lldp' | 'cdp'
}

export interface TopologyResponse {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

export const fetchTopology = () =>
  api.get<TopologyResponse>('/topology').then(r => r.data)
