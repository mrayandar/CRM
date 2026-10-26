'use client'

import { useMemo, useState, type DragEvent } from 'react'
import { Link } from '@/lib/router-compat'
import {
  CalendarDays,
  Download,
  Flame,
  GripVertical,
  MoreHorizontal,
  Plus,
  Settings2,
} from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge, StatusDot, stageTone } from '@/components/ui/Badge'
import { Avatar, CompanyMark } from '@/components/ui/Avatar'
import { SearchInput, Segmented, Select } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { MenuDivider, MenuItem, MenuLabel, Popover } from '@/components/ui/Menu'
import { NewDealModal } from '@/components/common/NewDealModal'
import { EditDealModal } from '@/components/common/EditDealModal'
import { StageManager } from '@/components/common/StageManager'
import { useNavigate } from '@/lib/router-compat'
import { useCrm } from '@/store/crm'
import type { Deal, Payment, PipelineStage } from '@/data/types'
import { cn, currency, currencyCompact, dayDelta, exportCsv, formatDate, receivedTotal, sortBy, sum, weightedValue } from '@/lib/utils'

export function Pipeline() {
  const { deals, owners, ownerById, moveDeal, currentUser, stages, orgCurrency, payments, canAccessPayments, isScopedMember } = useCrm()
  const fmt = (v: number) => currency(v, orgCurrency)
  const fmtCompact = (v: number) => currencyCompact(v, orgCurrency)
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('all')
  const [scope, setScope] = useState<'all' | 'mine'>('all')
  // null = closed; `stageId` pre-selects a column's stage (from that column's "+")
  const [newDeal, setNewDeal] = useState<{ stageId?: string } | null>(null)
  const [editDealId, setEditDealId] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<string | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)

  const columns = useMemo(() => sortBy(stages, (s) => s.order), [stages])
  const openStageIds = useMemo(() => new Set(columns.filter((s) => !s.isClosed).map((s) => s.id)), [columns])

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
    const map = Object.fromEntries(columns.map((s) => [s.id, [] as Deal[]])) as Record<string, Deal[]>
    for (const deal of visible) (map[deal.stageId] ??= []).push(deal)
    for (const stageId of Object.keys(map)) {
      map[stageId] = sortBy(map[stageId]!, (d) => -d.value)
    }
    return map
  }, [visible, columns])

  const openValue = sum(visible.filter((d) => openStageIds.has(d.stageId)).map((d) => d.value))
  const weighted = sum(visible.filter((d) => openStageIds.has(d.stageId)).map(weightedValue))
  const maxColumnValue = Math.max(
    ...columns.map((stage) => sum((byStage[stage.id] ?? []).map((d) => d.value))),
    1,
  )

  const editingDeal = editDealId ? deals.find((d) => d.id === editDealId) : undefined

  const exportDeals = () => {
    exportCsv(
      'deals.csv',
      visible.map((deal) => ({
        name: deal.name,
        company: deal.company,
        value: deal.value,
        currency: orgCurrency,
        stage: columns.find((s) => s.id === deal.stageId)?.label ?? '',
        probability: deal.probability,
        closeDate: deal.closeDate,
        owner: ownerById(deal.ownerId).name,
        priority: deal.priority,
      })),
    )
  }

  const handleDrop = (stageId: string) => (event: DragEvent) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/deal-id') || dragging
    if (id) moveDeal(id, stageId)
    setDragging(null)
    setOverStage(null)
  }

  return (
    <PageShell
      title="Pipeline"
      subtitle={`${fmt(openValue)} open · ${fmt(weighted)} weighted · ${
        visible.filter((d) => openStageIds.has(d.stageId)).length
      } active deals`}
      actions={
        <>
          <Button
            variant="secondary"
            size="sm"
            icon={<Settings2 size={14} />}
            onClick={() => setCustomizeOpen(true)}
          >
            Customize stages
          </Button>
          <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={exportDeals}>
            Export
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setNewDeal({})}
          >
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
          {/* Both hidden for a scoped Member — `deals` is already narrowed to their own records
              server-side, so an owner filter or an all/my toggle would have nothing left to
              filter. `owner` stays 'all' and `scope` stays 'all' in that case, which is already a
              no-op against an already-scoped `deals` array. Admins and ALL-mode orgs keep both. */}
          {!isScopedMember && (
            <>
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
            </>
          )}
          {/* The column headers' deal counts and totals come straight from `deals`, which is
              already scoped — this makes that explicit so a scoped Member doesn't read a
              column's total as the team's. */}
          {isScopedMember && (
            <span className="text-[11.5px] text-ink-400">Showing your own deals</span>
          )}
          <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-ink-400 md:flex">
            <GripVertical size={12} />
            Drag a card to move it between stages
          </span>
        </>
      }
      contentClassName="overflow-hidden"
    >
      <div className="flex h-full gap-3 overflow-x-auto scrollbar-slim p-5">
        {columns.map((stage) => {
          const columnDeals = byStage[stage.id] ?? []
          const value = sum(columnDeals.map((d) => d.value))
          const isOver = overStage === stage.id
          const openStages = columns.filter((s) => !s.isClosed)

          return (
            <section
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault()
                setOverStage(stage.id)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage(null)
              }}
              onDrop={handleDrop(stage.id)}
              className={cn(
                'flex h-full w-[292px] shrink-0 flex-col rounded-card border bg-subtler/60 transition-colors duration-100',
                isOver ? 'border-brand-200 bg-brand-50/50' : 'border-line',
              )}
            >
              <header className="shrink-0 border-b border-line px-3.5 pt-3 pb-2.5">
                <div className="flex items-center gap-2">
                  <StatusDot tone={stageTone(stage, openStages)} />
                  <h2 className="text-[12.5px] font-semibold tracking-[-0.005em] text-ink-800">
                    {stage.label}
                  </h2>
                  <span className="tabular rounded-full bg-surface px-1.5 text-[10.5px] leading-[17px] font-semibold text-ink-500 ring-1 ring-line">
                    {columnDeals.length}
                  </span>
                  <IconButton
                    label={`Add deal to ${stage.label}`}
                    onClick={() => setNewDeal({ stageId: stage.id })}
                    className="ml-auto -mr-1.5 size-7"
                  >
                    <Plus size={13} />
                  </IconButton>
                </div>
                <p className="tabular mt-1.5 text-[15px] leading-5 font-semibold tracking-[-0.02em] text-ink-900">
                  {fmtCompact(value)}
                </p>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[#ececef]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-500',
                      stage.isWon
                        ? 'bg-positive'
                        : stage.isClosed
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
                    stage={stage}
                    columns={columns}
                    ownerName={ownerById(deal.ownerId).name}
                    ownerInitials={ownerById(deal.ownerId).initials}
                    ownerAvatarUrl={ownerById(deal.ownerId).avatarUrl}
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
                    onEdit={() => setEditDealId(deal.id)}
                    canAccessPayments={canAccessPayments}
                    dealPayments={canAccessPayments ? payments.filter((p) => p.dealId === deal.id) : []}
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

      {newDeal && <NewDealModal onClose={() => setNewDeal(null)} defaultStageId={newDeal.stageId} />}

      {editingDeal && <EditDealModal deal={editingDeal} onClose={() => setEditDealId(null)} />}

      <Modal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        width={560}
        title="Customize stages"
        description="Rename, reorder, add, or remove pipeline stages for your organization."
        footer={
          <Button variant="primary" onClick={() => setCustomizeOpen(false)}>
            Done
          </Button>
        }
      >
        <StageManager />
      </Modal>
    </PageShell>
  )
}

function DealCard({
  deal,
  stage,
  columns,
  ownerName,
  ownerInitials,
  ownerAvatarUrl,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  onEdit,
  canAccessPayments,
  dealPayments,
}: {
  deal: Deal
  stage: PipelineStage
  columns: PipelineStage[]
  ownerName: string
  ownerInitials: string
  ownerAvatarUrl: string | null
  dragging: boolean
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onMove: (stageId: string) => void
  onEdit: () => void
  /** Privileged users only — see canAccessPayments in lib/auth.ts. Gates both the "View payments"
   *  menu item and the received-vs-value progress bar below. */
  canAccessPayments: boolean
  /** Already filtered to this deal and already [] for a non-privileged caller (see Pipeline()) —
   *  this component does no gating of its own, it just renders what it's given. */
  dealPayments: Payment[]
}) {
  const { logActivity, orgCurrency, openWonPaymentSetup } = useCrm()
  const navigate = useNavigate()
  const days = dayDelta(deal.closeDate)
  const closed = stage.isClosed
  const overdue = !closed && days < 0
  const urgent = !closed && days >= 0 && days <= 7
  const received = receivedTotal(dealPayments)

  const ACTIVITY_VERB = { call: 'called', email: 'emailed', meeting: 'met with' } as const
  const logDealActivity = (kind: keyof typeof ACTIVITY_VERB) =>
    logActivity(kind, `${ACTIVITY_VERB[kind]} ${deal.company} about ${deal.name}`, {
      type: 'deal',
      id: deal.id,
      label: deal.name,
    })

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
                {columns.map((s) => (
                  <MenuItem
                    key={s.id}
                    selected={deal.stageId === s.id}
                    onClick={() => {
                      onMove(s.id)
                      close()
                    }}
                  >
                    {s.label}
                  </MenuItem>
                ))}
                <MenuDivider />
                <MenuLabel>Log activity</MenuLabel>
                <MenuItem
                  onClick={() => {
                    logDealActivity('call')
                    close()
                  }}
                >
                  Log call
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    logDealActivity('email')
                    close()
                  }}
                >
                  Log email
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    logDealActivity('meeting')
                    close()
                  }}
                >
                  Log meeting
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  onClick={() => {
                    onEdit()
                    close()
                  }}
                >
                  Edit deal
                </MenuItem>
                {canAccessPayments && (
                  <>
                    <MenuDivider />
                    <MenuItem
                      onClick={() => {
                        navigate(`/payments?dealId=${deal.id}`)
                        close()
                      }}
                    >
                      View payments
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Popover>
        </span>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-2">
        <span className="tabular text-[16px] leading-5 font-semibold tracking-[-0.02em] text-ink-900">
          {currency(deal.value, orgCurrency)}
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
            <Badge tone={stage.isWon ? 'positive' : 'negative'}>{stage.label}</Badge>
          )}
          {deal.contactId ? (
            <Link to={`/contacts/${deal.contactId}`} onClick={(e) => e.stopPropagation()}>
              <Avatar name={ownerName} initials={ownerInitials} avatarUrl={ownerAvatarUrl} size="xs" title={`Owner: ${ownerName}`} />
            </Link>
          ) : (
            <Avatar name={ownerName} initials={ownerInitials} avatarUrl={ownerAvatarUrl} size="xs" title={`Owner: ${ownerName}`} />
          )}
        </span>
      </div>

      {/* Privileged users only; never reconciled against the deal — see the Payments screen's own
          received-vs-value banner for the same informational-only reasoning. Mutually exclusive
          with the "Set up payments" button below: a deal either has payments (show progress) or
          doesn't yet (offer to set them up) — never both. */}
      {canAccessPayments && stage.isWon && dealPayments.length > 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="flex items-center justify-between text-[10.5px] text-ink-500">
            <span>Received</span>
            <span className="tabular font-medium text-ink-700">
              {currencyCompact(received, orgCurrency)} / {currencyCompact(deal.value, orgCurrency)}
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-subtle">
            <div
              className={cn('h-full rounded-full', received >= deal.value ? 'bg-positive' : 'bg-ink-700/70')}
              style={{ width: `${Math.min((received / Math.max(deal.value, 1)) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Offered when the Won-stage trigger was skipped (or this deal never fired it, e.g. a
          pre-existing Won deal from before this feature) — same shared dialog, same guard. */}
      {canAccessPayments && stage.isWon && dealPayments.length === 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-center"
            onClick={() => openWonPaymentSetup(deal.id)}
          >
            Set up payments
          </Button>
        </div>
      )}
    </article>
  )
}
