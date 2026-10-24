/**
 * DB-backed coverage for the CSV-import feature's commit-3 scope: the chunked commit route
 * (POST /api/import/batches, POST /api/import/commit), idempotent chunk retries, cross-org id
 * collisions, the OWN-mode duplicate-skip rule, the per-org record cap, and undo (including its
 * skip cases). Parsing/mapping/field-validation and the read-only validate route are covered in
 * tests/unit/csv-import-parsing.test.ts and tests/integration/csv-import.test.ts instead.
 */
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import { PER_ORG_RECORD_CAP } from '@lib/data/import'
import { POST as batchesPOST, dynamic as batchesDynamic } from '../../app/api/import/batches/route'
import { POST as commitPOST, dynamic as commitDynamic } from '../../app/api/import/commit/route'
import { undoImportBatchAction, getOrgRecordCountsAction } from '@lib/actions/import'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let otherOrg: Awaited<ReturnType<typeof prisma.organization.create>>
let company: Awaited<ReturnType<typeof prisma.company.create>>
let repA: Awaited<ReturnType<typeof prisma.owner.create>>
let repB: Awaited<ReturnType<typeof prisma.owner.create>>
let admin: Awaited<ReturnType<typeof prisma.owner.create>>

beforeAll(async () => {
  org = await prisma.organization.create({
    data: { clerkOrgId: `test-import-commit-org-${RUN}`, name: 'Import commit test org', repVisibility: 'OWN' },
  })
  otherOrg = await prisma.organization.create({
    data: { clerkOrgId: `test-import-commit-other-org-${RUN}`, name: 'Other org', repVisibility: 'ALL' },
  })
  company = await prisma.company.create({ data: { orgId: org.id, name: `Import Commit Co ${RUN}` } })
  await prisma.company.create({ data: { orgId: otherOrg.id, name: `Other Co ${RUN}` } })
  repA = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-import-commit-repA-${RUN}`, name: 'Rep A', email: `rep-a-${RUN}@example.com`, role: 'Member' },
  })
  repB = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-import-commit-repB-${RUN}`, name: 'Rep B', email: `rep-b-${RUN}@example.com`, role: 'Member' },
  })
  admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-import-commit-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
})

afterAll(async () => {
  await prisma.activity.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } })
  await prisma.task.deleteMany({ where: { orgId: org.id } })
  await prisma.deal.deleteMany({ where: { orgId: org.id } })
  await prisma.lead.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } })
  await prisma.contact.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } })
  await prisma.importBatch.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } })
  await prisma.company.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } })
  await prisma.owner.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } })
  await prisma.$disconnect()
})

function loginAsRepA() {
  mockAuth.mockResolvedValue({ userId: repA.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}
function loginAsAdmin() {
  mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:admin' })
}

afterEach(() => mockAuth.mockReset())

const LEAD_MAPPING = { 0: 'name', 1: 'email', 2: 'company', 3: 'phone' } as const

async function createBatch(entityType: 'lead' | 'contact', totalRows: number) {
  const response = await batchesPOST(
    new Request('http://localhost/api/import/batches', { method: 'POST', body: JSON.stringify({ entityType, totalRows }) }),
  )
  const body = await response.json()
  return body.batchId as string
}

function commitRequest(body: unknown) {
  return commitPOST(new Request('http://localhost/api/import/commit', { method: 'POST', body: JSON.stringify(body) }))
}

describe('POST /api/import/batches', () => {
  it('is force-dynamic and no-store', async () => {
    expect(batchesDynamic).toBe('force-dynamic')
    loginAsRepA()
    const response = await batchesPOST(
      new Request('http://localhost/api/import/batches', { method: 'POST', body: JSON.stringify({ entityType: 'lead', totalRows: 5 }) }),
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.status).toBe(200)
  })

  it('rejects an invalid entityType', async () => {
    loginAsRepA()
    const response = await batchesPOST(
      new Request('http://localhost/api/import/batches', { method: 'POST', body: JSON.stringify({ entityType: 'deal', totalRows: 5 }) }),
    )
    expect(response.status).toBe(400)
  })
})

describe('POST /api/import/commit: a straightforward create', () => {
  it('is force-dynamic and no-store', () => {
    expect(commitDynamic).toBe('force-dynamic')
  })

  it('creates a new lead with importBatchId set and a single "created" activity', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const rowId = randomUUID()
    const response = await commitRequest({
      batchId,
      entityType: 'lead',
      mapping: LEAD_MAPPING,
      duplicateStrategy: 'skip',
      isFinalChunk: true,
      rows: [{ rowNumber: 1, id: rowId, cells: ['New Lead', `new-${RUN}@example.com`, company.name, ''] }],
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await response.json()
    expect(body.results).toEqual([{ rowNumber: 1, outcome: 'created', recordId: rowId }])
    expect(body.batchClosed).toBe(true)

    const lead = await prisma.lead.findUnique({ where: { id: rowId } })
    expect(lead?.importBatchId).toBe(batchId)
    const activityCount = await prisma.activity.count({ where: { leadId: rowId } })
    expect(activityCount).toBe(1)

    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } })
    expect(batch?.committedAt).not.toBeNull()
    expect(batch?.createdCount).toBe(1)
  })
})

