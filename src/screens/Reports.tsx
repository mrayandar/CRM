'use client'

import { useMemo } from 'react'
import { Download } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { BarChart, EmptyState, Meter } from '@/components/ui/Display'
import { MetricRow } from '@/components/common/MetricTile'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { useCrm } from '@/store/crm'
import type { LeadSource } from '@/data/types'
import {
  currency,
  currencyCompact,
  exportCsv,
  isMonthsAgo,
  isThisMonth,
  momDelta,
  monthlyWonRevenue,
  percent,
  sortBy,
  sum,
} from '@/lib/utils'

const SOURCES: LeadSource[] = ['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website']

export function Reports() {
  const { deals, leads, owners, stages, stageById } = useCrm()
  const openStages = sortBy(stages.filter((s) => !s.isClosed), (s) => s.order)

  const won = deals.filter((d) => stageById(d.stageId).isWon)
  const lost = deals.filter((d) => {
    const s = stageById(d.stageId)
    return s.isClosed && !s.isWon
  })
  const openDeals = deals.filter((d) => !stageById(d.stageId).isClosed)
  const winRate = (won.length / Math.max(won.length + lost.length, 1)) * 100
  const avgDealSize = won.length ? sum(won.map((d) => d.value)) / won.length : 0

  // Real month-over-month comparisons — each is null (rendered as no delta badge) unless both
  // the current and prior calendar month actually have the data needed to compare.
  const wonThisMonth = won.filter((d) => isThisMonth(d.closeDate))
  const wonLastMonth = won.filter((d) => isMonthsAgo(d.closeDate, 1))
  const revenueDelta = momDelta(sum(wonThisMonth.map((d) => d.value)), sum(wonLastMonth.map((d) => d.value)))

  const closedThisMonth = deals.filter((d) => stageById(d.stageId).isClosed && isThisMonth(d.closeDate))
  const closedLastMonth = deals.filter((d) => stageById(d.stageId).isClosed && isMonthsAgo(d.closeDate, 1))
  const winRateThisMonth = closedThisMonth.length
    ? (closedThisMonth.filter((d) => stageById(d.stageId).isWon).length / closedThisMonth.length) * 100
    : null
  const winRateLastMonth = closedLastMonth.length
    ? (closedLastMonth.filter((d) => stageById(d.stageId).isWon).length / closedLastMonth.length) * 100
    : null
  const winRateDelta =
    winRateThisMonth !== null && winRateLastMonth !== null ? momDelta(winRateThisMonth, winRateLastMonth) : null

  const avgDealSizeThisMonth = wonThisMonth.length ? sum(wonThisMonth.map((d) => d.value)) / wonThisMonth.length : null
  const avgDealSizeLastMonth = wonLastMonth.length ? sum(wonLastMonth.map((d) => d.value)) / wonLastMonth.length : null
  const avgDealSizeDelta =
    avgDealSizeThisMonth !== null && avgDealSizeLastMonth !== null
      ? momDelta(avgDealSizeThisMonth, avgDealSizeLastMonth)
      : null

  // Average days from a deal being opened to closing as Won — a real, if rough, cycle-time proxy
  // (we don't track a distinct "first touch" event, so this is creation-to-close, not
  // touch-to-signature as an idealized sales-cycle metric would use). Floored at 0 per deal: a
  // deal can't really close before it was created, but a demo/backfilled row's closeDate can
  // predate its own createdAt — clamping avoids a nonsensical negative average from that, without
  // fabricating anything for deals where the data is sound.
  const cycleDaysOf = (rows: typeof won) =>
    rows.length
      ? sum(rows.map((d) => Math.max(0, (+new Date(d.closeDate) - +new Date(d.createdAt)) / 86_400_000))) / rows.length
      : null
  const salesCycleDays = cycleDaysOf(won)
  const salesCycleThisMonth = cycleDaysOf(wonThisMonth)
  const salesCycleLastMonth = cycleDaysOf(wonLastMonth)
  const salesCycleDelta =
    salesCycleThisMonth !== null && salesCycleLastMonth !== null
      ? momDelta(salesCycleThisMonth, salesCycleLastMonth)
      : null

  const bySource = useMemo(
    () =>
      sortBy(
        SOURCES.map((source) => {
          const sourceLeads = leads.filter((l) => l.source === source)
          const sourceDeals = deals.filter((d) => d.source === source)
          const sourceWon = sourceDeals.filter((d) => stageById(d.stageId).isWon)
          const sourceLost = sourceDeals.filter((d) => {
            const s = stageById(d.stageId)
            return s.isClosed && !s.isWon
          })
          return {
            source,
            leads: sourceLeads.length,
            qualified: sourceLeads.filter((l) => l.status === 'qualified').length,
            pipeline: sum(sourceDeals.filter((d) => !stageById(d.stageId).isClosed).map((d) => d.value)),
            wonValue: sum(sourceWon.map((d) => d.value)),
            winRate:
              sourceWon.length + sourceLost.length > 0
                ? (sourceWon.length / (sourceWon.length + sourceLost.length)) * 100
                : null,
          }
        }),
        (row) => -row.pipeline,
      ),
    [leads, deals, stageById],
  )

  const leaderboard = useMemo(
    () =>
      sortBy(
        owners.map((owner) => {
          const ownerWon = won.filter((d) => d.ownerId === owner.id)
          const ownerOpen = openDeals.filter((d) => d.ownerId === owner.id)
          return {
            owner,
            wonValue: sum(ownerWon.map((d) => d.value)),
            wonCount: ownerWon.length,
            pipeline: sum(ownerOpen.map((d) => d.value)),
            openCount: ownerOpen.length,
          }
        }),
        (row) => -row.wonValue,
      ),
    [owners, won, openDeals],
  )

  const maxWon = Math.max(...leaderboard.map((r) => r.wonValue), 1)
  const maxSourcePipeline = Math.max(...bySource.map((r) => r.pipeline), 1)

  // The page shows two real tables (no single flat list the way Leads/Contacts/Pipeline do), so
  // Export writes one CSV per table — same exportCsv() used everywhere else, just called twice.
  const exportReports = () => {
    exportCsv(
      'reports-by-source.csv',
      bySource.map((row) => ({
        source: row.source,
        leads: row.leads,
        qualified: row.qualified,
        qualificationRate: row.leads ? Math.round((row.qualified / row.leads) * 100) : '',
        openPipeline: row.pipeline,
        closedWon: row.wonValue,
        winRate: row.winRate === null ? '' : Math.round(row.winRate),
      })),
    )
    exportCsv(
      'reports-rep-attainment.csv',
      leaderboard.map((row) => ({
        rep: row.owner.name,
        role: row.owner.role,
        closedWon: row.wonValue,
        dealsWon: row.wonCount,
        openPipeline: row.pipeline,
        openDeals: row.openCount,
      })),
    )
  }

  const monthlyRevenue = monthlyWonRevenue(won, 6)
  const hasRevenueHistory = monthlyRevenue.some((m) => m.value > 0)
  const chartData = monthlyRevenue.map((m, i) => ({
    label: m.month,
    value: m.value,
    highlight: i === monthlyRevenue.length - 1,
  }))

  return (
    <PageShell
      title="Reports"
      subtitle="Revenue performance, source efficiency, and rep attainment"
      actions={
        <>
          <Button variant="secondary" size="sm">
            This quarter
          </Button>
          <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={exportReports}>
            Export
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-[1440px] space-y-4 p-5">
        <MetricRow
          items={[
            {
              label: 'Closed-won revenue',
              value: currencyCompact(sum(won.map((d) => d.value))),
              ...(revenueDelta !== null && { delta: revenueDelta }),
              emphasis: true,
              footer: `${won.length} deals closed-won · all time`,
            },
            {
              label: 'Win rate',
              value: percent(winRate),
              ...(winRateDelta !== null && { delta: winRateDelta }),
              footer: `${won.length} won vs. ${lost.length} lost`,
            },
            {
              label: 'Average deal size',
              value: currencyCompact(avgDealSize),
              ...(avgDealSizeDelta !== null && { delta: avgDealSizeDelta }),
              footer: 'Across all closed-won deals',
            },
            {
              label: 'Avg. sales cycle',
              value: salesCycleDays === null ? '—' : salesCycleDays.toFixed(0),
              unit: salesCycleDays === null ? undefined : 'days',
              ...(salesCycleDelta !== null && { delta: salesCycleDelta, invertDelta: true }),
              // Deal creation to close — we don't track a distinct "first touch" event, so this
              // is a real but rougher proxy than an idealized touch-to-signature metric.
              footer: salesCycleDays === null ? 'No closed-won deals yet' : 'Deal creation to close',
            },
          ]}
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Closed-won revenue" subtitle="By month, last 6 months" />
            <div className="px-5 py-4">
              {hasRevenueHistory ? (
                <BarChart height={180} valueFormat={currencyCompact} data={chartData} />
              ) : (
                <EmptyState
                  title="No closed-won deals yet"
                  description="Revenue will show up here once deals start closing as Won."
                />
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Stage conversion" subtitle="Open deals by stage" />
            <ul className="divide-y divide-line">
              {openStages.map((stage) => {
                const inStage = deals.filter((d) => d.stageId === stage.id)
                const value = sum(inStage.map((d) => d.value))
                const share = (value / Math.max(sum(openDeals.map((d) => d.value)), 1)) * 100
                return (
                  <li key={stage.id} className="px-5 py-3">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[12.5px] font-medium text-ink-700">
                        {stage.label}
                      </span>
                      <span className="tabular text-[12.5px] font-semibold text-ink-900">
                        {currencyCompact(value)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <Meter value={share} />
                      <span className="tabular w-10 shrink-0 text-right text-[11.5px] text-ink-400">
                        {percent(share)}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <CardHeader
            title="Performance by lead source"
            subtitle="Which channels actually produce revenue"
          />
          <TableShell>
            <Thead>
              <Th>Source</Th>
              <Th align="right">Leads</Th>
              <Th align="right">Qualified</Th>
              <Th align="right">Qualification rate</Th>
              <Th align="right">Open pipeline</Th>
              <Th align="right">Closed-won</Th>
              <Th align="right">Win rate</Th>
            </Thead>
            <tbody>
              {bySource.map((row) => (
                <Tr key={row.source}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] font-medium text-ink-900">{row.source}</span>
                      <span className="h-1 w-16 overflow-hidden rounded-full bg-subtle">
                        <span
                          className="block h-full rounded-full bg-ink-700/70"
                          style={{ width: `${(row.pipeline / maxSourcePipeline) * 100}%` }}
                        />
                      </span>
                    </div>
                  </Td>
                  <Td align="right" className="tabular">
                    {row.leads}
                  </Td>
                  <Td align="right" className="tabular">
                    {row.qualified}
                  </Td>
                  <Td align="right" className="tabular text-ink-500">
                    {row.leads ? percent((row.qualified / row.leads) * 100) : '—'}
                  </Td>
                  <Td align="right" className="tabular font-medium text-ink-900">
                    {currency(row.pipeline)}
                  </Td>
                  <Td align="right" className="tabular font-medium text-ink-900">
                    {row.wonValue > 0 ? currency(row.wonValue) : '—'}
                  </Td>
                  <Td align="right">
                    <span
                      className={
                        row.winRate === null
                          ? 'tabular text-ink-400'
                          : row.winRate >= 50
                            ? 'tabular font-medium text-positive'
                            : 'tabular font-medium text-negative'
                      }
                    >
                      {row.winRate === null ? '—' : percent(row.winRate)}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Rep attainment" subtitle="Closed-won and open pipeline per owner" />
          <TableShell>
            <Thead>
              <Th>Rep</Th>
              <Th>Attainment</Th>
              <Th align="right">Closed-won</Th>
              <Th align="right">Deals won</Th>
              <Th align="right">Open pipeline</Th>
              <Th align="right">Open deals</Th>
            </Thead>
            <tbody>
              {leaderboard.map((row) => (
                <Tr key={row.owner.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={row.owner.name} initials={row.owner.initials} size="md" />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] leading-[17px] font-medium text-ink-900">
                          {row.owner.name}
                        </p>
                        <p className="truncate text-[11.5px] leading-4 text-ink-400">
                          {row.owner.role}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td className="w-[220px]">
                    <Meter
                      value={(row.wonValue / maxWon) * 100}
                      tone={row.wonValue === maxWon ? 'brand' : 'neutral'}
                    />
                  </Td>
                  <Td align="right" className="tabular font-medium text-ink-900">
                    {row.wonValue > 0 ? currency(row.wonValue) : '—'}
                  </Td>
                  <Td align="right" className="tabular">
                    {row.wonCount}
                  </Td>
                  <Td align="right" className="tabular font-medium text-ink-900">
                    {currency(row.pipeline)}
                  </Td>
                  <Td align="right" className="tabular">
                    {row.openCount}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        </Card>
      </div>
    </PageShell>
  )
}
