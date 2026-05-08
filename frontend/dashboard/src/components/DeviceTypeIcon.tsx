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

export function RouterIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Chassis */}
      <rect x="2" y="9" width="20" height="8" rx="2"/>
      {/* Uplink ports */}
      <path d="M6 9V6M10 9V5M14 9V5M18 9V6"/>
      {/* Status LEDs */}
      <circle cx="6"  cy="14" r="1" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="14" r="1" fill="currentColor" stroke="none"/>
      <circle cx="14" cy="14" r="1" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="14" r="1" fill="currentColor" stroke="none"/>
      {/* Downlink */}
      <path d="M12 17v2"/>
    </svg>
  )
}

export function SwitchIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Chassis — flatter than router */}
      <rect x="2" y="10" width="20" height="6" rx="1.5"/>
      {/* Dense port array going up */}
      <path d="M5 10V7M8 10V6M11 10V7M14 10V6M17 10V7M20 10V8"/>
      {/* Two downlink cables */}
      <path d="M6 16v2M18 16v2"/>
    </svg>
  )
}

export function AccessPointIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Vertical antenna stem */}
      <path d="M12 3.5v9.5"/>
      {/* Wireless arcs — inner */}
      <path d="M8.5 7a5 5 0 0 0 0 6"/>
      <path d="M15.5 7a5 5 0 0 1 0 6"/>
      {/* Wireless arcs — outer */}
      <path d="M5.5 4.5a10 10 0 0 0 0 11"/>
      <path d="M18.5 4.5a10 10 0 0 1 0 11"/>
      {/* Base mount */}
      <circle cx="12" cy="19" r="2" fill="currentColor" stroke="none"/>
      <path d="M12 13v4"/>
    </svg>
  )
}

export function FirewallIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Shield outline */}
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      {/* Checkmark = allowed/protected */}
      <path d="M9 12l2 2 4-4"/>
    </svg>
  )
}

export function WirelessControllerIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* 1U rack body */}
      <rect x="2" y="8" width="20" height="9" rx="2"/>
      {/* Antenna */}
      <path d="M17 8V5M19 5l-2-2M19 5l-2 2"/>
      {/* Ports */}
      <circle cx="7"  cy="12.5" r="1" fill="currentColor" stroke="none"/>
      <circle cx="11" cy="12.5" r="1" fill="currentColor" stroke="none"/>
      {/* WiFi arc on panel */}
      <path d="M14 11a2.5 2.5 0 0 1 0 3"/>
    </svg>
  )
}

export function LoadBalancerIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Arrow from single source to multiple targets */}
      <path d="M3 12h4"/>
      <path d="M7 12l3-4h7"/>
      <path d="M7 12l3 4h7"/>
      <circle cx="17" cy="8"  r="2"/>
      <circle cx="17" cy="16" r="2"/>
      <circle cx="5"  cy="12" r="2"/>
    </svg>
  )
}

export function UnknownDeviceIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* Generic device box */}
      <rect x="3" y="5" width="18" height="14" rx="2"/>
      <path d="M3 10h18"/>
      {/* Question mark */}
      <path d="M9.5 14a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 2"/>
      <circle cx="12" cy="17.5" r=".6" fill="currentColor" stroke="none"/>
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
  unknown:             '#64748b',
}

export const DEVICE_TYPE_LABEL: Record<string, string> = {
  router:              'Router',
  switch:              'Switch',
  access_point:        'Access Point',
  firewall:            'Firewall',
  wireless_controller: 'Wireless Controller',
  load_balancer:       'Load Balancer',
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
    default:                    return <UnknownDeviceIcon {...props} />
  }
}

export default DeviceTypeIcon