describe('POST /api/import/commit: idempotent retry and cross-org/cross-batch collisions', () => {
  it('retrying the same chunk (same row id, same batch) counts as done, without a second write', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const rowId = randomUUID()
    const row = { rowNumber: 1, id: rowId, cells: ['Retry Lead', `retry-${RUN}@example.com`, company.name, ''] }

    const first = await commitRequest({ batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: false, rows: [row] })
    const firstBody = await first.json()
    expect(firstBody.results[0].outcome).toBe('created')

    const second = await commitRequest({ batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true, rows: [row] })
    const secondBody = await second.json()
    expect(secondBody.results[0]).toEqual({ rowNumber: 1, outcome: 'created', recordId: rowId })

    const activityCount = await prisma.activity.count({ where: { leadId: rowId } })
    expect(activityCount).toBe(1) // not doubled

    const leadCount = await prisma.lead.count({ where: { id: rowId } })
    expect(leadCount).toBe(1)
  })

  it('a row id colliding with an existing row in a DIFFERENT batch (same org) fails with the uniform error', async () => {
    loginAsRepA()
    const batch1 = await createBatch('lead', 1)
    const rowId = randomUUID()
    await commitRequest({
      batchId: batch1, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: rowId, cells: ['Batch One Lead', `batch1-${RUN}@example.com`, company.name, ''] }],
    })

    const batch2 = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId: batch2, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: rowId, cells: ['Batch Two Lead', `batch2-${RUN}@example.com`, company.name, ''] }],
    })
    const body = await response.json()
    expect(body.results[0]).toEqual({ rowNumber: 1, outcome: 'failed', error: 'Could not create record' })
  })

  it('a row id colliding with an existing row in a DIFFERENT org fails with the uniform error, not a raw DB error', async () => {
    const sharedId = randomUUID()
    const otherOrgCompany = await prisma.company.findFirstOrThrow({ where: { orgId: otherOrg.id } })
    await prisma.lead.create({
      data: {
        id: sharedId, orgId: otherOrg.id, name: 'Other Org Lead', title: '', companyId: otherOrgCompany.id,
        email: `other-org-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repA.id,
      },
    })

    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: sharedId, cells: ['My Org Lead', `my-org-${RUN}@example.com`, company.name, ''] }],
    })
    const body = await response.json()
    expect(body.results[0]).toEqual({ rowNumber: 1, outcome: 'failed', error: 'Could not create record' })

    const stillOneRowWithThisId = await prisma.lead.count({ where: { id: sharedId } })
    expect(stillOneRowWithThisId).toBe(1) // the other org's row, untouched — no second write landed
  })

  it('rejects a chunk against a batch from a different org/importer, or already closed', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Closer', `closer-${RUN}@example.com`, company.name, ''] }],
    })
    // Batch is now closed — a further chunk against it is rejected outright.
    const afterClose = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 2, id: randomUUID(), cells: ['Too Late', `toolate-${RUN}@example.com`, company.name, ''] }],
    })
    expect(afterClose.status).toBe(400)

    // repB never created this batch — can't commit to someone else's import.
    loginAsRepA()
    const batchId2 = await createBatch('lead', 1)
    mockAuth.mockResolvedValue({ userId: repB.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
    const wrongImporter = await commitRequest({
      batchId: batchId2, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Not Yours', `notyours-${RUN}@example.com`, company.name, ''] }],
    })
    expect(wrongImporter.status).toBe(400)
  })
})

describe('POST /api/import/commit: duplicate strategy and OWN-mode scope', () => {
  it('a scoped Member\'s row matching another rep\'s record is force-skipped regardless of duplicateStrategy, revealing nothing', async () => {
    const otherRepLead = await prisma.lead.create({
      data: {
        orgId: org.id, name: 'Rep B Owned Lead', title: '', companyId: company.id,
        email: `repb-owned-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repB.id,
      },
    })

    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'update', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Attempted Update', otherRepLead.email, company.name, ''] }],
    })
    const body = await response.json()
    expect(body.results[0]).toEqual({ rowNumber: 1, outcome: 'skipped', error: 'A record with this email already exists' })

    const unchanged = await prisma.lead.findUnique({ where: { id: otherRepLead.id } })
    expect(unchanged?.name).toBe('Rep B Owned Lead') // never touched
  })

  it('duplicateStrategy "update" updates an editable match, preserving blank cells\' existing values', async () => {
    const ownLead = await prisma.lead.create({
      data: {
        orgId: org.id, name: 'Old Name', title: '', companyId: company.id,
        email: `own-update-${RUN}@example.com`, phone: '+1 555 0100', source: 'Inbound', location: '', ownerId: repA.id,
      },
    })

    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'update', isFinalChunk: true,
      // phone cell (index 3) is blank — must NOT erase the existing phone number.
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['New Name', ownLead.email, company.name, ''] }],
    })
    const body = await response.json()
    expect(body.results[0].outcome).toBe('updated')
    expect(body.results[0].recordId).toBe(ownLead.id)

    const updated = await prisma.lead.findUnique({ where: { id: ownLead.id } })
    expect(updated?.name).toBe('New Name')
    expect(updated?.phone).toBe('+1 555 0100') // preserved, not erased by the blank cell
  })

  it('duplicateStrategy "skip" (the default) leaves an editable match untouched and reports it', async () => {
    const ownLead = await prisma.lead.create({
      data: {
        orgId: org.id, name: 'Skip Me', title: '', companyId: company.id,
        email: `own-skip-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repA.id,
      },
    })

    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Should Not Apply', ownLead.email, company.name, ''] }],
    })
    const body = await response.json()
    expect(body.results[0]).toEqual({ rowNumber: 1, outcome: 'skipped', recordId: ownLead.id })

    const unchanged = await prisma.lead.findUnique({ where: { id: ownLead.id } })
    expect(unchanged?.name).toBe('Skip Me')
  })

  it('duplicateStrategy "create" creates a new row despite an editable existing match', async () => {
    const ownLead = await prisma.lead.create({
      data: {
        orgId: org.id, name: 'Has A Duplicate', title: '', companyId: company.id,
        email: `own-forcecreate-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repA.id,
      },
    })

    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const newRowId = randomUUID()
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'create', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: newRowId, cells: ['A New Duplicate', ownLead.email, company.name, ''] }],
    })
    const body = await response.json()
    expect(body.results[0]).toEqual({ rowNumber: 1, outcome: 'created', recordId: newRowId })

    const both = await prisma.lead.count({ where: { orgId: org.id, email: ownLead.email } })
    expect(both).toBe(2)
  })

  it('a blank email never counts as a duplicate, even against another row with a blank email', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 2)
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [
        { rowNumber: 1, id: randomUUID(), cells: ['Blank Email One', '', company.name, ''] },
        { rowNumber: 2, id: randomUUID(), cells: ['Blank Email Two', '', company.name, ''] },
      ],
    })
    const body = await response.json()
    expect(body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['created', 'created'])
  })

  it('an unrecognized source defaults and is flagged, without failing the row', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: { 0: 'name', 1: 'email', 2: 'company', 3: 'source' }, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Odd Source', `oddsource-${RUN}@example.com`, company.name, 'Carrier Pigeon'] }],
    })
    const body = await response.json()
    expect(body.results[0].outcome).toBe('created')
    expect(body.results[0].defaultedFields).toEqual(['source'])
  })
})

