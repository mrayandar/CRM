'use client'

import { useMemo, useState, type DragEvent } from 'react'
import { Link } from '@/lib/router-compat'
import {
  CalendarDays,
  Flame,
  GripVertical,
  MoreHorizontal,
  Plus,
  Settings2,
} from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge, DEAL_STAGE_TONE, StatusDot } from '@/components/ui/Badge'
import { Avatar, CompanyMark } from '@/components/ui/Avatar'
import { SearchInput, Segmented, Select } from '@/components/ui/Field'
import { MenuDivider, MenuItem, MenuLabel, Popover } from '@/components/ui/Menu'
import { useCrm } from '@/store/crm'
import {
  DEAL_STAGE_LABEL,
  DEAL_STAGE_ORDER,
  type Deal,
  type DealStage,
} from '@/data/types'
import { cn, currency, currencyCompact, dayDelta, formatDate, sortBy, sum } from '@/lib/utils'

const COLUMNS: DealStage[] = DEAL_STAGE_ORDER
const OPEN_STAGES: DealStage[] = ['discovery', 'proposal', 'negotiation', 'contract']

export function Pipeline() {
  const { deals, owners, ownerById, moveDeal, currentUser } = useCrm()
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('all')
  const [scope, setScope] = useState<'all' | 'mine'>('all')
  const [dragging, setDragging] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<DealStage | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return deals.filter((deal) => {
      if (scope === 'mine' && deal.ownerId !== currentUser.id) return false
      if (owner !== 'all' && deal.ownerId !== owner) return false
      if (!q) return true
      return `${deal.name} ${deal.company}`.toLowerCase().includes(q)
    })
  }, [deals, query, owner, scope, currentUser.id])

  const byStage = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((s) => [s, [] as Deal[]])) as Record<DealStage, Deal[]>
    for (const deal of visible) map[deal.stage].push(deal)
    for (const stage of COLUMNS) {
      map[stage] = sortBy(map[stage], (d) => -d.value)
    }
    return map
  }, [visible])

  const openValue = sum(visible.filter((d) => OPEN_STAGES.includes(d.stage)).map((d) => d.value))
  const weighted = sum(
    visible
      .filter((d) => OPEN_STAGES.includes(d.stage))
      .map((d) => (d.value * d.probability) / 100),
  )
  const maxColumnValue = Math.max(
    ...COLUMNS.map((stage) => sum(byStage[stage].map((d) => d.value))),
    1,
  )

  const handleDrop = (stage: DealStage) => (event: DragEvent) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/deal-id') || dragging
    if (id) moveDeal(id, stage)
    setDragging(null)
    setOverStage(null)
  }

  return (
    <PageShell
      title="Pipeline"
      subtitle={`${currency(openValue)} open · ${currency(weighted)} weighted · ${
        visible.filter((d) => OPEN_STAGES.includes(d.stage)).length
      } active deals`}
      actions={
        <>
          <Button variant="secondary" size="sm" icon={<Settings2 size={14} />}>
            Customize stages
          </Button>
          <Button variant="primary" size="sm" icon={<Plus size={14} />}>
            New deal
          </Button>
        </>
      }
      toolbar={
        <>
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search deals…"
            className="w-full sm:w-[250px]"
          />
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-[150px]">
            <option value="all">All owners</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All deals', count: deals.length },
              {
                value: 'mine',
                label: 'My deals',
                count: deals.filter((d) => d.ownerId === currentUser.id).length,
              },
            ]}
          />
          <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-ink-400 md:flex">
            <GripVertical size={12} />
            Drag a card to move it between stages
          </span>
        </>
      }
      contentClassName="overflow-hidden"
    >
      <div className="flex h-full gap-3 overflow-x-auto scrollbar-slim p-5">
        {COLUMNS.map((stage) => {
          const columnDeals = byStage[stage]
          const value = sum(columnDeals.map((d) => d.value))
          const isOver = overStage === stage

          return (
            <section
              key={stage}
              onDragOver={(e) => {
                e.preventDefault()
                setOverStage(stage)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage(null)
              }}
              onDrop={handleDrop(stage)}
              className={cn(
                'flex h-full w-[292px] shrink-0 flex-col rounded-card border bg-subtler/60 transition-colors duration-100',
                isOver ? 'border-brand-200 bg-brand-50/50' : 'border-line',
              )}
            >
              <header className="shrink-0 border-b border-line px-3.5 pt-3 pb-2.5">
                <div className="flex items-center gap-2">
                  <StatusDot tone={DEAL_STAGE_TONE[stage]} />
                  <h2 className="text-[12.5px] font-semibold tracking-[-0.005em] text-ink-800">
                    {DEAL_STAGE_LABEL[stage]}
                  </h2>
                  <span className="tabular rounded-full bg-surface px-1.5 text-[10.5px] leading-[17px] font-semibold text-ink-500 ring-1 ring-line">
                    {columnDeals.length}
                  </span>
                  <IconButton label={`Add deal to ${DEAL_STAGE_LABEL[stage]}`} className="ml-auto -mr-1.5 size-7">
                    <Plus size={13} />
                  </IconButton>
                </div>
                <p className="tabular mt-1.5 text-[15px] leading-5 font-semibold tracking-[-0.02em] text-ink-900">
                  {currencyCompact(value)}
                </p>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[#ececef]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-500',
                      stage === 'won'
                        ? 'bg-positive'
                        : stage === 'lost'
                          ? 'bg-negative/60'
                          : 'bg-ink-700/70',
                    )}
                    style={{ width: `${(value / maxColumnValue) * 100}%` }}
                  />
                </div>
              </header>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-slim p-2">
                {columnDeals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    ownerName={ownerById(deal.ownerId).name}
                    ownerInitials={ownerById(deal.ownerId).initials}
                    dragging={dragging === deal.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/deal-id', deal.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragging(deal.id)
                    }}
                    onDragEnd={() => {
                      setDragging(null)
                      setOverStage(null)
                    }}
                    onMove={(next) => moveDeal(deal.id, next)}
                  />
                ))}

                {columnDeals.length === 0 && (
                  <div
                    className={cn(
                      'flex h-24 items-center justify-center rounded-panel border border-dashed text-[12px]',
                      isOver
                        ? 'border-brand-200 bg-surface/60 text-brand-700'
                        : 'border-line-strong text-ink-400',
                    )}
                  >
                    {isOver ? 'Drop to move here' : 'No deals in this stage'}
                  </div>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </PageShell>
  )
}

