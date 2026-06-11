import api from './client'
import type { PaginatedResponse } from './types'

export interface AuditLogEntry {
  id: number
  tenant_id: string | null
  user_id: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  ip_address: string | null
  user_agent: string | null
  site_id: string | null
  created_at: string
  user_name: string | null
  resource_name: string | null
  summary: string | null
  changes: string[]
}

export interface AuditFilters {
  action?: string
  resource_type?: string
  user_id?: string
  since?: string
  until?: string
  search?: string
  limit?: number
  offset?: number
}

export const fetchAudit = (params?: AuditFilters) =>
  api.get<PaginatedResponse<AuditLogEntry>>('/audit', {
    params: params as Record<string, unknown> | undefined,
  }).then(r => r.data)

export async function downloadAuditCsv(
  params?: Omit<AuditFilters, 'limit' | 'offset'>,
): Promise<void> {
  const token = localStorage.getItem('token')
  const search = new URLSearchParams()
  if (params) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (v !== undefined && v !== '') search.append(k, String(v))
    }
  }
  const qs = search.toString()
  const url = `/api/v1/audit/export.csv${qs ? '?' + qs : ''}`

  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Export failed (${res.status})`)

  const blob = await res.blob()
  // Filename from Content-Disposition if present, else a sensible default.
  const cd = res.headers.get('content-disposition') || ''
  const m  = cd.match(/filename="?([^";]+)"?/)
  const filename = m ? m[1] : `anthrimon-audit-${Date.now()}.csv`

  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(objectUrl)
}
