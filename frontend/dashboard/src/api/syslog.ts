import api from './client'

export interface SyslogSummary {
  total:          number
  by_severity:    Record<string, number>
  active_devices: number
}

export interface SyslogMessage {
  device_id:      string
  device_name:    string
  device_ip:      string
  facility:       number
  facility_name:  string
  severity:       number
  severity_name:  string
  severity_color: string
  ts_ms:          number
  hostname:       string
  program:        string
  pid:            string
  message:        string
  raw:            string
}

export interface SyslogMessagesResult {
  total:    number
  messages: SyslogMessage[]
}

export interface SyslogRatePoint {
  ts_ms:         number
  severity:      number
  severity_name: string
  count:         number
}

export interface SyslogProgram {
  program: string
  total:   number
  errors:  number
}

export interface SyslogDevice {
  device_id:   string
  device_name: string
  device_type: string
  total:       number
  errors:      number
  warnings:    number
}

const p = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))

export const fetchSyslogSummary = (minutes: number, deviceId?: string) =>
  api.get<SyslogSummary>('/syslog/summary', { params: p({ minutes, device_id: deviceId }) }).then(r => r.data)

export const fetchSyslogMessages = (params: {
  device_id?: string; severity_max?: number; program?: string
  q?: string; minutes?: number; limit?: number; offset?: number
}) => api.get<SyslogMessagesResult>('/syslog/messages', { params: p(params) }).then(r => r.data)

export const fetchSyslogRate = (hours: number, deviceId?: string) =>
  api.get<SyslogRatePoint[]>('/syslog/rate', { params: p({ hours, device_id: deviceId }) }).then(r => r.data)

export const fetchSyslogTopPrograms = (minutes: number, deviceId?: string) =>
  api.get<SyslogProgram[]>('/syslog/top-programs', { params: p({ minutes, device_id: deviceId }) }).then(r => r.data)

export const fetchSyslogTopDevices = (minutes: number) =>
  api.get<SyslogDevice[]>('/syslog/top-devices', { params: { minutes } }).then(r => r.data)
