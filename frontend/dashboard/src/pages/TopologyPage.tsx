import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  ReactFlow, ReactFlowProvider, Controls, Background, MiniMap, Panel, useReactFlow,
  EdgeLabelRenderer, getSmoothStepPath, applyNodeChanges,
  Handle, Position,
  type NodeProps, type Node, type Edge, type EdgeProps,
  type NodeMouseHandler, type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  fetchTopology, fetchLinkUtil, fetchLinkUtilBatch,
  type TopologyNode, type TopologyEdge as ApiEdge,
  type LinkUtilisation,
} from '../api/topology'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR as TYPE_COLOR, DEVICE_TYPE_LABEL as TYPE_LABEL } from '../components/DeviceTypeIcon'
import api from '../api/client'

// ── Palettes ───────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  up:          '#16a34a',
  down:        '#dc2626',
  unreachable: '#f97316',
  unknown:     '#94a3b8',
}
const STATUS_LABEL: Record<string, string> = {
  up: 'Up', down: 'Down', unreachable: 'Unreachable', unknown: 'Unknown',
}
const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626',
  major:    '#ea580c',
  minor:    '#d97706',
  warning:  '#ca8a04',
  info:     '#2563eb',
}
const SEVERITY_ORDER = ['critical', 'major', 'minor', 'warning', 'info']

// ── Layout constants ───────────────────────────────────────────────────────

const NODE_W  = 160
const H_STEP  = 240
const V_STEP  = 190

