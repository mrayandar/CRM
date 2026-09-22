'use client'

import { ChevronRight } from 'lucide-react'
import { LEAD_STATUS_LABEL, type LeadStatus } from '@/data/types'
import { cn, percent } from '@/lib/utils'
import { LEAD_STATUS_TONE, StatusDot } from '@/components/ui/Badge'

const FUNNEL: LeadStatus[] = ['new', 'contacted', 'qualified']
const EXITS: LeadStatus[] = ['unqualified', 'lost']

/**
 * Status funnel across the top of the Leads list. Each step doubles as a filter:
 * clicking a step scopes the table below it.
 */
export function LeadFunnel({
  counts,
  active,
  onSelect,
}: {
  counts: Record<LeadStatus, number>
  active: LeadStatus | 'all'
  onSelect: (status: LeadStatus | 'all') => void
}) {
  const total = FUNNEL.reduce((acc, s) => acc + counts[s], 0)
  const allLeads = total + EXITS.reduce((acc, s) => acc + counts[s], 0)
  const largestStep = Math.max(...FUNNEL.map((s) => counts[s]), 1)

  return (
    <div className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-hairline xl:flex-row xl:divide-x xl:divide-y-0">
      <div className="flex flex-1 items-stretch divide-x divide-line">
        {FUNNEL.map((status, i) => {
          const value = counts[status]
          const share = (value / largestStep) * 100
          const shareOfAll = allLeads ? (value / allLeads) * 100 : 0
          const isActive = active === status

          return (
            <div key={status} className="relative flex min-w-0 flex-1 items-center">
              <button
                type="button"
                onClick={() => onSelect(isActive ? 'all' : status)}
                className={cn(
                  'group flex h-full w-full flex-col justify-between gap-3 px-4 py-3.5 text-left transition-colors',
                  isActive ? 'bg-brand-50/50' : 'hover:bg-subtler',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <StatusDot tone={LEAD_STATUS_TONE[status]} />
                  <span
                    className={cn(
                      'text-[12px] font-medium',
                      isActive ? 'text-brand-700' : 'text-ink-600',
                    )}
                  >
                    {LEAD_STATUS_LABEL[status]}
                  </span>
                </span>

                <span>
                  <span className="flex items-baseline gap-1.5">
                    <span className="tabular text-[22px] leading-7 font-semibold tracking-[-0.03em] text-ink-900">
                      {value}
                    </span>
                    <span className="tabular text-[11.5px] font-medium text-ink-400">
                      {percent(shareOfAll)} of all leads
                    </span>
                  </span>
                  <span className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-subtle">
                    <span
                      className={cn(
                        'block h-full rounded-full transition-[width] duration-500',
                        isActive ? 'bg-brand-600' : 'bg-ink-400/50',
                      )}
                      style={{ width: `${Math.max(share, 4)}%` }}
                    />
                  </span>
                </span>
              </button>

              {i < FUNNEL.length - 1 && (
                <ChevronRight
                  size={13}
                  className="absolute top-1/2 -right-[7px] z-10 -translate-y-1/2 bg-surface text-ink-400/70"
                />
              )}
            </div>
          )
        })}
      </div>

      <div className="flex shrink-0 divide-x divide-line">
        {EXITS.map((status) => {
          const isActive = active === status
          return (
            <button
              key={status}
              type="button"
              onClick={() => onSelect(isActive ? 'all' : status)}
              className={cn(
                'flex w-[132px] flex-col justify-between gap-3 px-4 py-3.5 text-left transition-colors',
                isActive ? 'bg-brand-50/50' : 'hover:bg-subtler',
              )}
            >
              <span className="flex items-center gap-1.5">
                <StatusDot tone={LEAD_STATUS_TONE[status]} />
                <span
                  className={cn(
                    'text-[12px] font-medium',
                    isActive ? 'text-brand-700' : 'text-ink-500',
                  )}
                >
                  {LEAD_STATUS_LABEL[status]}
                </span>
              </span>
              <span className="tabular text-[22px] leading-7 font-semibold tracking-[-0.03em] text-ink-500">
                {counts[status]}
              </span>
            </button>
          )
        })}
        <div className="flex w-[150px] flex-col justify-between gap-3 bg-subtler px-4 py-3.5">
          <span className="text-[12px] font-medium text-ink-500">Qualification rate</span>
          <span className="tabular text-[22px] leading-7 font-semibold tracking-[-0.03em] text-ink-900">
            {percent(total ? (counts.qualified / total) * 100 : 0)}
          </span>
        </div>
      </div>
    </div>
  )
}