function DealCard({
  deal,
  ownerName,
  ownerInitials,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  deal: Deal
  ownerName: string
  ownerInitials: string
  dragging: boolean
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onMove: (stage: DealStage) => void
}) {
  const days = dayDelta(deal.closeDate)
  const closed = deal.stage === 'won' || deal.stage === 'lost'
  const overdue = !closed && days < 0
  const urgent = !closed && days >= 0 && days <= 7

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'group/card cursor-grab rounded-panel border border-line bg-surface p-3 shadow-hairline',
        'transition-[box-shadow,transform,border-color] duration-100 active:cursor-grabbing',
        'hover:border-line-strong hover:shadow-lift',
        dragging && 'dragging',
      )}
    >
      <div className="flex items-start gap-2">
        <CompanyMark name={deal.company} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] leading-4 font-semibold text-ink-900">
            {deal.company}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-[15px] text-ink-500">
            {deal.name.includes('—') ? deal.name.split('—')[1]!.trim() : deal.name}
          </p>
        </div>
        <span onClick={(e) => e.stopPropagation()}>
          <Popover
            align="end"
            width={200}
            trigger={({ toggle, open }) => (
              <IconButton
                label={`Actions for ${deal.name}`}
                onClick={toggle}
                className={cn(
                  '-mt-1 -mr-1.5 size-7 text-ink-400',
                  open
                    ? 'bg-subtle text-ink-700'
                    : 'opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100',
                )}
              >
                <MoreHorizontal size={14} />
              </IconButton>
            )}
          >
            {({ close }) => (
              <>
                <MenuLabel>Move to stage</MenuLabel>
                {DEAL_STAGE_ORDER.map((stage) => (
                  <MenuItem
                    key={stage}
                    selected={deal.stage === stage}
                    onClick={() => {
                      onMove(stage)
                      close()
                    }}
                  >
                    {DEAL_STAGE_LABEL[stage]}
                  </MenuItem>
                ))}
                <MenuDivider />
                <MenuItem onClick={close}>Log activity</MenuItem>
                <MenuItem onClick={close}>Edit deal</MenuItem>
              </>
            )}
          </Popover>
        </span>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-2">
        <span className="tabular text-[16px] leading-5 font-semibold tracking-[-0.02em] text-ink-900">
          {currency(deal.value)}
        </span>
        {deal.priority === 'high' && !closed && (
          <span title="High priority" className="flex items-center gap-1 text-[11px] font-medium text-warning">
            <Flame size={11} />
            High
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <CalendarDays size={11} className="shrink-0 text-ink-400" />
          <span
            className={cn(
              'tabular truncate text-[11.5px]',
              overdue ? 'font-medium text-negative' : urgent ? 'font-medium text-warning' : 'text-ink-500',
            )}
          >
            {closed
              ? `Closed ${formatDate(deal.closeDate)}`
              : overdue
                ? `${-days}d overdue`
                : `${formatDate(deal.closeDate)} · ${days}d`}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {!closed && (
            <span className="tabular text-[11px] font-medium text-ink-400">{deal.probability}%</span>
          )}
          {closed && (
            <Badge tone={deal.stage === 'won' ? 'positive' : 'negative'}>
              {deal.stage === 'won' ? 'Won' : 'Lost'}
            </Badge>
          )}
          {deal.contactId ? (
            <Link to={`/contacts/${deal.contactId}`} onClick={(e) => e.stopPropagation()}>
              <Avatar name={ownerName} initials={ownerInitials} size="xs" title={`Owner: ${ownerName}`} />
            </Link>
          ) : (
            <Avatar name={ownerName} initials={ownerInitials} size="xs" title={`Owner: ${ownerName}`} />
          )}
        </span>
      </div>
    </article>
  )
}
