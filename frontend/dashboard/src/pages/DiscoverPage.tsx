import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchCredentials, startSweep, getSweepJob, type DiscoveredDevice, type SweepJob } from '../api/discovery'
import api from '../api/client'
import VendorBadge from '../components/VendorBadge'

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{value} / {max} hosts scanned</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function DiscoverPage() {
  const queryClient = useQueryClient()

  const [cidr, setCidr] = useState('')
  const [credId, setCredId] = useState('')
  const [timeout, setTimeout_] = useState(3)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<SweepJob | null>(null)
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: credentials = [] } = useQuery({
    queryKey: ['credentials'],
    queryFn: fetchCredentials,
  })

  // Poll job status while running
  useEffect(() => {
    if (!jobId) return
    pollRef.current = setInterval(async () => {
      try {
        const j = await getSweepJob(jobId)
        setJob(j)
        if (j.status === 'done' || j.status === 'error') {
          clearInterval(pollRef.current!)
        }
      } catch { /* ignore */ }
    }, 1000)
    return () => clearInterval(pollRef.current!)
  }, [jobId])

  const sweepMutation = useMutation({
    mutationFn: () => startSweep(cidr, credId, timeout),
    onSuccess: (j) => {
      setJob(j)
      setJobId(j.job_id)
    },
  })

  async function handleAddDevice(d: DiscoveredDevice) {
    setAdding(prev => new Set(prev).add(d.ip))
    try {
      await api.post('/api/v1/devices', {
        hostname: d.hostname,
        mgmt_ip: d.ip,
        vendor: d.vendor,
        collection_method: 'snmp',
        snmp_version: credentials.find(c => c.id === credId)?.type === 'snmp_v3' ? 'v3' : 'v2c',
      })
      // Invalidate devices list so it refreshes
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      // Refresh job to mark as in_db
      if (jobId) {
        const j = await getSweepJob(jobId)
        setJob(j)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setAdding(prev => { const s = new Set(prev); s.delete(d.ip); return s })
    }
  }

  const isRunning = job?.status === 'pending' || job?.status === 'running'

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <h1 className="text-base font-semibold text-slate-800">Discover</h1>
      </div>

      <main className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Sweep form */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">SNMP Sweep</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">CIDR Range</label>
              <input
                type="text"
                value={cidr}
                onChange={e => setCidr(e.target.value)}
                placeholder="10.0.2.0/24"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Credential</label>
              <select
                value={credId}
                onChange={e => setCredId(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isRunning}
              >
                <option value="">— select —</option>
                {credentials.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Timeout (s)</label>
              <input
                type="number"
                value={timeout}
                onChange={e => setTimeout_(Number(e.target.value))}
                min={1} max={10}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isRunning}
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={() => sweepMutation.mutate()}
              disabled={!cidr || !credId || isRunning}
              className="bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isRunning ? 'Scanning…' : 'Start sweep'}
            </button>
            {job && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                job.status === 'done'    ? 'bg-green-100 text-green-700' :
                job.status === 'error'   ? 'bg-red-100 text-red-700' :
                'bg-blue-100 text-blue-700'
              }`}>
                {job.status}
              </span>
            )}
            {sweepMutation.isError && (
              <span className="text-xs text-red-600">Failed to start sweep</span>
            )}
          </div>

          {job && isRunning && (
            <div className="mt-4">
              <ProgressBar value={job.scanned} max={job.total} />
            </div>
          )}
          {job?.status === 'done' && (
            <p className="mt-3 text-xs text-slate-500">
              Scan complete — {job.found.length} device{job.found.length !== 1 ? 's' : ''} found in {job.cidr}
            </p>
          )}
        </div>

        {/* Results */}
        {job && job.found.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Discovered Devices</h3>
              <span className="text-xs text-slate-400">{job.found.length} found</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">IP</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Hostname</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Vendor</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600 max-w-xs">Description</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {job.found.map(d => (
                  <tr key={d.ip} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{d.ip}</td>
                    <td className="px-4 py-2.5 text-slate-700">{d.hostname}</td>
                    <td className="px-4 py-2.5"><VendorBadge vendor={d.vendor} /></td>
                    <td className="px-4 py-2.5 text-xs text-slate-400 max-w-xs truncate">{d.sys_descr}</td>
                    <td className="px-4 py-2.5 text-right">
                      {d.already_in_db ? (
                        <Link
                          to={`/devices/${d.device_id}`}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          View
                        </Link>
                      ) : (
                        <button
                          onClick={() => handleAddDevice(d)}
                          disabled={adding.has(d.ip)}
                          className="text-xs bg-green-600 text-white rounded px-3 py-1 hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >
                          {adding.has(d.ip) ? 'Adding…' : 'Add'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {job?.status === 'done' && job.found.length === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 text-sm">
            No SNMP-responding devices found in {job.cidr}.
          </div>
        )}
      </main>
    </div>
  )
}
