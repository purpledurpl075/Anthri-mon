import api from './client'
import type { Alert, AlertRule, PaginatedResponse } from './types'

export const fetchAlerts = (params?: { status?: string; severity?: string; limit?: number }) =>
  api.get<PaginatedResponse<Alert>>('/alerts', { params }).then(r => r.data)

export const acknowledgeAlert = (id: string) =>
  api.post<Alert>(`/alerts/${id}/acknowledge`).then(r => r.data)

export const resolveAlert = (id: string) =>
  api.post<Alert>(`/alerts/${id}/resolve`).then(r => r.data)

export const fetchAlertRules = () =>
  api.get<PaginatedResponse<AlertRule>>('/alert-rules').then(r => r.data)

export const createAlertRule = (body: Record<string, unknown>) =>
  api.post<AlertRule>('/alert-rules', body).then(r => r.data)

export const updateAlertRule = (id: string, body: Record<string, unknown>) =>
  api.patch<AlertRule>(`/alert-rules/${id}`, body).then(r => r.data)

export const deleteAlertRule = (id: string) =>
  api.delete(`/alert-rules/${id}`)

export const fetchAlert = (id: string) =>
  api.get<Alert>(`/alerts/${id}`).then(r => r.data)

export const fetchAlertRule = (id: string) =>
  api.get<AlertRule>(`/alert-rules/${id}`).then(r => r.data)
