'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, Plus } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Segmented, Select } from '@/components/ui/Field'
import { EmptyState } from '@/components/ui/Display'
import { TaskRow } from '@/components/common/TaskRow'
import { useCrm } from '@/store/crm'
import type { Task } from '@/data/types'
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
        <Button variant="primary" size="sm" icon={<Plus size={14} />}>
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
    </PageShell>
  )
}
