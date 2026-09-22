'use client'

import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MetricTileProps {
  label: string
  value: string
  unit?: string
  delta?: number
  invertDelta?: boolean
  footer?: ReactNode
  emphasis?: boolean
}

export function MetricTile({
  label,
  value,
  unit,
  delta,
  invertDelta = false,
  footer,
  emphasis = false,
}: MetricTileProps) {
  const good = delta === undefined ? null : invertDelta ? delta < 0 : delta > 0
  const flat = delta === 0

  return (
    <div className="flex min-w-0 flex-col justify-between gap-4 px-5 py-4">
      <p className="text-[12px] leading-4 font-medium text-ink-500">{label}</p>

      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={cn(
              'tabular font-semibold tracking-[-0.03em] text-ink-900',
              emphasis ? 'text-[30px] leading-9' : 'text-[26px] leading-8',
            )}
          >
            {value}
          </span>
          {unit && <span className="text-[12.5px] font-medium text-ink-500">{unit}</span>}
          {delta !== undefined && (
            <span
              className={cn(
                'tabular inline-flex items-center gap-0.5 text-[12px] font-medium',
                flat ? 'text-ink-500' : good ? 'text-positive' : 'text-negative',
              )}
            >
              {/* Arrow follows the direction of the change, color follows whether it is good. */}
              {!flat &&
                (delta > 0 ? (
                  <ArrowUpRight size={12} strokeWidth={2.5} />
                ) : (
                  <ArrowDownRight size={12} strokeWidth={2.5} />
                ))}
              {Math.abs(delta).toFixed(1)}%
            </span>
          )}
        </div>
        {footer && <div className="mt-1.5 text-[11.5px] leading-4 text-ink-400">{footer}</div>}
      </div>
    </div>
  )
}

/** Four metrics sharing a single card, separated by hairlines. */
export function MetricRow({ items }: { items: MetricTileProps[] }) {
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-card border border-line bg-surface shadow-hairline sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={cn(
            'border-line',
            // stacked: every tile after the first gets a top rule
            i > 0 && 'border-t sm:border-t-0',
            // 2-up: right column gets a left rule, second row gets a top rule
            i % 2 === 1 && 'sm:border-l',
            i >= 2 && 'sm:border-t lg:border-t-0',
            // 4-up: every tile after the first gets a left rule
            i > 0 && 'lg:border-l',
          )}
        >
          <MetricTile {...item} />
        </div>
      ))}
    </div>
  )
}
