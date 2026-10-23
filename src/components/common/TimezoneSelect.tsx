'use client'

import { useMemo, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { listIanaTimezones } from '@lib/timezones'
import { Popover, MenuItem } from '@/components/ui/Menu'

const ALL_TIMEZONES = listIanaTimezones()

/** Searchable IANA timezone picker — replaces the old 4-option free-text dropdown. Filters
 *  `Intl.supportedValuesOf('timeZone')` client-side as the user types; there's no server round
 *  trip for this, the full list (~400 entries) is small enough to filter in the browser. */
export function TimezoneSelect({
  value,
  onChange,
  placeholder = 'Select a time zone…',
  className,
}: {
  value: string | null
  onChange: (tz: string) => void
  placeholder?: string
  className?: string
}) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? ALL_TIMEZONES.filter((tz) => tz.toLowerCase().includes(q)) : ALL_TIMEZONES
    return list.slice(0, 50) // the full list fits, but a 400-row menu is never useful to scroll
  }, [query])

  return (
    <Popover
      width={280}
      className={className}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-control border border-line-strong',
            'bg-surface px-2.5 text-left text-[13px] transition-colors hover:border-[#cfcfd6]',
            value ? 'text-ink-900' : 'text-ink-400',
          )}
        >
          <span className="min-w-0 truncate">{value ?? placeholder}</span>
          <ChevronsUpDown size={13} className="shrink-0 text-ink-400" />
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex max-h-72 flex-col">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search time zones…"
            className="mb-1 h-8 shrink-0 rounded-[6px] border border-line-strong px-2 text-[13px] focus:border-brand-500 focus:outline-none"
          />
          <div className="flex-1 overflow-y-auto scrollbar-slim">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12.5px] text-ink-400">No match</p>
            ) : (
              filtered.map((tz) => (
                <MenuItem
                  key={tz}
                  selected={tz === value}
                  onClick={() => {
                    onChange(tz)
                    setQuery('')
                    close()
                  }}
                >
                  {tz}
                </MenuItem>
              ))
            )}
          </div>
        </div>
      )}
    </Popover>
  )
}
