'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Download, Plus, SplitSquareHorizontal, Wallet, X } from 'lucide-react'
import { useSearchParams } from '@/lib/router-compat'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input, Label, Segmented, Select, Textarea } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/Display'
import { Tag } from '@/components/ui/Badge'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { SplitPaymentModal } from '@/components/common/SplitPaymentModal'
import { useCrm } from '@/store/crm'
import type { Payment, PaymentLabel, PaymentStatus } from '@/data/types'
import { PAYMENT_LABELS } from '@/data/types'
import {
  currency,
  currencySymbol,
  exportCsv,
  formatDate,
  isAwaitingMilestone,
  isPaymentOverdue,
  receivedTotal,
  sortBy,
  sum,
} from '@/lib/utils'

const STATUS_TONE: Record<PaymentStatus, 'neutral' | 'positive' | 'negative' | 'warning'> = {
  pending: 'neutral',
  paid: 'positive',
  cancelled: 'negative',
}

const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

type Filter = 'all' | 'overdue' | 'awaiting' | 'paid' | 'cancelled'

/** The "Paid" column's text. A payment that was paid and then cancelled keeps its `paidAt` (see
 *  cancelPayment in lib/data/payments.ts) specifically so this history stays visible, rather than
 *  looking identical to a payment that was simply cancelled while still pending. */
function paidColumnText(payment: Payment): string {
  if (!payment.paidAt) return '—'
  return payment.status === 'cancelled'
    ? `Paid ${formatDate(payment.paidAt)}, then cancelled`
    : formatDate(payment.paidAt)
}

function dueColumnText(payment: Payment): string {
  if (isAwaitingMilestone(payment)) return 'Awaiting milestone'
  if (!payment.dueDate) return '—'
  return formatDate(payment.dueDate)
}

