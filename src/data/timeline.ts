import type { Activity, ActivityKind } from './types'
import { seededRandom } from '@/lib/utils'

const OWNER_POOL = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']

const TEMPLATES: Array<{
  kind: ActivityKind
  title: (name: string, company: string) => string
  body?: (name: string, company: string) => string
}> = [
  {
    kind: 'email',
    title: (name) => `emailed ${name} a follow-up`,
    body: (_n, company) => `Recapped the call and shared the ${company} pilot outline plus pricing tiers.`,
  },
  {
    kind: 'call',
    title: (name) => `logged a call with ${name}`,
    body: (name) => `${name.split(' ')[0]} walked through the current workflow and where the handoffs break down.`,
  },
  {
    kind: 'meeting',
    title: (name) => `ran a discovery session with ${name}`,
    body: (_n, company) => `Mapped ${company}'s reporting requirements. Two teams need read-only access on day one.`,
  },
  {
    kind: 'note',
    title: (name) => `added a note on ${name}`,
    body: (name) => `${name.split(' ')[0]} flagged that budget approval runs through finance at the end of the quarter.`,
  },
  {
    kind: 'email',
    title: (name) => `sent ${name} the security overview`,
  },
  {
    kind: 'call',
    title: (name) => `left a voicemail for ${name}`,
  },
  {
    kind: 'meeting',
    title: (name) => `demoed the reporting module to ${name}`,
    body: () => `Strong reaction to the forecast view. Asked whether alerts can be routed to Slack.`,
  },
  {
    kind: 'note',
    title: (name) => `added a note on ${name}`,
    body: () => `Competitor already in the account on a 12-month term — renewal lands in the spring.`,
  },
]

/**
 * Deterministic history for a record so every detail view has a believable
 * timeline, layered under whatever real activity exists in the store.
 */
const DAY = 86_400_000

export function generatedTimeline({
  id,
  name,
  company,
  createdAt,
  lastActivityAt,
  ownerId,
  type,
}: {
  id: string
  name: string
  company: string
  createdAt: string
  lastActivityAt: string
  ownerId: string
  type: 'lead' | 'contact'
}): Activity[] {
  const rand = seededRandom(id)
  const count = 3 + Math.floor(rand() * 4)
  const created = new Date(createdAt).getTime()
  const latest = new Date(lastActivityAt).getTime()

  // Cluster the working history into the weeks leading up to the last
  // interaction rather than smearing it across the whole account lifetime.
  const windowStart = Math.max(created + DAY, latest - 45 * DAY)
  const span = Math.max(latest - windowStart, DAY)

  const events: Activity[] = []
  const usedTemplates = new Set<number>()

  for (let i = 0; i < count; i++) {
    let index = Math.floor(rand() * TEMPLATES.length)
    // Don't repeat a template within one record — duplicate notes read as a bug.
    for (let attempt = 0; usedTemplates.has(index) && attempt < TEMPLATES.length; attempt++) {
      index = (index + 1) % TEMPLATES.length
    }
    usedTemplates.add(index)
    const template = TEMPLATES[index]!

    // The newest generated event lands on the record's last-activity date so the
    // profile panel and the timeline agree.
    const at = new Date(windowStart + span * ((i + 1) / count) - rand() * 3_600_000)
    events.push({
      id: `${id}-g${i}`,
      kind: template.kind,
      title: template.title(name, company),
      body: template.body?.(name, company),
      at: at.toISOString(),
      actorId: rand() > 0.55 ? OWNER_POOL[Math.floor(rand() * OWNER_POOL.length)]! : ownerId,
      subject: { type, id, label: name },
    })
  }

  events.push({
    id: `${id}-created`,
    kind: 'created',
    title: type === 'lead' ? `created lead ${name}` : `added ${name} as a contact`,
    at: createdAt,
    actorId: ownerId,
    subject: { type, id, label: name },
  })

  return events
}
