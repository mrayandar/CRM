/**
 * DB-backed coverage for the CSV-import feature's commit-2 scope: duplicate-email detection
 * (respecting Scope — an OWN-mode Member's match on another rep's record must reveal nothing),
 * company resolution preview (read-only, never creates), owner-email resolution, and the parse/
 * validate route handlers end to end. The chunked commit route, idempotency, and undo are
 * covered separately once they exist (lib/actions/import.ts's own test file).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))
vi.mock('@clerk/nextjs/server', () => ({ auth: () => mockAuth(), clerkClient: () => ({}) }))

import { prisma } from '@lib/prisma'
import {
  findDuplicateByEmail,
  previewCompanyResolution,
  resolveOwnerByEmail,
  type PreviewedCompany,
} from '@lib/data/import'
import { POST as parsePOST, dynamic as parseDynamic } from '../../app/api/import/parse/route'
import { POST as validatePOST, dynamic as validateDynamic } from '../../app/api/import/validate/route'
import type { Scope } from '@lib/scope'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

let org: Awaited<ReturnType<typeof prisma.organization.create>>
let company: Awaited<ReturnType<typeof prisma.company.create>>
let repA: Awaited<ReturnType<typeof prisma.owner.create>>
let repB: Awaited<ReturnType<typeof prisma.owner.create>>
let admin: Awaited<ReturnType<typeof prisma.owner.create>>
let leadOwnedByB: Awaited<ReturnType<typeof prisma.lead.create>>

beforeAll(async () => {
  org = await prisma.organization.create({
    data: { clerkOrgId: `test-import-org-${RUN}`, name: 'Import test org', repVisibility: 'OWN' },
  })
  company = await prisma.company.create({ data: { orgId: org.id, name: `Import Co ${RUN}` } })
  repA = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-import-repA-${RUN}`, name: 'Rep A', email: `rep-a-${RUN}@example.com`, role: 'Member' },
  })
  repB = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-import-repB-${RUN}`, name: 'Rep B', email: `rep-b-${RUN}@example.com`, role: 'Member' },
  })
  admin = await prisma.owner.create({
    data: { orgId: org.id, clerkUserId: `test-import-admin-${RUN}`, name: 'Admin', email: `admin-${RUN}@example.com`, role: 'Admin' },
  })
  leadOwnedByB = await prisma.lead.create({
    data: {
      orgId: org.id, name: 'Existing Lead B', title: '', companyId: company.id,
      email: `existing-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repB.id,
    },
  })
})

afterAll(async () => {
  await prisma.lead.deleteMany({ where: { orgId: org.id } })
  await prisma.contact.deleteMany({ where: { orgId: org.id } })
  await prisma.company.deleteMany({ where: { orgId: org.id } })
  await prisma.owner.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  await prisma.$disconnect()
})

function loginAsRepA() {
  mockAuth.mockResolvedValue({ userId: repA.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:member' })
}
function loginAsAdmin() {
  mockAuth.mockResolvedValue({ userId: admin.clerkUserId, orgId: org.clerkOrgId, orgRole: 'org:admin' })
}

const scopeA = (): Scope => ({ orgId: org.id, scopeOwnerId: repA.id })
const scopeUnscoped = (): Scope => ({ orgId: org.id, scopeOwnerId: null })

afterEach(() => mockAuth.mockReset())

describe('findDuplicateByEmail', () => {
  it('blank email never matches', async () => {
    expect(await findDuplicateByEmail(scopeA(), 'lead', '')).toBeNull()
  })

  it('matches case-insensitively', async () => {
    const match = await findDuplicateByEmail(scopeUnscoped(), 'lead', leadOwnedByB.email.toUpperCase())
    expect(match && match.editable && match.recordId).toBe(leadOwnedByB.id)
  })

  it('an unscoped caller (Admin, or ALL mode) sees a full, editable match', async () => {
    const match = await findDuplicateByEmail(scopeUnscoped(), 'lead', leadOwnedByB.email)
    expect(match).toEqual({ editable: true, recordId: leadOwnedByB.id, name: leadOwnedByB.name })
  })

  it('a scoped Member matching their OWN record sees a full, editable match', async () => {
    const ownLead = await prisma.lead.create({
      data: {
        orgId: org.id, name: 'Own Lead A', title: '', companyId: company.id,
        email: `own-${RUN}@example.com`, phone: '', source: 'Inbound', location: '', ownerId: repA.id,
      },
    })
    const match = await findDuplicateByEmail(scopeA(), 'lead', ownLead.email)
    expect(match).toEqual({ editable: true, recordId: ownLead.id, name: ownLead.name })
    await prisma.lead.delete({ where: { id: ownLead.id } })
  })

  it('a scoped Member matching ANOTHER rep\'s record gets editable:false with no id or name', async () => {
    const match = await findDuplicateByEmail(scopeA(), 'lead', leadOwnedByB.email)
    expect(match).toEqual({ editable: false })
    expect(match).not.toHaveProperty('recordId')
    expect(match).not.toHaveProperty('name')
  })
})

describe('previewCompanyResolution', () => {
  it('finds an existing company case-insensitively, without creating a second row', async () => {
    const cache = new Map<string, PreviewedCompany>()
    const result = await previewCompanyResolution(org.id, company.name.toUpperCase(), cache)
    expect(result).toEqual({ id: company.id, name: company.name, existing: true })
  })

  it('reports a not-yet-existing company as existing:false, WITHOUT creating it', async () => {
    const newName = `Not Yet Created ${RUN}`
    const cache = new Map<string, PreviewedCompany>()
    const result = await previewCompanyResolution(org.id, newName, cache)
    expect(result).toEqual({ id: null, name: newName, existing: false })

    const stillAbsent = await prisma.company.findFirst({ where: { orgId: org.id, name: newName } })
    expect(stillAbsent).toBeNull()
  })

  it('caches within one call so a repeated name is only looked up once (same result both times)', async () => {
    const cache = new Map<string, PreviewedCompany>()
    const first = await previewCompanyResolution(org.id, company.name, cache)
    const second = await previewCompanyResolution(org.id, company.name, cache)
    expect(first).toEqual(second)
  })
})

describe('resolveOwnerByEmail', () => {
  it('matches an org member case-insensitively', async () => {
    const result = await resolveOwnerByEmail(org.id, repA.email.toUpperCase())
    expect(result).toEqual({ id: repA.id, name: repA.name })
  })

  it('reports an unknown email, never silently falling back to anyone', async () => {
    const result = await resolveOwnerByEmail(org.id, `nobody-${RUN}@example.com`)
    expect(result).toEqual({ unknownEmail: `nobody-${RUN}@example.com` })
  })

  it('a blank email resolves to null (no owner column mapped for this row)', async () => {
    expect(await resolveOwnerByEmail(org.id, '')).toBeNull()
  })
})

describe('POST /api/import/parse', () => {
  it('is force-dynamic', () => {
    expect(parseDynamic).toBe('force-dynamic')
  })

  it('sets Cache-Control: private, no-store', async () => {
    loginAsRepA()
    const form = new FormData()
    form.append('entityType', 'lead')
    form.append('file', new Blob(['name,email\nAlice,alice@example.com\n'], { type: 'text/csv' }), 'leads.csv')
    const response = await parsePOST(new Request('http://localhost/api/import/parse', { method: 'POST', body: form }))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('parses a small file and suggests a column mapping', async () => {
    loginAsRepA()
    const form = new FormData()
    form.append('entityType', 'lead')
    form.append(
      'file',
      new Blob(['Name,Email,Company\nAlice,alice@example.com,Acme\n'], { type: 'text/csv' }),
      'leads.csv',
    )
    const response = await parsePOST(new Request('http://localhost/api/import/parse', { method: 'POST', body: form }))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.headers).toEqual(['Name', 'Email', 'Company'])
    expect(body.rows).toEqual([['Alice', 'alice@example.com', 'Acme']])
    expect(body.suggestedMapping).toEqual({ 0: 'name', 1: 'email', 2: 'company' })
  })

  it('rejects a file over the row limit', async () => {
    loginAsRepA()
    const lines = ['name,company']
    for (let i = 0; i < 2001; i++) lines.push(`Row ${i},Acme`)
    const form = new FormData()
    form.append('entityType', 'lead')
    form.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), 'big.csv')
    const response = await parsePOST(new Request('http://localhost/api/import/parse', { method: 'POST', body: form }))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toMatch(/2001 rows/)
  })

  it('rejects a file over the size limit', async () => {
    loginAsRepA()
    const bigValue = 'x'.repeat(3 * 1024 * 1024) // 3MB, over the 2MB cap
    const form = new FormData()
    form.append('entityType', 'lead')
    form.append('file', new Blob([`name,notes\nAlice,${bigValue}\n`], { type: 'text/csv' }), 'huge.csv')
    const response = await parsePOST(new Request('http://localhost/api/import/parse', { method: 'POST', body: form }))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toMatch(/2MB/)
  })

  it('401s with no session', async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null, orgRole: null })
    const form = new FormData()
    form.append('entityType', 'lead')
    form.append('file', new Blob(['name\nAlice\n'], { type: 'text/csv' }), 'leads.csv')
    const response = await parsePOST(new Request('http://localhost/api/import/parse', { method: 'POST', body: form }))
    expect(response.status).toBe(401)
  })
})

describe('POST /api/import/validate', () => {
  it('is force-dynamic', () => {
    expect(validateDynamic).toBe('force-dynamic')
  })

  it('sets Cache-Control: private, no-store', async () => {
    loginAsRepA()
    const response = await validatePOST(
      new Request('http://localhost/api/import/validate', {
        method: 'POST',
        body: JSON.stringify({ entityType: 'lead', rows: [['Alice', '', 'Acme']], mapping: { 0: 'name', 1: 'email', 2: 'company' } }),
      }),
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('a scoped Member\'s row that email-matches another rep\'s lead is reported with no owner/details', async () => {
    loginAsRepA()
    const response = await validatePOST(
      new Request('http://localhost/api/import/validate', {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'lead',
          rows: [['Someone New', leadOwnedByB.email, 'Acme']],
          mapping: { 0: 'name', 1: 'email', 2: 'company' },
        }),
      }),
    )
    const body = await response.json()
    expect(body.rows[0].duplicate).toEqual({ editable: false })
  })

  it('an admin mapping an owner column against an unknown email gets it flagged, not silently defaulted', async () => {
    loginAsAdmin()
    const response = await validatePOST(
      new Request('http://localhost/api/import/validate', {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'lead',
          rows: [['Alice', '', 'Acme', `ghost-${RUN}@example.com`]],
          mapping: { 0: 'name', 1: 'email', 2: 'company', 3: 'owner' },
        }),
      }),
    )
    const body = await response.json()
    expect(body.rows[0].resolvedOwner).toEqual({ unknownEmail: `ghost-${RUN}@example.com` })
  })

  it('a non-admin\'s owner-column mapping is stripped server-side, never resolved', async () => {
    loginAsRepA()
    const response = await validatePOST(
      new Request('http://localhost/api/import/validate', {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'lead',
          rows: [['Alice', '', 'Acme', repB.email]],
          mapping: { 0: 'name', 1: 'email', 2: 'company', 3: 'owner' },
        }),
      }),
    )
    const body = await response.json()
    expect(body.rows[0].resolvedOwner).toBeNull()
  })

  it('401s with no session', async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: null, orgRole: null })
    const response = await validatePOST(
      new Request('http://localhost/api/import/validate', {
        method: 'POST',
        body: JSON.stringify({ entityType: 'lead', rows: [['Alice', '', 'Acme']], mapping: { 0: 'name', 1: 'email', 2: 'company' } }),
      }),
    )
    expect(response.status).toBe(401)
  })
})
