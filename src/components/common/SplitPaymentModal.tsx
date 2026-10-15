'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { Input, Label, Segmented, Select } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { Link } from '@/lib/router-compat'
import { useCrm } from '@/store/crm'
import type { PaymentLabel } from '@/data/types'
import { PAYMENT_LABELS } from '@/data/types'
import { currency, receivedTotal, splitAmounts, sum } from '@/lib/utils'

const LABEL_OPTIONS: PaymentLabel[] = [...PAYMENT_LABELS]

type Preset = '50-50' | '30-40-30' | 'custom'

interface SplitRow {
  percent: number
  label: PaymentLabel
  dueDate: string
}

function presetRows(preset: Preset): SplitRow[] {
  if (preset === '50-50') {
    return [
      { percent: 50, label: 'Advance', dueDate: '' },
      { percent: 50, label: 'Final', dueDate: '' },
    ]
  }
  if (preset === '30-40-30') {
    return [
      { percent: 30, label: 'Advance', dueDate: '' },
      { percent: 40, label: 'Milestone', dueDate: '' },
      { percent: 30, label: 'Final', dueDate: '' },
    ]
  }
  return [
    { percent: 50, label: 'Other', dueDate: '' },
    { percent: 50, label: 'Other', dueDate: '' },
  ]
}

/**
 * The one "split a deal's value into installments" form, shared by the Payments screen's own
 * "Split into installments" action and the "set up payments after Won" prompt/button — never
 * duplicated. Creates nothing until "Create N payments" is pressed; `onClose` dismisses without
 * creating anything (used for both "Cancel" and a caller's "Skip for now").
 *
 * If the real splitPaymentAction rejects because the deal already has payments — most likely a
 * race (the deal picked up a payment, e.g. from another tab, between this dialog opening and the
 * user submitting) — this shows received-vs-value and a link to the deal's Payments view instead
 * of a bare error, since that's the actually-useful next step for the human at the keyboard.
 */
export function SplitPaymentModal({
  deal,
  onClose,
  title,
  description,
  cancelLabel = 'Cancel',
}: {
  deal: { id: string; name: string; value: number }
  onClose: () => void
  title?: string
  description?: string
  cancelLabel?: string
}) {
  const { splitPayment, payments, orgCurrency } = useCrm()
  const [preset, setPreset] = useState<Preset>('50-50')
  const [rows, setRows] = useState<SplitRow[]>(presetRows('50-50'))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [alreadyHasPayments, setAlreadyHasPayments] = useState(false)

  const totalPercent = sum(rows.map((r) => r.percent))
  const amounts = useMemo(() => splitAmounts(deal.value, rows.map((r) => r.percent)), [deal.value, rows])
  const canSubmit = totalPercent === 100 && rows.length >= 2 && !submitting

  const applyPreset = (next: Preset) => {
    setPreset(next)
    setRows(presetRows(next))
  }

  const updateRow = (index: number, patch: Partial<SplitRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const addRow = () => setRows((prev) => [...prev, { percent: 0, label: 'Other', dueDate: '' }])
  const removeRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index))

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await splitPayment(
        deal.id,
        rows.map((r) => ({
          percent: r.percent,
          label: r.label,
          dueDate: r.dueDate ? new Date(`${r.dueDate}T12:00:00`).toISOString() : undefined,
        })),
      )
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't split the payment, please try again."
      if (/already has payments/i.test(message)) {
        setAlreadyHasPayments(true)
      } else {
        setError(message)
      }
      setSubmitting(false)
    }
  }

  if (alreadyHasPayments) {
    const received = receivedTotal(payments.filter((p) => p.dealId === deal.id))
    return (
      <Modal open onClose={onClose} width={440} title="This deal already has payments">
        <div className="space-y-3">
          <p className="text-[13px] leading-5 text-ink-700">
            {deal.name} already has payments set up — splitting again isn&apos;t available for a deal
            that already has some.
          </p>
          <div className="flex items-center justify-between rounded-panel bg-subtler px-3 py-2 text-[12.5px]">
            <span className="text-ink-500">Received</span>
            <span className="tabular font-semibold text-ink-900">
              {currency(received, orgCurrency)} / {currency(deal.value, orgCurrency)}
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Link to={`/payments?dealId=${deal.id}`}>
              <Button variant="primary" onClick={onClose}>
                View payments
              </Button>
            </Link>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={title ?? 'Split into installments'}
      description={
        description ??
        `From ${deal.name}'s value of ${currency(deal.value, orgCurrency)}. Changing the deal's value later does not change these amounts.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {submitting ? 'Splitting…' : `Create ${rows.length} payments`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={preset}
          onChange={(v) => applyPreset(v as Preset)}
          options={[
            { value: '50-50', label: '50 / 50' },
            { value: '30-40-30', label: '30 / 40 / 30' },
            { value: 'custom', label: 'Custom' },
          ]}
        />

        <div className="space-y-2.5">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[72px_1fr_1fr_auto] items-end gap-2">
              <Field label="%">
                <Input
                  value={row.percent || ''}
                  inputMode="numeric"
                  disabled={preset !== 'custom'}
                  onChange={(e) => updateRow(i, { percent: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })}
                  className="tabular"
                />
              </Field>
              <Field label="Label">
                <Select value={row.label} onChange={(e) => updateRow(i, { label: e.target.value as PaymentLabel })} className="h-9">
                  {LABEL_OPTIONS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Due date (optional)">
                <Input type="date" value={row.dueDate} onChange={(e) => updateRow(i, { dueDate: e.target.value })} />
              </Field>
              {preset === 'custom' && rows.length > 2 ? (
                <IconButton label="Remove installment" onClick={() => removeRow(i)} className="mb-0.5">
                  <X size={14} />
                </IconButton>
              ) : (
                <span />
              )}
              <p className="col-span-4 -mt-1.5 text-[11.5px] text-ink-400">
                {amounts[i] !== undefined ? currency(amounts[i]!, orgCurrency) : '—'}
              </p>
            </div>
          ))}
        </div>

        {preset === 'custom' && (
          <Button variant="ghost" size="sm" onClick={addRow}>
            Add installment
          </Button>
        )}

        <div className="flex items-center justify-between rounded-panel bg-subtler px-3 py-2 text-[12.5px]">
          <span className="text-ink-500">Total</span>
          <span className={`tabular font-semibold ${totalPercent === 100 ? 'text-positive' : 'text-negative'}`}>
            {totalPercent}%{totalPercent !== 100 && ' — must total exactly 100%'}
          </span>
        </div>

        {error && <p className="text-[12px] leading-5 text-negative">{error}</p>}
      </div>
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