const ROOT_PRIO: Record<string, number> = {
  router: 5, firewall: 5, load_balancer: 4,
  switch: 3, wireless_controller: 2, access_point: 0, unknown: 1,
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtSpeed(bps: number): string {
  if (bps >= 1e9) return `${bps / 1e9} Gbps`
  if (bps >= 1e6) return `${bps / 1e6} Mbps`
  if (bps >= 1e3) return `${bps / 1e3} Kbps`
  return `${bps} bps`
}

function fmtBps(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Kbps`
  return `${bps.toFixed(0)} bps`
}

// Colour an edge based on utilisation percentage
function utilEdgeColor(pct: number | null, protocol: string): string {
  if (pct === null) return protocol === 'lldp' ? '#0891b2' : '#7c3aed'
  if (pct < 30)   return '#16a34a'  // green
  if (pct < 60)   return protocol === 'lldp' ? '#0891b2' : '#7c3aed'  // normal
  if (pct < 80)   return '#d97706'  // amber
  if (pct < 95)   return '#ea580c'  // orange
  return '#dc2626'                  // red
}

// Stroke width scaled to link capacity
function edgeStrokeWidth(speedBps: number | null): number {
  if (!speedBps) return 1.5
  if (speedBps >= 40e9) return 5
  if (speedBps >= 10e9) return 3.5
  if (speedBps >= 1e9)  return 2.5
  return 1.5
}

// ── Hierarchical layout ────────────────────────────────────────────────────

function hierLayout(
  nodes: TopologyNode[],
  rawEdges: Pick<ApiEdge, 'source' | 'target'>[],
): Record<string, { x: number; y: number }> {
  if (!nodes.length) return {}

  const idSet = new Set(nodes.map(n => n.id))
  const adj: Record<string, string[]> = {}
  const deg: Record<string, number> = {}
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]))
  nodes.forEach(n => { adj[n.id] = []; deg[n.id] = 0 })
  rawEdges.forEach(e => {
    if (!idSet.has(e.source) || !idSet.has(e.target)) return
    adj[e.source].push(e.target)
    adj[e.target].push(e.source)
    deg[e.source]++
    deg[e.target]++
  })

  const score = (id: string) =>
    (ROOT_PRIO[nodeMap[id]?.device_type ?? 'unknown'] ?? 1) * 20 + deg[id]

  const visited = new Set<string>()
  const layer: Record<string, number> = {}
  const comps: string[][] = []
  const byScore = [...nodes].sort((a, b) => score(b.id) - score(a.id))

  for (const start of byScore) {
    if (visited.has(start.id)) continue
    const comp: string[] = []
    const q = [start.id]
    visited.add(start.id)
    layer[start.id] = 0
    let qi = 0
    while (qi < q.length) {
      const cur = q[qi++]
      comp.push(cur)
      const nbs = [...adj[cur]].sort((a, b) => score(b) - score(a))
      for (const nb of nbs) {
        if (!visited.has(nb)) {
          visited.add(nb)
          layer[nb] = layer[cur] + 1
          q.push(nb)
        }
      }
    }
    comps.push(comp)
  }

  const pos: Record<string, { x: number; y: number }> = {}
  let offsetX = 0

  for (const comp of comps) {
    const byLayer: Record<number, string[]> = {}
    comp.forEach(id => { (byLayer[layer[id] ?? 0] ??= []).push(id) })

    const layerNums = Object.keys(byLayer).map(Number).sort((a, b) => a - b)
    for (let li = 1; li < layerNums.length; li++) {
      const l = layerNums[li]
      const prev = byLayer[layerNums[li - 1]] ?? []
      const prevIdx = Object.fromEntries(prev.map((id, i) => [id, i]))
      byLayer[l].sort((a, b) => {
        const avg = (id: string) => {
          const ps = adj[id].filter(p => prev.includes(p))
          return ps.length ? ps.reduce((s, p) => s + (prevIdx[p] ?? 0), 0) / ps.length : 999
        }
        return avg(a) - avg(b)
      })
    }

    const maxW = Math.max(...Object.values(byLayer).map(l => l.length))
    const compW = maxW * H_STEP

    layerNums.forEach(l => {
      const ids = byLayer[l]
      const layerW = ids.length * H_STEP
      const x0 = offsetX + (compW - layerW) / 2
      ids.forEach((id, i) => { pos[id] = { x: x0 + i * H_STEP, y: l * V_STEP } })
    })

    offsetX += compW + H_STEP
  }

  return pos
}

// ── Handle routing ────────────────────────────────────────────────────────

type HandleSide = 'top' | 'bottom' | 'left' | 'right'

function edgeHandles(
  src?: { x: number; y: number },
  tgt?: { x: number; y: number },
): { sh: HandleSide; th: HandleSide; sp: Position; tp: Position } {
  if (!src || !tgt) return { sh: 'bottom', th: 'top', sp: Position.Bottom, tp: Position.Top }
  const dx = tgt.x - src.x
  const dy = tgt.y - src.y
  if (Math.abs(dy) >= Math.abs(dx) * 0.6) {
    return dy >= 0
      ? { sh: 'bottom', th: 'top',    sp: Position.Bottom, tp: Position.Top    }
      : { sh: 'top',    th: 'bottom', sp: Position.Top,    tp: Position.Bottom }
  }
  return dx >= 0
    ? { sh: 'right', th: 'left',  sp: Position.Right, tp: Position.Left  }
    : { sh: 'left',  th: 'right', sp: Position.Left,  tp: Position.Right }
}

// ── Node ───────────────────────────────────────────────────────────────────

const H: React.CSSProperties = {
  opacity: 0, width: 2, height: 2, minWidth: 2, minHeight: 2, border: 'none',
}

type NodeData = TopologyNode & {
  alerts:    { count: number; severity: string } | null
  dimmed:    boolean
  searchHit: boolean
}

function DeviceNode({ data, selected }: NodeProps) {
  const d      = data as unknown as NodeData
  const color  = TYPE_COLOR[d.device_type] ?? '#475569'
  const sc     = STATUS_COLOR[d.status] ?? '#94a3b8'
  const hasCrit = d.alerts?.severity === 'critical'

  return (
    <div style={{ width: NODE_W, opacity: d.dimmed ? 0.15 : 1, transition: 'opacity 0.2s' }}>
      <Handle id="top"    type="source" position={Position.Top}    style={H} />
      <Handle id="top"    type="target" position={Position.Top}    style={H} />
      <Handle id="bottom" type="source" position={Position.Bottom} style={H} />
      <Handle id="bottom" type="target" position={Position.Bottom} style={H} />
      <Handle id="left"   type="source" position={Position.Left}   style={H} />
      <Handle id="left"   type="target" position={Position.Left}   style={H} />
      <Handle id="right"  type="source" position={Position.Right}  style={H} />
      <Handle id="right"  type="target" position={Position.Right}  style={H} />

      <div className="relative">
        {/* Alert badge */}
        {d.alerts && d.alerts.count > 0 && (
          <div
            className="absolute -top-2 -right-2 z-10 min-w-[20px] h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white px-1.5"
            style={{
              backgroundColor: SEVERITY_COLOR[d.alerts.severity] ?? '#dc2626',
              boxShadow: `0 0 0 2px white`,
              animation: hasCrit ? 'alertPulse 1.8s ease-in-out infinite' : undefined,
            }}
          >
            {d.alerts.count > 99 ? '99+' : d.alerts.count}
          </div>
        )}

        {/* Search highlight ring */}
        {d.searchHit && (
          <div
            className="absolute -inset-1.5 rounded-[14px] pointer-events-none"
            style={{ boxShadow: '0 0 0 2.5px #3b82f6, 0 0 12px #3b82f640' }}
          />
        )}

        <div
          className="rounded-xl bg-white transition-shadow"
          style={{
            border:     `1.5px solid ${selected ? color : '#e2e8f0'}`,
            boxShadow:  selected
              ? `0 0 0 3px ${color}22, 0 6px 20px rgba(0,0,0,0.10)`
              : '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
          }}
        >
          <div style={{ height: 3, backgroundColor: color, borderRadius: '8px 8px 0 0' }} />
          <div className="px-3 pt-2.5 pb-2">
            <div className="flex items-start justify-between mb-1.5">
              <span style={{ color }}><DeviceTypeIcon type={d.device_type} size={22} /></span>
              <span
                className="w-2 h-2 rounded-full mt-0.5 shrink-0"
                style={{ backgroundColor: sc }}
                title={STATUS_LABEL[d.status] ?? d.status}
              />
            </div>
            <div className="text-[11px] font-semibold text-slate-800 truncate leading-tight">
              {d.hostname}
            </div>
            <div className="text-[10px] font-mono text-slate-400 mt-0.5 truncate">
              {d.mgmt_ip || '—'}
            </div>
          </div>
          <div
            className="px-3 py-1 border-t text-[9px] text-slate-400 capitalize rounded-b-xl"
            style={{ borderColor: `${color}20`, backgroundColor: `${color}07` }}
          >
            {TYPE_LABEL[d.device_type] ?? 'Unknown'}
          </div>
        </div>
      </div>
    </div>
  )
}

const NODE_TYPES = { device: DeviceNode }

// ── Edge ───────────────────────────────────────────────────────────────────

type EdgeData = {
  label?: string
  protocol?: string
  highlighted?: boolean
  dimmed?: boolean
  source_port?: string
  target_port?: string
  speed_bps?: number | null
  source_hostname?: string
  target_hostname?: string
  source_iface_id?: string | null
  util_pct?: number | null
  util_in_pct?: number | null
  util_out_pct?: number | null
}

function TopologyEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false)
  const d       = data as EdgeData
  const utilPct = d.util_pct ?? null
  const color   = utilEdgeColor(utilPct, d.protocol ?? 'lldp')
  const sw      = edgeStrokeWidth(d.speed_bps ?? null)
  const dimmed  = !!d.dimmed
  const hilit   = !!d.highlighted || selected

  // Continuous flow animation when utilisation > 8%, speed proportional to load
  const flowDur = (!hilit && utilPct !== null && utilPct > 8)
    ? Math.max(0.5, 3 - utilPct * 0.025)
    : null

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 14,
    offset: 28,
  })

  return (
    <>
      {/* Glow halo when selected */}
      {hilit && (
        <path d={path} fill="none" stroke={color} strokeWidth={(sw + 6)} strokeOpacity={0.12} strokeLinecap="round" />
      )}
      {/* White backing (creates gap effect) */}
      <path
        d={path} fill="none" stroke="white"
        strokeWidth={hilit ? sw + 3 : sw + 2}
        strokeOpacity={dimmed ? 0 : 0.65}
        strokeLinecap="round"
      />
      {/* Main edge line */}
      <path
        id={id} d={path} fill="none"
        stroke={color}
        strokeWidth={hilit ? sw + 1 : sw}
        strokeOpacity={dimmed ? 0.07 : 1}
        strokeLinecap="round"
        strokeDasharray={hilit ? '7 4' : (flowDur ? '6 5' : undefined)}
        style={{
          animation: hilit
            ? 'topoEdgeDash 0.9s linear infinite'
            : flowDur
              ? `topoEdgeDash ${flowDur}s linear infinite`
              : undefined,
          transition: 'stroke 0.4s, stroke-opacity 0.15s, stroke-width 0.15s',
        }}
      />
      {/* Wide invisible hit area */}
      <path
        d={path} fill="none" stroke="transparent" strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {!dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'none',
              zIndex: hovered ? 20 : 1,
            }}
          >
            {hovered ? (
              <div className="bg-slate-900/95 text-white rounded-lg shadow-xl whitespace-nowrap" style={{ fontSize: 10, padding: '6px 10px' }}>
                <div className="font-mono space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 w-12 shrink-0">Local</span>
                    <span className="text-white font-semibold">{d.source_port ?? '—'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 w-12 shrink-0">Remote</span>
                    <span className="text-slate-300">{d.target_port ?? '—'}</span>
                  </div>
                  {d.speed_bps != null && (
                    <div className="flex items-center gap-2 pt-0.5 border-t border-slate-700 mt-0.5">
                      <span className="text-slate-400 w-12 shrink-0">Speed</span>
                      <span className="text-cyan-300">{fmtSpeed(d.speed_bps)}</span>
                    </div>
                  )}
                  {utilPct !== null && (
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 w-12 shrink-0">Util</span>
                      <span style={{ color }}>{utilPct.toFixed(1)}%</span>
                      {d.util_in_pct != null && d.util_out_pct != null && (
                        <span className="text-slate-400">↑{d.util_out_pct.toFixed(0)}% ↓{d.util_in_pct.toFixed(0)}%</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              utilPct !== null && utilPct >= 60 ? (
                <span
                  className="text-[9px] font-bold rounded px-1.5 py-0.5 shadow-sm leading-none whitespace-nowrap text-white"
                  style={{ backgroundColor: color }}
                >
                  {utilPct.toFixed(0)}%
                </span>
              ) : d.label ? (
                <span className="text-[9px] font-mono text-slate-500 bg-white border border-slate-200 rounded px-1.5 py-0.5 shadow-sm leading-none whitespace-nowrap">
                  {d.label}
                </span>
              ) : null
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const EDGE_TYPES = { topology: TopologyEdge }

// ── Device panel ───────────────────────────────────────────────────────────

function DevicePanel({
  node, edges, nodesById, onClose, onNavigate,
}: {
  node: TopologyNode
  edges: ApiEdge[]
  nodesById: Record<string, TopologyNode>
  onClose: () => void
  onNavigate: (id: string) => void
}) {
  const color = TYPE_COLOR[node.device_type] ?? '#475569'
  const sc    = STATUS_COLOR[node.status]    ?? '#94a3b8'

  const links = edges
    .filter(e => e.source === node.id || e.target === node.id)
    .map(e => {
      const isSrc  = e.source === node.id
      const peerId = isSrc ? e.target : e.source
      const peer   = nodesById[peerId]
      const lp     = isSrc ? e.source_port : e.target_port
      const rp     = isSrc ? e.target_port : e.source_port
      return { peer, lp, rp, protocol: e.protocol }
    })

  return (
    <div
      className="absolute top-4 right-4 w-72 bg-white rounded-2xl shadow-xl border border-slate-200 z-10 flex flex-col overflow-hidden"
      style={{ maxHeight: 'calc(100% - 2rem)' }}
    >
      <div className="px-4 py-3 flex items-start justify-between" style={{ borderBottom: `3px solid ${color}` }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span style={{ color }}><DeviceTypeIcon type={node.device_type} size={15} /></span>
            <span className="text-xs text-slate-400">{TYPE_LABEL[node.device_type] ?? 'Unknown'}</span>
          </div>
          <h3 className="text-sm font-bold text-slate-800 truncate">{node.hostname}</h3>
        </div>
        <button onClick={onClose} className="ml-2 p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="px-4 py-3 space-y-2 overflow-y-auto flex-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-slate-400">Status</span>
          <span className="flex items-center gap-1.5 font-medium" style={{ color: sc }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sc }} />
            {STATUS_LABEL[node.status] ?? node.status}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-400">Management IP</span>
          <span className="font-mono text-slate-700">{node.mgmt_ip || '—'}</span>
        </div>
        {node.vendor && node.vendor !== 'unknown' && (
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Vendor</span>
            <span className="text-slate-700 capitalize">{node.vendor.replace('_', ' ')}</span>
          </div>
        )}
        {links.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
              {links.length} link{links.length !== 1 ? 's' : ''}
            </p>
            <div className="space-y-1.5">
              {links.map((l, i) => (
                <button
                  key={i}
                  onClick={() => l.peer && onNavigate(l.peer.id)}
                  disabled={!l.peer}
                  className="w-full text-left rounded-lg border border-slate-100 px-3 py-2 hover:border-slate-300 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-700 truncate">{l.peer?.hostname ?? 'Unknown'}</span>
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded text-white shrink-0 ${l.protocol === 'lldp' ? 'bg-cyan-600' : 'bg-violet-600'}`}>
                      {l.protocol.toUpperCase()}
                    </span>
                  </div>
                  {(l.lp || l.rp) && (
                    <div className="text-[10px] text-slate-400 font-mono mt-0.5">{l.lp ?? '—'} → {l.rp ?? '—'}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-slate-100">
        <button
          onClick={() => onNavigate(node.id)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors"
        >
          Open device
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  )
}

// ── Sparkline ──────────────────────────────────────────────────────────────

function Sparkline({ inSeries, outSeries, w = 248, h = 64 }: {
  inSeries:  [number, number][]
  outSeries: [number, number][]
  w?: number
  h?: number
}) {
  const allVals = [...inSeries, ...outSeries].map(([, v]) => v)
  const max     = Math.max(...allVals, 1)
  const allT    = [...inSeries, ...outSeries].map(([t]) => t)
  const minT    = Math.min(...allT)
  const maxT    = Math.max(...allT)
  const rangeT  = maxT - minT || 1

  const sx = (t: number) => ((t - minT) / rangeT) * w
  const sy = (v: number) => h - 2 - (v / max) * (h - 6)

  const linePts = (s: [number, number][]) => s.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' ')
  const areaPath = (s: [number, number][]) => {
    if (s.length < 2) return ''
    const pts = s.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' L ')
    return `M ${sx(s[0][0])},${h} L ${pts} L ${sx(s.at(-1)![0])},${h} Z`
  }

  if (inSeries.length < 2 && outSeries.length < 2) {
    return (
      <div style={{ width: w, height: h }} className="flex items-center justify-center text-[10px] text-slate-300">
        No data yet
      </div>
    )
  }

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {inSeries.length >= 2 && <>
        <path d={areaPath(inSeries)} fill="#0891b2" fillOpacity={0.12} />
        <polyline points={linePts(inSeries)} fill="none" stroke="#0891b2" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </>}
      {outSeries.length >= 2 && <>
        <path d={areaPath(outSeries)} fill="#f59e0b" fillOpacity={0.12} />
        <polyline points={linePts(outSeries)} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </>}
    </svg>
  )
}

