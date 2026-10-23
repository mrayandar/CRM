'use client'

import { useState } from 'react'
import { Link } from '@/lib/router-compat'
import { ArrowUpRight, ChevronRight, Plus, TriangleAlert } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, StatusDot, Tag, stageTone } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { BarChart, EmptyState } from '@/components/ui/Display'
import { Segmented } from '@/components/ui/Field'
import { MetricRow } from '@/components/common/MetricTile'
import { ActivityFeed } from '@/components/common/ActivityStream'
import { TaskRow } from '@/components/common/TaskRow'
import { NewDealModal } from '@/components/common/NewDealModal'
import { useCrm } from '@/store/crm'
import type { Payment } from '@/data/types'
import {
  currency,
  currencyCompact,
  dayDelta,
  formatDate,
  isAwaitingMilestone,
  isPaymentOverdue,
  momDelta,
  percent,
  receivedTotal,
  sortBy,
  sum,
  weightedValue,
} from '@/lib/utils'
import {
  isClosingSoon,
  isInCurrentQuarter,
  isMonthsAgo,
  isTaskDueToday,
  isTaskOverdue,
  isThisMonth,
  monthlyWonRevenue,
} from '@lib/timePeriods'
import { resolveBrowserTimezone } from '@lib/timezones'

export function Dashboard() {
  const {
    deals,
    leads,
    tasks,
    activities,
    currentUser,
    ownerById,
    stages,
    stageById,
    quarterlyQuota,
    orgCurrency,
    effectiveOrgTimezone,
    payments,
    canAccessPayments,
    isScopedMember,
  } = useCrm()
  // Personal day boundaries (tasks due today/overdue) use the viewer's own timezone, falling
  // back to the browser's resolved zone while it's unset (prompted for in Settings, never
  // silently assumed to be UTC). Every other date-boundary rule here is an org-wide business
  // period and uses effectiveOrgTimezone instead — the org's configured zone once an admin has
  // set one, otherwise this same viewer fallback (never a silent, un-chosen "UTC") — see
  // resolveOrgTimezone in lib/timezones.ts.
  const viewerTimezone = currentUser.timezone ?? resolveBrowserTimezone()
  const [newDealOpen, setNewDealOpen] = useState(false)
  const [taskScope, setTaskScope] = useState<'mine' | 'team'>('mine')
  // Bound to this org's currency — see src/lib/utils.ts; every money display on this page goes
  // through one of these two instead of the raw currency()/currencyCompact() exports.
  const fmt = (v: number) => currency(v, orgCurrency)
  const fmtCompact = (v: number) => currencyCompact(v, orgCurrency)
  const openStages = sortBy(stages.filter((s) => !s.isClosed), (s) => s.order)

  const openDeals = deals.filter((d) => !stageById(d.stageId).isClosed)
  const openValue = sum(openDeals.map((d) => d.value))
  const weightedTotal = sum(openDeals.map(weightedValue))

  const wonDeals = deals.filter((d) => stageById(d.stageId).isWon)
  const wonThisMonth = wonDeals.filter((d) => isThisMonth(d.closeDate, effectiveOrgTimezone))
  const wonLastMonth = wonDeals.filter((d) => isMonthsAgo(d.closeDate, 1, effectiveOrgTimezone))
  const wonThisMonthValue = sum(wonThisMonth.map((d) => d.value))
  const wonDelta = momDelta(wonThisMonthValue, sum(wonLastMonth.map((d) => d.value)))

  // The quota (Settings -> Workspace) is explicitly quarterly, so it's compared against
  // quarter-to-date revenue, not the month-to-date figure the tile's headline value shows.
  const wonThisQuarterValue = sum(
    wonDeals.filter((d) => isInCurrentQuarter(d.closeDate, effectiveOrgTimezone)).map((d) => d.value),
  )
  const quotaProgress = quarterlyQuota ? Math.min((wonThisQuarterValue / quarterlyQuota) * 100, 999) : null

  const lostDeals = deals.filter((d) => {
    const s = stageById(d.stageId)
    return s.isClosed && !s.isWon
  })
  const conversionRate = (wonDeals.length / Math.max(wonDeals.length + lostDeals.length, 1)) * 100

  // Real month-over-month conversion trend — only shown when both months actually had closed
  // deals to compute a rate from; otherwise there's nothing honest to compare.
  const closedThisMonth = deals.filter((d) => stageById(d.stageId).isClosed && isThisMonth(d.closeDate, effectiveOrgTimezone))
  const closedLastMonth = deals.filter((d) => stageById(d.stageId).isClosed && isMonthsAgo(d.closeDate, 1, effectiveOrgTimezone))
  const conversionThisMonth = closedThisMonth.length
    ? (closedThisMonth.filter((d) => stageById(d.stageId).isWon).length / closedThisMonth.length) * 100
    : null
  const conversionLastMonth = closedLastMonth.length
    ? (closedLastMonth.filter((d) => stageById(d.stageId).isWon).length / closedLastMonth.length) * 100
    : null
  const conversionDelta =
    conversionThisMonth !== null && conversionLastMonth !== null
      ? momDelta(conversionThisMonth, conversionLastMonth)
      : null

  const myOpenTasks = tasks.filter((t) => !t.done && t.ownerId === currentUser.id)
  const teamOpenTasks = tasks.filter((t) => !t.done)
  // "Task workload" card: mine by default, toggled to the whole team. Grouped into
  // overdue/due-today/upcoming(7d) so the counts in each section header are real, unfiltered
  // counts straight off this array — never affected by how many rows are actually rendered below.
  const scopedTasks = taskScope === 'mine' ? myOpenTasks : teamOpenTasks
  const byDueDate = (list: typeof tasks) => sortBy(list, (t) => new Date(t.dueDate).getTime())
  const overdueTasks = byDueDate(scopedTasks.filter((t) => isTaskOverdue(t, viewerTimezone)))
  const dueTodayTasks = byDueDate(scopedTasks.filter((t) => isTaskDueToday(t, viewerTimezone)))
  const upcomingTasks = byDueDate(
    scopedTasks.filter((t) => dayDelta(t.dueDate) > 0 && dayDelta(t.dueDate) <= 7),
  )
  const TASK_SECTION_LIMIT = 5

  const overdue = tasks.filter((t) => !t.done && isTaskOverdue(t, viewerTimezone))
  const stalled = openDeals.filter((d) => dayDelta(d.updatedAt) <= -5)
  const untouchedLeads = leads.filter((l) => l.status === 'new')

  const closingSoon = sortBy(
    openDeals.filter((d) => isClosingSoon(d, effectiveOrgTimezone)),
    (d) => new Date(d.closeDate).getTime(),
  ).slice(0, 5)

  const stageRows = openStages.map((stage) => {
    const inStage = deals.filter((d) => d.stageId === stage.id)
    return { stage, count: inStage.length, value: sum(inStage.map((d) => d.value)) }
  })
  const maxStageValue = Math.max(...stageRows.map((r) => r.value), 1)

  const monthlyRevenue = monthlyWonRevenue(wonDeals, effectiveOrgTimezone, 6)
  const hasRevenueHistory = monthlyRevenue.some((m) => m.value > 0)
  const chartData = monthlyRevenue.map((m, i) => ({
    label: m.month,
    value: m.value,
    highlight: i === monthlyRevenue.length - 1,
  }))

  return (
    <PageShell
      eyebrow={greeting()}
      title={`Good ${timeOfDay()}, ${currentUser.name.split(' ')[0]}`}
      actions={
        <>
          <Button variant="secondary" size="sm" disabled>
            Last 30 days
          </Button>
          <Tag>Coming soon</Tag>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setNewDealOpen(true)}
          >
            New deal
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-[1440px] space-y-4 p-5">
        <MetricRow
          items={[
            {
              // No historical snapshots of open pipeline value are kept, so there's nothing
              // honest to compare against — no delta, rather than a fabricated one.
              label: 'Open pipeline value',
              value: fmtCompact(openValue),
              emphasis: true,
              footer: `${fmtCompact(weightedTotal)} weighted · ${openDeals.length} open deals`,
            },
            {
              // Same reasoning: no time-series of the open-deal count exists to trend against.
              label: 'Active deals',
              value: String(openDeals.length),
              footer: `${stalled.length} with no activity in 5+ days`,
            },
            {
              label: 'Won this month',
              value: fmtCompact(wonThisMonthValue),
              ...(wonDelta !== null && { delta: wonDelta }),
              footer: (
                <>
                  {wonThisMonth.length} deals closed
                  {wonDelta === null && ' · not enough history for a trend yet'}
                  {quotaProgress !== null ? (
                    <>
                      {' · '}
                      {fmtCompact(wonThisQuarterValue)} of {fmtCompact(quarterlyQuota!)} quota this
                      quarter ({percent(quotaProgress)})
                    </>
                  ) : (
                    <>
                      {' · '}
                      <Link to="/settings" className="underline hover:text-ink-600">
                        Set a quota in Settings
                      </Link>{' '}
                      to see progress
                    </>
                  )}
                </>
              ),
            },
            {
              label: 'Conversion rate',
              value: percent(conversionRate),
              ...(conversionDelta !== null && { delta: conversionDelta }),
              footer: `${wonDeals.length} won / ${lostDeals.length} lost · all time`,
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
                subtitle={`${fmt(openValue)} across ${openDeals.length} open deals`}
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
                  <li key={stage.id}>
                    <Link
                      to="/pipeline"
                      className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-subtler"
                    >
                      <span className="flex w-[150px] shrink-0 items-center gap-2">
                        <StatusDot tone={stageTone(stage, openStages)} />
                        <span className="text-[12.5px] font-medium text-ink-700">
                          {stage.label}
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
                        {fmtCompact(value)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-line bg-subtler px-5 py-2.5">
                <span className="text-[12px] text-ink-500">Weighted forecast</span>
                <span className="tabular text-[13px] font-semibold text-ink-900">
                  {fmt(weightedTotal)}
                </span>
              </div>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader
                  title="Closed-won revenue"
                  subtitle="By month, last 6 months"
                />
                <div className="px-5 pt-4 pb-4">
                  {hasRevenueHistory ? (
                    <>
                      <BarChart data={chartData} valueFormat={fmtCompact} />
                      <div className="mt-3 flex items-center gap-4 border-t border-line pt-3">
                        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
                          <span className="size-2 rounded-[2px] bg-brand-600" /> This month
                        </span>
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      title="No closed-won deals yet"
                      description="Revenue will show up here once deals start closing as Won."
                    />
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Closing in 30 days"
                  subtitle={`${fmtCompact(sum(closingSoon.map((d) => d.value)))} committed`}
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
                                {formatDate(deal.closeDate)} · {days <= 7 ? `${days}d left` : stageById(deal.stageId).label}
                              </span>
                            </span>
                            <span className="tabular shrink-0 text-[12.5px] font-semibold text-ink-900">
                              {fmtCompact(deal.value)}
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
                title="Task workload"
                subtitle={`${overdueTasks.length + dueTodayTasks.length + upcomingTasks.length} open ${taskScope === 'mine' ? 'tasks assigned to you' : 'team tasks'} · overdue, due today, or due within 7 days`}
                action={
                  <div className="flex items-center gap-2">
                    {/* Hidden for a scoped Member — "Team" would be a filter they're not allowed
                        to widen into anyway (see lib/scope.ts); `taskScope` already defaults to
                        'mine' so hiding this control alone is enough, no separate force-override
                        needed. Admins and ALL-mode orgs keep both options. */}
                    {!isScopedMember && (
                      <Segmented
                        value={taskScope}
                        onChange={setTaskScope}
                        options={[
                          { value: 'mine', label: 'Mine' },
                          { value: 'team', label: 'Team' },
                        ]}
                      />
                    )}
                    <Link to="/tasks">
                      <Button variant="ghost" size="xs">
                        All tasks
                      </Button>
                    </Link>
                  </div>
                }
              />
              {overdueTasks.length === 0 && dueTodayTasks.length === 0 && upcomingTasks.length === 0 ? (
                <EmptyState
                  title="Inbox zero"
                  description={
                    taskScope === 'mine'
                      ? 'Nothing overdue, due today, or due this week.'
                      : "Nothing overdue, due today, or due this week for the team."
                  }
                />
              ) : (
                <div className="divide-y divide-line">
                  {overdueTasks.length > 0 && (
                    <div>
                      <p className="px-5 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.07em] text-negative uppercase">
                        Overdue · {overdueTasks.length}
                      </p>
                      <div className="divide-y divide-line">
                        {overdueTasks.slice(0, TASK_SECTION_LIMIT).map((task) => (
                          <TaskRow key={task.id} task={task} showOwner={taskScope === 'team'} />
                        ))}
                      </div>
                      {overdueTasks.length > TASK_SECTION_LIMIT && (
                        <Link
                          to="/tasks"
                          className="block px-5 py-2 text-[11.5px] text-ink-500 hover:text-brand-700 hover:underline"
                        >
                          +{overdueTasks.length - TASK_SECTION_LIMIT} more overdue — view all
                        </Link>
                      )}
                    </div>
                  )}
                  {dueTodayTasks.length > 0 && (
                    <div>
                      <p className="px-5 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.07em] text-ink-400 uppercase">
                        Due today · {dueTodayTasks.length}
                      </p>
                      <div className="divide-y divide-line">
                        {dueTodayTasks.slice(0, TASK_SECTION_LIMIT).map((task) => (
                          <TaskRow key={task.id} task={task} showOwner={taskScope === 'team'} />
                        ))}
                      </div>
                      {dueTodayTasks.length > TASK_SECTION_LIMIT && (
                        <Link
                          to="/tasks"
                          className="block px-5 py-2 text-[11.5px] text-ink-500 hover:text-brand-700 hover:underline"
                        >
                          +{dueTodayTasks.length - TASK_SECTION_LIMIT} more due today — view all
                        </Link>
                      )}
                    </div>
                  )}
                  {upcomingTasks.length > 0 && (
                    <div>
                      <p className="px-5 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.07em] text-ink-400 uppercase">
                        Upcoming (7 days) · {upcomingTasks.length}
                      </p>
                      <div className="divide-y divide-line">
                        {upcomingTasks.slice(0, TASK_SECTION_LIMIT).map((task) => (
                          <TaskRow key={task.id} task={task} showOwner={taskScope === 'team'} />
                        ))}
                      </div>
                      {upcomingTasks.length > TASK_SECTION_LIMIT && (
                        <Link
                          to="/tasks"
                          className="block px-5 py-2 text-[11.5px] text-ink-500 hover:text-brand-700 hover:underline"
                        >
                          +{upcomingTasks.length - TASK_SECTION_LIMIT} more upcoming — view all
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* Admin-only — see canAccessPayments in lib/auth.ts. Computed from `payments` only,
                never from Deal values, same as the Payments screen's own totals. For a Member,
                `canAccessPayments` is false and `payments` is already [] (loadCrmData never
                queries Payment rows for them), so this renders nothing and has nothing to render
                from even if the gate were somehow bypassed client-side. */}
            {canAccessPayments && (
              <PaymentsSummaryCard payments={payments} orgCurrency={orgCurrency} orgTimezone={effectiveOrgTimezone} />
            )}

            <Card>
              <CardHeader
                title="Recent activity"
                subtitle="Across the whole team"
                action={
                  <Badge tone="neutral">{activities.length}</Badge>
                }
              />
              <ActivityFeed items={activities} limit={8} />
              <div className="flex items-center justify-center gap-2 border-t border-line px-5 py-2.5">
                <Button variant="ghost" size="xs" trailingIcon={<ArrowUpRight size={12} />} disabled>
                  View full history
                </Button>
                <Tag>Coming soon</Tag>
              </div>
            </Card>
          </div>
        </div>
      </div>

      {newDealOpen && <NewDealModal onClose={() => setNewDealOpen(false)} />}
    </PageShell>
  )
}

function PaymentsSummaryCard({
  payments,
  orgCurrency,
  orgTimezone,
}: {
  payments: Payment[]
  orgCurrency: string
  orgTimezone: string
}) {
  const fmtCompact = (v: number) => currencyCompact(v, orgCurrency)
  // Collected this month: status === 'paid' (via receivedTotal, never paidAt alone) AND paidAt
  // falls in the current calendar month — an org-wide business period, same as "won this month"
  // (see lib/timePeriods.ts). A payment paid and then cancelled fails the status check and is
  // correctly excluded even though its paidAt is still set.
  const paidThisMonth = payments.filter((p) => p.status === 'paid' && p.paidAt && isThisMonth(p.paidAt, orgTimezone))
  const collectedThisMonth = receivedTotal(paidThisMonth)
  const overduePayments = payments.filter(isPaymentOverdue)
  const overdueAmount = sum(overduePayments.map((p) => p.amount))
  const awaitingCount = payments.filter(isAwaitingMilestone).length

  return (
    <Card>
      <CardHeader
        title="Payments"
        subtitle="Admin-only"
        action={
          <Link to="/payments">
            <Button variant="ghost" size="xs" trailingIcon={<ChevronRight size={13} />}>
              Open
            </Button>
          </Link>
        }
      />
      <div className="grid grid-cols-3 divide-x divide-line">
        <div className="px-4 py-4">
          <p className="text-[11px] leading-4 text-ink-500">Collected this month</p>
          <p className="tabular mt-1.5 text-[17px] leading-5 font-semibold text-ink-900">
            {fmtCompact(collectedThisMonth)}
          </p>
        </div>
        <div className="px-4 py-4">
          <p className="text-[11px] leading-4 text-ink-500">Overdue</p>
          <p
            className={`tabular mt-1.5 text-[17px] leading-5 font-semibold ${
              overduePayments.length > 0 ? 'text-negative' : 'text-ink-900'
            }`}
          >
            {fmtCompact(overdueAmount)}
            <span className="ml-1 text-[11px] font-normal text-ink-400">· {overduePayments.length}</span>
          </p>
        </div>
        <div className="px-4 py-4">
          <p className="text-[11px] leading-4 text-ink-500">Awaiting milestone</p>
          <p className="tabular mt-1.5 text-[17px] leading-5 font-semibold text-ink-900">{awaitingCount}</p>
        </div>
      </div>
    </Card>
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
