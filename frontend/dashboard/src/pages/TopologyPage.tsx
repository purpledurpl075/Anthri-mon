import React, { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  ReactFlow, Controls, Background, MiniMap,
  Handle, Position,
  type NodeProps, type Node, type Edge, type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { fetchTopology, type TopologyNode, type TopologyEdge } from '../api/topology'

// ── Colours & icons ────────────────────────────────────────────────────────

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

const TYPE_LABEL: Record<string, string> = {
  router:              'Router',
  switch:              'Switch',
  access_point:        'Access Point',
  firewall:            'Firewall',
  wireless_controller: 'Wireless Controller',
  unknown:             'Unknown',
}

const STATUS_COLOR: Record<string, string> = {
  up:          '#16a34a',
  down:        '#dc2626',
  unreachable: '#f97316',
  unknown:     '#94a3b8',
}

const STATUS_LABEL: Record<string, string> = {
  up:          'Up',
  down:        'Down',
  unreachable: 'Unreachable',
  unknown:     'Unknown',
}

const centerHandle: React.CSSProperties = {
  opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1,
  top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
}

// ── Device node ────────────────────────────────────────────────────────────

function DeviceNode({ data, selected }: NodeProps) {
  const d = data as unknown as TopologyNode
  const color = TYPE_COLOR[d.device_type] ?? '#475569'
  const statusDot = STATUS_COLOR[d.status] ?? '#94a3b8'

  return (
    <div
      className="rounded-2xl bg-white shadow-md w-36 text-center transition-all"
      style={{
        border: `2px solid ${selected ? color : `${color}88`}`,
        boxShadow: selected ? `0 0 0 3px ${color}33, 0 4px 12px rgba(0,0,0,0.12)` : undefined,
      }}
    >
      <Handle type="source" position={Position.Right} style={centerHandle} />
      <Handle type="target" position={Position.Left} style={centerHandle} />

      <div className="px-3 pt-3 pb-2">
        <div className="text-xs font-bold mb-1.5" style={{ color }}>
          {TYPE_ICON[d.device_type] ?? '?'}
        </div>
        <div className="text-xs font-semibold text-slate-800 truncate leading-tight">{d.hostname}</div>
        <div className="text-[10px] text-slate-400 font-mono mt-0.5">{d.mgmt_ip}</div>
      </div>
      <div className="border-t px-3 py-1.5 flex items-center justify-between rounded-b-2xl"
        style={{ borderColor: `${color}30`, backgroundColor: `${color}08` }}>
        <span className="text-[10px] text-slate-400 capitalize">{(d.device_type ?? 'unknown').replace('_', ' ')}</span>
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusDot }} title={STATUS_LABEL[d.status] ?? d.status} />
      </div>
    </div>
  )
}

const NODE_TYPES = { device: DeviceNode }

// ── Device detail panel ────────────────────────────────────────────────────

