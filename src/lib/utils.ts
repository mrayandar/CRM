export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

/** $148,000 */
export function currency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

/** $148K — for metric tiles and column headers where space is tight. */
export function currencyCompact(value: number): string {
  return `$${compactFormatter.format(value)}`
}

export function percent(value: number, fractionDigits = 0): string {
  return `${value.toFixed(fractionDigits)}%`
}

export function initialsOf(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

const DAY = 86_400_000

export function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

/** Whole days from today to the given date. Negative means the past. */
export function dayDelta(iso: string): number {
  const then = startOfDay(new Date(iso)).getTime()
  const today = startOfDay(new Date()).getTime()
  return Math.round((then - today) / DAY)
}

/** "2h ago", "Yesterday", "Sep 12" */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const minutes = Math.round(diff / 60_000)

  if (diff < 0) {
    const delta = dayDelta(iso)
    if (delta === 0) return 'Later today'
    if (delta === 1) return 'Tomorrow'
    return `in ${delta}d`
  }
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = -dayDelta(iso)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return formatDate(iso)
}

/** "Sep 12" or "Sep 12, 2025" when the year differs from today's. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  })
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return `${formatDate(iso)} · ${d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

export function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/** "Overdue by 2d" / "Due today" / "Due in 5d" */
export function dueLabel(iso: string): { text: string; tone: 'overdue' | 'today' | 'soon' | 'later' } {
  const delta = dayDelta(iso)
  if (delta < 0) return { text: delta === -1 ? 'Overdue by 1d' : `Overdue by ${-delta}d`, tone: 'overdue' }
  if (delta === 0) return { text: 'Due today', tone: 'today' }
  if (delta === 1) return { text: 'Due tomorrow', tone: 'soon' }
  if (delta <= 7) return { text: `Due in ${delta}d`, tone: 'soon' }
  return { text: formatDate(iso), tone: 'later' }
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  return items.reduce((acc, item) => {
    const k = key(item)
    ;(acc[k] ||= []).push(item)
    return acc
  }, {} as Record<K, T[]>)
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

export function sortBy<T>(items: T[], value: (item: T) => number | string, dir: 'asc' | 'desc' = 'asc'): T[] {
  const factor = dir === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (av === bv) return 0
    return (av > bv ? 1 : -1) * factor
  })
}

/** Stable pseudo-random from a string id — keeps generated timelines consistent. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return ((h >>> 0) % 100000) / 100000
  }
}

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Builds a CSV from row objects and triggers a browser download. Client-side only — the rows
 * passed in are whatever's currently filtered/visible on screen, so the export always matches
 * what the user is looking at.
 */
export function exportCsv(filename: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return
  const headers = Object.keys(rows[0]!)
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function isThisMonth(iso: string): boolean {
  const d = new Date(iso)
  const now = new Date()
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
}

/** True if `iso` falls in the calendar month exactly `monthsAgo` months before the current one
 *  (0 = this month, 1 = last month, ...). Used for real month-over-month comparisons — never
 *  invent a trend for a metric with no time-series basis; this is how the real ones are built. */
export function isMonthsAgo(iso: string, monthsAgo: number): boolean {
  const d = new Date(iso)
  const now = new Date()
  const target = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1)
  return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth()
}

/**
 * Real month-over-month % change. Returns null — render as "not enough data yet", never a
 * fabricated number — when there's nothing meaningful to compare against (no prior-period value).
 */
export function momDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}

/**
 * Buckets already-won deals into calendar months (oldest to newest, `months` wide, including the
 * current month) and sums their value per month. Every bucket in the window is present even when
 * empty — an org with sparse or no closed-won history gets honest zero bars, never padded with
 * fabricated figures.
 */
export function monthlyWonRevenue(
  wonDeals: Array<{ value: number; closeDate: string }>,
  months = 6,
): Array<{ month: string; value: number }> {
  const now = new Date()
  const buckets = new Map<string, { month: string; value: number }>()
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    buckets.set(`${d.getFullYear()}-${d.getMonth()}`, {
      month: d.toLocaleDateString('en-US', { month: 'short' }),
      value: 0,
    })
  }
  for (const deal of wonDeals) {
    const d = new Date(deal.closeDate)
    const bucket = buckets.get(`${d.getFullYear()}-${d.getMonth()}`)
    if (bucket) bucket.value += deal.value
  }
  return [...buckets.values()]
}
