// Server-only data access. Do not import this module from a Client
// Component — it pulls in `@prisma/client`, which only runs in Node.
//
// Every function requires `orgId` as its first argument and includes it in
// every `where` clause. Never call these with an id alone — that would let
// a client that guessed/enumerated an id read across tenants.
//
// Admin-only feature: every caller of this module must already have gone through
// requirePaymentAccess() (reads) or requirePaymentWriteAccess() (writes) in
// lib/actions/payments.ts or the data loader — this module itself does no role
// checking, same division of responsibility as every other lib/data/*.ts file.
import type { PaymentLabel, PaymentStatus } from '@prisma/client'
import { prisma } from '@lib/prisma'

export interface ListPaymentsOptions {
  dealId?: string
}

export function listPayments(orgId: string, options: ListPaymentsOptions = {}) {
  const { dealId } = options
  return prisma.payment.findMany({
    where: { orgId, ...(dealId && { dealId }) },
    include: { deal: true },
    orderBy: { dueDate: 'asc' },
  })
}

export function getPaymentById(orgId: string, id: string) {
  return prisma.payment.findFirst({ where: { id, orgId } })
}

export interface CreatePaymentInput {
  id: string
  dealId: string
  amount: number
  label: PaymentLabel
  /** Null means "awaiting milestone" — see the doc comment on Payment.dueDate in schema.prisma. */
  dueDate: Date | null
  note: string | null
  createdById: string
}

export function createPayment(orgId: string, data: CreatePaymentInput, dealLabel: string) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        id: data.id,
        orgId,
        dealId: data.dealId,
        amount: data.amount,
        label: data.label,
        dueDate: data.dueDate,
        note: data.note,
        createdById: data.createdById,
      },
    })
    // kind: 'payment' — never 'created' — so this is excluded from loadCrmData for anyone without
    // payment access, same as every other activity this module logs. No amount in the title: see
    // the module doc comment in lib/actions/payments.ts for why.
    await tx.activity.create({
      data: {
        orgId,
        kind: 'payment',
        title: `logged a payment on ${dealLabel}`,
        actorId: data.createdById,
        subjectType: 'deal',
        subjectLabel: dealLabel,
        dealId: data.dealId,
      },
    })
    return payment
  })
}

export interface SplitPaymentRow {
  id: string
  amount: number
  label: PaymentLabel
  dueDate: Date | null
  note: string | null
}

/**
 * Creates every installment row from a "Split into installments" action in one transaction — if
 * any row fails, none of them are created, rather than leaving a partial split behind. Logs a
 * single activity for the whole split, not one per row, same no-amount-in-title policy as every
 * other payment activity.
 */
export function createPaymentsSplit(
  orgId: string,
  dealId: string,
  rows: SplitPaymentRow[],
  createdById: string,
  dealLabel: string,
) {
  return prisma.$transaction(async (tx) => {
    const created = []
    for (const row of rows) {
      created.push(
        await tx.payment.create({
          data: {
            id: row.id,
            orgId,
            dealId,
            amount: row.amount,
            label: row.label,
            dueDate: row.dueDate,
            note: row.note,
            createdById,
          },
        }),
      )
    }
    await tx.activity.create({
      data: {
        orgId,
        kind: 'payment',
        title: `split ${dealLabel} into ${rows.length} installments`,
        actorId: createdById,
        subjectType: 'deal',
        subjectLabel: dealLabel,
        dealId,
      },
    })
    return created
  })
}

export interface UpdatePaymentInput {
  amount: number
  label: PaymentLabel
  /** Null means "awaiting milestone". Editing lets a milestone's date be set later, once known —
   *  going from null to a real date (or back) is just another field change. */
  dueDate: Date | null
  note: string | null
}

/** No-op save (nothing actually differs) skips the write and the activity, same convention as
 *  updateTask/updateDeal/updateLead. Editing is allowed regardless of status (pending/paid/
 *  cancelled) — only *deleting* is restricted (see deletePayment). */
export async function updatePayment(
  orgId: string,
  id: string,
  data: UpdatePaymentInput,
  actorId: string,
  dealLabel: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Payment ${id} not found in org ${orgId}`)

    const existingDueDateMs = existing.dueDate ? +existing.dueDate : null
    const nextDueDateMs = data.dueDate ? +data.dueDate : null
    const changed =
      existing.amount !== data.amount ||
      existing.label !== data.label ||
      existingDueDateMs !== nextDueDateMs ||
      (existing.note ?? '') !== (data.note ?? '')
    if (!changed) return existing

    const updated = await tx.payment.update({
      where: { id },
      data: { amount: data.amount, label: data.label, dueDate: data.dueDate, note: data.note },
    })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'payment',
        title: `edited a payment on ${dealLabel}`,
        actorId,
        subjectType: 'deal',
        subjectLabel: dealLabel,
        dealId: existing.dealId,
      },
    })

    return updated
  })
}

export async function markPaymentPaid(orgId: string, id: string, actorId: string, dealLabel: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Payment ${id} not found in org ${orgId}`)
    if (existing.status === 'paid') return existing

    const updated = await tx.payment.update({
      where: { id },
      data: { status: 'paid', paidAt: new Date() },
    })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'payment',
        title: `marked a payment as paid on ${dealLabel}`,
        actorId,
        subjectType: 'deal',
        subjectLabel: dealLabel,
        dealId: existing.dealId,
      },
    })

    return updated
  })
}

/**
 * The only way to undo a paid payment (deletion is permanently blocked once paid — see
 * deletePayment). Deliberately keeps `paidAt` rather than clearing it: the record should still
 * read as "paid on X, then cancelled" rather than erasing the fact that money was received. The
 * received-total calculation (Payments screen) excludes cancelled payments by `status`, not by
 * `paidAt`, so this doesn't double-count anything.
 */
export async function cancelPayment(orgId: string, id: string, actorId: string, dealLabel: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Payment ${id} not found in org ${orgId}`)
    if (existing.status === 'cancelled') return existing

    const updated = await tx.payment.update({
      where: { id },
      data: { status: 'cancelled' },
    })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'payment',
        title: `cancelled a payment on ${dealLabel}`,
        actorId,
        subjectType: 'deal',
        subjectLabel: dealLabel,
        dealId: existing.dealId,
      },
    })

    return updated
  })
}

/**
 * Deletable only when there's no record of money ever having been received: a `pending` payment,
 * or a `cancelled` one that was never `paid` first. Checked by `paidAt`, not `status` alone — a
 * payment that was paid and then cancelled still has `paidAt` set (cancelPayment deliberately
 * keeps it), so it stays permanently undeletable even though its *current* status is `cancelled`.
 * Without this, paid -> cancel -> delete would erase the one row that proves money was received.
 */
export async function deletePayment(orgId: string, id: string, actorId: string, dealLabel: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findFirst({ where: { id, orgId } })
    if (!existing) throw new Error(`Payment ${id} not found in org ${orgId}`)
    if (existing.paidAt) {
      throw new Error("Can't delete a payment that was ever marked paid — it stays as a record even once cancelled.")
    }

    await tx.payment.delete({ where: { id } })

    await tx.activity.create({
      data: {
        orgId,
        kind: 'payment',
        title: `deleted a payment on ${dealLabel}`,
        actorId,
        subjectType: 'deal',
        subjectLabel: dealLabel,
        dealId: existing.dealId,
      },
    })

    return existing
  })
}

export type { PaymentStatus, PaymentLabel }
