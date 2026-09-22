'use client'

import { Link } from '@/lib/router-compat'
import { CalendarDays, Mail, Phone, SquareCheck } from 'lucide-react'
import type { Task } from '@/data/types'
import { cn, dueLabel } from '@/lib/utils'
import { Checkbox } from '@/components/ui/Field'
import { Avatar } from '@/components/ui/Avatar'
import { useCrm } from '@/store/crm'

const TYPE_ICON = {
  call: Phone,
  email: Mail,
  meeting: CalendarDays,
  todo: SquareCheck,
} as const

const PRIORITY_RAIL = {
  high: 'bg-warning',
  medium: 'bg-info',
  low: 'bg-transparent',
} as const

export function TaskRow({
  task,
  showOwner = false,
  showRelated = true,
}: {
  task: Task
  showOwner?: boolean
  showRelated?: boolean
}) {
  const { toggleTask, ownerById } = useCrm()
  const due = dueLabel(task.dueDate)
  const Icon = TYPE_ICON[task.type]
  const owner = ownerById(task.ownerId)

  const relatedHref =
    task.relatedTo?.type === 'lead'
      ? `/leads/${task.relatedTo.id}`
      : task.relatedTo?.type === 'contact'
        ? `/contacts/${task.relatedTo.id}`
        : '/pipeline'

  return (
    <div className="group relative flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-subtler">
      <span
        className={cn(
          'absolute inset-y-2 left-0 w-[2px] rounded-r-full',
          task.done ? 'bg-transparent' : PRIORITY_RAIL[task.priority],
        )}
      />
      <Checkbox checked={task.done} onChange={() => toggleTask(task.id)} label={task.title} />
      <Icon size={13} className={cn('shrink-0', task.done ? 'text-ink-400/70' : 'text-ink-400')} />

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-[13px] leading-[18px]',
            task.done ? 'text-ink-400 line-through' : 'text-ink-800',
          )}
        >
          {task.title}
        </p>
        {showRelated && task.relatedTo && (
          <Link
            to={relatedHref}
            className="block max-w-full truncate text-[11.5px] text-ink-400 hover:text-brand-700 hover:underline"
          >
            {task.relatedTo.label}
          </Link>
        )}
      </div>

      {showOwner && <Avatar name={owner.name} initials={owner.initials} size="xs" />}

      <span
        className={cn(
          'tabular w-[92px] shrink-0 text-right text-[11.5px] font-medium',
          task.done
            ? 'text-ink-400'
            : due.tone === 'overdue'
              ? 'text-negative'
              : due.tone === 'today'
                ? 'text-warning'
                : 'text-ink-500',
        )}
      >
        {task.done ? 'Completed' : due.text}
      </span>
    </div>
  )
}