function DevicePanel({
  node,
  edges,
  nodesById,
  onClose,
  onNavigate,
}: {
  node: TopologyNode
  edges: TopologyEdge[]
  nodesById: Record<string, TopologyNode>
  onClose: () => void
  onNavigate: (id: string) => void
}) {
  const color = TYPE_COLOR[node.device_type] ?? '#475569'
  const statusColor = STATUS_COLOR[node.status] ?? '#94a3b8'

  // Edges connected to this node
  const links = edges.filter(e => e.source === node.id || e.target === node.id).map(e => {
    const isSource = e.source === node.id
    const peerId   = isSource ? e.target : e.source
    const peer     = nodesById[peerId]
    const localPort  = isSource ? e.source_port : e.target_port
    const remotePort = isSource ? e.target_port : e.source_port
    return { peer, localPort, remotePort, protocol: e.protocol }
  })

  return (
    <div className="absolute top-4 right-4 w-72 bg-white rounded-2xl shadow-xl border border-slate-200 z-10 flex flex-col overflow-hidden"
      style={{ maxHeight: 'calc(100% - 2rem)' }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-start justify-between"
        style={{ borderBottom: `3px solid ${color}` }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-bold" style={{ color }}>{TYPE_ICON[node.device_type] ?? '?'}</span>
            <span className="text-xs text-slate-400">{TYPE_LABEL[node.device_type] ?? 'Unknown'}</span>
          </div>
          <h3 className="text-sm font-bold text-slate-800 truncate">{node.hostname}</h3>
        </div>
        <button onClick={onClose}
          className="ml-2 p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      {/* Details */}
      <div className="px-4 py-3 space-y-2 overflow-y-auto flex-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Status</span>
          <span className="flex items-center gap-1.5 font-medium" style={{ color: statusColor }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
            {STATUS_LABEL[node.status] ?? node.status}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Management IP</span>
          <span className="font-mono text-slate-700">{node.mgmt_ip}</span>
        </div>
        {node.vendor && node.vendor !== 'unknown' && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Vendor</span>
            <span className="text-slate-700 capitalize">{node.vendor.replace('_', ' ')}</span>
          </div>
        )}

        {/* Links */}
        {links.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
              {links.length} link{links.length !== 1 ? 's' : ''}
            </p>
            <div className="space-y-2">
              {links.map((l, i) => (
                <button key={i} onClick={() => l.peer && onNavigate(l.peer.id)}
                  disabled={!l.peer}
                  className="w-full text-left rounded-lg border border-slate-100 px-3 py-2 hover:border-slate-300 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-700 truncate">
                      {l.peer?.hostname ?? 'Unknown device'}
                    </span>
                    <span className={`text-[9px] font-medium px-1 py-0.5 rounded text-white shrink-0 ${l.protocol === 'lldp' ? 'bg-cyan-600' : 'bg-violet-600'}`}>
                      {l.protocol.toUpperCase()}
                    </span>
                  </div>
                  {(l.localPort || l.remotePort) && (
                    <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                      {l.localPort ?? '—'} → {l.remotePort ?? '—'}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-100">
        <button onClick={() => onNavigate(node.id)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
          Open device
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

// ── Layout ─────────────────────────────────────────────────────────────────

function layoutNodes(nodes: TopologyNode[], edges: { source: string; target: string }[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {}
  if (nodes.length === 0) return pos

  const cols = Math.ceil(Math.sqrt(nodes.length))
  nodes.forEach((node, i) => {
    pos[node.id] = { x: (i % cols) * 280, y: Math.floor(i / cols) * 230 }
  })

  for (let iter = 0; iter < 60; iter++) {
    const force: Record<string, { x: number; y: number }> = {}
    nodes.forEach(n => { force[n.id] = { x: 0, y: 0 } })

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        const dx = pos[b.id].x - pos[a.id].x
        const dy = pos[b.id].y - pos[a.id].y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const rep = 22000 / (dist * dist)
        force[a.id].x -= (dx / dist) * rep
        force[a.id].y -= (dy / dist) * rep
        force[b.id].x += (dx / dist) * rep
        force[b.id].y += (dy / dist) * rep
      }
    }

    edges.forEach(e => {
      if (!pos[e.source] || !pos[e.target]) return
      const dx = pos[e.target].x - pos[e.source].x
      const dy = pos[e.target].y - pos[e.source].y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const att = dist * 0.012
      force[e.source].x += (dx / dist) * att
      force[e.source].y += (dy / dist) * att
      force[e.target].x -= (dx / dist) * att
      force[e.target].y -= (dy / dist) * att
    })

    nodes.forEach(n => {
      pos[n.id].x += force[n.id].x * 0.1
      pos[n.id].y += force[n.id].y * 0.1
    })
  }

  return pos
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const navigate   = useNavigate()
  const [showIsolated, setShowIsolated] = useState(false)
  const [selectedId, setSelectedId]     = useState<string | null>(null)

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['topology'],
    queryFn: fetchTopology,
    staleTime: 30_000,
  })

  const nodesById = useMemo<Record<string, TopologyNode>>(() =>
    Object.fromEntries((data?.nodes ?? []).map(n => [n.id, n])),
    [data]
  )

  const rfNodes: Node[] = useMemo(() => {
    if (!data) return []
    const visible = showIsolated ? data.nodes : data.nodes.filter(n => n.connected)
    const pos = layoutNodes(visible, data.edges)
    return visible.map(n => ({
      id:        n.id,
      type:      'device',
      position:  pos[n.id] ?? { x: 0, y: 0 },
      selected:  n.id === selectedId,
      data:      n as unknown as Record<string, unknown>,
      draggable: true,
    }))
  }, [data, showIsolated, selectedId])

  const rfEdges: Edge[] = useMemo(() => {
    if (!data) return []
    const nodeIds = new Set(rfNodes.map(n => n.id))
    return data.edges
      .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map(e => {
        const isAdj = selectedId && (e.source === selectedId || e.target === selectedId)
        return {
          id:     e.id,
          source: e.source,
          target: e.target,
          type:   'straight',
          label:  e.source_port && e.target_port
            ? `${e.source_port} → ${e.target_port}`
            : e.source_port ?? e.target_port ?? '',
          labelStyle:     { fontSize: 9, fill: '#64748b' },
          labelBgStyle:   { fill: 'white', fillOpacity: 0.85 },
          labelBgPadding: [4, 3] as [number, number],
          style: {
            stroke:      isAdj
              ? (e.protocol === 'lldp' ? '#0891b2' : '#7c3aed')
              : '#cbd5e1',
            strokeWidth: isAdj ? 2.5 : 1.5,
            opacity:     selectedId && !isAdj ? 0.3 : 1,
          },
        }
      })
  }, [data, rfNodes, selectedId])

  const onNodeClick: NodeMouseHandler = (_, node) => {
    setSelectedId(id => id === node.id ? null : node.id)
  }

  const selectedNode = selectedId ? nodesById[selectedId] : null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        Loading topology…
      </div>
    )
  }

  const connectedCount = data?.nodes.filter(n => n.connected).length ?? 0

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Topology</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {connectedCount} devices · {data?.edges.length ?? 0} links
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={showIsolated} onChange={e => setShowIsolated(e.target.checked)}
              className="rounded border-slate-300 text-blue-600" />
            Show isolated
          </label>
          <div className="flex items-center gap-3 text-xs text-slate-400 border-l pl-3">
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 inline-block bg-cyan-600 rounded"/>LLDP
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 inline-block bg-violet-600 rounded"/>CDP
            </span>
          </div>
          <button onClick={() => refetch()} disabled={isFetching}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50">
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        {rfNodes.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-slate-400 text-sm mb-2">No topology data yet.</p>
              <p className="text-slate-300 text-xs">LLDP/CDP neighbours are collected on each poll cycle.</p>
            </div>
          </div>
        ) : (
          <>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={NODE_TYPES}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedId(null)}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Controls />
              <MiniMap
                nodeColor={n => TYPE_COLOR[(n.data as unknown as TopologyNode)?.device_type] ?? '#475569'}
                pannable zoomable
              />
              <Background color="#e2e8f0" gap={20} />
            </ReactFlow>

            {/* Device popup panel */}
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
