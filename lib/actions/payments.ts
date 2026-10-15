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
} from '@lib/data/payments'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertClientId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Invalid id')
}

function assertValidAmount(amount: number) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new Error('Invalid amount')
  }
}

export async function createPaymentAction(input: {
  id: string
  dealId: string
  amount: number
  dueDate: string
  note?: string
}) {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()
  assertClientId(input.id)
  assertValidAmount(input.amount)

  const dueDate = new Date(input.dueDate)
  if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date')
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw new Error('Note is too long')

  // dealId comes from the client — must belong to this org before anything is linked to it.
  const deal = await getDealById(orgId, input.dealId)
  if (!deal) throw new Error('Deal not found')

  const payment = await dbCreatePayment(
    orgId,
    { id: input.id, dealId: deal.id, amount: input.amount, dueDate, note, createdById: actorId },
    deal.name,
  )
  revalidatePath('/', 'layout')
  return { id: payment.id }
}

export async function updatePaymentAction(input: {
  id: string
  amount: number
  dueDate: string
  note?: string
}) {
  const { orgId, ownerId: actorId } = await requirePaymentWriteAccess()
  assertValidAmount(input.amount)

  const dueDate = new Date(input.dueDate)
  if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date')
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw new Error('Note is too long')

  const payment = await getPaymentById(orgId, input.id)
  if (!payment) throw new Error('Payment not found')
  const deal = await getDealById(orgId, payment.dealId)
  if (!deal) throw new Error('Deal not found')

  await dbUpdatePayment(orgId, input.id, { amount: input.amount, dueDate, note }, actorId, deal.name)
  revalidatePath('/', 'layout')
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
