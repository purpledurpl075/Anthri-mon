import api from './client'

export interface ConfigBackupMeta {
  id: string
  device_id: string
  collected_at: string
  config_hash: string
  collection_method: string
  is_latest: boolean
  size_bytes: number
}

export interface ConfigBackupFull extends ConfigBackupMeta {
  config_text: string
}

export interface ConfigDiffMeta {
  id: string
  device_id: string
  prev_backup_id: string | null
  curr_backup_id: string
  lines_added: number
  lines_removed: number
  created_at: string
}

export interface ConfigDiffFull extends ConfigDiffMeta {
  diff_text: string
}

export interface ConfigStatus {
  has_backup: boolean
  last_collected: string | null
  backup_count: number
  last_changed_at: string | null
  last_diff: { id: string; lines_added: number; lines_removed: number } | null
  compliance_fail_count: number
  compliance_total: number
}

export interface ComplianceRule {
  type: 'regex_present' | 'regex_absent' | 'contains' | 'not_contains'
  pattern: string
  description?: string
}

export interface CompliancePolicy {
  id: string
  tenant_id: string
  name: string
  description: string | null
  is_enabled: boolean
  device_selector: Record<string, unknown> | null
  rules: ComplianceRule[]
  severity: string
  created_at: string
  updated_at: string
}

export interface ComplianceFinding {
  description: string
  type: string
  status: 'pass' | 'fail' | 'error'
  matched_text?: string | null
  error?: string
}

export interface ComplianceResult {
  id: string
  device_id: string
  device_name: string
  policy_id: string
  policy_name: string
  severity: string
  status: 'pass' | 'fail' | 'error'
  checked_at: string
  findings: ComplianceFinding[]
}

export const fetchConfigStatus = (deviceId: string) =>
  api.get<ConfigStatus>(`/config/status/${deviceId}`).then(r => r.data)

export const fetchBackups = (deviceId: string, limit = 20) =>
  api.get<ConfigBackupMeta[]>('/config/backups', { params: { device_id: deviceId, limit } }).then(r => r.data)

export const fetchBackup = (backupId: string) =>
  api.get<ConfigBackupFull>(`/config/backups/${backupId}`).then(r => r.data)

export const fetchDiffs = (deviceId: string, limit = 20) =>
  api.get<ConfigDiffMeta[]>('/config/diffs', { params: { device_id: deviceId, limit } }).then(r => r.data)

export const fetchDiff = (diffId: string) =>
  api.get<ConfigDiffFull>(`/config/diffs/${diffId}`).then(r => r.data)

export const triggerCollect = (deviceId: string) =>
  api.post<{ status: string }>(`/config/collect/${deviceId}`).then(r => r.data)

export const fetchPolicies = () =>
  api.get<CompliancePolicy[]>('/config/policies').then(r => r.data)

export const createPolicy = (body: Partial<CompliancePolicy>) =>
  api.post<CompliancePolicy>('/config/policies', body).then(r => r.data)

export const updatePolicy = (id: string, body: Partial<CompliancePolicy>) =>
  api.patch<CompliancePolicy>(`/config/policies/${id}`, body).then(r => r.data)

export const deletePolicy = (id: string) =>
  api.delete(`/config/policies/${id}`)

export const runPolicy = (id: string) =>
  api.post<Record<string, number>>(`/config/policies/${id}/evaluate`).then(r => r.data)

export const fetchComplianceResults = (deviceId?: string) =>
  api.get<ComplianceResult[]>('/config/compliance/results', {
    params: deviceId ? { device_id: deviceId } : {},
  }).then(r => r.data)

export interface DeployResult {
  device_id: string
  hostname:  string
  commands:  number
  saved:     boolean
  output:    string
}

export const deployConfig = (deviceId: string, commands: string[], save = true) =>
  api.post<DeployResult>(`/config/deploy/${deviceId}`, { commands, save }).then(r => r.data)

export interface MultiDeployDeviceResult {
  device_id: string
  hostname:  string
  success:   boolean
  error:     string | null
  output:    string
}

export interface MultiDeployResult {
  results:   MultiDeployDeviceResult[]
  total:     number
  succeeded: number
  failed:    number
}

export const deployConfigMulti = (body: {
  commands: string[]
  device_selector?: Record<string, unknown> | null
  variables?: Record<string, string>
  save?: boolean
}) => api.post<MultiDeployResult>('/config/deploy/multi', body).then(r => r.data)

export const previewDeployTargets = (params: { vendor?: string; tag?: string }) =>
  api.get<{ id: string; hostname: string; mgmt_ip: string; vendor: string }[]>(
    '/config/deploy/preview', { params }
  ).then(r => r.data)