describe('POST /api/import/commit: admin-only owner-column mapping', () => {
  it('an admin mapping an unknown owner email fails that row, never silently defaulting', async () => {
    loginAsAdmin()
    const batchId = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId, entityType: 'lead',
      mapping: { 0: 'name', 1: 'email', 2: 'company', 3: 'owner' },
      duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Ghost Owner', `ghostowner-${RUN}@example.com`, company.name, `ghost-${RUN}@example.com`] }],
    })
    const body = await response.json()
    expect(body.results[0].outcome).toBe('failed')
    expect(body.results[0].error).toMatch(/Unknown owner email/)
  })

  it('a non-admin\'s owner-column mapping is stripped server-side; the row is still owned by the importer', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const rowId = randomUUID()
    await commitRequest({
      batchId, entityType: 'lead',
      mapping: { 0: 'name', 1: 'email', 2: 'company', 3: 'owner' },
      duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: rowId, cells: ['Stripped Owner', `strippedowner-${RUN}@example.com`, company.name, repB.email] }],
    })
    const lead = await prisma.lead.findUnique({ where: { id: rowId } })
    expect(lead?.ownerId).toBe(repA.id) // never repB, despite the mapped column
  })
})

describe('POST /api/import/commit: per-org record cap', () => {
  it('rejects a new create once the org is at its lead cap, with a clear message', async () => {
    const existing = await prisma.lead.count({ where: { orgId: org.id } })
    const toSeed = PER_ORG_RECORD_CAP.lead - existing
    await prisma.lead.createMany({
      data: Array.from({ length: toSeed }, (_, i) => ({
        id: randomUUID(), orgId: org.id, name: `Cap Filler ${i}`, title: '', companyId: company.id,
        email: '', phone: '', source: 'Inbound' as const, location: '', ownerId: repA.id,
      })),
    })

    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const response = await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Over The Cap', `overcap-${RUN}@example.com`, company.name, ''] }],
    })
    const body = await response.json()
    expect(body.results[0].outcome).toBe('failed')
    expect(body.results[0].error).toMatch(new RegExp(`${PER_ORG_RECORD_CAP.lead}-record limit`))

    await prisma.lead.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Cap Filler' } } })
  }, 120000)
})

