/**
 * Shared network device type icons.
 * Use everywhere a device_type needs a visual indicator.
 */

interface IconProps {
  size?: number
  className?: string
  style?: React.CSSProperties
}

const base = (size = 20) => ({
  width:  size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

// Classic Cisco-style router: cylinder drum + routing arrow
export function RouterIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Cylinder top */}
      <ellipse cx="12" cy="7" rx="8" ry="2.5"/>
      {/* Cylinder sides */}
      <line x1="4" y1="7" x2="4" y2="17"/>
      <line x1="20" y1="7" x2="20" y2="17"/>
      {/* Cylinder bottom */}
      <ellipse cx="12" cy="17" rx="8" ry="2.5"/>
      {/* Routing arrow through center */}
      <path d="M8 12h8M14 10l2 2-2 2"/>
    </svg>
  )
}

// Flat 1U switch with visible port rectangles
export function SwitchIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* 1U chassis body */}
      <rect x="2" y="8" width="20" height="8" rx="1.5"/>
      {/* Port slots */}
      <rect x="4"  y="10.5" width="2.2" height="3" rx="0.5"/>
      <rect x="7"  y="10.5" width="2.2" height="3" rx="0.5"/>
      <rect x="10" y="10.5" width="2.2" height="3" rx="0.5"/>
      <rect x="13" y="10.5" width="2.2" height="3" rx="0.5"/>
      <rect x="16" y="10.5" width="2.2" height="3" rx="0.5"/>
      {/* Status LED */}
      <circle cx="20" cy="12" r="0.8" fill="currentColor" stroke="none"/>
    </svg>
  )
}

// Ceiling-mount AP: circular body + wifi arcs radiating up
export function AccessPointIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* WiFi arcs (upward) */}
      <path d="M8.5 9.5a5 5 0 0 1 7 0"/>
      <path d="M5.5 6.5a10 10 0 0 1 13 0"/>
      {/* AP body dot */}
      <circle cx="12" cy="13" r="2" fill="currentColor" stroke="none"/>
      {/* Mount stem + base */}
      <path d="M12 15v3M9 18h6"/>
    </svg>
  )
}

// Shield with padlock — unmistakably a firewall
export function FirewallIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Shield outline */}
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      {/* Lock body */}
      <rect x="9" y="12.5" width="6" height="4.5" rx="1"/>
      {/* Lock shackle */}
      <path d="M9.5 12.5V11a2.5 2.5 0 0 1 5 0v1.5"/>
    </svg>
  )
}

// 1U rack with antenna + wifi arc on panel
export function WirelessControllerIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* 1U rack body */}
      <rect x="2" y="8" width="20" height="9" rx="2"/>
      {/* Antenna */}
      <path d="M17 8V4.5M15 4.5h4"/>
      {/* Port dots */}
      <circle cx="6"  cy="12.5" r="1" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="12.5" r="1" fill="currentColor" stroke="none"/>
      {/* WiFi arc on right side of panel */}
      <path d="M14 11a2.5 2.5 0 0 1 0 3"/>
    </svg>
  )
}

// Load balancer: single input → forked to two outputs
export function LoadBalancerIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Input */}
      <circle cx="5" cy="12" r="2"/>
      <path d="M7 12h3"/>
      {/* Fork */}
      <path d="M10 12l3-4h4"/>
      <path d="M10 12l3 4h4"/>
      {/* Outputs */}
      <circle cx="17" cy="8"  r="2"/>
      <circle cx="17" cy="16" r="2"/>
    </svg>
  )
}

// Generic device: server box with question mark
export function UnknownDeviceIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <rect x="3" y="5" width="18" height="14" rx="2"/>
      <path d="M3 10h18"/>
      <path d="M9.5 14a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 2"/>
      <circle cx="12" cy="17.5" r=".6" fill="currentColor" stroke="none"/>
    </svg>
  )
}

// Cloud / internet node (used in topology only)
export function CloudIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
    </svg>
  )
}

// ── Convenience map ────────────────────────────────────────────────────────

export const DEVICE_TYPE_COLOR: Record<string, string> = {
  router:              '#2563eb',
  switch:              '#16a34a',
  access_point:        '#7c3aed',
  firewall:            '#dc2626',
  wireless_controller: '#0891b2',
  load_balancer:       '#f59e0b',
  cloud:               '#64748b',
  unknown:             '#64748b',
}

export const DEVICE_TYPE_LABEL: Record<string, string> = {
  router:              'Router',
  switch:              'Switch',
  access_point:        'Access Point',
  firewall:            'Firewall',
  wireless_controller: 'Wireless Controller',
  load_balancer:       'Load Balancer',
  cloud:               'Internet / WAN',
  unknown:             'Unknown',
}

export function DeviceTypeIcon({ type, size, className, style }: { type: string } & IconProps) {
  const props = { size, className, style }
  switch (type) {
    case 'router':              return <RouterIcon {...props} />
    case 'switch':              return <SwitchIcon {...props} />
    case 'access_point':        return <AccessPointIcon {...props} />
    case 'firewall':            return <FirewallIcon {...props} />
    case 'wireless_controller': return <WirelessControllerIcon {...props} />
    case 'load_balancer':       return <LoadBalancerIcon {...props} />
    case 'cloud':               return <CloudIcon {...props} />
    default:                    return <UnknownDeviceIcon {...props} />
  }
}

export default DeviceTypeIcon
