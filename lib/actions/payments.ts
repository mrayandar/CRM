'use server'

/**
 * Payment actions, kept separate from lib/actions/crm.ts per the approved design — Payments is an
 * admin-only feature with its own stricter auth (requirePaymentAccess / requirePaymentWriteAccess,
 * not requireAuth/requireAdmin) and its own activity-leak concerns (every activity this file logs
 * uses kind: 'payment', which the data loader excludes for anyone without payment access — see
 * lib/data-loader.ts and lib/data/activities.ts). Never log a payment-related activity under any
 * other kind; that single `kind: 'payment'` filter is the only thing keeping amounts and payment
 * history out of a non-privileged member's hydrated state, so a different kind here would leak it.
 *
 * No dollar amounts in activity titles, on principle, regardless of who can see them — titles are
 * plain strings that could end up rendered somewhere a amount-formatting decision (currency,
 * rounding) wasn't made for; the Payments table itself is the place amounts are shown.
 *
 * Every write here goes through requirePaymentWriteAccess(), not requirePaymentAccess() — the
 * live Clerk Backend API check, so a demotion blocks a write immediately rather than within
 * Clerk's ~1-minute session-refresh window (see the doc comment on requirePaymentWriteAccess in
 * lib/auth.ts).
 */

import { revalidatePath } from 'next/cache'
import { requirePaymentWriteAccess } from '@lib/auth'
import { getDealById } from '@lib/data/deals'
import {
  getPaymentById,
  createPayment as dbCreatePayment,
  updatePayment as dbUpdatePayment,
  markPaymentPaid as dbMarkPaymentPaid,
  cancelPayment as dbCancelPayment,
  deletePayment as dbDeletePayment,
  createPaymentsSplit as dbCreatePaymentsSplit,
  type PaymentLabel,
} from '@lib/data/payments'
import { splitAmounts } from '@/lib/utils'
import { PAYMENT_LABELS } from '@/data/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertClientId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Invalid id')
}

function assertValidAmount(amount: number) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new Error('Invalid amount')
  }
}

function assertValidLabel(label: unknown): asserts label is PaymentLabel {
  if (!PAYMENT_LABELS.includes(label as PaymentLabel)) throw new Error('Invalid label')
}

/** Parses an optional due-date string. Empty/undefined means "awaiting milestone" (null) — a
 *  deliberate, valid state, not a validation failure. */
function parseOptionalDueDate(input: string | undefined): Date | null {
  if (!input) return null
  const dueDate = new Date(input)
  if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date')
  return dueDate
}

export async function createPaymentAction(input: {
  id: string
  dealId: string
  amount: number
  label: PaymentLabel
  dueDate?: string
  note?: string
}) {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()
  assertClientId(input.id)
  assertValidAmount(input.amount)
  assertValidLabel(input.label)

  const dueDate = parseOptionalDueDate(input.dueDate)
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw new Error('Note is too long')

  // dealId comes from the client — must belong to this org before anything is linked to it.
  const deal = await getDealById(orgId, input.dealId)
  if (!deal) throw new Error('Deal not found')

  const payment = await dbCreatePayment(
    orgId,
    { id: input.id, dealId: deal.id, amount: input.amount, label: input.label, dueDate, note, createdById: actorId },
    deal.name,
  )
  revalidatePath('/', 'layout')
  return { id: payment.id }
}

export async function updatePaymentAction(input: {
  id: string
  amount: number
  label: PaymentLabel
  dueDate?: string
  note?: string
}) {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()
  assertValidAmount(input.amount)
  assertValidLabel(input.label)

  const dueDate = parseOptionalDueDate(input.dueDate)
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw new Error('Note is too long')

  const payment = await getPaymentById(orgId, input.id)
  if (!payment) throw new Error('Payment not found')
  const deal = await getDealById(orgId, payment.dealId)
  if (!deal) throw new Error('Deal not found')

  await dbUpdatePayment(orgId, input.id, { amount: input.amount, label: input.label, dueDate, note }, actorId, deal.name)
  revalidatePath('/', 'layout')
}

/**
 * Creates every installment for a deal in one go. Percentages (integers, each 1-99) must total
 * exactly 100 — rejected otherwise, before anything is written. Amounts are computed server-side
 * via splitAmounts(), never trusted from the client: the last installment absorbs whatever
 * rounding remainder is left so the parts always sum to exactly the deal's current value.
 */
export async function splitPaymentAction(input: {
  dealId: string
  parts: Array<{ id: string; percent: number; label: PaymentLabel; dueDate?: string }>
}) {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()

  if (!Array.isArray(input.parts) || input.parts.length < 2) {
    throw new Error('Need at least two installments to split a payment')
  }
  const dueDates: Array<Date | null> = []
  for (const part of input.parts) {
    assertClientId(part.id)
    assertValidLabel(part.label)
    if (!Number.isInteger(part.percent) || part.percent <= 0 || part.percent >= 100) {
      throw new Error('Each installment must be a whole percentage between 1 and 99')
    }
    dueDates.push(parseOptionalDueDate(part.dueDate))
  }
  const totalPercent = input.parts.reduce((sum, p) => sum + p.percent, 0)
  if (totalPercent !== 100) throw new Error('Percentages must total exactly 100%')

  // dealId comes from the client — must belong to this org before anything is linked to it.
  const deal = await getDealById(orgId, input.dealId)
  if (!deal) throw new Error('Deal not found')

  const amounts = splitAmounts(deal.value, input.parts.map((p) => p.percent))
  const rows = input.parts.map((part, i) => ({
    id: part.id,
    amount: amounts[i]!,
    label: part.label,
    dueDate: dueDates[i]!,
    note: null,
  }))

  const created = await dbCreatePaymentsSplit(orgId, deal.id, rows, actorId, deal.name)
  revalidatePath('/', 'layout')
  return { payments: created.map((p) => ({ id: p.id, amount: p.amount })) }
}

export async function markPaymentPaidAction(paymentId: string) {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()
  const payment = await getPaymentById(orgId, paymentId)
  if (!payment) throw new Error('Payment not found')
  const deal = await getDealById(orgId, payment.dealId)
  if (!deal) throw new Error('Deal not found')

  await dbMarkPaymentPaid(orgId, paymentId, actorId, deal.name)
  revalidatePath('/', 'layout')
}

export async function cancelPaymentAction(paymentId: string) {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()
  const payment = await getPaymentById(orgId, paymentId)
  if (!payment) throw new Error('Payment not found')
  const deal = await getDealById(orgId, payment.dealId)
  if (!deal) throw new Error('Deal not found')

  await dbCancelPayment(orgId, paymentId, actorId, deal.name)
  revalidatePath('/', 'layout')
}

/** Blocked server-side (dbDeletePayment throws) while the payment is `paid` — the caller must
 *  Cancel it instead. Returned, not thrown-and-caught-generically, because the client needs this
 *  specific message, same {ok, error} shape as deleteCompanyAction/deleteStageAction. */
export async function deletePaymentAction(paymentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()
  const payment = await getPaymentById(orgId, paymentId)
  if (!payment) throw new Error('Payment not found')
  const deal = await getDealById(orgId, payment.dealId)
  if (!deal) throw new Error('Deal not found')

  try {
    await dbDeletePayment(orgId, paymentId, actorId, deal.name)
    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't delete the payment" }
  }
}
