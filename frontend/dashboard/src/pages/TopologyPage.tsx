import React, { useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  ReactFlow, Controls, Background, MiniMap, Panel, useReactFlow,
  EdgeLabelRenderer, getSmoothStepPath, applyNodeChanges,
  Handle, Position,
  type NodeProps, type Node, type Edge, type EdgeProps,
  type NodeMouseHandler, type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { fetchTopology, type TopologyNode, type TopologyEdge as ApiEdge } from '../api/topology'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR as TYPE_COLOR, DEVICE_TYPE_LABEL as TYPE_LABEL } from '../components/DeviceTypeIcon'

// ── Palette ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  up:          '#16a34a',
  down:        '#dc2626',
  unreachable: '#f97316',
  unknown:     '#94a3b8',
}
const STATUS_LABEL: Record<string, string> = {
  up: 'Up', down: 'Down', unreachable: 'Unreachable', unknown: 'Unknown',
}

// ── Layout constants ───────────────────────────────────────────────────────

const NODE_W  = 160   // matches rendered node width
const H_STEP  = 240   // center-to-center horizontal spacing in a layer
const V_STEP  = 190   // center-to-center vertical spacing between layers

// Root-election priority per device type (higher = preferred as hierarchy root)
const ROOT_PRIO: Record<string, number> = {
  router: 5, firewall: 5, load_balancer: 4,
  switch: 3, wireless_controller: 2, access_point: 0, unknown: 1,
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

  // BFS from highest-scoring unvisited node → one component per iteration
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

    // Minimise crossings: sort each layer by average parent index
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

// ── Determine which handles an edge should use ─────────────────────────────

type HandleSide = 'top' | 'bottom' | 'left' | 'right'

function edgeHandles(
  src?: { x: number; y: number },
  tgt?: { x: number; y: number },
): { sh: HandleSide; th: HandleSide; sp: Position; tp: Position } {
  if (!src || !tgt) return { sh: 'bottom', th: 'top', sp: Position.Bottom, tp: Position.Top }
  const dx = tgt.x - src.x
  const dy = tgt.y - src.y
  // Prefer vertical routing (network hierarchies read top→bottom)
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

function DeviceNode({ data, selected }: NodeProps) {
  const d = data as unknown as TopologyNode
  const color  = TYPE_COLOR[d.device_type] ?? '#475569'
  const sc     = STATUS_COLOR[d.status] ?? '#94a3b8'

  return (
    <div style={{ width: NODE_W }}>
      <Handle id="top"    type="source" position={Position.Top}    style={H} />
      <Handle id="top"    type="target" position={Position.Top}    style={H} />
      <Handle id="bottom" type="source" position={Position.Bottom} style={H} />
      <Handle id="bottom" type="target" position={Position.Bottom} style={H} />
      <Handle id="left"   type="source" position={Position.Left}   style={H} />
      <Handle id="left"   type="target" position={Position.Left}   style={H} />
      <Handle id="right"  type="source" position={Position.Right}  style={H} />
      <Handle id="right"  type="target" position={Position.Right}  style={H} />

      <div
        className="rounded-xl bg-white transition-shadow"
        style={{
          border:     `1.5px solid ${selected ? color : '#e2e8f0'}`,
          boxShadow:  selected
            ? `0 0 0 3px ${color}22, 0 6px 20px rgba(0,0,0,0.10)`
            : '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
        }}
      >
        {/* Coloured accent bar */}
        <div style={{ height: 3, backgroundColor: color, borderRadius: '8px 8px 0 0' }} />

        {/* Body */}
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

        {/* Footer */}
        <div
          className="px-3 py-1 border-t text-[9px] text-slate-400 capitalize rounded-b-xl"
          style={{ borderColor: `${color}20`, backgroundColor: `${color}07` }}
        >
          {TYPE_LABEL[d.device_type] ?? 'Unknown'}
        </div>
      </div>
    </div>
  )
}

const NODE_TYPES = { device: DeviceNode }

// ── Edge ───────────────────────────────────────────────────────────────────

function TopologyEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, selected,
}: EdgeProps) {
  const d       = data as { label?: string; protocol?: string; highlighted?: boolean; dimmed?: boolean }
  const isLLDP  = d.protocol === 'lldp'
  const color   = isLLDP ? '#0891b2' : '#7c3aed'
  const dimmed  = !!d.dimmed
  const hilit   = !!d.highlighted || selected

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 14,
    offset: 28,
  })

  return (
    <>
      {hilit && (
        <path d={path} fill="none" stroke={color} strokeWidth={12} strokeOpacity={0.12} strokeLinecap="round" />
      )}
      {/* White knockout track so lines stay visible over the grid */}
      <path
        d={path} fill="none" stroke="white"
        strokeWidth={hilit ? 5 : 3.5}
        strokeOpacity={dimmed ? 0 : 0.65}
        strokeLinecap="round"
      />
      <path
        id={id} d={path} fill="none"
        stroke={color}
        strokeWidth={hilit ? 2.5 : 1.5}
        strokeOpacity={dimmed ? 0.08 : 1}
        strokeLinecap="round"
        strokeDasharray={hilit ? '7 4' : undefined}
        style={{
          animation:  hilit ? 'topoEdgeDash 1s linear infinite' : undefined,
          transition: 'stroke-opacity 0.15s, stroke-width 0.15s',
        }}
      />
      {d.label && !dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'none',
            }}
          >
            <span className="text-[9px] font-mono text-slate-500 bg-white border border-slate-200 rounded px-1.5 py-0.5 shadow-sm leading-none whitespace-nowrap">
              {d.label}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const EDGE_TYPES = { topology: TopologyEdge }

