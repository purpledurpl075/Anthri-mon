import api from './client'

export interface SmtpSettings {
  host: string
  port: number
  user: string
  from_addr: string
  ssl: boolean
  password_set: boolean
}

export interface SmtpSettingsWrite {
  host: string
  port: number
  user: string
  password: string | null  // null = keep existing
  from_addr: string
  ssl: boolean
}

export const fetchSmtpSettings = () =>
  api.get<SmtpSettings>('/admin/settings/smtp').then(r => r.data)

export const saveSmtpSettings = (body: SmtpSettingsWrite) =>
  api.put<SmtpSettings>('/admin/settings/smtp', body).then(r => r.data)

export const testSmtpSettings = () =>
  api.post('/admin/settings/smtp/test')
