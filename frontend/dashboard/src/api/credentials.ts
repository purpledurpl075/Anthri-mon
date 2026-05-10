import api from './client'

export interface Credential {
  id: string
  name: string
  type: string
  data: Record<string, any>
  created_at: string
  updated_at: string
}

export const fetchCredentials = (all = false) =>
  api.get<Credential[]>('/credentials', { params: all ? { all: true } : {} }).then(r => r.data)

export const fetchCredential = (id: string) =>
  api.get<Credential>(`/credentials/${id}`).then(r => r.data)

export const createCredential = (body: { name: string; type: string; data: Record<string, any> }) =>
  api.post<Credential>('/credentials', body).then(r => r.data)

export const updateCredential = (id: string, body: { name?: string; data?: Record<string, any> }) =>
  api.patch<Credential>(`/credentials/${id}`, body).then(r => r.data)

export const deleteCredential = (id: string) =>
  api.delete(`/credentials/${id}`)
