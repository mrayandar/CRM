'use client'

import { useMemo } from 'react'
import { Download } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { BarChart, Meter } from '@/components/ui/Display'
import { MetricRow } from '@/components/common/MetricTile'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { useCrm } from '@/store/crm'
import { monthlyPerformance } from '@/data/mock'
import { DEAL_STAGE_LABEL, PIPELINE_STAGES, type LeadSource } from '@/data/types'
import { currency, currencyCompact, percent, sortBy, sum } from '@/lib/utils'

const SOURCES: LeadSource[] = ['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website']

export function Reports() {
  const { deals, leads, owners } = useCrm()

  const won = deals.filter((d) => d.stage === 'won')
  const lost = deals.filter((d) => d.stage === 'lost')
  const openDeals = deals.filter((d) => !['won', 'lost'].includes(d.stage))
  const winRate = (won.length / Math.max(won.length + lost.length, 1)) * 100
  const avgDealSize = won.length ? sum(won.map((d) => d.value)) / won.length : 0

  const bySource = useMemo(
    () =>
      sortBy(
        SOURCES.map((source) => {
          const sourceLeads = leads.filter((l) => l.source === source)
          const sourceDeals = deals.filter((d) => d.source === source)
          const sourceWon = sourceDeals.filter((d) => d.stage === 'won')
          const sourceLost = sourceDeals.filter((d) => d.stage === 'lost')
          return {
            source,
            leads: sourceLeads.length,
            qualified: sourceLeads.filter((l) => l.status === 'qualified').length,
            pipeline: sum(sourceDeals.filter((d) => !['won', 'lost'].includes(d.stage)).map((d) => d.value)),
            wonValue: sum(sourceWon.map((d) => d.value)),
            winRate:
              sourceWon.length + sourceLost.length > 0
                ? (sourceWon.length / (sourceWon.length + sourceLost.length)) * 100
                : null,
          }
        }),
        (row) => -row.pipeline,
      ),
    [leads, deals],
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

  return (
    <PageShell
      title="Reports"
      subtitle="Revenue performance, source efficiency, and rep attainment"
      actions={
        <>
          <Button variant="secondary" size="sm">
            This quarter
          </Button>
          <Button variant="secondary" size="sm" icon={<Download size={14} />}>
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
              delta: 9.8,
              emphasis: true,
              footer: `${won.length} deals closed this quarter`,
            },
            {
              label: 'Win rate',
              value: percent(winRate),
              delta: 3.4,
              footer: `${won.length} won vs. ${lost.length} lost`,
            },
            {
              label: 'Average deal size',
              value: currencyCompact(avgDealSize),
              delta: -4.1,
              footer: 'Across all closed-won deals',
            },
            {
              label: 'Avg. sales cycle',
              value: '38',
              unit: 'days',
              delta: -6.2,
              invertDelta: true,
              footer: 'First touch to signature',
            },
          ]}
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Revenue vs. target" subtitle="Closed-won by month" />
            <div className="px-5 py-4">
              <BarChart
                height={180}
                valueFormat={currencyCompact}
                data={monthlyPerformance.map((m, i) => ({
                  label: m.month,
                  value: m.won,
                  target: m.target,
                  highlight: i === monthlyPerformance.length - 1,
                }))}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Stage conversion" subtitle="Open deals by stage" />
            <ul className="divide-y divide-line">
              {PIPELINE_STAGES.filter((s) => s !== 'won').map((stage) => {
                const inStage = deals.filter((d) => d.stage === stage)
                const value = sum(inStage.map((d) => d.value))
                const share = (value / Math.max(sum(openDeals.map((d) => d.value)), 1)) * 100
                return (
                  <li key={stage} className="px-5 py-3">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[12.5px] font-medium text-ink-700">
                        {DEAL_STAGE_LABEL[stage]}
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
