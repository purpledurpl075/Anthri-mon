import api from './client'
import type { Device, DeviceListItem, HealthData, Interface, PaginatedResponse } from './types'

export const fetchDevices = (params?: { limit?: number; offset?: number }) =>
  api.get<PaginatedResponse<DeviceListItem>>('/devices', { params }).then((r) => r.data)

export const fetchDevice = (id: string) =>
  api.get<Device>(`/devices/${id}`).then((r) => r.data)

export const fetchDeviceInterfaces = (id: string) =>
  api.get<Interface[]>(`/devices/${id}/interfaces`).then((r) => r.data)

export const fetchDeviceHealth = (id: string) =>
  api.get<HealthData>(`/devices/${id}/health`).then((r) => r.data)

export const deleteDevice = (id: string) =>
  api.delete(`/devices/${id}`)

export const patchDevice = (id: string, data: Record<string, unknown>) =>
  api.patch<Device>(`/devices/${id}`, data).then((r) => r.data)

export const setAlertExclusions = (id: string, metrics: string[], interface_ids: string[]) =>
  api.put(`/devices/${id}/alert-exclusions`, { metrics, interface_ids }).then(r => r.data)

export const login = (username: string, password: string) =>
  api.post<{ access_token: string }>('/auth/login', { username, password }).then((r) => r.data)

export interface DeviceCredentialEntry {
  credential_id: string
  name: string
  type: string
  priority: number
}

export interface SnmpDiagResult {
  success: boolean
  credential_name: string
  credential_type: string
  response_ms: number | null
  results: { oid: string; value: string }[]
  error: string | null
}

export const fetchDeviceCredentials = (id: string) =>
  api.get<DeviceCredentialEntry[]>(`/devices/${id}/credentials`).then(r => r.data)

export const linkDeviceCredential = (id: string, credential_id: string, priority: number) =>
  api.post(`/devices/${id}/credentials`, { credential_id, priority })

export const unlinkDeviceCredential = (deviceId: string, credentialId: string) =>
  api.delete(`/devices/${deviceId}/credentials/${credentialId}`)

export const runSnmpDiag = (id: string) =>
  api.post<SnmpDiagResult>(`/devices/${id}/snmp-diag`).then(r => r.data)

export interface LLDPNeighbourEntry {
  local_port: string
  remote_system_name: string | null
  remote_port: string | null
  remote_chassis_id: string | null
  remote_chassis_id_subtype: string | null
  remote_mgmt_ip: string | null
  capabilities: string[]
  updated_at: string
}

export interface CDPNeighbourEntry {
  local_port: string
  remote_device: string | null
  remote_port: string | null
  remote_mgmt_ip: string | null
  platform: string | null
  capabilities: string[]
  native_vlan: number | null
  duplex: string | null
  updated_at: string
}

export interface NeighboursResponse {
  lldp: LLDPNeighbourEntry[]
  cdp: CDPNeighbourEntry[]
}

export const fetchDeviceNeighbours = (id: string) =>
  api.get<NeighboursResponse>(`/devices/${id}/neighbours`).then(r => r.data)

export interface OSPFNeighbourEntry {
  neighbour_ip: string | null
  router_id: string | null
  state: string
  area: string | null
  interface_name: string | null
  priority: number | null
  last_state_change: string | null
  updated_at: string
}

export const fetchDeviceOSPF = (id: string) =>
  api.get<OSPFNeighbourEntry[]>(`/devices/${id}/ospf`).then(r => r.data)

export interface AddressEntry {
  type: 'arp' | 'mac'
  ip: string | null
  mac: string
  port: string | null
  vlan: number | null
  entry_type: string
  updated_at: string
}

export interface AddressesResponse {
  total: number
  limit: number
  offset: number
  items: AddressEntry[]
}

export const fetchDeviceAddresses = (id: string, params?: { search?: string; type?: string; limit?: number; offset?: number }) =>
  api.get<AddressesResponse>(`/devices/${id}/addresses`, { params }).then(r => r.data)

export interface GlobalAddressEntry extends AddressEntry {
  device_id: string
  device_name: string
}

export interface GlobalAddressesResponse {
  total: number
  limit: number
  offset: number
  items: GlobalAddressEntry[]
}

export const fetchAllAddresses = (params?: { search?: string; type?: string; device_id?: string; limit?: number; offset?: number }) =>
  api.get<GlobalAddressesResponse>('/devices/addresses', { params }).then(r => r.data)
