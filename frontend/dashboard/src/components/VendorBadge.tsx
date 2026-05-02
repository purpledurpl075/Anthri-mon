const labels: Record<string, string> = {
  cisco_ios:   'Cisco IOS',
  cisco_iosxe: 'Cisco IOS-XE',
  cisco_iosxr: 'Cisco IOS-XR',
  cisco_nxos:  'Cisco NX-OS',
  juniper:     'Juniper',
  arista:      'Arista EOS',
  aruba_cx:    'Aruba CX',
  fortios:     'FortiOS',
  procurve:    'HP ProCurve',
  unknown:     'Unknown',
}

export default function VendorBadge({ vendor }: { vendor: string }) {
  return (
    <span className="text-sm text-slate-600 font-medium">
      {labels[vendor] ?? vendor}
    </span>
  )
}
