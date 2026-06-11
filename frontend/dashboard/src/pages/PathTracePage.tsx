import { useState, useRef, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { runPathTrace, type TraceResult, type L3Hop, type L2Hop } from '../api/pathTrace'

// ── Protocol badge colours ─────────────────────────────────────────────────
function protocolClass(proto: string | null): string {
  if (!proto) return 'bg-slate-700 text-slate-300'
  const p = proto.toLowerCase()
  if (p === 'connected' || p === 'local' || p === 'direct') return 'bg-green-900/60 text-green-300'
  if (p === 'static') return 'bg-blue-900/60 text-blue-300'
  if (p === 'ospf' || p === 'ospf e1' || p === 'ospf e2') return 'bg-purple-900/60 text-purple-300'
  if (p === 'bgp' || p.startsWith('bgp')) return 'bg-pink-900/60 text-pink-300'
  if (p === 'rip') return 'bg-orange-900/60 text-orange-300'
  if (p === 'isis') return 'bg-teal-900/60 text-teal-300'
  return 'bg-slate-700 text-slate-300'
}

// ── Arrow ──────────────────────────────────────────────────────────────────
function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center my-1">
      {label && <span className="text-[10px] text-slate-500 mb-0.5">{label}</span>}
      <svg className="w-4 h-6 text-slate-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 16 24">
        <line x1="8" y1="0" x2="8" y2="18"/>
        <polyline points="4,14 8,20 12,14"/>
      </svg>
    </div>
  )
}

