import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { runProbe, fetchProbeCollectors, type ProbeEvent, type ProbeType } from '../api/probes'

// ── RTT heatmap thresholds (ms) ──────────────────────────────────────────────
function rttToneClass(ms: number | null): string {
  if (ms === null)        return 'bg-red-500 text-white'        // timeout
  if (ms < 5)             return 'bg-emerald-500 text-white'
  if (ms < 25)            return 'bg-emerald-400 text-white'
  if (ms < 75)            return 'bg-amber-400 text-slate-900'
  if (ms < 200)           return 'bg-orange-500 text-white'
  return 'bg-red-500 text-white'
}

interface TracerouteHop {
  hop:  number
  ip:   string | null   // null if "* * *"
  host: string | null
  rtts: (number | null)[]   // ms, null if "*"
}

/**
 * Parse `traceroute -n` output lines into structured hops.  Handles:
 *    1  10.0.0.1  0.456 ms  0.512 ms  0.478 ms
 *    2  * * *
 *    3  10.0.1.1 (gateway.example.com)  1.234 ms !H
 */
function parseTracerouteLine(line: string): TracerouteHop | null {
  const m = line.match(/^\s*(\d+)\s+(.*)$/)
  if (!m) return null
  const hop = parseInt(m[1], 10)
  const rest = m[2].trim()
  if (/^\*(\s+\*)*$/.test(rest)) {
    return { hop, ip: null, host: null, rtts: [null] }
  }
  // First token is IP (numeric output) or hostname; following tokens are RTT
  // chunks like "1.234 ms" or "*".
  const parts = rest.split(/\s+/)
  let ip: string | null = null
  let host: string | null = null
  let idx = 0
  if (parts[0] && (/^[0-9.]+$/.test(parts[0]) || /^[0-9a-f:.]+$/i.test(parts[0]))) {
    ip = parts[0]
    idx = 1
    // Some traceroutes append (hostname) in parens even with -n
    if (parts[1] && parts[1].startsWith('(') && parts[1].endsWith(')')) {
      host = parts[1].slice(1, -1)
      idx = 2
    }
  } else {
    host = parts[0]
    idx = 1
  }
  const rtts: (number | null)[] = []
  while (idx < parts.length) {
    if (parts[idx] === '*') { rtts.push(null); idx += 1; continue }
    const v = parseFloat(parts[idx])
    if (!isNaN(v) && parts[idx + 1] === 'ms') {
      rtts.push(v); idx += 2; continue
    }
    idx += 1
  }
  return { hop, ip, host, rtts }
}

interface MtrHop {
  hop:    number
  ip:     string | null
  lossPct: number
  sent:   number
  last:   number | null
  avg:    number | null
  best:   number | null
  worst:  number | null
  stdev:  number | null
}

/** Parse `mtr -r` table row, e.g.
 *      1.|-- 10.0.0.1                      0.0%     5    0.5   0.5   0.4   0.7   0.1
 */
