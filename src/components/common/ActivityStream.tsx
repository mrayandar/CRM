'use client'

import { Link } from '@/lib/router-compat'
import {
  ArrowRightLeft,
  CalendarDays,
  CheckCircle2,
  CircleSlash,
  Mail,
  Phone,
  Plus,
  StickyNote,
  Trophy,
} from 'lucide-react'
import type { Activity, ActivityKind } from '@/data/types'
import { cn, formatDateTime, relativeTime } from '@/lib/utils'
import { useCrm } from '@/store/crm'

const KIND_META: Record<
  ActivityKind,
  { icon: typeof Mail; ring: string; text: string; label: string }
> = {
  call: { icon: Phone, ring: 'border-line bg-subtle', text: 'text-ink-500', label: 'Call' },
  email: { icon: Mail, ring: 'border-line bg-subtle', text: 'text-ink-500', label: 'Email' },
  meeting: { icon: CalendarDays, ring: 'border-line bg-subtle', text: 'text-ink-500', label: 'Meeting' },
  note: { icon: StickyNote, ring: 'border-line bg-subtle', text: 'text-ink-500', label: 'Note' },
  stage: {
    icon: ArrowRightLeft,
    ring: 'border-info-line bg-info-soft',
    text: 'text-info',
    label: 'Stage change',
  },
  created: { icon: Plus, ring: 'border-line bg-subtle', text: 'text-ink-500', label: 'Created' },
  task: {
    icon: CheckCircle2,
    ring: 'border-line bg-subtle',
    text: 'text-ink-500',
    label: 'Task',
  },
  won: {
    icon: Trophy,
    ring: 'border-positive-line bg-positive-soft',
    text: 'text-positive',
    label: 'Won',
  },
  lost: {
    icon: CircleSlash,
    ring: 'border-negative-line bg-negative-soft',
    text: 'text-negative',
    label: 'Lost',
  },
}

export function ActivityGlyph({ kind, size = 'md' }: { kind: ActivityKind; size?: 'sm' | 'md' }) {
  const meta = KIND_META[kind]
  const Icon = meta.icon
  return (
    <span
      title={meta.label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border',
        size === 'sm' ? 'size-6' : 'size-7',
        meta.ring,
        meta.text,
      )}
    >
      <Icon size={size === 'sm' ? 11 : 13} strokeWidth={2} />
    </span>
  )
}

function subjectHref(subject: Activity['subject']): string | null {
  if (!subject) return null
  if (subject.type === 'lead') return `/leads/${subject.id}`
  if (subject.type === 'contact') return `/contacts/${subject.id}`
  return '/pipeline'
}

/** Compact feed used on the dashboard — "who did what, when". */
export function ActivityFeed({ items, limit }: { items: Activity[]; limit?: number }) {
  const { ownerById } = useCrm()
  const shown = limit ? items.slice(0, limit) : items

  return (
    <ul className="divide-y divide-line">
      {shown.map((item) => {
        const actor = ownerById(item.actorId)
        const href = subjectHref(item.subject)
        return (
          <li key={item.id} className="flex gap-3 px-5 py-3 transition-colors hover:bg-subtler">
            <ActivityGlyph kind={item.kind} />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] leading-[18px] text-ink-700">
                <span className="font-semibold text-ink-900">{actor.name}</span> {item.title}
              </p>
              {item.body && (
                <p className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-ink-500">{item.body}</p>
              )}
              <div className="mt-1 flex items-center gap-2">
                <span className="tabular text-[11.5px] text-ink-400">{relativeTime(item.at)}</span>
                {href && item.subject && (
                  <>
                    <span className="text-ink-400/60">·</span>
                    <Link
                      to={href}
                      className="max-w-[220px] truncate text-[11.5px] font-medium text-ink-500 hover:text-brand-700 hover:underline"
                    >
                      {item.subject.label}
                    </Link>
                  </>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Vertical rail timeline used on record detail pages. */
export function ActivityTimeline({ items }: { items: Activity[] }) {
  const { ownerById } = useCrm()

  return (
    <ol className="relative">
      {items.map((item, i) => {
        const actor = ownerById(item.actorId)
        const last = i === items.length - 1
        return (
          <li key={item.id} className="relative flex gap-3 pb-5 last:pb-0">
            {!last && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-line" />}
            <ActivityGlyph kind={item.kind} />
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-[12.5px] leading-[18px] text-ink-700">
                <span className="font-semibold text-ink-900">{actor.name}</span> {item.title}
              </p>
              {item.body && (
                <p className="mt-1.5 rounded-panel border border-line bg-subtler px-3 py-2 text-[12.5px] leading-[19px] text-ink-700">
                  {item.body}
                </p>
              )}
              <p className="tabular mt-1 text-[11.5px] text-ink-400">{formatDateTime(item.at)}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
