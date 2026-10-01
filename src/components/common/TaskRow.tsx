'use client'

import { useState } from 'react'
import { Link } from '@/lib/router-compat'
import { CalendarDays, Mail, MoreHorizontal, Phone, SquareCheck } from 'lucide-react'
import type { Task } from '@/data/types'
import { cn, dueLabel } from '@/lib/utils'
import { Checkbox } from '@/components/ui/Field'
import { Avatar } from '@/components/ui/Avatar'
import { IconButton, Button } from '@/components/ui/Button'
import { MenuItem, Popover } from '@/components/ui/Menu'
import { Modal } from '@/components/ui/Modal'
import { EditTaskModal } from '@/components/common/EditTaskModal'
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

/**
 * Shared by the Tasks page, the Dashboard's "Today's focus" card, and a record detail page's
 * Tasks tab — wiring Edit/Delete in here once gives every task list the same capability, rather
 * than deciding per-surface whether to add controls (or duplicating them three times).
 */
export function TaskRow({
  task,
  showOwner = false,
  showRelated = true,
}: {
  task: Task
  showOwner?: boolean
  showRelated?: boolean
}) {
  const { toggleTask, deleteTask, ownerById } = useCrm()
  const [editOpen, setEditOpen] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const due = dueLabel(task.dueDate)
  const Icon = TYPE_ICON[task.type]
  const owner = ownerById(task.ownerId)

  const relatedHref =
    task.relatedTo?.type === 'lead'
      ? `/leads/${task.relatedTo.id}`
      : task.relatedTo?.type === 'contact'
        ? `/contacts/${task.relatedTo.id}`
        : '/pipeline'

  const confirmDelete = () => {
    setConfirmDeleteOpen(false)
    deleteTask(task.id)
  }

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

      <span onClick={(e) => e.stopPropagation()}>
        <Popover
          align="end"
          width={160}
          trigger={({ toggle, open }) => (
            <IconButton
              label={`Actions for ${task.title}`}
              onClick={toggle}
              className={cn(
                'size-7 text-ink-400',
                open
                  ? 'bg-subtle text-ink-700'
                  : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              )}
            >
              <MoreHorizontal size={14} />
            </IconButton>
          )}
        >
          {({ close }) => (
            <>
              <MenuItem
                onClick={() => {
                  setEditOpen(true)
                  close()
                }}
              >
                Edit task
              </MenuItem>
              <MenuItem
                tone="danger"
                onClick={() => {
                  setConfirmDeleteOpen(true)
                  close()
                }}
              >
                Delete task
              </MenuItem>
            </>
          )}
        </Popover>
      </span>

      {editOpen && <EditTaskModal task={task} onClose={() => setEditOpen(false)} />}

      <Modal
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        width={420}
        title="Delete task"
        description={`Delete "${task.title}"? This can't be undone.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              Delete
            </Button>
          </>
        }
      >
        <></>
      </Modal>
    </div>
  )
}
