'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Card({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        'rounded-card border border-line bg-surface shadow-hairline',
        className,
      )}
    >
      {children}
    </section>
  )
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex items-start justify-between gap-4 border-b border-line px-5 py-3.5',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[13.5px] leading-5 font-semibold tracking-[-0.01em] text-ink-900">
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-[12.5px] leading-4 text-ink-500">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </header>
  )
}

/** Small uppercase section label used inside panels. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-[10.5px] font-semibold tracking-[0.07em] text-ink-400 uppercase',
        className,
      )}
    >
      {children}
    </p>
  )
}
