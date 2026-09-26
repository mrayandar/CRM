// Seed one lead, one contact, and two deals for the audit org
// Usage: node scripts/seed-audit.js
require('dotenv').config()

const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
  // Find the Nexo Verified Org
  const org = await p.organization.findFirst({
    where: { name: 'Nexo Verified Org' },
  })
  if (!org) throw new Error('Nexo Verified Org not found in DB')

  const owner = await p.owner.findFirst({ where: { orgId: org.id } })
  if (!owner) throw new Error('No owner found for org')

  console.log('Seeding for org:', org.id, org.name)

  const lead = await p.lead.create({
    data: {
      orgId: org.id,
      ownerId: owner.id,
      name: 'Alice Audit',
      title: 'Head of Procurement',
      company: 'Audit Corp',
      email: 'alice@auditcorp.com',
      phone: '+1-555-0100',
      location: 'New York, NY',
      status: 'new',
      source: 'Inbound',
      score: 50,
      estValue: 12000,
    },
  })
  console.log('Lead:', lead.id, lead.name)

  const contact = await p.contact.create({
    data: {
      orgId: org.id,
      ownerId: owner.id,
      name: 'Bob Audit',
      company: 'Audit Corp',
      email: 'bob@auditcorp.com',
      phone: '+1-555-0101',
      location: 'New York, NY',
      title: 'CTO',
      tags: ['audit', 'test'],
    },
  })
  console.log('Contact:', contact.id, contact.name)

  const deal1 = await p.deal.create({
    data: {
      orgId: org.id,
      ownerId: owner.id,
      contactId: contact.id,
      name: 'Audit Deal Alpha',
      value: 25000,
      company: 'Audit Corp',
      stage: 'discovery',
      source: 'Inbound',
      priority: 'medium',
      closeDate: new Date(Date.now() + 30 * 86400 * 1000),
      probability: 30,
    },
  })
  console.log('Deal1:', deal1.id, deal1.name, deal1.stage)

  const deal2 = await p.deal.create({
    data: {
      orgId: org.id,
      ownerId: owner.id,
      contactId: contact.id,
      name: 'Audit Deal Beta',
      value: 8000,
      company: 'Audit Corp',
      stage: 'proposal',
      source: 'Outbound',
      priority: 'medium',
      closeDate: new Date(Date.now() + 15 * 86400 * 1000),
      probability: 60,
    },
  })
  console.log('Deal2:', deal2.id, deal2.name, deal2.stage)

  console.log('DONE')
}

main()
  .catch((e) => { console.error(e.message); process.exit(1) })
  .finally(() => p.$disconnect())
