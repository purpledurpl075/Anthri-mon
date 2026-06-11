import api from './client'

export interface PlatformHealth {
  process: { uptime_seconds: number; started_at_unix: number; pid: number }
  api: {
    requests_total: number
    requests_by_status: Record<string, number>
    request_duration: { count: number; sum: number; p50: number; p95: number; p99: number; max: number }
  }
  alert_engine: {
    cycle_duration: { count: number; sum: number; p50: number; p95: number; p99: number; max: number }
    fired_total: number
    suppressed_total: number
    wake_events: number
  }
  alerts: {
    by_status: Record<string, number>
    last_hour_fired: number
    last_hour_notify: number
    notify_failures_24h: number
  }
  database: {
    row_counts: Record<string, number>
    active_connections: number
    database_bytes: number
    pool: { size: number; checked_in: number; checked_out: number; overflow: number }
  }
  collectors: { name: string; wg_ip: string | null; version: string | null; last_seen: string | null; stale_seconds: number | null; synthetic: boolean }[]
}

export const fetchPlatformHealth = () =>
  api.get<PlatformHealth>('/platform/health').then(r => r.data)


export interface UploadedBackup {
  filename: string
  path: string
  size: number
  modified_at: string
}

export const fetchUploadedBackups = () =>
  fetch('/api/v1/platform/backups', {
    headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
  }).then(r => r.ok ? r.json() as Promise<UploadedBackup[]> : Promise.reject(r))

export async function uploadBackup(
  file: File,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<{ path: string; filename: string; restore_command: string; size: number }> {
  const token = localStorage.getItem('token')
  const xhr = new XMLHttpRequest()
  return new Promise((resolve, reject) => {
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) }
        catch { reject(new Error('Bad response from server')) }
      } else {
        let msg = `Upload failed (${xhr.status})`
        try { msg = JSON.parse(xhr.responseText).detail ?? msg } catch { /* ignore */ }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload aborted'))
    xhr.open('POST', '/api/v1/platform/backup-upload')
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    const fd = new FormData()
    fd.append('file', file, file.name)
    xhr.send(fd)
  })
}

export async function deleteUploadedBackup(filename: string): Promise<void> {
  const token = localStorage.getItem('token')
  const res = await fetch(`/api/v1/platform/backups/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Delete failed (${res.status})`)
}

export async function downloadPlatformBackup(
  opts: { noFlowHistory?: boolean; compression?: number } = {},
): Promise<void> {
  const token = localStorage.getItem('token')
  const params = new URLSearchParams({
    no_flow_history: String(opts.noFlowHistory ?? true),
    compression:     String(opts.compression ?? 3),
  })
  const res = await fetch(`/api/v1/platform/backup?${params}`, {
    method:  'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Backup failed (${res.status}): ${text || res.statusText}`)
  }
  const blob = await res.blob()
  const cd = res.headers.get('content-disposition') || ''
  const m  = cd.match(/filename="?([^";]+)"?/)
  const filename = m ? m[1] : `anthrimon-backup-${Date.now()}.tar.zst`

  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(objectUrl)
}
