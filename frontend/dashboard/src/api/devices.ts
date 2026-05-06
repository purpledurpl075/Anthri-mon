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
