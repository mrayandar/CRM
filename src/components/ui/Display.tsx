'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div className="mb-3 flex size-9 items-center justify-center rounded-[10px] border border-line bg-subtle text-ink-400">
          {icon}
        </div>
      )}
      <p className="text-[13.5px] font-semibold text-ink-800">{title}</p>
      {description && <p className="mt-1 max-w-[320px] text-[12.5px] leading-5 text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Thin horizontal meter. Color is only used when a tone is passed explicitly. */
export function Meter({
  value,
  tone = 'neutral',
  className,
}: {
  value: number
  tone?: 'neutral' | 'brand' | 'positive' | 'warning' | 'negative'
  className?: string
}) {
  const fill = {
    neutral: 'bg-ink-400',
    brand: 'bg-brand-600',
    positive: 'bg-positive',
    warning: 'bg-warning',
    negative: 'bg-negative',
  }[tone]

  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-subtle', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', fill)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}

export function KeyValue({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-baseline gap-3 py-1.5', className)}>
      <dt className="w-[92px] shrink-0 text-[12px] text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-[12.5px] text-ink-800">{children}</dd>
    </div>
  )
}

export function DeltaText({
  value,
  suffix = '%',
  invert = false,
}: {
  value: number
  suffix?: string
  invert?: boolean
}) {
  const positive = invert ? value < 0 : value > 0
  const neutral = value === 0
  return (
    <span
      className={cn(
        'tabular text-[12px] font-medium',
        neutral ? 'text-ink-500' : positive ? 'text-positive' : 'text-negative',
      )}
    >
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}
      {suffix}
    </span>
  )
}

/** Compact SVG bar chart used on the dashboard and reports. */
export function BarChart({
  data,
  height = 120,
  valueFormat,
}: {
  data: Array<{ label: string; value: number; target?: number; highlight?: boolean }>
  height?: number
  valueFormat?: (v: number) => string
}) {
  const max = Math.max(...data.flatMap((d) => [d.value, d.target ?? 0])) || 1

  return (
    <div className="flex items-end gap-2.5" style={{ height }}>
      {data.map((d) => {
        const h = (d.value / max) * 100
        const targetH = d.target ? (d.target / max) * 100 : null
        return (
          <div key={d.label} className="group flex h-full min-w-0 flex-1 flex-col justify-end gap-1.5">
            <div className="relative flex-1">
              {targetH !== null && (
                <div
                  className="absolute inset-x-0 border-t border-dashed border-line-strong"
                  style={{ bottom: `${targetH}%` }}
                />
              )}
              <div
                title={valueFormat ? valueFormat(d.value) : String(d.value)}
                className={cn(
                  'absolute inset-x-0 bottom-0 rounded-t-[4px] transition-colors duration-100',
                  d.highlight ? 'bg-brand-600' : 'bg-[#e4e4e8] group-hover:bg-[#d4d4da]',
                )}
                style={{ height: `${h}%` }}
              />
            </div>
            <span className="truncate text-center text-[10.5px] font-medium text-ink-400">
              {d.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
