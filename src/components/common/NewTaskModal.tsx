'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Input, Label, Select } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { useCrm } from '@/store/crm'
import { assignableOwners } from '@/lib/utils'
import type { Priority, Task } from '@/data/types'

const TASK_TYPE_OPTIONS: Array<{ value: Task['type']; label: string }> = [
  { value: 'todo', label: 'To-do' },
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'meeting', label: 'Meeting' },
]

function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The one "New task" form, shared by the Tasks page's quick-add flow and the Calendar screen's
 * "Add task" entry points (the agenda panel's button and each day cell's "+") — there is no
 * second copy of this form anywhere; both callers render this same component and go through the
 * same `addTask` mutation (client-generated id, optimistic update, the same assignee rules —
 * `assignableOwners` excludes inactive owners, defaulting to the caller — and the same server-
 * side `addTaskAction`, including the "assigned" notification when the assignee isn't the actor).
 *
 * `defaultDueDate`, when given, is a plain "YYYY-MM-DD" calendar date — passed straight into the
 * date input's own value, never parsed into a `Date`/instant and reformatted on the way in. That
 * is what makes the Calendar's prefill immune to the viewer's timezone: there is no conversion
 * step at the handoff for a timezone to shift. (The date input's own value, once submitted, still
 * goes through this form's existing `new Date(...).toISOString()` conversion to build the stored
 * instant — unchanged, pre-existing behavior, not something this feature touches.)
 */
export function NewTaskModal({
  onClose,
  onCreated,
  defaultDueDate,
}: {
  onClose: () => void
  onCreated?: (assigneeId: string) => void
  defaultDueDate?: string
}) {
  const { addTask, owners, currentUser } = useCrm()
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState(defaultDueDate ?? todayYmd())
  const [priority, setPriority] = useState<Priority>('medium')
  const [type, setType] = useState<Task['type']>('todo')
  const [ownerId, setOwnerId] = useState(currentUser.id)

  const canSubmit = title.trim() !== '' && dueDate !== ''

  const submit = () => {
    if (!canSubmit) return
    addTask({
      title: title.trim(),
      dueDate: new Date(`${dueDate}T12:00:00`).toISOString(),
      priority,
      type,
      ownerId,
    })
    onCreated?.(ownerId)
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title="New task"
      description="Add a follow-up and assign it to someone on your team."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            Create task
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Task">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Send the revised proposal"
            autoFocus
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="h-9">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as Task['type'])} className="h-9">
              {TASK_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assignee">
            <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="h-9">
              {assignableOwners(owners, ownerId).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.role}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </form>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  )
}
