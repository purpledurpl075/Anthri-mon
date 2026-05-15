import api from './client'

export interface FlowSummary {
  bytes_total:      number
  packets_total:    number
  flows_total:      number
  unique_src_ips:   number
  unique_dst_ips:   number
  active_exporters: number
}

export interface TopTalker {
  src_ip:        string
  dst_ip:        string
  protocol:      number
  protocol_name: string
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface TopPort {
  dst_port:      number
  protocol:      number
  protocol_name: string
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface ProtocolPoint {
  ts_ms:         number
  protocol:      number
  protocol_name: string
  bytes_total:   number
  packets_total: number
}

export interface TopDevice {
  device_id:     string
  device_name:   string
  device_type:   string
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface TimeseriesPoint {
  ts_ms:         number
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface FlowRecord {
  device_id:       string
  exporter_ip:     string
  flow_type:       string
  flow_start_ms:   number
  flow_end_ms:     number
  src_ip:          string
  dst_ip:          string
  src_port:        number
  dst_port:        number
  protocol:        number
  protocol_name:   string
  tcp_flags:       number
  bytes:           number
  packets:         number
  input_if_index:  number
  output_if_index: number
  src_asn:         number
  dst_asn:         number
  sampling_rate:   number
}

export interface InterfaceBreakdownRow {
  input_if_index:  number
  input_if_name:   string
  output_if_index: number
  output_if_name:  string
  bytes_total:     number
  packets_total:   number
  flow_count:      number
}

const p = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))

export const fetchFlowSummary = (minutes: number, deviceId?: string) =>
  api.get<FlowSummary>('/flow/summary', { params: p({ minutes, device_id: deviceId }) }).then(r => r.data)

export const fetchTopTalkers = (minutes: number, limit: number, deviceId?: string, protocol?: number) =>
  api.get<TopTalker[]>('/flow/top-talkers', { params: p({ minutes, limit, device_id: deviceId, protocol }) }).then(r => r.data)

export const fetchTopPorts = (minutes: number, limit: number, deviceId?: string) =>
  api.get<TopPort[]>('/flow/top-ports', { params: p({ minutes, limit, device_id: deviceId }) }).then(r => r.data)

export const fetchProtocolBreakdown = (minutes: number, deviceId?: string) =>
  api.get<ProtocolPoint[]>('/flow/protocol-breakdown', { params: p({ minutes, device_id: deviceId }) }).then(r => r.data)

export const fetchTopDevices = (minutes: number, limit = 10) =>
  api.get<TopDevice[]>('/flow/top-devices', { params: p({ minutes, limit }) }).then(r => r.data)

export const fetchFlowTimeseries = (minutes: number, deviceId?: string, srcIp?: string, dstIp?: string) =>
  api.get<TimeseriesPoint[]>('/flow/timeseries', { params: p({ minutes, device_id: deviceId, src_ip: srcIp, dst_ip: dstIp }) }).then(r => r.data)

export const searchFlows = (params: {
  device_id?: string; src_ip?: string; dst_ip?: string
  protocol?: number; src_port?: number; dst_port?: number
  minutes?: number; limit?: number
}) => api.get<FlowRecord[]>('/flow/search', { params: p(params) }).then(r => r.data)

export interface IpDetail {
  ip: string
  bytes_as_src: number
  bytes_as_dst: number
  pkts_as_src:  number
  pkts_as_dst:  number
  flows_total:  number
  top_peers: { peer_ip: string; bytes_sent: number; bytes_received: number }[]
  top_ports: { dst_port: number; protocol: number; protocol_name: string; bytes_total: number }[]
  timeseries: { ts_ms: number; bytes_out: number; bytes_in: number }[]
}

export const fetchIpDetail = (ip: string, minutes: number, deviceId?: string) =>
  api.get<IpDetail>('/flow/ip-detail', { params: p({ ip, minutes, device_id: deviceId }) }).then(r => r.data)

export interface IfaceFlowPoint {
  ts_ms: number; bytes_in: number; bytes_out: number; packets_total: number; flow_count: number
}

export interface IfaceTalker {
  src_ip: string; dst_ip: string; protocol: number; protocol_name: string
  bytes_total: number; packets_total: number; flow_count: number
}

export const fetchInterfaceFlowTimeseries = (deviceId: string, ifIndex: number, minutes: number) =>
  api.get<IfaceFlowPoint[]>('/flow/interface-timeseries', { params: { device_id: deviceId, if_index: ifIndex, minutes } }).then(r => r.data)

export const fetchInterfaceTopTalkers = (deviceId: string, ifIndex: number, minutes: number, limit = 10) =>
  api.get<IfaceTalker[]>('/flow/interface-top-talkers', { params: { device_id: deviceId, if_index: ifIndex, minutes, limit } }).then(r => r.data)
