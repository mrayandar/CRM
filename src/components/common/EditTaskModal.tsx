'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Input, Label, Select, Textarea } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { useCrm } from '@/store/crm'
import type { Priority, Task } from '@/data/types'

const TASK_TYPE_OPTIONS: Array<{ value: Task['type']; label: string }> = [
  { value: 'todo', label: 'To-do' },
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'meeting', label: 'Meeting' },
]

export function EditTaskModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const { updateTask, owners } = useCrm()

  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [dueDate, setDueDate] = useState(task.dueDate.slice(0, 10))
  const [priority, setPriority] = useState<Priority>(task.priority)
  const [type, setType] = useState<Task['type']>(task.type)
  const [ownerId, setOwnerId] = useState(task.ownerId)

  // Re-seed from the task whenever it changes underneath the modal, not on every render, so it
  // doesn't clobber an in-progress edit.
  useEffect(() => {
    setTitle(task.title)
    setDescription(task.description ?? '')
    setDueDate(task.dueDate.slice(0, 10))
    setPriority(task.priority)
    setType(task.type)
    setOwnerId(task.ownerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  const canSubmit = title.trim() !== '' && dueDate !== ''

  const submit = () => {
    if (!canSubmit) return
    // The <input type=date> only has day precision. If the user never touched it, resubmit the
    // task's original dueDate exactly as stored rather than reconstructing a coarser "noon on
    // that day" value — same rule every other date field in this app follows.
    const dateTouched = dueDate !== task.dueDate.slice(0, 10)
    updateTask(task.id, {
      title,
      description: description.trim() || undefined,
      dueDate: dateTouched ? new Date(`${dueDate}T12:00:00`).toISOString() : task.dueDate,
      priority,
      type,
      ownerId,
    })
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title="Edit task"
      description="Update this task's details."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            Save changes
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
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add more detail…"
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
              {owners.map((o) => (
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
