import { useState, useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  ReactFlow, Controls, Background, MiniMap,
  useNodesState, useEdgesState,
  Handle, Position,
  type NodeProps, type Node, type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { fetchTopology, type TopologyNode } from '../api/topology'

// ── Colours by device type ─────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  router:              '#2563eb',
  switch:              '#16a34a',
  access_point:        '#7c3aed',
  firewall:            '#dc2626',
  wireless_controller: '#7c3aed',
  unknown:             '#475569',
}

const TYPE_ICON: Record<string, string> = {
  router:              'R',
  switch:              'SW',
  access_point:        'AP',
  firewall:            'FW',
  wireless_controller: 'WC',
  unknown:             '?',
}

const STATUS_COLOR: Record<string, string> = {
  up:          '#16a34a',
  down:        '#dc2626',
  unreachable: '#f97316',
  unknown:     '#94a3b8',
}

// ── Custom node ────────────────────────────────────────────────────────────

const centerHandle: React.CSSProperties = {
  opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1,
  top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
}

function DeviceNode({ data }: NodeProps) {
  const d = data as unknown as TopologyNode & { onClick: () => void }
  const color = TYPE_COLOR[d.device_type] ?? '#475569'
  const statusDot = STATUS_COLOR[d.status] ?? '#94a3b8'

  return (
    <div onClick={d.onClick}
      className="rounded-2xl bg-white border-2 shadow-md w-36 text-center cursor-pointer hover:shadow-lg transition-shadow"
      style={{ borderColor: color }}>
      <Handle type="source" position={Position.Right} style={centerHandle} />
      <Handle type="target" position={Position.Left} style={centerHandle} />

      <div className="px-3 pt-3 pb-2">
        <div className="text-xs font-bold mb-1" style={{ color }}>
          {TYPE_ICON[d.device_type] ?? '?'}
        </div>
        <div className="text-xs font-semibold text-slate-800 truncate">{d.hostname}</div>
        <div className="text-[10px] text-slate-400 font-mono mt-0.5">{d.mgmt_ip}</div>
      </div>
      <div className="border-t px-3 py-1.5 flex items-center justify-between"
        style={{ borderColor: `${color}30`, backgroundColor: `${color}08` }}>
        <span className="text-[10px] text-slate-400 capitalize">{d.device_type.replace('_', ' ')}</span>
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusDot }} />
      </div>
    </div>
  )
}

const NODE_TYPES = { device: DeviceNode }

// ── Layout: force-directed approximation (grid + push apart) ──────────────

function layoutNodes(nodes: TopologyNode[], edges: { source: string; target: string }[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {}
  const n = nodes.length
  if (n === 0) return pos

  // Start with a grid
  const cols = Math.ceil(Math.sqrt(n))
  nodes.forEach((node, i) => {
    pos[node.id] = {
      x: (i % cols) * 260,
      y: Math.floor(i / cols) * 220,
    }
  })

  // Simple spring iterations
  const adj: Record<string, Set<string>> = {}
  nodes.forEach(n => { adj[n.id] = new Set() })
  edges.forEach(e => {
    adj[e.source]?.add(e.target)
    adj[e.target]?.add(e.source)
  })

  for (let iter = 0; iter < 50; iter++) {
    const force: Record<string, { x: number; y: number }> = {}
    nodes.forEach(n => { force[n.id] = { x: 0, y: 0 } })

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        const dx = pos[b.id].x - pos[a.id].x
        const dy = pos[b.id].y - pos[a.id].y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const rep = 20000 / (dist * dist)
        force[a.id].x -= (dx / dist) * rep
        force[a.id].y -= (dy / dist) * rep
        force[b.id].x += (dx / dist) * rep
        force[b.id].y += (dy / dist) * rep
      }
    }

    // Attraction along edges
    edges.forEach(e => {
      if (!pos[e.source] || !pos[e.target]) return
      const dx = pos[e.target].x - pos[e.source].x
      const dy = pos[e.target].y - pos[e.source].y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const att = dist * 0.01
      force[e.source].x += (dx / dist) * att
      force[e.source].y += (dy / dist) * att
      force[e.target].x -= (dx / dist) * att
      force[e.target].y -= (dy / dist) * att
    })

    // Apply with damping
    const damp = 0.1
    nodes.forEach(n => {
      pos[n.id].x += force[n.id].x * damp
      pos[n.id].y += force[n.id].y * damp
    })
  }

  return pos
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const navigate = useNavigate()
  const [showIsolated, setShowIsolated] = useState(false)

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['topology'],
    queryFn: fetchTopology,
    staleTime: 30_000,
  })

  const rfNodes: Node[] = useMemo(() => {
    if (!data) return []
    const visible = showIsolated ? data.nodes : data.nodes.filter(n => n.connected)
    const pos = layoutNodes(visible, data.edges)
    return visible.map(n => ({
      id:       n.id,
      type:     'device',
      position: pos[n.id] ?? { x: 0, y: 0 },
      data:     { ...n, onClick: () => navigate(`/devices/${n.id}`) } as unknown as Record<string, unknown>,
      draggable: true,
    }))
  }, [data, showIsolated, navigate])

  const rfEdges: Edge[] = useMemo(() => {
    if (!data) return []
    const nodeIds = new Set(rfNodes.map(n => n.id))
    return data.edges
      .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map(e => ({
        id:     e.id,
        source: e.source,
        target: e.target,
        type:   'straight',
        label:  e.source_port && e.target_port
          ? `${e.source_port} → ${e.target_port}`
          : e.source_port ?? e.target_port ?? '',
        labelStyle:   { fontSize: 9, fill: '#64748b' },
        labelBgStyle: { fill: 'white', fillOpacity: 0.85 },
        labelBgPadding: [4, 3] as [number, number],
        style: { stroke: e.protocol === 'lldp' ? '#0891b2' : '#7c3aed', strokeWidth: 1.5 },
      }))
  }, [data, rfNodes])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        Loading topology…
      </div>
    )
  }

  const connectedCount = data?.nodes.filter(n => n.connected).length ?? 0
  const edgeCount = data?.edges.length ?? 0

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Topology</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {connectedCount} devices · {edgeCount} links
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={showIsolated} onChange={e => setShowIsolated(e.target.checked)}
              className="rounded border-slate-300 text-blue-600" />
            Show isolated devices
          </label>
          {/* Legend */}
          <div className="flex items-center gap-3 text-xs text-slate-400 border-l pl-3">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block bg-cyan-600"/>LLDP</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block bg-violet-600"/>CDP</span>
          </div>
          <button onClick={() => refetch()} disabled={isFetching}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50">
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 relative">
        {rfNodes.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-slate-400 text-sm mb-2">No topology data yet.</p>
              <p className="text-slate-300 text-xs">LLDP/CDP neighbours are collected on each poll cycle.</p>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Controls />
            <MiniMap nodeColor={n => {
              const d = n.data as unknown as TopologyNode
              return TYPE_COLOR[d?.device_type] ?? '#475569'
            }} pannable zoomable />
            <Background color="#e2e8f0" gap={20} />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