function parseMtrLine(line: string): MtrHop | null {
  const m = line.match(/^\s*(\d+)\.\|--\s+(\S+)\s+([\d.]+)%\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (!m) return null
  const ip = m[2] === '???' ? null : m[2]
  return {
    hop:     parseInt(m[1], 10),
    ip,
    lossPct: parseFloat(m[3]),
    sent:    parseInt(m[4], 10),
    last:    ip ? parseFloat(m[5]) : null,
    avg:     ip ? parseFloat(m[6]) : null,
    best:    ip ? parseFloat(m[7]) : null,
    worst:   ip ? parseFloat(m[8]) : null,
    stdev:   ip ? parseFloat(m[9]) : null,
  }
}

function RttPill({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-slate-300 text-xs">—</span>
  return (
    <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 font-mono ${rttToneClass(v)}`}>
      {v.toFixed(1)}
    </span>
  )
}

const TYPE_OPTIONS: { label: string; value: ProbeType; sub: string }[] = [
  { label: 'Ping',        value: 'ping',       sub: 'ICMP echo' },
  { label: 'Traceroute',  value: 'traceroute', sub: 'Hop-by-hop' },
  { label: 'MTR',         value: 'mtr',        sub: 'Loss/latency per hop' },
]

export default function ProbesPage() {
  const [type,      setType]      = useState<ProbeType>('ping')
  const [source,    setSource]    = useState<string>('hub')
  const [target,    setTarget]    = useState('')
  const [count,     setCount]     = useState(5)
  const [timeoutS,  setTimeoutS]  = useState(3)
  const [maxHops,   setMaxHops]   = useState(24)
  const [running,   setRunning]   = useState(false)
  const [events,    setEvents]    = useState<ProbeEvent[]>([])
  const cancelRef = useRef<(() => void) | null>(null)
  const outputRef = useRef<HTMLDivElement | null>(null)

  const { data: collectors = [] } = useQuery({
    queryKey: ['probe-collectors'],
    queryFn:  fetchProbeCollectors,
  })

  // Auto-scroll output as new lines stream in
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' })
  }, [events])

  function start() {
    if (!target.trim()) return
    setEvents([])
    setRunning(true)
    cancelRef.current = runProbe(
      { type, target: target.trim(), source,
        count, timeout_s: timeoutS, max_hops: maxHops },
      ev  => setEvents(prev => [...prev, ev]),
      ()  => { setRunning(false); cancelRef.current = null },
    )
  }

  function stop() {
    cancelRef.current?.()
  }

  useEffect(() => () => cancelRef.current?.(), [])  // cancel on unmount

  const lastEvent = events[events.length - 1]
  const completed = lastEvent?.event === 'complete' || lastEvent?.event === 'error'

  // Derived structured views per probe type
  const traceHops: TracerouteHop[] = useMemo(() => {
    if (type !== 'traceroute') return []
    const hops: TracerouteHop[] = []
    for (const ev of events) {
      if (ev.event !== 'line' || !ev.data) continue
      const h = parseTracerouteLine(ev.data)
      if (h) hops.push(h)
    }
    return hops
  }, [events, type])

  const mtrHops: MtrHop[] = useMemo(() => {
    if (type !== 'mtr') return []
    const hops: MtrHop[] = []
    for (const ev of events) {
      if (ev.event !== 'line' || !ev.data) continue
      const h = parseMtrLine(ev.data)
      if (h) hops.push(h)
    }
    return hops
  }, [events, type])

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Probes</h1>
        <p className="text-sm text-slate-500 mt-1">
          Run ping, traceroute, or MTR from the hub or any registered remote collector.
          Output streams live; close the page to cancel.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-4 space-y-4">
        {/* Type pills */}
        <div>
          <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Type</p>
          <div className="inline-flex border border-slate-200 rounded-lg overflow-hidden">
            {TYPE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setType(opt.value)}
                disabled={running}
                className={`px-4 py-2 text-sm font-semibold transition-colors ${
                  type === opt.value
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                } ${opt.value !== TYPE_OPTIONS[0].value ? 'border-l border-slate-200' : ''}`}
                title={opt.sub}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Source + Target */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5 uppercase tracking-wide">From</label>
            <select
              value={source}
              onChange={e => setSource(e.target.value)}
              disabled={running}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-slate-400"
            >
              <option value="hub">Hub</option>
              {collectors.map(c => (
                <option key={c.id} value={c.id} disabled={!c.wg_ip}>
                  {c.name} {c.wg_ip ? `(${c.wg_ip})` : '(not registered)'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5 uppercase tracking-wide">Target</label>
            <input
              value={target}
              onChange={e => setTarget(e.target.value)}
              disabled={running}
              placeholder="10.0.0.1, 8.8.8.8, 2606:4700::1111, or example.com"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-slate-400 font-mono"
              onKeyDown={e => { if (e.key === 'Enter' && !running) start() }}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              IPv4 / IPv6 / hostname accepted. No shell metacharacters.
            </p>
          </div>
        </div>

        {/* Numeric knobs */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5 uppercase tracking-wide">
              {type === 'traceroute' ? 'Probes/hop' : 'Count'}
            </label>
            <input
              type="number" min={1} max={60}
              value={count} onChange={e => setCount(Math.max(1, Math.min(60, Number(e.target.value))))}
              disabled={running || type === 'traceroute'}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5 uppercase tracking-wide">Timeout (s)</label>
            <input
              type="number" min={1} max={10}
              value={timeoutS} onChange={e => setTimeoutS(Math.max(1, Math.min(10, Number(e.target.value))))}
              disabled={running}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5 uppercase tracking-wide">Max hops</label>
            <input
              type="number" min={1} max={32}
              value={maxHops} onChange={e => setMaxHops(Math.max(1, Math.min(32, Number(e.target.value))))}
              disabled={running || type === 'ping'}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 disabled:bg-slate-50"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          {running ? (
            <button
              onClick={stop}
              className="text-sm font-semibold text-red-700 border border-red-200 bg-red-50 hover:bg-red-100 rounded-lg px-4 py-2 transition-colors inline-flex items-center gap-2"
            >
              <span className="inline-block w-3 h-3 border-2 border-red-200 border-t-red-700 rounded-full animate-spin" />
              Stop
            </button>
          ) : (
            <button
              onClick={start}
              disabled={!target.trim()}
              className="text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg px-4 py-2 transition-colors"
            >
              ▶ Run
            </button>
          )}
        </div>
      </div>

      {/* Structured traceroute view */}
      {type === 'traceroute' && traceHops.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-4">
          <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
            Hops &nbsp;<span className="font-normal text-slate-400">{traceHops.length} discovered</span>
          </div>
          <div className="divide-y divide-slate-100">
            {traceHops.map(h => {
              const best = h.rtts.find(v => v !== null) ?? null
              return (
                <div key={h.hop} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono text-xs text-slate-400 w-6 text-right">{h.hop}</span>
                  <span className={`inline-block w-2 h-2 rounded-full ${h.ip ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <span className="font-mono text-slate-700 flex-1 truncate">
                    {h.ip ?? <span className="text-red-400 italic">timeout</span>}
                    {h.host && h.host !== h.ip && <span className="ml-2 text-slate-400">({h.host})</span>}
                  </span>
                  <div className="flex gap-1">
                    {h.rtts.map((rtt, i) => (
                      <span
                        key={i}
                        className={`text-[10px] font-semibold rounded px-1.5 py-0.5 font-mono min-w-[44px] text-center ${rttToneClass(rtt)}`}
                        title={rtt === null ? 'No response' : `${rtt.toFixed(2)} ms`}
                      >
                        {rtt === null ? '✗' : `${rtt.toFixed(1)}ms`}
                      </span>
                    ))}
                    {best !== null && (
                      <span className="text-[10px] text-slate-400 ml-2 font-mono">best {best.toFixed(1)}ms</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Structured MTR view */}
      {type === 'mtr' && mtrHops.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-4">
          <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
            MTR report &nbsp;<span className="font-normal text-slate-400">{mtrHops.length} hops</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr className="text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                <th className="px-3 py-1.5">#</th>
                <th className="px-3 py-1.5">Host</th>
                <th className="px-3 py-1.5">Loss%</th>
                <th className="px-3 py-1.5">Sent</th>
                <th className="px-3 py-1.5">Last</th>
                <th className="px-3 py-1.5">Avg</th>
                <th className="px-3 py-1.5">Best</th>
                <th className="px-3 py-1.5">Worst</th>
                <th className="px-3 py-1.5">StDev</th>
              </tr>
            </thead>
            <tbody>
              {mtrHops.map(h => (
                <tr key={h.hop} className="border-b border-slate-50 last:border-0">
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-400">{h.hop}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-700">
                    {h.ip ?? <span className="text-red-400 italic">???</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 font-mono ${
                      h.lossPct === 0 ? 'bg-emerald-100 text-emerald-700' :
                      h.lossPct < 5   ? 'bg-amber-100 text-amber-700' :
                                        'bg-red-100 text-red-700'
                    }`}>{h.lossPct.toFixed(1)}%</span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{h.sent}</td>
                  <td className="px-3 py-1.5"><RttPill v={h.last} /></td>
                  <td className="px-3 py-1.5"><RttPill v={h.avg} /></td>
                  <td className="px-3 py-1.5"><RttPill v={h.best} /></td>
                  <td className="px-3 py-1.5"><RttPill v={h.worst} /></td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{h.stdev?.toFixed(2) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Output */}
      {(events.length > 0 || running) && (
        <div className="bg-slate-900 text-slate-100 rounded-xl overflow-hidden border border-slate-700">
          <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between text-xs">
            <span className="font-mono text-slate-300">
              {lastEvent?.event === 'start' || (running && !completed)
                ? <>● <span className="text-emerald-400 animate-pulse">running</span></>
                : lastEvent?.event === 'complete'
                  ? <>● <span className="text-emerald-400">done</span> (exit {lastEvent.exit_code})</>
                  : lastEvent?.event === 'error'
                    ? <>● <span className="text-red-400">error</span></>
                    : '…'}
            </span>
            <span className="font-mono text-slate-400 text-[11px]">
              {events.filter(e => e.event === 'line').length} lines
            </span>
          </div>
          <div ref={outputRef} className="p-4 max-h-[60vh] overflow-y-auto font-mono text-xs leading-relaxed">
            {events.map((ev, i) => {
              if (ev.event === 'start') {
                return (
                  <div key={i} className="text-slate-400">
                    $ {ev.command}{ev.source ? ` ← ${ev.source}` : ''}
                  </div>
                )
              }
              if (ev.event === 'line') {
                return <div key={i} className="whitespace-pre">{ev.data}</div>
              }
              if (ev.event === 'complete') {
                return <div key={i} className="text-emerald-400 mt-2">--- complete (exit {ev.exit_code}) ---</div>
              }
              if (ev.event === 'error') {
                return <div key={i} className="text-red-400 mt-2">!! {ev.detail}</div>
              }
              return null
            })}
          </div>
        </div>
      )}
    </div>
  )
}
