/**
 * Maps Prisma records → frontend types used by `src/data/types.ts`.
 *
 * The main differences:
 * - Prisma DateTime → ISO string
 * - Owner doesn't have `initials` — computed from name
 * - Contact.openDeals is denormalized in the frontend; Prisma uses _count
 * - Task.relatedTo is an object in the frontend; Prisma uses separate fields
 * - Activity.subject is an object in the frontend; Prisma uses separate fields
 */
import type {
  Owner as PrismaOwner,
  Lead as PrismaLead,
  Contact as PrismaContact,
  Deal as PrismaDeal,
  Task as PrismaTask,
  Activity as PrismaActivity,
} from '@prisma/client'
import type {
  Owner,
  Lead,
  Contact,
  Deal,
  Task,
  Activity,
} from '@/data/types'

function initialsOf(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

export function mapOwner(o: PrismaOwner): Owner {
  return {
    id: o.id,
    name: o.name,
    initials: initialsOf(o.name),
    role: o.role,
    email: o.email,
  }
}

export function mapLead(
  l: PrismaLead & { convertedDeal?: { id: string } | null },
): Lead {
  return {
    id: l.id,
    name: l.name,
    title: l.title,
    company: l.company,
    email: l.email,
    phone: l.phone,
    status: l.status,
    source: l.source,
    ownerId: l.ownerId,
    score: l.score,
    estValue: l.estValue,
    location: l.location,
    createdAt: l.createdAt.toISOString(),
    lastTouchedAt: l.lastTouchedAt.toISOString(),
    convertedDealId: l.convertedDeal?.id,
  }
}

export function mapContact(
  c: PrismaContact & { _count?: { deals: number } },
): Contact {
  return {
    id: c.id,
    name: c.name,
    title: c.title,
    company: c.company,
    email: c.email,
    phone: c.phone,
    ownerId: c.ownerId,
    leadId: c.originLeadId ?? undefined,
    tags: c.tags,
    lifecycle: c.lifecycle,
    location: c.location,
    lastInteractionAt: c.lastInteractionAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    openDeals: c._count?.deals ?? 0,
    accountValue: c.accountValue,
  }
}

export function mapDeal(d: PrismaDeal): Deal {
  return {
    id: d.id,
    name: d.name,
    company: d.company,
    contactId: d.contactId ?? undefined,
    leadId: d.leadId ?? undefined,
    value: d.value,
    stage: d.stage,
    ownerId: d.ownerId,
    probability: d.probability,
    closeDate: d.closeDate.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    priority: d.priority,
    source: d.source,
  }
}

export function mapTask(t: PrismaTask): Task {
  const relatedTo = t.relatedToType
    ? {
        type: t.relatedToType as 'lead' | 'contact' | 'deal',
        id: (t.leadId ?? t.contactId ?? t.dealId)!,
        label: t.relatedToLabel ?? '',
      }
    : undefined

  return {
    id: t.id,
    title: t.title,
    dueDate: t.dueDate.toISOString(),
    done: t.done,
    priority: t.priority,
    ownerId: t.ownerId,
    relatedTo,
    type: t.type,
  }
}

export function mapActivity(a: PrismaActivity): Activity {
  const subject = a.subjectType
    ? {
        type: a.subjectType as 'lead' | 'contact' | 'deal',
        id: (a.leadId ?? a.contactId ?? a.dealId)!,
        label: a.subjectLabel ?? '',
      }
    : undefined

  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    body: a.body ?? undefined,
    at: a.at.toISOString(),
    actorId: a.actorId,
    subject,
  }
}
