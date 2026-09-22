'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { DealStage, LeadStatus, Priority } from '@/data/types'

export type Tone = 'neutral' | 'positive' | 'negative' | 'warning' | 'info' | 'accent' | 'brand'

const tones: Record<Tone, string> = {
  neutral: 'bg-subtle text-ink-600 border-line',
  positive: 'bg-positive-soft text-positive border-positive-line',
  negative: 'bg-negative-soft text-negative border-negative-line',
  warning: 'bg-warning-soft text-warning border-warning-line',
  info: 'bg-info-soft text-info border-info-line',
  accent: 'bg-accent-soft text-accent border-accent-line',
  brand: 'bg-brand-50 text-brand-700 border-brand-100',
}

const dotTones: Record<Tone, string> = {
  neutral: 'bg-ink-400',
  positive: 'bg-positive',
  negative: 'bg-negative',
  warning: 'bg-warning',
  info: 'bg-info',
  accent: 'bg-accent',
  brand: 'bg-brand-600',
}

interface BadgeProps {
  tone?: Tone
  dot?: boolean
  className?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', dot = false, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px]',
        'text-[11.5px] leading-[16px] font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {dot && <span className={cn('size-1.5 rounded-full', dotTones[tone])} />}
      {children}
    </span>
  )
}

/** A quieter label for metadata like tags — no status meaning. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] border border-line bg-subtler px-1.5',
        'py-[1px] text-[11.5px] leading-[16px] font-medium text-ink-600 whitespace-nowrap',
        className,
      )}
    >
      {children}
    </span>
  )
}

export const LEAD_STATUS_TONE: Record<LeadStatus, Tone> = {
  new: 'info',
  contacted: 'accent',
  qualified: 'positive',
  unqualified: 'neutral',
  lost: 'negative',
}

export const DEAL_STAGE_TONE: Record<DealStage, Tone> = {
  discovery: 'neutral',
  proposal: 'info',
  negotiation: 'accent',
  contract: 'warning',
  won: 'positive',
  lost: 'negative',
}

export const PRIORITY_TONE: Record<Priority, Tone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
}

export function StatusDot({ tone }: { tone: Tone }) {
  return <span className={cn('size-1.5 shrink-0 rounded-full', dotTones[tone])} />
}