export function Payments() {
  const { payments, deals, orgCurrency } = useCrm()
  const [searchParams] = useSearchParams()
  const dealId = searchParams.get('dealId') || undefined
  const [filter, setFilter] = useState<Filter>('all')
  const [newOpen, setNewOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const [editing, setEditing] = useState<Payment | null>(null)
  const [deleting, setDeleting] = useState<Payment | null>(null)

  const deal = dealId ? deals.find((d) => d.id === dealId) : undefined
  const scoped = dealId ? payments.filter((p) => p.dealId === dealId) : payments

  const overdue = scoped.filter(isPaymentOverdue)
  const awaiting = scoped.filter(isAwaitingMilestone)
  const paid = scoped.filter((p) => p.status === 'paid')
  const cancelled = scoped.filter((p) => p.status === 'cancelled')
  const pendingWithDate = scoped.filter((p) => p.status === 'pending' && !isAwaitingMilestone(p) && !isPaymentOverdue(p))

  const filtered = useMemo(() => {
    switch (filter) {
      case 'overdue':
        return overdue
      case 'awaiting':
        return awaiting
      case 'paid':
        return paid
      case 'cancelled':
        return cancelled
      default:
        return scoped
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, scoped, overdue, awaiting, paid, cancelled])

  const rows = sortBy(filtered, (p) => (isPaymentOverdue(p) ? 0 : 1), 'asc')

  const dealName = (id: string) => deals.find((d) => d.id === id)?.name ?? 'Unknown deal'

  // Informational only — never reconciled against the deal, never changes anything. Only
  // meaningful in the per-deal view, where "the deal" is unambiguous. receivedTotal() counts only
  // status === 'paid' — a cancelled-after-paid payment is correctly excluded even though its
  // paidAt is still set (see the doc comment on receivedTotal in src/lib/utils.ts).
  const receivedForDeal = deal ? receivedTotal(scoped) : 0
  const overReceived = deal ? receivedForDeal > deal.value : false

  const exportPayments = () => {
    exportCsv(
      'payments.csv',
      rows.map((p) => ({
        deal: dealName(p.dealId),
        amount: p.amount,
        currency: orgCurrency,
        label: p.label,
        status: p.status,
        dueDate: p.dueDate ?? '',
        paidAt: p.paidAt ?? '',
        note: p.note ?? '',
      })),
    )
  }

  return (
    <PageShell
      back={dealId ? '/payments' : undefined}
      title={deal ? `Payments · ${deal.name}` : 'Payments'}
      subtitle={`${scoped.length} ${scoped.length === 1 ? 'payment' : 'payments'}${dealId ? ' for this deal' : ''}`}
      actions={
        <>
          {deal && (
            <Button
              variant="secondary"
              size="sm"
              icon={<SplitSquareHorizontal size={14} />}
              onClick={() => setSplitOpen(true)}
            >
              Split into installments
            </Button>
          )}
          <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={exportPayments}>
            Export
          </Button>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setNewOpen(true)}>
            New payment
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-[1200px] space-y-4 p-5">
        {deal && overReceived && (
          <div className="rounded-card border border-warning-line bg-warning-soft px-4 py-2.5 text-[12.5px] leading-5 text-warning">
            Total received ({currency(receivedForDeal, orgCurrency)}) exceeds this deal&apos;s value (
            {currency(deal.value, orgCurrency)}). Payments never change the deal automatically — check whether
            the deal&apos;s value needs updating.
          </div>
        )}

        <SummaryTiles
          collected={receivedTotal(scoped)}
          pendingAmount={sum(pendingWithDate.map((p) => p.amount))}
          pendingCount={pendingWithDate.length}
          overdueAmount={sum(overdue.map((p) => p.amount))}
          overdueCount={overdue.length}
          awaitingCount={awaiting.length}
          currencyCode={orgCurrency}
        />

        <div className="flex items-center">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: scoped.length },
              { value: 'overdue', label: 'Overdue', count: overdue.length },
              { value: 'awaiting', label: 'Awaiting milestone', count: awaiting.length },
              { value: 'paid', label: 'Paid', count: paid.length },
              { value: 'cancelled', label: 'Cancelled', count: cancelled.length },
            ]}
          />
        </div>

        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState
              icon={<Wallet size={16} />}
              title={scoped.length === 0 ? (dealId ? 'No payments on this deal yet' : 'No payments yet') : 'No payments match this filter'}
              description={
                scoped.length === 0
                  ? 'Log an expected or received amount against a deal to start tracking it here.'
                  : 'Try a different filter.'
              }
            />
          ) : (
            <TableShell>
              <Thead>
                {!dealId && <Th>Deal</Th>}
                <Th>Label</Th>
                <Th align="right">Amount</Th>
                <Th>Status</Th>
                <Th>Due date</Th>
                <Th>Paid</Th>
                <Th>Note</Th>
                <Th align="right">Actions</Th>
              </Thead>
              <tbody>
                {rows.map((payment) => (
                  <Tr key={payment.id}>
                    {!dealId && (
                      <Td>
                        <span className="truncate text-[13px] font-medium text-ink-900">
                          {dealName(payment.dealId)}
                        </span>
                      </Td>
                    )}
                    <Td>
                      <Tag>{payment.label}</Tag>
                    </Td>
                    <Td align="right" className="tabular font-medium text-ink-900">
                      {currency(payment.amount, orgCurrency)}
                    </Td>
                    <Td>
                      <Badge tone={isPaymentOverdue(payment) ? 'negative' : STATUS_TONE[payment.status]}>
                        {isPaymentOverdue(payment) ? 'Overdue' : STATUS_LABEL[payment.status]}
                      </Badge>
                    </Td>
                    <Td className={isAwaitingMilestone(payment) ? 'text-ink-400 italic' : 'text-ink-600'}>
                      {dueColumnText(payment)}
                    </Td>
                    <Td className="text-ink-600">{paidColumnText(payment)}</Td>
                    <Td className="max-w-[220px] truncate text-ink-500">{payment.note || '—'}</Td>
                    <Td align="right">
                      <PaymentActions
                        payment={payment}
                        onEdit={() => setEditing(payment)}
                        onDelete={() => setDeleting(payment)}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>

      {newOpen && <NewPaymentModal defaultDealId={dealId} onClose={() => setNewOpen(false)} />}
      {splitOpen && deal && <SplitPaymentModal deal={deal} onClose={() => setSplitOpen(false)} />}
      {editing && <EditPaymentModal payment={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeletePaymentModal payment={deleting} onClose={() => setDeleting(null)} />}
    </PageShell>
  )
}

function SummaryTiles({
  collected,
  pendingAmount,
  pendingCount,
  overdueAmount,
  overdueCount,
  awaitingCount,
  currencyCode,
}: {
  collected: number
  pendingAmount: number
  pendingCount: number
  overdueAmount: number
  overdueCount: number
  awaitingCount: number
  currencyCode: string
}) {
  const fmt = (v: number) => currency(v, currencyCode)
  const tiles: Array<{ label: string; value: string; footer: string; tone?: 'negative' }> = [
    { label: 'Collected', value: fmt(collected), footer: 'Sum of paid payments' },
    { label: 'Pending', value: fmt(pendingAmount), footer: `${pendingCount} with a due date, not yet overdue` },
    { label: 'Overdue', value: fmt(overdueAmount), footer: `${overdueCount} ${overdueCount === 1 ? 'payment' : 'payments'}`, tone: 'negative' },
    { label: 'Awaiting milestone', value: String(awaitingCount), footer: 'No due date set yet' },
  ]
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-card border border-line bg-surface shadow-hairline sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile, i) => (
        <div
          key={tile.label}
          className={`border-line px-5 py-4 ${i > 0 ? 'border-t sm:border-t-0' : ''} ${i % 2 === 1 ? 'sm:border-l' : ''} ${i >= 2 ? 'sm:border-t lg:border-t-0' : ''} ${i > 0 ? 'lg:border-l' : ''}`}
        >
          <p className="text-[12px] leading-4 font-medium text-ink-500">{tile.label}</p>
          <p className={`mt-2 tabular text-[22px] leading-7 font-semibold tracking-[-0.02em] ${tile.tone === 'negative' && (overdueCount > 0) ? 'text-negative' : 'text-ink-900'}`}>
            {tile.value}
          </p>
          <p className="mt-1 text-[11.5px] leading-4 text-ink-400">{tile.footer}</p>
        </div>
      ))}
    </div>
  )
}

