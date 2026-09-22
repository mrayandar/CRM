'use client'

import { Link } from '@/lib/router-compat'
import { ArrowUpRight, ChevronRight, Plus, TriangleAlert } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, DEAL_STAGE_TONE, StatusDot } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { BarChart, EmptyState } from '@/components/ui/Display'
import { MetricRow } from '@/components/common/MetricTile'
import { ActivityFeed } from '@/components/common/ActivityStream'
import { TaskRow } from '@/components/common/TaskRow'
import { useCrm } from '@/store/crm'
import { monthlyPerformance } from '@/data/mock'
import {
  DEAL_STAGE_LABEL,
  PIPELINE_STAGES,
  type DealStage,
} from '@/data/types'
import {
  currency,
  currencyCompact,
  dayDelta,
  formatDate,
  isThisMonth,
  percent,
  sortBy,
  sum,
} from '@/lib/utils'

const OPEN_STAGES: DealStage[] = ['discovery', 'proposal', 'negotiation', 'contract']

/** Period-over-period deltas — a real deployment would derive these from history. */
const TREND = { pipeline: 12.4, active: 6.1, won: -8.3, conversion: 4.2 }

export function Dashboard() {
  const { deals, leads, tasks, activities, currentUser, ownerById } = useCrm()

  const openDeals = deals.filter((d) => OPEN_STAGES.includes(d.stage))
  const openValue = sum(openDeals.map((d) => d.value))
  const weightedValue = sum(openDeals.map((d) => (d.value * d.probability) / 100))

  const wonDeals = deals.filter((d) => d.stage === 'won')
  const wonThisMonth = wonDeals.filter((d) => isThisMonth(d.closeDate))
  const wonThisMonthValue = sum(wonThisMonth.map((d) => d.value))

  const lostDeals = deals.filter((d) => d.stage === 'lost')
  const conversionRate = (wonDeals.length / Math.max(wonDeals.length + lostDeals.length, 1)) * 100

  const myTasks = sortBy(
    tasks.filter((t) => !t.done && t.ownerId === currentUser.id),
    (t) => new Date(t.dueDate).getTime(),
  )
  const overdue = tasks.filter((t) => !t.done && dayDelta(t.dueDate) < 0)
  const stalled = openDeals.filter((d) => dayDelta(d.updatedAt) <= -5)
  const untouchedLeads = leads.filter((l) => l.status === 'new')

  const closingSoon = sortBy(
    openDeals.filter((d) => dayDelta(d.closeDate) <= 30),
    (d) => new Date(d.closeDate).getTime(),
  ).slice(0, 5)

  const stageRows = PIPELINE_STAGES.filter((s) => s !== 'won').map((stage) => {
    const inStage = deals.filter((d) => d.stage === stage)
    return { stage, count: inStage.length, value: sum(inStage.map((d) => d.value)) }
  })
  const maxStageValue = Math.max(...stageRows.map((r) => r.value), 1)

  const chartData = monthlyPerformance.map((m, i) => ({
    label: m.month,
    value: m.won,
    target: m.target,
    highlight: i === monthlyPerformance.length - 1,
  }))

  return (
    <PageShell
      eyebrow={greeting()}
      title={`Good ${timeOfDay()}, ${currentUser.name.split(' ')[0]}`}
      actions={
        <>
          <Button variant="secondary" size="sm">
            Last 30 days
          </Button>
          <Button variant="primary" size="sm" icon={<Plus size={14} />}>
            New deal
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-[1440px] space-y-4 p-5">
        <MetricRow
          items={[
            {
              label: 'Open pipeline value',
              value: currencyCompact(openValue),
              delta: TREND.pipeline,
              emphasis: true,
              footer: `${currencyCompact(weightedValue)} weighted · ${openDeals.length} open deals`,
            },
            {
              label: 'Active deals',
              value: String(openDeals.length),
              delta: TREND.active,
              footer: `${stalled.length} with no activity in 5+ days`,
            },
            {
              label: 'Won this month',
              value: currencyCompact(wonThisMonthValue),
              delta: TREND.won,
              footer: `${wonThisMonth.length} deals closed · ${currencyCompact(280000)} target`,
            },
            {
              label: 'Conversion rate',
              value: percent(conversionRate),
              delta: TREND.conversion,
              footer: `${wonDeals.length} won / ${lostDeals.length} lost this quarter`,
            },
          ]}
        />

        {(overdue.length > 0 || untouchedLeads.length > 0 || stalled.length > 0) && (
          <AttentionBar
            overdue={overdue.length}
            untouched={untouchedLeads.length}
            stalled={stalled.length}
          />
        )}

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Card>
              <CardHeader
                title="Pipeline snapshot"
                subtitle={`${currency(openValue)} across ${openDeals.length} open deals`}
                action={
                  <Link to="/pipeline">
                    <Button variant="ghost" size="xs" trailingIcon={<ChevronRight size={13} />}>
                      Open board
                    </Button>
                  </Link>
                }
              />
              <ul className="divide-y divide-line">
                {stageRows.map(({ stage, count, value }) => (
                  <li key={stage}>
                    <Link
                      to="/pipeline"
                      className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-subtler"
                    >
                      <span className="flex w-[150px] shrink-0 items-center gap-2">
                        <StatusDot tone={DEAL_STAGE_TONE[stage]} />
                        <span className="text-[12.5px] font-medium text-ink-700">
                          {DEAL_STAGE_LABEL[stage]}
                        </span>
                      </span>
                      <span className="tabular w-9 shrink-0 text-[12px] text-ink-400">{count}</span>
                      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle">
                        <span
                          className="block h-full rounded-full bg-ink-700/80"
                          style={{ width: `${(value / maxStageValue) * 100}%` }}
                        />
                      </span>
                      <span className="tabular w-[84px] shrink-0 text-right text-[13px] font-semibold text-ink-900">
                        {currencyCompact(value)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-line bg-subtler px-5 py-2.5">
                <span className="text-[12px] text-ink-500">Weighted forecast</span>
                <span className="tabular text-[13px] font-semibold text-ink-900">
                  {currency(weightedValue)}
                </span>
              </div>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader
                  title="Won vs. target"
                  subtitle="Closed-won revenue, last 6 months"
                />
                <div className="px-5 pt-4 pb-4">
                  <BarChart data={chartData} valueFormat={currencyCompact} />
                  <div className="mt-3 flex items-center gap-4 border-t border-line pt-3">
                    <span className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
                      <span className="size-2 rounded-[2px] bg-brand-600" /> This month
                    </span>
                    <span className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
                      <span className="h-0 w-3 border-t border-dashed border-line-strong" /> Target
                    </span>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Closing in 30 days"
                  subtitle={`${currencyCompact(sum(closingSoon.map((d) => d.value)))} committed`}
                />
                {closingSoon.length === 0 ? (
                  <EmptyState title="Nothing closing soon" description="No open deals have a close date in the next 30 days." />
                ) : (
                  <ul className="divide-y divide-line">
                    {closingSoon.map((deal) => {
                      const owner = ownerById(deal.ownerId)
                      const days = dayDelta(deal.closeDate)
                      return (
                        <li key={deal.id}>
                          <Link
                            to="/pipeline"
                            className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-subtler"
                          >
                            <Avatar name={owner.name} initials={owner.initials} size="xs" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium text-ink-900">
                                {deal.company}
                              </span>
                              <span className="tabular block text-[11.5px] text-ink-400">
                                {formatDate(deal.closeDate)} · {days <= 7 ? `${days}d left` : DEAL_STAGE_LABEL[deal.stage]}
                              </span>
                            </span>
                            <span className="tabular shrink-0 text-[12.5px] font-semibold text-ink-900">
                              {currencyCompact(deal.value)}
                            </span>
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </Card>
            </div>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Today's focus"
                subtitle={`${myTasks.length} open tasks assigned to you`}
                action={
                  <Link to="/tasks">
                    <Button variant="ghost" size="xs">
                      All tasks
                    </Button>
                  </Link>
                }
              />
              {myTasks.length === 0 ? (
                <EmptyState title="Inbox zero" description="No open tasks assigned to you." />
              ) : (
                <div className="divide-y divide-line">
                  {myTasks.slice(0, 4).map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Recent activity"
                subtitle="Across the whole team"
                action={
                  <Badge tone="neutral">{activities.length}</Badge>
                }
              />
              <ActivityFeed items={activities} limit={8} />
              <div className="border-t border-line px-5 py-2.5 text-center">
                <Button variant="ghost" size="xs" trailingIcon={<ArrowUpRight size={12} />}>
                  View full history
                </Button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </PageShell>
  )
}

function AttentionBar({
  overdue,
  untouched,
  stalled,
}: {
  overdue: number
  untouched: number
  stalled: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-warning-line bg-warning-soft px-5 py-3">
      <span className="flex items-center gap-2 text-[12.5px] font-semibold text-warning">
        <TriangleAlert size={14} />
        Needs attention
      </span>
      <span className="h-4 w-px bg-warning-line" />
      <AttentionItem to="/tasks" count={overdue} label="overdue tasks" />
      <AttentionItem to="/leads?status=new" count={untouched} label="leads never contacted" />
      <AttentionItem to="/pipeline" count={stalled} label="deals stalled 5+ days" />
    </div>
  )
}

function AttentionItem({ to, count, label }: { to: string; count: number; label: string }) {
  if (count === 0) return null
  return (
    <Link
      to={to}
      className="group flex items-center gap-1.5 text-[12.5px] text-ink-700 hover:text-ink-900"
    >
      <span className="tabular font-semibold">{count}</span>
      <span className="group-hover:underline">{label}</span>
      <ChevronRight size={12} className="text-ink-400" />
    </Link>
  )
}

function timeOfDay(): string {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

function greeting(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}
