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

export const login = (username: string, password: string) =>
  api.post<{ access_token: string }>('/auth/login', { username, password }).then((r) => r.data)