function PaymentActions({
  payment,
  onEdit,
  onDelete,
}: {
  payment: Payment
  onEdit: () => void
  onDelete: () => void
}) {
  const { markPaymentPaid, cancelPayment } = useCrm()
  return (
    <div className="flex items-center justify-end gap-1.5">
      {payment.status === 'pending' && (
        <Button variant="secondary" size="sm" onClick={() => markPaymentPaid(payment.id)}>
          Mark paid
        </Button>
      )}
      {payment.status !== 'cancelled' && (
        <Button variant="ghost" size="sm" onClick={() => cancelPayment(payment.id)}>
          Cancel
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      {/* Never deletable once there's any record money was received — even after cancelling,
          paidAt stays set (see cancelPayment in lib/data/payments.ts). */}
      {!payment.paidAt && (
        <IconButton label="Delete payment" onClick={onDelete}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}

const LABEL_OPTIONS: PaymentLabel[] = [...PAYMENT_LABELS]

function NewPaymentModal({ defaultDealId, onClose }: { defaultDealId?: string; onClose: () => void }) {
  const { addPayment, deals, orgCurrency } = useCrm()
  const sortedDeals = useMemo(() => sortBy(deals, (d) => d.name.toLowerCase()), [deals])
  const [dealId, setDealId] = useState(defaultDealId ?? sortedDeals[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [label, setLabel] = useState<PaymentLabel>('Other')
  const [awaitingMilestone, setAwaitingMilestone] = useState(false)
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [note, setNote] = useState('')

  const numericAmount = Number(amount.replace(/[^0-9]/g, '')) || 0
  const canSubmit = dealId !== '' && numericAmount > 0 && (awaitingMilestone || dueDate !== '')

  const submit = () => {
    if (!canSubmit) return
    addPayment({
      dealId,
      amount: numericAmount,
      label,
      dueDate: awaitingMilestone ? undefined : new Date(`${dueDate}T12:00:00`).toISOString(),
      note: note.trim() || undefined,
    })
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="New payment"
      description="Log an expected or received amount against a deal."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            Create payment
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
        {!defaultDealId && (
          <Field label="Deal">
            <Select value={dealId} onChange={(e) => setDealId(e.target.value)} className="h-9">
              {sortedDeals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.company}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount">
            <div className="relative">
              <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-ink-400">
                {currencySymbol(orgCurrency)}
              </span>
              <Input
                value={amount}
                inputMode="numeric"
                autoFocus
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^0-9]/g, '')
                  setAmount(digits ? Number(digits).toLocaleString('en-US') : '')
                }}
                className="tabular pl-10"
              />
            </div>
          </Field>
          <Field label="Label">
            <Select value={label} onChange={(e) => setLabel(e.target.value as PaymentLabel)} className="h-9">
              {LABEL_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Due date">
          <div className="space-y-2">
            <Input
              type="date"
              value={dueDate}
              disabled={awaitingMilestone}
              onChange={(e) => setDueDate(e.target.value)}
              className={awaitingMilestone ? 'opacity-50' : undefined}
            />
            <label className="flex items-center gap-2 text-[12px] text-ink-600">
              <input
                type="checkbox"
                checked={awaitingMilestone}
                onChange={(e) => setAwaitingMilestone(e.target.checked)}
                className="size-3.5"
              />
              Awaiting milestone — no due date yet; set it later once the work completes
            </label>
          </div>
        </Field>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional…" />
        </Field>
      </form>
    </Modal>
  )
}

function EditPaymentModal({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const { updatePayment, orgCurrency } = useCrm()
  const [amount, setAmount] = useState(payment.amount.toLocaleString('en-US'))
  const [label, setLabel] = useState<PaymentLabel>(payment.label)
  const [awaitingMilestone, setAwaitingMilestone] = useState(!payment.dueDate)
  const [dueDate, setDueDate] = useState(() => {
    if (payment.dueDate) return payment.dueDate.slice(0, 10)
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [note, setNote] = useState(payment.note ?? '')

  const numericAmount = Number(amount.replace(/[^0-9]/g, '')) || 0
  const canSubmit = numericAmount > 0 && (awaitingMilestone || dueDate !== '')

  const submit = () => {
    if (!canSubmit) return
    const originalDateOnly = payment.dueDate?.slice(0, 10)
    const dateTouched = dueDate !== originalDateOnly
    const nextDueDate = awaitingMilestone
      ? undefined
      : dateTouched || !payment.dueDate
        ? new Date(`${dueDate}T12:00:00`).toISOString()
        : payment.dueDate
    updatePayment(payment.id, {
      amount: numericAmount,
      label,
      dueDate: nextDueDate,
      note: note.trim() || undefined,
    })
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="Edit payment"
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
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount">
            <div className="relative">
              <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-ink-400">
                {currencySymbol(orgCurrency)}
              </span>
              <Input
                value={amount}
                inputMode="numeric"
                autoFocus
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^0-9]/g, '')
                  setAmount(digits ? Number(digits).toLocaleString('en-US') : '')
                }}
                className="tabular pl-10"
              />
            </div>
          </Field>
          <Field label="Label">
            <Select value={label} onChange={(e) => setLabel(e.target.value as PaymentLabel)} className="h-9">
              {LABEL_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Due date">
          <div className="space-y-2">
            <Input
              type="date"
              value={dueDate}
              disabled={awaitingMilestone}
              onChange={(e) => setDueDate(e.target.value)}
              className={awaitingMilestone ? 'opacity-50' : undefined}
            />
            <label className="flex items-center gap-2 text-[12px] text-ink-600">
              <input
                type="checkbox"
                checked={awaitingMilestone}
                onChange={(e) => setAwaitingMilestone(e.target.checked)}
                className="size-3.5"
              />
              Awaiting milestone — no due date yet; set it later once the work completes
            </label>
          </div>
        </Field>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional…" />
        </Field>
      </form>
    </Modal>
  )
}

function DeletePaymentModal({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const { deletePayment, orgCurrency } = useCrm()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirmDelete = async () => {
    setDeleting(true)
    setError(null)
    const result = await deletePayment(payment.id)
    if (result.ok) onClose()
    else {
      setError(result.error)
      setDeleting(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => { onClose(); setError(null) }}
      width={420}
      title="Delete payment"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-5 text-ink-700">
        Delete this {currency(payment.amount, orgCurrency)} payment? This can&apos;t be undone.
      </p>
      {error && <p className="mt-2 text-[12px] leading-5 text-negative">{error}</p>}
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
