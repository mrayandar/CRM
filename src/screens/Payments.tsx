'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Download, Plus, Wallet, X } from 'lucide-react'
import { useSearchParams } from '@/lib/router-compat'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input, Label, Select, Textarea } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/Display'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { useCrm } from '@/store/crm'
import type { Payment, PaymentStatus } from '@/data/types'
import { currency, currencySymbol, dayDelta, exportCsv, formatDate, sortBy } from '@/lib/utils'

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

/** A pending payment past its due date — same day-level comparison dayDelta/dueLabel use for
 *  tasks, applied here instead of inventing a second definition of "overdue". Computed on read,
 *  never stored. */
function isOverdue(payment: Payment): boolean {
  return payment.status === 'pending' && dayDelta(payment.dueDate) < 0
}

export function Payments() {
  const { payments, deals, orgCurrency } = useCrm()
  const [searchParams] = useSearchParams()
  const dealId = searchParams.get('dealId') || undefined
  const [newOpen, setNewOpen] = useState(false)
  const [editing, setEditing] = useState<Payment | null>(null)
  const [deleting, setDeleting] = useState<Payment | null>(null)

  const deal = dealId ? deals.find((d) => d.id === dealId) : undefined
  const scoped = dealId ? payments.filter((p) => p.dealId === dealId) : payments
  const rows = sortBy(scoped, (p) => (isOverdue(p) ? 0 : 1), 'asc')

  const dealName = (id: string) => deals.find((d) => d.id === id)?.name ?? 'Unknown deal'

  // Informational only — never reconciled against the deal, never changes anything. Only
  // meaningful in the per-deal view, where "the deal" is unambiguous.
  const receivedForDeal = deal ? scoped.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0) : 0
  const overReceived = deal ? receivedForDeal > deal.value : false

  const exportPayments = () => {
    exportCsv(
      'payments.csv',
      rows.map((p) => ({
        deal: dealName(p.dealId),
        amount: p.amount,
        currency: orgCurrency,
        status: p.status,
        dueDate: p.dueDate,
        paidAt: p.paidAt ?? '',
        note: p.note ?? '',
      })),
    )
  }

  return (
    <PageShell
      back={dealId ? '/payments' : undefined}
      title={deal ? `Payments · ${deal.name}` : 'Payments'}
      subtitle={`${rows.length} ${rows.length === 1 ? 'payment' : 'payments'}${dealId ? ' for this deal' : ''}`}
      actions={
        <>
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

        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState
              icon={<Wallet size={16} />}
              title={dealId ? 'No payments on this deal yet' : 'No payments yet'}
              description="Log an expected or received amount against a deal to start tracking it here."
            />
          ) : (
            <TableShell>
              <Thead>
                {!dealId && <Th>Deal</Th>}
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
                    <Td align="right" className="tabular font-medium text-ink-900">
                      {currency(payment.amount, orgCurrency)}
                    </Td>
                    <Td>
                      <Badge tone={isOverdue(payment) ? 'negative' : STATUS_TONE[payment.status]}>
                        {isOverdue(payment) ? 'Overdue' : STATUS_LABEL[payment.status]}
                      </Badge>
                    </Td>
                    <Td className="text-ink-600">{formatDate(payment.dueDate)}</Td>
                    <Td className="text-ink-600">{payment.paidAt ? formatDate(payment.paidAt) : '—'}</Td>
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
      {editing && <EditPaymentModal payment={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeletePaymentModal payment={deleting} onClose={() => setDeleting(null)} />}
    </PageShell>
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
      {payment.status !== 'paid' && (
        <IconButton label="Delete payment" onClick={onDelete}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}

function NewPaymentModal({ defaultDealId, onClose }: { defaultDealId?: string; onClose: () => void }) {
  const { addPayment, deals, orgCurrency } = useCrm()
  const sortedDeals = useMemo(() => sortBy(deals, (d) => d.name.toLowerCase()), [deals])
  const [dealId, setDealId] = useState(defaultDealId ?? sortedDeals[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [note, setNote] = useState('')

  const numericAmount = Number(amount.replace(/[^0-9]/g, '')) || 0
  const canSubmit = dealId !== '' && numericAmount > 0 && dueDate !== ''

  const submit = () => {
    if (!canSubmit) return
    addPayment({
      dealId,
      amount: numericAmount,
      dueDate: new Date(`${dueDate}T12:00:00`).toISOString(),
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
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
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
  const [dueDate, setDueDate] = useState(payment.dueDate.slice(0, 10))
  const [note, setNote] = useState(payment.note ?? '')

  const numericAmount = Number(amount.replace(/[^0-9]/g, '')) || 0
  const canSubmit = numericAmount > 0 && dueDate !== ''

  const submit = () => {
    if (!canSubmit) return
    const dateTouched = dueDate !== payment.dueDate.slice(0, 10)
    updatePayment(payment.id, {
      amount: numericAmount,
      dueDate: dateTouched ? new Date(`${dueDate}T12:00:00`).toISOString() : payment.dueDate,
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
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
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
