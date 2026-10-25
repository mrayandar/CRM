'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router-compat'
import { ChevronLeft, ChevronRight, Loader2, Plus, RotateCw } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Field'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/Display'
import { NewTaskModal } from '@/components/common/NewTaskModal'
import { useCrm } from '@/store/crm'
import { calendarMonthGrid, calendarYmd, cn } from '@/lib/utils'
import { localDayDelta } from '@lib/timezones'
import type { CalendarItemDTO } from '../../app/api/calendar/route'

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const KIND_TONE: Record<CalendarItemDTO['kind'], 'brand' | 'accent' | 'info'> = {
  task: 'brand',
  lead_follow_up: 'accent',
  deal_close: 'info',
}
const KIND_LABEL: Record<CalendarItemDTO['kind'], string> = {
  task: 'Task',
  lead_follow_up: 'Follow-up',
  deal_close: 'Close date',
}

function itemHref(item: CalendarItemDTO): string {
  if (item.subjectType === 'lead') return `/leads/${item.subjectId}`
  if (item.subjectType === 'deal') return '/pipeline'
  return '/tasks'
}

export function Calendar() {
  const navigate = useNavigate()
  const { currentUser, effectiveOrgTimezone, toggleTask, tasks: providerTasks } = useCrm()
  const viewerTimezone = currentUser.timezone ?? effectiveOrgTimezone

  const [monthStart, setMonthStart] = useState(() => {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  })
  const [selectedDate, setSelectedDate] = useState(() => calendarYmd(new Date()))
  const [showCompleted, setShowCompleted] = useState(false)
  const [items, setItems] = useState<CalendarItemDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [newTaskDate, setNewTaskDate] = useState<string | null>(null)

  const grid = useMemo(() => calendarMonthGrid(monthStart), [monthStart])
  const rangeFrom = calendarYmd(grid[0])
  const rangeTo = calendarYmd(grid[grid.length - 1])

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    fetch(`/api/calendar?from=${rangeFrom}&to=${rangeTo}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`calendar fetch failed: ${response.status}`)
        const body: { items: CalendarItemDTO[] } = await response.json()
        setItems(body.items)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [rangeFrom, rangeTo])

  // Refetch on month change (via `load`'s own rangeFrom/rangeTo deps) and on focus regained —
  // no periodic poll: a calendar's data changes far less often than the live CRM feed's does, and
  // a manual month-navigation or a focus event already covers the cases that matter.
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])

  // Task items are derived from CrmProvider's own `tasks` array, not the fetched `items` (whose
  // task entries are ignored below) — `tasks` is already the complete, scope-correct set (see
  // loadCrmData) and is already reactive to every task mutation (addTask, toggleTask, a live
  // refetch), so a task created or completed from THIS screen, the Tasks page, or anywhere else
  // shows up here immediately with no extra wiring, and a failed create's rollback (already built
  // into `addTask`/`persist`) removes it from the grid for free — there is nothing calendar-
  // specific to keep in sync by hand. Lead follow-ups and deal close dates still come from the
  // fetched `items`, unchanged — those arrays aren't loaded in bulk by the provider.
  const taskItems = useMemo<CalendarItemDTO[]>(
    () =>
      providerTasks
        .map((t) => ({ date: t.dueDate.slice(0, 10), task: t }))
        .filter(({ date }) => date >= rangeFrom && date <= rangeTo)
        .map(({ date, task }) => ({
          id: `task:${task.id}`, kind: 'task' as const, date, title: task.title, done: task.done,
          subjectType: 'task' as const, subjectId: task.id,
        })),
    [providerTasks, rangeFrom, rangeTo],
  )

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItemDTO[]>()
    const nonTaskItems = (items ?? []).filter((i) => i.kind !== 'task')
    for (const item of [...nonTaskItems, ...taskItems]) {
      if (item.kind === 'task' && item.done && !showCompleted) continue
      const list = map.get(item.date)
      if (list) list.push(item)
      else map.set(item.date, [item])
    }
    return map
  }, [items, taskItems, showCompleted])

  const isToday = (cellYmd: string) => localDayDelta(`${cellYmd}T00:00:00.000Z`, viewerTimezone) === 0
  const isOverdueDay = (cellYmd: string) => localDayDelta(`${cellYmd}T00:00:00.000Z`, viewerTimezone) < 0

  const overdueTaskCount = useMemo(
    () => taskItems.filter((i) => !i.done && isOverdueDay(i.date)).length,
    [taskItems, viewerTimezone],
  )

  const markTaskDone = (item: CalendarItemDTO) => {
    if (item.kind !== 'task') return
    toggleTask(item.subjectId) // optimistic/rollback/toast already built into toggleTask/persist
  }

  const monthLabel = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const selectedItems = itemsByDate.get(selectedDate) ?? []

  return (
    <PageShell
      title="Calendar"
      subtitle="Tasks, lead follow-ups, and open deals' expected close dates"
      toolbar={
        <>
          <div className="flex items-center gap-1">
            <IconButton
              label="Previous month"
              onClick={() => setMonthStart((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)))}
            >
              <ChevronLeft size={15} />
            </IconButton>
            <span className="w-[140px] text-center text-[13px] font-medium text-ink-800">{monthLabel}</span>
            <IconButton
              label="Next month"
              onClick={() => setMonthStart((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))}
            >
              <ChevronRight size={15} />
            </IconButton>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const now = new Date()
              setMonthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
              setSelectedDate(calendarYmd(now))
            }}
          >
            Today
          </Button>
          <div className="ml-auto flex items-center gap-2 text-[12.5px] text-ink-600">
            <Checkbox checked={showCompleted} onChange={setShowCompleted} label="Show completed tasks" />
            <span className="cursor-pointer" onClick={() => setShowCompleted((v) => !v)}>
              Show completed
            </span>
          </div>
        </>
      }
    >
      <div className="mx-auto max-w-[1100px] space-y-4 p-5">
        {overdueTaskCount > 0 && (
          <button
            type="button"
            onClick={() => navigate('/tasks')}
            className="flex w-full items-center justify-between rounded-[8px] border border-negative-line bg-negative-soft px-3.5 py-2 text-left text-[12.5px] text-negative transition-colors hover:bg-[#fde8e6]"
          >
            <span className="font-medium">
              {overdueTaskCount} overdue task{overdueTaskCount === 1 ? '' : 's'} in this view
            </span>
            <span className="underline">Go to Tasks</span>
          </button>
        )}

        {error && (
          <Card>
            <EmptyState
              title="Couldn't load the calendar"
              description="Something went wrong fetching this month's items."
              action={
                <Button variant="secondary" size="sm" icon={<RotateCw size={13} />} onClick={load}>
                  Try again
                </Button>
              }
            />
          </Card>
        )}

        {!error && loading && !items && (
          <Card>
            <div className="flex items-center justify-center py-16">
              <Loader2 size={18} className="animate-spin text-ink-400" />
            </div>
          </Card>
        )}

        {!error && items && (
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            {/* Month grid — hidden on narrow screens; the agenda list below is the whole view there. */}
            <Card className="hidden overflow-hidden sm:block">
              <div className="grid grid-cols-7 border-b border-line bg-subtle">
                {DAY_LABELS.map((label) => (
                  <div key={label} className="px-2 py-1.5 text-center text-[11px] font-medium text-ink-400">
                    {label}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {grid.map((cellDate) => {
                  const cellYmd = calendarYmd(cellDate)
                  const inMonth = cellDate.getUTCMonth() === monthStart.getUTCMonth()
                  const dayItems = itemsByDate.get(cellYmd) ?? []
                  const selected = cellYmd === selectedDate
                  return (
                    <div
                      key={cellYmd}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedDate(cellYmd)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') setSelectedDate(cellYmd)
                      }}
                      className={cn(
                        'group relative flex min-h-[86px] cursor-pointer flex-col items-start gap-1 border-b border-r border-line p-1.5 text-left transition-colors',
                        !inMonth && 'bg-subtler/60',
                        selected && 'bg-brand-50/70',
                        'hover:bg-subtle',
                      )}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span
                          className={cn(
                            'flex size-5 items-center justify-center rounded-full text-[11.5px] font-medium',
                            isToday(cellYmd) ? 'bg-brand-600 text-white' : inMonth ? 'text-ink-700' : 'text-ink-300',
                          )}
                        >
                          {cellDate.getUTCDate()}
                        </span>
                        <IconButton
                          label={`Add task on ${cellYmd}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setNewTaskDate(cellYmd)
                          }}
                          className="size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <Plus size={12} />
                        </IconButton>
                      </div>
                      <div className="flex w-full flex-col gap-0.5">
                        {dayItems.slice(0, 3).map((item) => (
                          <span
                            key={item.id}
                            className={cn(
                              'truncate rounded-[4px] px-1 py-px text-[10.5px] leading-[14px]',
                              item.kind === 'task' && item.done && 'text-ink-400 line-through',
                              isOverdueDay(cellYmd) && item.kind !== 'deal_close' && !(item.kind === 'task' && item.done)
                                ? 'bg-negative-soft text-negative'
                                : item.kind === 'task'
                                  ? 'bg-brand-50 text-brand-700'
                                  : item.kind === 'lead_follow_up'
                                    ? 'bg-accent-soft text-accent'
                                    : 'bg-info-soft text-info',
                            )}
                          >
                            {item.title}
                          </span>
                        ))}
                        {dayItems.length > 3 && (
                          <span className="text-[10px] text-ink-400">+{dayItems.length - 3} more</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>

            {/* Agenda — the selected day on wide screens, every day with items on narrow ones. */}
            <div className="space-y-3 sm:hidden">
              {[...itemsByDate.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([day, dayItems]) => (
                  <AgendaDay key={day} day={day} items={dayItems} onMarkDone={markTaskDone} />
                ))}
              {itemsByDate.size === 0 && (
                <Card>
                  <EmptyState title="Nothing this month" description="No tasks, follow-ups, or close dates in range." />
                </Card>
              )}
            </div>

            <Card className="hidden sm:block">
              <CardHeader
                title={new Date(`${selectedDate}T00:00:00.000Z`).toLocaleDateString('en-US', {
                  weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC',
                })}
                action={
                  <Button variant="secondary" size="xs" icon={<Plus size={12} />} onClick={() => setNewTaskDate(selectedDate)}>
                    Add task
                  </Button>
                }
              />
              <div className="divide-y divide-line">
                {selectedItems.length === 0 && (
                  <EmptyState title="Nothing scheduled" description="No items for this day." />
                )}
                {selectedItems.map((item) => (
                  <AgendaItem key={item.id} item={item} onMarkDone={markTaskDone} />
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>

      {newTaskDate !== null && (
        <NewTaskModal defaultDueDate={newTaskDate} onClose={() => setNewTaskDate(null)} />
      )}
    </PageShell>
  )
}

function AgendaDay({
  day,
  items,
  onMarkDone,
}: {
  day: string
  items: CalendarItemDTO[]
  onMarkDone: (item: CalendarItemDTO) => void
}) {
  return (
    <Card>
      <CardHeader
        title={new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-US', {
          weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC',
        })}
      />
      <div className="divide-y divide-line">
        {items.map((item) => (
          <AgendaItem key={item.id} item={item} onMarkDone={onMarkDone} />
        ))}
      </div>
    </Card>
  )
}

function AgendaItem({ item, onMarkDone }: { item: CalendarItemDTO; onMarkDone: (item: CalendarItemDTO) => void }) {
  const navigate = useNavigate()
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      {item.kind === 'task' ? (
        <Checkbox checked={!!item.done} onChange={() => onMarkDone(item)} />
      ) : (
        <span className="size-[16px]" />
      )}
      <button
        type="button"
        onClick={() => navigate(itemHref(item))}
        className={cn(
          'min-w-0 flex-1 truncate text-left text-[13px]',
          item.kind === 'task' && item.done ? 'text-ink-400 line-through' : 'text-ink-800 hover:underline',
        )}
      >
        {item.title}
      </button>
      <Badge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</Badge>
    </div>
  )
}