// ── Link panel ─────────────────────────────────────────────────────────────

function LinkPanel({
  edge, nodesById, clickPos, onClose, onNavigate,
}: {
  edge: ApiEdge
  nodesById: Record<string, TopologyNode>
  clickPos: { x: number; y: number }
  onClose: () => void
  onNavigate: (id: string) => void
}) {
  const src = nodesById[edge.source]
  const tgt = nodesById[edge.target]

  const { data: util, isLoading } = useQuery<LinkUtilisation>({
    queryKey:        ['link-util', edge.source_iface_id],
    queryFn:         () => fetchLinkUtil(edge.source_iface_id!),
    enabled:         !!edge.source_iface_id,
    staleTime:       30_000,
    refetchInterval: 60_000,
  })

  const speed   = util?.speed_bps ?? edge.source_speed_bps
  const inLast  = util?.in_bps?.at(-1)?.[1]  ?? null
  const outLast = util?.out_bps?.at(-1)?.[1]  ?? null
  const inPct   = speed && inLast  != null ? inLast  / speed * 100 : null
  const outPct  = speed && outLast != null ? outLast / speed * 100 : null

  const W = 284
  const left    = Math.min(Math.max(clickPos.x - W / 2, 8), window.innerWidth - W - 8)
  const below   = clickPos.y + 12
  const above   = clickPos.y - 12
  const fitsBelow = below + 420 < window.innerHeight

  return (
    <div
      style={{
        position:  'fixed',
        left,
        ...(fitsBelow ? { top: below } : { bottom: window.innerHeight - above }),
        width:     W,
        maxHeight: 420,
        zIndex:    50,
      }}
      className="bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
    >
      <div className="px-3 py-2.5 flex items-center justify-between bg-slate-800 rounded-t-2xl">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
          <span className="text-xs font-semibold text-white truncate">
            {edge.source_port ?? src?.hostname ?? '?'}
          </span>
          <span className="text-slate-500 text-xs">↔</span>
          <span className="text-xs text-slate-300 truncate">
            {edge.target_port ?? tgt?.hostname ?? '?'}
          </span>
        </div>
        <button onClick={onClose} className="ml-2 p-1 text-slate-400 hover:text-white rounded transition-colors shrink-0">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="overflow-y-auto flex-1">
        <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100">
          {[
            { device: src, port: edge.source_port, side: 'Local' },
            { device: tgt, port: edge.target_port, side: 'Remote' },
          ].map(({ device, port, side }) => (
            <button
              key={side}
              onClick={() => device && onNavigate(device.id)}
              disabled={!device}
              className="px-3 py-2 text-left hover:bg-slate-50 transition-colors disabled:cursor-default"
            >
              <div className="text-[9px] text-slate-400 uppercase tracking-wide mb-0.5">{side}</div>
              <div className="text-xs font-semibold text-slate-800 truncate">{device?.hostname ?? '—'}</div>
              <div className="font-mono text-[10px] text-cyan-600 mt-0.5 truncate">{port ?? '—'}</div>
            </button>
          ))}
        </div>

        {speed != null && (
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
            <span className="text-[11px] text-slate-500">Port speed</span>
            <span className="text-[11px] font-semibold text-slate-800">{fmtSpeed(speed)}</span>
          </div>
        )}

        {edge.source_iface_id ? (
          <div className="px-3 pt-2.5 pb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">Bandwidth — 30 min</span>
              <div className="flex items-center gap-2.5 text-[9px] text-slate-400">
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 rounded bg-cyan-500 inline-block" />In</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 rounded bg-amber-400 inline-block" />Out</span>
              </div>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center h-16 text-[10px] text-slate-300">Loading…</div>
            ) : util ? (
              <>
                <div className="rounded-xl bg-slate-50 px-1 py-1.5 mb-2.5">
                  <Sparkline
                    inSeries={util.in_bps as [number, number][]}
                    outSeries={util.out_bps as [number, number][]}
                    w={248} h={64}
                  />
                </div>

                <div className="space-y-1.5">
                  {([
                    { label: 'In',  val: inLast,  pct: inPct,  c: '#0891b2' },
                    { label: 'Out', val: outLast, pct: outPct, c: '#f59e0b' },
                  ] as const).map(({ label, val, pct, c }) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-6 shrink-0">{label}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(pct ?? 0, 100)}%`, backgroundColor: c }} />
                      </div>
                      <span className="text-[10px] font-mono text-slate-600 w-20 text-right shrink-0">
                        {val != null ? fmtBps(val) : '—'}
                      </span>
                      <span className="text-[10px] text-slate-400 w-10 text-right shrink-0">
                        {pct != null ? `${pct.toFixed(1)}%` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-[10px] text-slate-400 py-1">No utilisation data</div>
            )}
          </div>
        ) : (
          <div className="px-3 py-2 text-[10px] text-slate-400">No interface metrics available</div>
        )}
      </div>
    </div>
  )
}

// ── Fit-view button ────────────────────────────────────────────────────────

function FitBtn() {
  const { fitView } = useReactFlow()
  return (
    <button
      onClick={() => fitView({ padding: 0.2, duration: 400 })}
      title="Fit to view"
      className="flex items-center justify-center w-7 h-7 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300 shadow-sm transition-colors"
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
      </svg>
    </button>
  )
}

// ── Utilisation legend ────────────────────────────────────────────────────

function UtilLegend() {
  const steps = [
    { label: '0–30%',  color: '#16a34a' },
    { label: '30–60%', color: '#0891b2' },
    { label: '60–80%', color: '#d97706' },
    { label: '80–95%', color: '#ea580c' },
    { label: '>95%',   color: '#dc2626' },
    { label: 'No data', color: '#94a3b8' },
  ]
  return (
    <div className="flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 shadow-sm">
      <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide shrink-0">Link util</span>
      <div className="flex items-center gap-2 flex-wrap">
        {steps.map(s => (
          <span key={s.label} className="flex items-center gap-1 text-[9px] text-slate-500">
            <span className="w-5 h-0.5 rounded-full inline-block" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Layout persistence ────────────────────────────────────────────────────

const LAYOUT_KEY = 'topology_layout_v1'

function loadSavedLayout(): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') }
  catch { return {} }
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  return (
    <ReactFlowProvider>
      <TopologyPageInner />
    </ReactFlowProvider>
  )
}

function TopologyPageInner() {
  const navigate = useNavigate()
  const { fitView } = useReactFlow()

  const [selectedId,     setSelectedId]    = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [edgePanelPos,   setEdgePanelPos]  = useState<{ x: number; y: number } | null>(null)
  const [showIsolated,   setShowIsolated]  = useState(false)
  const [showLabels,     setShowLabels]    = useState(true)
  const [protocolFilter, setProtocol]      = useState<'all' | 'lldp' | 'cdp'>('all')
  const [hiddenTypes,    setHiddenTypes]   = useState<Set<string>>(new Set())
  const [typeMenuOpen,   setTypeMenuOpen]  = useState(false)
  const [search,         setSearch]        = useState('')
  const [showUtilLegend, setShowUtilLegend] = useState(false)

  const [rfNodes, setRfNodes] = useState<Node[]>([])
  const [rfEdges, setRfEdges] = useState<Edge[]>([])

  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const savedLayout = useMemo(() => loadSavedLayout(), [])

  // ── Main topology query ────────────────────────────────────────────────
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey:  ['topology'],
    queryFn:   fetchTopology,
    staleTime: 30_000,
  })

  // ── Alert summary query ────────────────────────────────────────────────
  const { data: alertsData } = useQuery({
    queryKey:        ['topo-alerts'],
    queryFn:         () => api.get('/alerts', { params: { status: 'open', limit: 1000 } }).then(r => r.data),
    staleTime:       30_000,
    refetchInterval: 60_000,
  })

  const alertsByDevice = useMemo(() => {
    const map: Record<string, { count: number; severity: string }> = {}
    for (const alert of (alertsData as any)?.items ?? []) {
      const did: string = alert.device_id
      if (!did) continue
      if (!map[did]) map[did] = { count: 0, severity: 'info' }
      map[did].count++
      if (SEVERITY_ORDER.indexOf(alert.severity) < SEVERITY_ORDER.indexOf(map[did].severity)) {
        map[did].severity = alert.severity
      }
    }
    return map
  }, [alertsData])

  // ── Batch util query (all topology edges) ─────────────────────────────
  const ifaceIds = useMemo(
    () => [...new Set((data?.edges ?? []).map(e => e.source_iface_id).filter(Boolean) as string[])],
    [data?.edges],
  )

  const { data: utilBatch } = useQuery({
    queryKey:        ['topo-util', ifaceIds.slice().sort().join(',')],
    queryFn:         () => fetchLinkUtilBatch(ifaceIds),
    enabled:         ifaceIds.length > 0,
    staleTime:       25_000,
    refetchInterval: 30_000,
  })

  // ── Search matches ────────────────────────────────────────────────────
  const searchMatchIds = useMemo(() => {
    if (!search.trim()) return null
    const q = search.toLowerCase()
    return new Set(
      (data?.nodes ?? [])
        .filter(n => (n.hostname ?? '').toLowerCase().includes(q) || n.mgmt_ip.includes(q))
        .map(n => n.id)
    )
  }, [search, data?.nodes])

  // ── Fit view to search results ────────────────────────────────────────
  useEffect(() => {
    if (!searchMatchIds || searchMatchIds.size === 0) return
    const timer = setTimeout(() => {
      fitView({ nodes: rfNodes.filter(n => searchMatchIds.has(n.id)), padding: 0.3, duration: 400 })
    }, 50)
    return () => clearTimeout(timer)
  }, [searchMatchIds])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build ReactFlow nodes + edges ─────────────────────────────────────
  const nodesById = Object.fromEntries((data?.nodes ?? []).map(n => [n.id, n]))
  const deviceTypes = [...new Set((data?.nodes ?? []).map(n => n.device_type))].filter(Boolean)

  useEffect(() => {
    if (!data) return

    const visible = data.nodes.filter(n =>
      !hiddenTypes.has(n.device_type) && (showIsolated || n.connected)
    )
    const pos     = hierLayout(visible, data.edges)
    const nodeIds = new Set(visible.map(n => n.id))

    setRfNodes(prev => {
      const prevById = Object.fromEntries(prev.map(n => [n.id, n]))
      return visible.map(n => {
        const isSearchDimmed = searchMatchIds !== null && !searchMatchIds.has(n.id)
        const isSearchHit    = searchMatchIds !== null && searchMatchIds.has(n.id)
        return {
          id:       n.id,
          type:     'device',
          position: prevById[n.id]?.position ?? savedLayout[n.id] ?? pos[n.id] ?? { x: 0, y: 0 },
          selected: n.id === selectedId,
          data: {
            ...n,
            alerts:    alertsByDevice[n.id] ?? null,
            dimmed:    isSearchDimmed,
            searchHit: isSearchHit,
          } as unknown as Record<string, unknown>,
          draggable: true,
        }
      })
    })

    setRfEdges(
      data.edges
        .filter(e =>
          nodeIds.has(e.source) && nodeIds.has(e.target) &&
          (protocolFilter === 'all' || e.protocol === protocolFilter)
        )
        .map(e => {
          const { sh, th } = edgeHandles(pos[e.source], pos[e.target])
          const isAdj = !selectedId || e.source === selectedId || e.target === selectedId
          const label = showLabels
            ? (e.source_port && e.target_port
                ? `${e.source_port} → ${e.target_port}`
                : e.source_port ?? e.target_port ?? '')
            : ''

          // Compute utilisation percentage from batch snapshot
          let utilPct: number | null = null
          let utilInPct: number | null = null
          let utilOutPct: number | null = null
          if (e.source_iface_id && utilBatch?.[e.source_iface_id]) {
            const snap = utilBatch[e.source_iface_id]
            if (snap.speed_bps && snap.speed_bps > 0) {
              utilInPct  = (snap.in_bps  / snap.speed_bps) * 100
              utilOutPct = (snap.out_bps / snap.speed_bps) * 100
              utilPct    = Math.max(utilInPct, utilOutPct)
            }
          }

          const edgeDimmed = (!!selectedId && !isAdj) ||
            (searchMatchIds !== null && !searchMatchIds.has(e.source) && !searchMatchIds.has(e.target))

          return {
            id: e.id, source: e.source, target: e.target,
            sourceHandle: sh, targetHandle: th,
            type: 'topology',
            data: {
              label,
              protocol:        e.protocol,
              highlighted:     !!selectedId && isAdj,
              dimmed:          edgeDimmed,
              source_port:     e.source_port,
              target_port:     e.target_port,
              speed_bps:       e.source_speed_bps,
              source_hostname: nodesById[e.source]?.hostname,
              target_hostname: nodesById[e.target]?.hostname,
              source_iface_id: e.source_iface_id,
              util_pct:        utilPct,
              util_in_pct:     utilInPct,
              util_out_pct:    utilOutPct,
            },
          }
        })
    )
  }, [data, showIsolated, hiddenTypes, selectedId, protocolFilter, showLabels,
      alertsByDevice, utilBatch, searchMatchIds, savedLayout])

  // ── Drag with localStorage persistence ───────────────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes(prev => {
      const next = applyNodeChanges(changes, prev)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const layout: Record<string, { x: number; y: number }> = {}
        next.forEach(n => { layout[n.id] = n.position })
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* ignore */ }
      }, 800)
      return next
    })
  }, [])

  const onNodeClick: NodeMouseHandler = (_, node) => {
    setSelectedEdgeId(null)
    setSelectedId(id => id === node.id ? null : node.id)
  }

  const onNodeDoubleClick: NodeMouseHandler = (_, node) => {
    navigate(`/devices/${node.id}`)
  }

  const onEdgeClick = useCallback((e: React.MouseEvent, edge: Edge) => {
    setSelectedId(null)
    setSelectedEdgeId(prev => {
      if (prev === edge.id) { setEdgePanelPos(null); return null }
      setEdgePanelPos({ x: e.clientX, y: e.clientY })
      return edge.id
    })
  }, [])

  const selectedNode = selectedId ? nodesById[selectedId] : null
  const toggleType   = (t: string) =>
    setHiddenTypes(s => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n })

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-slate-400 text-sm">Loading topology…</div>
  }

  const Pill = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border ${
        active ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
      }`}
    >
      {children}
    </button>
  )

  const hasUtilData = Object.keys(utilBatch ?? {}).length > 0

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      <style>{`
        @keyframes topoEdgeDash { to { stroke-dashoffset: -22; } }
        @keyframes alertPulse {
          0%, 100% { box-shadow: 0 0 0 2px white, 0 0 0 4px transparent; }
          50%       { box-shadow: 0 0 0 2px white, 0 0 0 5px #dc262660; }
        }
      `}</style>

      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-slate-200 bg-white shrink-0 z-10">
        {/* Mobile row: title + refresh */}
        <div className="flex items-center justify-between mb-1.5 md:hidden">
          <div>
            <span className="text-sm font-semibold text-slate-800">Topology</span>
            <span className="ml-2 text-xs text-slate-400">{rfNodes.length}n · {rfEdges.length}l</span>
          </div>
          <button onClick={() => refetch()} disabled={isFetching} className="p-1.5 text-blue-600 disabled:opacity-50">
            <svg className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9" />
            </svg>
          </button>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-800 mr-1 hidden md:inline">Topology</span>
          <span className="text-xs text-slate-400 hidden md:inline">
            {rfNodes.length} node{rfNodes.length !== 1 ? 's' : ''} · {rfEdges.length} link{rfEdges.length !== 1 ? 's' : ''}
          </span>
          <div className="hidden md:block h-4 w-px bg-slate-200" />

          {/* Search */}
          <div className="relative">
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              className={`pl-6 pr-2 py-1 rounded-lg text-xs border transition-colors w-28 focus:w-40 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                search ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white'
              }`}
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>

          {/* Protocol filter */}
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {(['all', 'lldp', 'cdp'] as const).map(p => (
              <button key={p} onClick={() => setProtocol(p)}
                className={`px-2 py-1 text-xs font-medium transition-colors ${
                  protocolFilter === p
                    ? p === 'lldp' ? 'bg-cyan-600 text-white'
                      : p === 'cdp' ? 'bg-violet-600 text-white'
                      : 'bg-slate-800 text-white'
                    : 'bg-white text-slate-500 hover:bg-slate-50'
                } ${p !== 'all' ? 'border-l border-slate-200' : ''}`}
              >
                {p === 'all' ? 'All' : p.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Device type filter */}
          <div className="relative">
            <button onClick={() => setTypeMenuOpen(o => !o)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                hiddenTypes.size > 0 ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
              }`}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 6h16M8 12h8M11 18h2"/></svg>
              <span className="hidden sm:inline">Types</span>
              {hiddenTypes.size > 0 && <span className="bg-blue-600 text-white rounded-full px-1 text-[10px]">{hiddenTypes.size}</span>}
            </button>
            {typeMenuOpen && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-2 min-w-[160px]"
                onMouseLeave={() => setTypeMenuOpen(false)}>
                {deviceTypes.map(t => (
                  <label key={t} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => toggleType(t)} className="rounded border-slate-300 text-blue-600"/>
                    <span style={{ color: TYPE_COLOR[t] ?? '#475569', opacity: hiddenTypes.has(t) ? 0.3 : 1 }}><DeviceTypeIcon type={t} size={13}/></span>
                    <span className="text-xs text-slate-600 capitalize">{(t ?? 'unknown').replace('_', ' ')}</span>
                  </label>
                ))}
                {hiddenTypes.size > 0 && (
                  <button onClick={() => setHiddenTypes(new Set())} className="w-full text-left px-3 py-1.5 text-xs text-blue-600 hover:bg-slate-50 border-t border-slate-100 mt-1">Show all</button>
                )}
              </div>
            )}
          </div>

          <Pill active={showLabels} onClick={() => setShowLabels(v => !v)}>
            <span className="hidden sm:inline">{showLabels ? 'Labels on' : 'Labels off'}</span>
            <span className="sm:hidden">Lbl</span>
          </Pill>
          <Pill active={showIsolated} onClick={() => setShowIsolated(v => !v)}>
            <span className="hidden sm:inline">{showIsolated ? 'All devices' : 'Connected only'}</span>
            <span className="sm:hidden">All</span>
          </Pill>

          {/* Util legend toggle */}
          {hasUtilData && (
            <Pill active={showUtilLegend} onClick={() => setShowUtilLegend(v => !v)}>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'linear-gradient(90deg,#16a34a,#d97706,#dc2626)' }} />
                <span className="hidden sm:inline">Util</span>
              </span>
            </Pill>
          )}

          {/* Reset layout */}
          <button
            onClick={() => {
              try { localStorage.removeItem(LAYOUT_KEY) } catch { /* ignore */ }
              if (data) {
                const visible = data.nodes.filter(n => !hiddenTypes.has(n.device_type) && (showIsolated || n.connected))
                const pos = hierLayout(visible, data.edges)
                setRfNodes(prev => prev.map(n => ({ ...n, position: pos[n.id] ?? n.position })))
              }
            }}
            title="Reset layout to auto-computed positions"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-500 hover:border-slate-400 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
            <span className="hidden sm:inline">Reset</span>
          </button>

          <div className="flex-1 hidden md:block"/>
          <button onClick={() => refetch()} disabled={isFetching}
            className="hidden md:flex items-center gap-1.5 text-xs text-blue-600 hover:underline disabled:opacity-50">
            <svg className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9"/>
            </svg>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {/* Util legend row */}
        {showUtilLegend && (
          <div className="mt-2">
            <UtilLegend />
          </div>
        )}

        {/* Search result count */}
        {searchMatchIds !== null && (
          <div className="mt-1.5 text-xs text-slate-500">
            {searchMatchIds.size === 0
              ? <span className="text-red-500">No devices match "{search}"</span>
              : <span>{searchMatchIds.size} device{searchMatchIds.size !== 1 ? 's' : ''} matched</span>
            }
          </div>
        )}
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        {rfNodes.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-slate-400 text-sm mb-1">No topology data yet.</p>
              <p className="text-slate-300 text-xs">LLDP/CDP neighbours are collected on each poll cycle.</p>
            </div>
          </div>
        ) : (
          <>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={() => {
                setSelectedId(null)
                setSelectedEdgeId(null)
                setEdgePanelPos(null)
                setTypeMenuOpen(false)
              }}
              fitView
              fitViewOptions={{ padding: 0.22 }}
              minZoom={0.1}
              maxZoom={2.5}
              proOptions={{ hideAttribution: true }}
              elevateEdgesOnSelect
            >
              <Controls showFitView={false} />
              <Panel position="top-right" className="flex gap-1.5 mt-1 mr-1">
                <FitBtn />
              </Panel>
              <MiniMap
                nodeColor={n => TYPE_COLOR[(n.data as unknown as TopologyNode)?.device_type] ?? '#475569'}
                pannable zoomable
                className="rounded-xl shadow-md border border-slate-200"
              />
              <Background color="#dde3eb" gap={30} size={1.5} />
            </ReactFlow>

            {selectedNode && (
              <DevicePanel
                node={selectedNode}
                edges={data?.edges ?? []}
                nodesById={nodesById}
                onClose={() => setSelectedId(null)}
                onNavigate={id => navigate(`/devices/${id}`)}
              />
            )}
            {selectedEdgeId && edgePanelPos && (() => {
              const edge = data?.edges.find(e => e.id === selectedEdgeId)
              return edge ? (
                <LinkPanel
                  edge={edge}
                  nodesById={nodesById}
                  clickPos={edgePanelPos}
                  onClose={() => { setSelectedEdgeId(null); setEdgePanelPos(null) }}
                  onNavigate={id => navigate(`/devices/${id}`)}
                />
              ) : null
            })()}

            {/* Hint */}
            <div className="absolute bottom-14 left-1/2 -translate-x-1/2 text-[10px] text-slate-400 pointer-events-none">
              Click node to inspect · Double-click to open · Click link for bandwidth
            </div>
          </>
        )}
      </div>
    </div>
  )
}
