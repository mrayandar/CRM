'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Plus } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Label, Segmented, Select } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/Display'
import { TaskRow } from '@/components/common/TaskRow'
import { useCrm } from '@/store/crm'
import type { Priority, Task } from '@/data/types'
import { dayDelta, sortBy } from '@/lib/utils'

type Bucket = 'overdue' | 'today' | 'week' | 'later' | 'done'

const BUCKET_META: Record<Bucket, { title: string; subtitle: string }> = {
  overdue: { title: 'Overdue', subtitle: 'Past their due date' },
  today: { title: 'Today', subtitle: 'Due before end of day' },
  week: { title: 'This week', subtitle: 'Due in the next 7 days' },
  later: { title: 'Later', subtitle: 'Scheduled further out' },
  done: { title: 'Completed', subtitle: 'Recently finished' },
}

const bucketOf = (task: Task): Bucket => {
  if (task.done) return 'done'
  const delta = dayDelta(task.dueDate)
  if (delta < 0) return 'overdue'
  if (delta === 0) return 'today'
  if (delta <= 7) return 'week'
  return 'later'
}

export function Tasks() {
  const { tasks, owners, currentUser, addTask } = useCrm()
  const [scope, setScope] = useState<'all' | 'mine'>('mine')
  const [owner, setOwner] = useState('all')
  const [draft, setDraft] = useState('')
  const [newTaskOpen, setNewTaskOpen] = useState(false)

  const visible = useMemo(
    () =>
      tasks.filter((t) => {
        if (scope === 'mine' && t.ownerId !== currentUser.id) return false
        if (owner !== 'all' && t.ownerId !== owner) return false
        return true
      }),
    [tasks, scope, owner, currentUser.id],
  )

  const buckets = useMemo(() => {
    const map: Record<Bucket, Task[]> = { overdue: [], today: [], week: [], later: [], done: [] }
    for (const task of visible) map[bucketOf(task)].push(task)
    for (const key of Object.keys(map) as Bucket[]) {
      map[key] = sortBy(map[key], (t) => new Date(t.dueDate).getTime())
    }
    return map
  }, [visible])

  const submit = () => {
    const title = draft.trim()
    if (!title) return
    addTask({ title, dueDate: new Date().toISOString(), priority: 'medium' })
    setDraft('')
  }

  const open = visible.filter((t) => !t.done)
  const order: Bucket[] = ['overdue', 'today', 'week', 'later', 'done']

  return (
    <PageShell
      title="Tasks"
      subtitle={`${open.length} open · ${buckets.overdue.length} overdue · ${buckets.done.length} completed`}
      actions={
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setNewTaskOpen(true)}>
          New task
        </Button>
      }
      toolbar={
        <>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'mine', label: 'My tasks' },
              { value: 'all', label: 'Team tasks' },
            ]}
          />
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-[150px]">
            <option value="all">All assignees</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <div className="ml-auto flex w-full items-center gap-2 sm:w-[320px]">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="Quick add a task…"
              className="h-8"
            />
            <Button variant="secondary" size="sm" onClick={submit} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
        </>
      }
    >
      <div className="mx-auto max-w-[1040px] space-y-4 p-5">
        {open.length === 0 && buckets.done.length === 0 && (
          <Card>
            <EmptyState
              icon={<CheckCircle2 size={16} />}
              title="No tasks here"
              description="Switch to team tasks or add a task to get started."
            />
          </Card>
        )}

        {order.map((bucket) => {
          const items = buckets[bucket]
          if (items.length === 0) return null
          return (
            <Card key={bucket}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {BUCKET_META[bucket].title}
                    <span className="tabular rounded-full bg-subtle px-1.5 text-[10.5px] leading-[17px] font-semibold text-ink-500">
                      {items.length}
                    </span>
                  </span>
                }
                subtitle={BUCKET_META[bucket].subtitle}
              />
              <div className="divide-y divide-line">
                {items.map((task) => (
                  <TaskRow key={task.id} task={task} showOwner={scope === 'all'} />
                ))}
              </div>
            </Card>
          )
        })}
      </div>

      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onCreated={(assigneeId) => {
            // "My tasks" is the default view; don't let a task assigned to someone else vanish from sight.
            if (assigneeId !== currentUser.id) {
              setScope('all')
              setOwner('all')
            }
          }}
        />
      )}
    </PageShell>
  )
}

const TASK_TYPE_OPTIONS: Array<{ value: Task['type']; label: string }> = [
  { value: 'todo', label: 'To-do' },
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'meeting', label: 'Meeting' },
]

function NewTaskModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (assigneeId: string) => void
}) {
  const { addTask, owners, currentUser } = useCrm()
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
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
    onCreated(ownerId)
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
