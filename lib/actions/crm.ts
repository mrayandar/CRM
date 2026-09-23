'use server'

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@lib/auth'
import {
  updateLeadStatus as dbUpdateLeadStatus,
  convertLeadToDeal as dbConvertLeadToDeal,
} from '@lib/data/leads'
import { moveDealToStage as dbMoveDealToStage } from '@lib/data/deals'
import { toggleTaskDone as dbToggleTaskDone, createTask as dbCreateTask } from '@lib/data/tasks'
import { logActivity as dbLogActivity } from '@lib/data/activities'
import type { DealStage, LeadStatus, Priority, ActivityKind } from '@prisma/client'

const STAGE_PROBABILITY: Record<string, number> = {
  discovery: 20,
  proposal: 45,
  negotiation: 65,
  contract: 85,
  won: 100,
  lost: 0,
}

export async function moveDealAction(dealId: string, stage: DealStage) {
  const { orgId } = await requireAuth()
  await dbMoveDealToStage(orgId, dealId, stage, STAGE_PROBABILITY[stage] ?? 25)
  revalidatePath('/', 'layout')
}

export async function setLeadStatusAction(leadId: string, status: LeadStatus) {
  const { orgId } = await requireAuth()
  await dbUpdateLeadStatus(orgId, leadId, status)
  revalidatePath('/', 'layout')
}

export async function convertLeadAction(
  leadId: string,
  input: {
    ownerId: string
    deal?: {
      name: string
      value: number
      stage: DealStage
      closeDate: string
      priority: Priority
    }
  },
) {
  const { orgId } = await requireAuth()
  const result = await dbConvertLeadToDeal(orgId, leadId, {
    ownerId: input.ownerId,
    deal: input.deal
      ? {
          ...input.deal,
          closeDate: new Date(input.deal.closeDate),
        }
      : undefined,
  })
  revalidatePath('/', 'layout')
  return {
    contactId: result.contact.id,
    dealId: result.deal?.id ?? null,
  }
}

export async function toggleTaskAction(taskId: string, done: boolean) {
  const { orgId } = await requireAuth()
  await dbToggleTaskDone(orgId, taskId, done)
  revalidatePath('/', 'layout')
}

export async function addTaskAction(input: {
  title: string
  dueDate: string
  priority: Priority
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string }
}) {
  const { orgId, ownerId } = await requireAuth()
  await dbCreateTask(orgId, {
    title: input.title,
    dueDate: new Date(input.dueDate),
    priority: input.priority,
    type: 'todo',
    owner: { connect: { id: ownerId } },
    ...(input.subject?.type === 'lead' && {
      relatedToType: 'lead',
      relatedToLabel: input.subject.label,
      lead: { connect: { id: input.subject.id } },
    }),
    ...(input.subject?.type === 'contact' && {
      relatedToType: 'contact',
      relatedToLabel: input.subject.label,
      contact: { connect: { id: input.subject.id } },
    }),
    ...(input.subject?.type === 'deal' && {
      relatedToType: 'deal',
      relatedToLabel: input.subject.label,
      deal: { connect: { id: input.subject.id } },
    }),
  })
  revalidatePath('/', 'layout')
}

export async function logActivityAction(
  kind: ActivityKind,
  title: string,
  subject?: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body?: string,
) {
  const { orgId, ownerId } = await requireAuth()
  await dbLogActivity(orgId, {
    kind,
    title,
    body,
    actor: { connect: { id: ownerId } },
    ...(subject?.type === 'lead' && {
      subjectType: 'lead',
      subjectLabel: subject.label,
      lead: { connect: { id: subject.id } },
    }),
    ...(subject?.type === 'contact' && {
      subjectType: 'contact',
      subjectLabel: subject.label,
      contact: { connect: { id: subject.id } },
    }),
    ...(subject?.type === 'deal' && {
      subjectType: 'deal',
      subjectLabel: subject.label,
      deal: { connect: { id: subject.id } },
    }),
  })
  revalidatePath('/', 'layout')
}

export async function addNoteAction(
  subject: { type: 'lead' | 'contact' | 'deal'; id: string; label: string },
  body: string,
) {
  await logActivityAction('note', `added a note on ${subject.label}`, subject, body)
}
