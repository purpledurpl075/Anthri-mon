import api from './client'

export interface MaintenanceWindow {
  id: string
  tenant_id: string
  name: string
  description: string | null
  device_selector: Record<string, unknown> | null
  starts_at: string
  ends_at: string
  is_recurring: boolean
  recurrence_cron: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  is_active: boolean
  next_fire_at: string | null
}

export interface MaintenanceWindowCreate {
  name: string
  description?: string
  device_selector?: Record<string, unknown> | null
  starts_at: string
  ends_at: string
  is_recurring: boolean
  recurrence_cron?: string | null
}

export const fetchMaintenanceWindows = (params?: { device_id?: string; active_only?: boolean }) =>
  api.get<MaintenanceWindow[]>('/maintenance-windows', { params }).then(r => r.data)

export const createMaintenanceWindow = (body: MaintenanceWindowCreate) =>
  api.post<MaintenanceWindow>('/maintenance-windows', body).then(r => r.data)

export const deleteMaintenanceWindow = (id: string) =>
  api.delete(`/maintenance-windows/${id}`)