describe('undoImportBatchAction', () => {
  it('is admin-only', async () => {
    loginAsRepA()
    const result = await undoImportBatchAction(randomUUID())
    expect(result).toEqual({ ok: false, error: 'forbidden' })
  })

  it('removes an untouched, dependent-free imported lead', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const rowId = randomUUID()
    await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: rowId, cells: ['Undo Me', `undome-${RUN}@example.com`, company.name, ''] }],
    })

    loginAsAdmin()
    const result = await undoImportBatchAction(batchId)
    expect(result).toEqual({ ok: true, removed: 1, kept: 0 })
    expect(await prisma.lead.findUnique({ where: { id: rowId } })).toBeNull()
  })

  it('keeps a row that has an activity beyond "created"', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const rowId = randomUUID()
    await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: rowId, cells: ['Touched Lead', `touched-${RUN}@example.com`, company.name, ''] }],
    })
    await prisma.activity.create({
      data: { orgId: org.id, kind: 'edited', title: 'edited later', actorId: repA.id, ownerId: repA.id, leadId: rowId },
    })

    loginAsAdmin()
    const result = await undoImportBatchAction(batchId)
    expect(result).toEqual({ ok: true, removed: 0, kept: 1 })
    expect(await prisma.lead.findUnique({ where: { id: rowId } })).not.toBeNull()

    await prisma.activity.deleteMany({ where: { leadId: rowId } })
    await prisma.lead.delete({ where: { id: rowId } })
  })

  it('keeps a row that has a dependent (a linked Task)', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    const rowId = randomUUID()
    await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: rowId, cells: ['Lead With Task', `leadwithtask-${RUN}@example.com`, company.name, ''] }],
    })
    const task = await prisma.task.create({
      data: { orgId: org.id, title: 'Follow up', dueDate: new Date(), ownerId: repA.id, createdById: repA.id, leadId: rowId },
    })

    loginAsAdmin()
    const result = await undoImportBatchAction(batchId)
    expect(result).toEqual({ ok: true, removed: 0, kept: 1 })

    await prisma.task.delete({ where: { id: task.id } })
    await prisma.activity.deleteMany({ where: { leadId: rowId } })
    await prisma.lead.delete({ where: { id: rowId } })
  })

  it('rejects an import older than the 24h window', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Old Import', `oldimport-${RUN}@example.com`, company.name, ''] }],
    })
    await prisma.importBatch.update({ where: { id: batchId }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } })

    loginAsAdmin()
    const result = await undoImportBatchAction(batchId)
    expect(result).toEqual({ ok: false, error: 'This import is more than 24 hours old and can no longer be undone.' })
  })

  it('is idempotent — undoing an already-undone batch is reported, not re-processed', async () => {
    loginAsRepA()
    const batchId = await createBatch('lead', 1)
    await commitRequest({
      batchId, entityType: 'lead', mapping: LEAD_MAPPING, duplicateStrategy: 'skip', isFinalChunk: true,
      rows: [{ rowNumber: 1, id: randomUUID(), cells: ['Undo Twice', `undotwice-${RUN}@example.com`, company.name, ''] }],
    })

    loginAsAdmin()
    const first = await undoImportBatchAction(batchId)
    expect(first).toEqual({ ok: true, removed: 1, kept: 0 })
    const second = await undoImportBatchAction(batchId)
    expect(second).toEqual({ ok: false, error: 'This import has already been undone.' })
  })
})

describe('getOrgRecordCountsAction', () => {
  it('is admin-only', async () => {
    loginAsRepA()
    expect(await getOrgRecordCountsAction()).toEqual({ ok: false, error: 'forbidden' })
  })

  it('reports real per-org counts for an Admin', async () => {
    loginAsAdmin()
    const result = await getOrgRecordCountsAction()
    expect(result.ok).toBe(true)
    if (result.ok) {
      const realLeadCount = await prisma.lead.count({ where: { orgId: org.id } })
      expect(result.counts.leads).toBe(realLeadCount)
    }
  })
})
