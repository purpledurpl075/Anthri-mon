const colours: Record<string, string> = {
  up:          'bg-green-100 text-green-800',
  down:        'bg-red-100 text-red-800',
  unreachable: 'bg-red-100 text-red-800',
  maintenance: 'bg-yellow-100 text-yellow-800',
  unknown:     'bg-gray-100 text-gray-600',
  testing:     'bg-blue-100 text-blue-800',
  dormant:     'bg-gray-100 text-gray-500',
  not_present: 'bg-gray-100 text-gray-400',
  lower_layer_down: 'bg-orange-100 text-orange-700',
}

export default function StatusBadge({ status }: { status: string }) {
  const cls = colours[status] ?? colours.unknown
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  )
}