// ── Endpoint box ───────────────────────────────────────────────────────────
function Endpoint({
  ip, mac, label, deviceName, located, unlocatedNote,
}: {
  ip: string
  mac?: string | null
  label: string
  deviceName?: string | null
  located?: boolean       // undefined = no location concept (dst); false = unlocated
  unlocatedNote?: string
}) {
  const isUnlocated = located === false
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] text-slate-500 mb-1 uppercase tracking-wider font-semibold">{label}</span>
      <div className={`border rounded-lg px-4 py-2.5 min-w-[160px] text-center ${
        isUnlocated
          ? 'bg-slate-800/50 border-dashed border-slate-600'
          : 'bg-slate-800 border-slate-600'
      }`}>
        <div className="text-sm font-mono font-semibold text-slate-100">{ip}</div>
        {mac && <div className="text-[10px] text-slate-500 font-mono mt-0.5">{mac}</div>}
        {deviceName && <div className="text-[10px] text-blue-400 mt-0.5">{deviceName}</div>}
        {isUnlocated && (
          <div className="text-[9px] text-amber-500 mt-0.5">
            {unlocatedNote ?? 'not in monitored network'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── L3 hop card ────────────────────────────────────────────────────────────
function L3HopCard({ hop, index }: { hop: L3Hop; index: number }) {
  const isConnected = !hop.next_hop && hop.route_protocol !== 'static'
  return (
    <div className="flex flex-col items-center">
      {index > 0 && <Arrow label={hop.route_prefix ?? undefined} />}
      <div className={`bg-slate-800/80 border rounded-xl px-5 py-3 min-w-[220px] shadow-sm ${
        isConnected ? 'border-green-700/40' : 'border-slate-700'
      }`}>
        {/* Device name + IP */}
        <div className="flex items-center justify-between gap-3 mb-2">
          <Link
            to={`/devices/${hop.device_id}`}
            className="text-sm font-semibold text-blue-400 hover:text-blue-300 transition-colors truncate"
          >
            {hop.device_name}
          </Link>
          <span className="text-[10px] font-mono text-slate-500 shrink-0">{hop.mgmt_ip}</span>
        </div>

        {/* Route info */}
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          {hop.route_protocol && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide ${protocolClass(hop.route_protocol)}`}>
              {hop.route_protocol}
            </span>
          )}
          {hop.route_prefix && (
            <span className="text-[10px] font-mono text-slate-400">{hop.route_prefix}</span>
          )}
          {hop.ecmp_count && hop.ecmp_count > 1 && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide bg-amber-900/40 text-amber-300"
              title={`${hop.ecmp_count} equal-cost paths available; showing one`}
            >
              ECMP ×{hop.ecmp_count}
            </span>
          )}
        </div>

        {/* Egress interface + next hop */}
        {(hop.egress_if || hop.next_hop) && (
          <div className="mt-2 pt-2 border-t border-slate-700/50 flex items-center gap-2 text-[10px] text-slate-500">
            {hop.egress_if && (
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>
                </svg>
                {hop.egress_if}
              </span>
            )}
            {hop.next_hop && (
              <span className="ml-auto font-mono text-slate-400">{hop.next_hop}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── L2 hop card ────────────────────────────────────────────────────────────
function L2HopCard({ hop, index }: { hop: L2Hop; index: number }) {
  return (
    <div className="flex flex-col items-center">
      {index > 0 && <Arrow />}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-2.5 min-w-[200px] shadow-sm">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <Link
            to={`/devices/${hop.device_id}`}
            className="text-xs font-semibold text-slate-300 hover:text-blue-300 transition-colors truncate"
          >
            {hop.device_name}
          </Link>
          <span className="text-[9px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded font-mono">L2</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          {hop.ingress_port && (
            <>
              <span className="font-mono text-slate-400">{hop.ingress_port}</span>
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </>
          )}
          {hop.egress_port && (
            <span className="font-mono text-slate-300 font-medium">{hop.egress_port}</span>
          )}
          {hop.vlan != null && (
            <span className="ml-auto bg-slate-700/60 px-1.5 py-0.5 rounded text-[9px]">VLAN {hop.vlan}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Status banner ──────────────────────────────────────────────────────────
function StatusBanner({ result }: { result: TraceResult }) {
  const srcNote = result.src_located && result.src_device
    ? `Source located on ${result.src_device}.`
    : result.src_located
      ? 'Source located in monitored network.'
      : 'Source IP not in monitored network — trace may start from an approximate entry point.'

  if (result.error && result.l3_hops.length === 0) {
    return (
      <div className="space-y-2 mt-4">
        {!result.src_located && (
          <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2 text-xs text-amber-400">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
            </svg>
            {srcNote}
          </div>
        )}
        <div className="flex items-center gap-2 bg-red-900/20 border border-red-700/40 rounded-lg px-4 py-2.5 text-sm text-red-300">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>
          {result.error}
        </div>
      </div>
    )
  }
  if (result.dst_found) {
    return (
      <div className="space-y-2 mt-4">
        {result.src_device && (
          <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-2 text-xs text-slate-400">
            <svg className="w-3.5 h-3.5 shrink-0 text-blue-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            {srcNote}
          </div>
        )}
        <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-lg px-4 py-2.5 text-sm text-green-300">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="m20 6-11 11-5-5"/>
          </svg>
          Destination reachable via {result.l3_hops.length} L3 hop{result.l3_hops.length !== 1 ? 's' : ''}
          {result.l2_hops.length > 0 && `, ${result.l2_hops.length} L2 switch${result.l2_hops.length !== 1 ? 'es' : ''}`}
        </div>
      </div>
    )
  }
  if (result.incomplete) {
    return (
      <div className="space-y-2 mt-4">
        {result.src_device && (
          <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-2 text-xs text-slate-400">
            <svg className="w-3.5 h-3.5 shrink-0 text-blue-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            {srcNote}
          </div>
        )}
        <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-700/40 rounded-lg px-4 py-2.5 text-sm text-amber-300">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Trace incomplete — {result.error ?? 'next hop exits monitored network'}
        </div>
      </div>
    )
  }
  return null
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function PathTracePage() {
  const navigate = useNavigate()
  const [srcIp, setSrcIp] = useState('')
  const [dstIp, setDstIp] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TraceResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const dstRef = useRef<HTMLInputElement>(null)

  // Ordered, de-duplicated device IDs along the traced path — used to
  // highlight the path on the topology map.
  const pathDeviceIds = useMemo(() => {
    if (!result) return []
    const ids = [
      ...result.l3_hops.map(h => h.device_id),
      ...result.l2_hops.map(h => h.device_id),
    ]
    if (result.incomplete_reason === 'no_route' && result.dead_end_device_id) {
      ids.push(result.dead_end_device_id)
    }
    const out: string[] = []
    for (const id of ids) {
      if (out[out.length - 1] !== id) out.push(id)
    }
    return out
  }, [result])

  const run = async () => {
    const src = srcIp.trim()
    const dst = dstIp.trim()
    if (!src || !dst) return
    setLoading(true)
    setErr(null)
    setResult(null)
    try {
      const r = await runPathTrace(src, dst)
      setResult(r)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Trace failed'
      setErr(typeof msg === 'string' ? msg : JSON.stringify(msg))
    } finally {
      setLoading(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') run()
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-xl font-bold text-slate-100 mb-1">Path Trace</h1>
      <p className="text-sm text-slate-400 mb-6">
        Trace the L3 route and L2 switching path between two IP addresses using polled network data.
      </p>

      {/* Input form */}
      <div className="flex flex-col sm:flex-row gap-3 items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-400 mb-1">Source IP</label>
          <input
            value={srcIp}
            onChange={e => setSrcIp(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); dstRef.current?.focus() } }}
            placeholder="10.0.2.10"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-400 mb-1">Destination IP</label>
          <input
            ref={dstRef}
            value={dstIp}
            onChange={e => setDstIp(e.target.value)}
            onKeyDown={onKey}
            placeholder="8.8.8.8"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <button
          onClick={run}
          disabled={loading || !srcIp.trim() || !dstIp.trim()}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
        >
          {loading ? 'Tracing…' : 'Trace'}
        </button>
      </div>

      {/* Quick examples */}
      <div className="flex flex-wrap gap-2 mt-3">
        <span className="text-[10px] text-slate-600 self-center">Quick:</span>
        {[
          ['10.0.2.3', '10.0.2.2'],
          ['10.0.2.3', '8.8.8.8'],
          ['10.0.2.2', '10.0.2.3'],
        ].map(([s, d]) => (
          <button
            key={`${s}-${d}`}
            onClick={() => { setSrcIp(s); setDstIp(d) }}
            className="text-[10px] font-mono text-slate-500 hover:text-slate-300 border border-slate-700 hover:border-slate-600 rounded px-2 py-0.5 transition-colors"
          >
            {s} → {d}
          </button>
        ))}
      </div>

      {/* Error */}
      {err && (
        <div className="mt-4 bg-red-900/20 border border-red-700/40 rounded-lg px-4 py-2.5 text-sm text-red-300">
          {err}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mt-6">
          <StatusBanner result={result} />

          {pathDeviceIds.length > 0 && (
            <div className="flex justify-end mt-3">
              <button
                onClick={() => navigate('/topology', {
                  state: {
                    pathTrace: {
                      deviceIds: pathDeviceIds,
                      srcIp: result.src_ip,
                      dstIp: result.dst_ip,
                      exitsToCloud: result.incomplete_reason === 'unmonitored_next_hop',
                    },
                  },
                })}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium rounded-lg transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
                View on topology
              </button>
            </div>
          )}

          {(result.l3_hops.length > 0 || result.l2_hops.length > 0) && (
            <div className="mt-6 flex flex-col items-center">

              {/* Source */}
              <Endpoint
                ip={result.src_ip}
                mac={result.src_mac}
                label="Source"
                deviceName={result.src_device}
                located={result.src_located}
                unlocatedNote="not found in monitored network"
              />

              {/* L3 hops */}
              {result.l3_hops.map((hop, i) => (
                <L3HopCard key={hop.device_id + i} hop={hop} index={i} />
              ))}

              {/* L2 hops (shown after last L3 hop if dst is on a connected segment) */}
              {result.l2_hops.length > 0 && (
                <>
                  <div className="my-2 flex items-center gap-2">
                    <div className="h-px w-12 bg-slate-700/50" />
                    <span className="text-[10px] text-slate-600 uppercase tracking-wider">L2 path</span>
                    <div className="h-px w-12 bg-slate-700/50" />
                  </div>
                  {result.l2_hops.map((hop, i) => (
                    <L2HopCard key={hop.device_id + i} hop={hop} index={i} />
                  ))}
                </>
              )}

              {/* Incomplete marker */}
              {result.incomplete && (
                <div className="flex flex-col items-center mt-1">
                  <Arrow />
                  {result.incomplete_reason === 'no_route' ? (
                    <div className="border border-dashed border-amber-600/40 rounded-lg px-4 py-2 text-[10px] font-mono text-center">
                      <span className="text-amber-500">{result.dead_end_device ?? '…'}</span>
                      <span className="text-slate-600 ml-1">(no route to {result.dst_ip})</span>
                    </div>
                  ) : (
                    <div className="border border-dashed border-amber-600/40 rounded-lg px-4 py-2 text-[10px] text-amber-500 font-mono">
                      {result.l3_hops[result.l3_hops.length - 1]?.next_hop ?? '…'}
                      <span className="text-slate-600 ml-1">(unmonitored)</span>
                    </div>
                  )}
                </div>
              )}

              {/* Destination */}
              {(result.dst_found || result.dst_device) && (
                <>
                  <Arrow />
                  <Endpoint
                    ip={result.dst_ip}
                    mac={result.dst_mac}
                    label="Destination"
                    deviceName={result.dst_device}
                  />
                </>
              )}
              {/* Unlocated source note in diagram */}
              {!result.src_located && result.l3_hops.length === 0 && (
                <div className="mt-4 text-xs text-slate-500 italic text-center">
                  Source IP not found on any monitored device or subnet
                </div>
              )}
            </div>
          )}

          {/* Summary table */}
          {result.l3_hops.length > 0 && (
            <div className="mt-8">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">L3 Hop Summary</h2>
              <div className="bg-slate-800/50 rounded-xl overflow-hidden border border-slate-700/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">#</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Device</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Prefix</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Protocol</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Via</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Egress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.l3_hops.map((hop, i) => (
                      <tr key={i} className="border-b border-slate-700/30 last:border-0 hover:bg-white/5">
                        <td className="px-4 py-2.5 text-slate-600">{i + 1}</td>
                        <td className="px-4 py-2.5">
                          <Link to={`/devices/${hop.device_id}`} className="text-blue-400 hover:text-blue-300 font-medium">
                            {hop.device_name}
                          </Link>
                          <div className="text-[10px] text-slate-600 font-mono">{hop.mgmt_ip}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-400">{hop.route_prefix ?? '—'}</td>
                        <td className="px-4 py-2.5">
                          {hop.route_protocol && (
                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded uppercase ${protocolClass(hop.route_protocol)}`}>
                              {hop.route_protocol}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-400">
                          {hop.next_hop ?? '—'}
                          {hop.ecmp_count && hop.ecmp_count > 1 && (
                            <span
                              className="ml-1.5 text-[10px] font-medium px-1 py-0.5 rounded uppercase bg-amber-900/40 text-amber-300"
                              title={`${hop.ecmp_count} equal-cost paths available; showing one`}
                            >
                              ECMP ×{hop.ecmp_count}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-400">{hop.egress_if ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* L2 summary */}
          {result.l2_hops.length > 0 && (
            <div className="mt-4">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">L2 Switch Path</h2>
              <div className="bg-slate-800/50 rounded-xl overflow-hidden border border-slate-700/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">#</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Switch</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Ingress</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Egress</th>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">VLAN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.l2_hops.map((hop, i) => (
                      <tr key={i} className="border-b border-slate-700/30 last:border-0 hover:bg-white/5">
                        <td className="px-4 py-2.5 text-slate-600">{i + 1}</td>
                        <td className="px-4 py-2.5">
                          <Link to={`/devices/${hop.device_id}`} className="text-blue-400 hover:text-blue-300 font-medium">
                            {hop.device_name}
                          </Link>
                          <div className="text-[10px] text-slate-600 font-mono">{hop.mgmt_ip}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-400">{hop.ingress_port ?? '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-300 font-medium">{hop.egress_port ?? '—'}</td>
                        <td className="px-4 py-2.5 text-slate-400">{hop.vlan != null ? `VLAN ${hop.vlan}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Dst MAC info */}
          {result.dst_mac && (
            <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
              </svg>
              Destination MAC:
              <span className="font-mono text-slate-300">{result.dst_mac}</span>
              <Link
                to={`/clients/${encodeURIComponent(result.dst_mac)}`}
                className="text-blue-400 hover:text-blue-300 ml-1"
              >
                View client →
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