// ── Detail panel ───────────────────────────────────────────────────────────

function DevicePanel({
  node, edges, nodesById, onClose, onNavigate,
}: {
  node: TopologyNode
  edges: ApiEdge[]
  nodesById: Record<string, TopologyNode>
  onClose: () => void
  onNavigate: (id: string) => void
}) {
  const color  = TYPE_COLOR[node.device_type] ?? '#475569'
  const sc     = STATUS_COLOR[node.status]    ?? '#94a3b8'

  const links = edges
    .filter(e => e.source === node.id || e.target === node.id)
    .map(e => {
      const isSrc   = e.source === node.id
      const peerId  = isSrc ? e.target : e.source
      const peer    = nodesById[peerId]
      const lp      = isSrc ? e.source_port : e.target_port
      const rp      = isSrc ? e.target_port : e.source_port
      return { peer, lp, rp, protocol: e.protocol }
    })

  return (
    <div
      className="absolute top-4 right-4 w-72 bg-white rounded-2xl shadow-xl border border-slate-200 z-10 flex flex-col overflow-hidden"
      style={{ maxHeight: 'calc(100% - 2rem)' }}
    >
      {/* Header */}
      <div className="px-4 py-3 flex items-start justify-between" style={{ borderBottom: `3px solid ${color}` }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span style={{ color }}><DeviceTypeIcon type={node.device_type} size={15} /></span>
            <span className="text-xs text-slate-400">{TYPE_LABEL[node.device_type] ?? 'Unknown'}</span>
          </div>
          <h3 className="text-sm font-bold text-slate-800 truncate">{node.hostname}</h3>
        </div>
        <button
          onClick={onClose}
          className="ml-2 p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Details */}
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

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-100">
        <button
          onClick={() => onNavigate(node.id)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors"
        >
          Open device
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
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

// ── Page ───────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const navigate = useNavigate()
  const [selectedId,     setSelectedId]    = useState<string | null>(null)
  const [showIsolated,   setShowIsolated]  = useState(false)
  const [showLabels,     setShowLabels]    = useState(true)
  const [protocolFilter, setProtocol]      = useState<'all' | 'lldp' | 'cdp'>('all')
  const [hiddenTypes,    setHiddenTypes]   = useState<Set<string>>(new Set())
  const [typeMenuOpen,   setTypeMenuOpen]  = useState(false)

  const [rfNodes, setRfNodes] = useState<Node[]>([])
  const [rfEdges, setRfEdges] = useState<Edge[]>([])

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['topology'],
    queryFn:  fetchTopology,
    staleTime: 30_000,
  })

  const nodesById = Object.fromEntries((data?.nodes ?? []).map(n => [n.id, n]))
  const deviceTypes = [...new Set((data?.nodes ?? []).map(n => n.device_type))].filter(Boolean)

  // Recompute layout whenever topology data or filter changes.
  // Preserves user-dragged positions for nodes that already exist.
  useEffect(() => {
    if (!data) return

    const visible = data.nodes.filter(n =>
      !hiddenTypes.has(n.device_type) && (showIsolated || n.connected)
    )
    const pos     = hierLayout(visible, data.edges)
    const nodeIds = new Set(visible.map(n => n.id))

    setRfNodes(prev => {
      const prevById = Object.fromEntries(prev.map(n => [n.id, n]))
      return visible.map(n => ({
        id:       n.id,
        type:     'device',
        position: prevById[n.id]?.position ?? pos[n.id] ?? { x: 0, y: 0 },
        selected: n.id === selectedId,
        data:     n as unknown as Record<string, unknown>,
        draggable: true,
      }))
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
          return {
            id: e.id, source: e.source, target: e.target,
            sourceHandle: sh, targetHandle: th,
            type: 'topology',
            data: { label, protocol: e.protocol, highlighted: !!selectedId && isAdj, dimmed: !!selectedId && !isAdj },
          }
        })
    )
  }, [data, showIsolated, hiddenTypes, selectedId, protocolFilter, showLabels])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes(prev => applyNodeChanges(changes, prev))
  }, [])

  const onNodeClick: NodeMouseHandler = (_, node) =>
    setSelectedId(id => id === node.id ? null : node.id)

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

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Dash animation keyframe */}
      <style>{`@keyframes topoEdgeDash { to { stroke-dashoffset: -22; } }`}</style>

      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b border-slate-200 bg-white flex items-center gap-3 shrink-0 flex-wrap z-10">
        <div className="mr-1">
          <span className="text-sm font-semibold text-slate-800">Topology</span>
          <span className="ml-2 text-xs text-slate-400">
            {rfNodes.length} node{rfNodes.length !== 1 ? 's' : ''} · {rfEdges.length} link{rfEdges.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="h-4 w-px bg-slate-200" />

        {/* Protocol */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400">Protocol</span>
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {(['all', 'lldp', 'cdp'] as const).map(p => (
              <button key={p} onClick={() => setProtocol(p)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
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
        </div>

        <div className="h-4 w-px bg-slate-200" />

        {/* Device type filter */}
        <div className="relative">
          <button
            onClick={() => setTypeMenuOpen(o => !o)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
              hiddenTypes.size > 0 ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M4 6h16M8 12h8M11 18h2" />
            </svg>
            Types
            {hiddenTypes.size > 0 && (
              <span className="ml-0.5 bg-blue-600 text-white rounded-full px-1 text-[10px]">{hiddenTypes.size}</span>
            )}
          </button>
          {typeMenuOpen && (
            <div
              className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-2 min-w-[160px]"
              onMouseLeave={() => setTypeMenuOpen(false)}
            >
              {deviceTypes.map(t => (
                <label key={t} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                  <input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => toggleType(t)} className="rounded border-slate-300 text-blue-600" />
                  <span style={{ color: TYPE_COLOR[t] ?? '#475569', opacity: hiddenTypes.has(t) ? 0.3 : 1 }}>
                    <DeviceTypeIcon type={t} size={13} />
                  </span>
                  <span className="text-xs text-slate-600 capitalize">{(t ?? 'unknown').replace('_', ' ')}</span>
                </label>
              ))}
              {hiddenTypes.size > 0 && (
                <button onClick={() => setHiddenTypes(new Set())}
                  className="w-full text-left px-3 py-1.5 text-xs text-blue-600 hover:bg-slate-50 border-t border-slate-100 mt-1">
                  Show all
                </button>
              )}
            </div>
          )}
        </div>

        <div className="h-4 w-px bg-slate-200" />

        <Pill active={showLabels}  onClick={() => setShowLabels(v => !v)}>
          {showLabels ? 'Labels on' : 'Labels off'}
        </Pill>
        <Pill active={showIsolated} onClick={() => setShowIsolated(v => !v)}>
          {showIsolated ? 'All devices' : 'Connected only'}
        </Pill>

        <div className="flex-1" />
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline disabled:opacity-50"
        >
          <svg className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9" />
          </svg>
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
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
              onPaneClick={() => { setSelectedId(null); setTypeMenuOpen(false) }}
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
          </>
        )}
      </div>
    </div>
  )
}
